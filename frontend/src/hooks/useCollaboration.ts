'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { CollaborationService } from '@/services/collaboration.service';
import { CollaborationCallbacks, UseCollaborationReturn, CollabUser, LockedNode } from '@/types';

export function useCollaboration(callbacks: CollaborationCallbacks = {}): UseCollaborationReturn {
    const [sessionCode, setSessionCode] = useState<string | null>(null);
    const [users, setUsers] = useState<CollabUser[]>([]);
    const [lockedNodes, setLockedNodes] = useState<Record<string, LockedNode>>({});
    const [isConnected, setIsConnected] = useState(false);
    const [typingUser, setTypingUser] = useState<CollabUser | null>(null);
    const [inputLocked, setInputLocked] = useState(false);
    const [inputLockedBy, setInputLockedBy] = useState<{ id: number; username: string } | null>(null);
    const [streamingMessage, setStreamingMessage] = useState('');
    const [streamingNodes, setStreamingNodes] = useState<Record<string, string>>({});

    const wsRef = useRef<WebSocket | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionCodeRef = useRef<string | null>(null);

    const chatQueueRef = useRef<string[]>([]);
    const chatDrainRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const nodeQueuesRef = useRef<Record<string, string[]>>({});
    const nodeDrainRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
    const nodeStreamsCompleteRef = useRef<Set<string>>(new Set());

    const CHAT_CHAR_INTERVAL = 50;
    const NODE_CHAR_INTERVAL = 70;
    const CHARS_PER_TICK = 1;

    const isServerStreamDoneRef = useRef(false);
    const finalAiMessageRef = useRef<any>(null);

    const startChatDrain = useCallback(() => {
        if (chatDrainRef.current) return;
        chatDrainRef.current = setInterval(() => {
            const queue = chatQueueRef.current;
            if (queue.length === 0) {
                // Only stop if the server has finished sending data
                if (isServerStreamDoneRef.current) {
                    if (chatDrainRef.current) {
                        clearInterval(chatDrainRef.current);
                        chatDrainRef.current = null;
                    }

                    // Final cleanup sequence
                    setStreamingMessage('');
                    setStreamingNodes({});
                    isServerStreamDoneRef.current = false;

                    if (callbacksRef.current.onAiStreamDone && finalAiMessageRef.current) {
                        callbacksRef.current.onAiStreamDone(finalAiMessageRef.current);
                        finalAiMessageRef.current = null;
                    }
                }
                return;
            }
            const batch = queue.splice(0, CHARS_PER_TICK).join('');
            setStreamingMessage((prev) => prev + batch);
        }, CHAT_CHAR_INTERVAL);
    }, []);

    const startNodeDrain = useCallback((nodeId: string) => {
        if (nodeDrainRef.current[nodeId]) return;
        nodeDrainRef.current[nodeId] = setInterval(() => {
            const queue = nodeQueuesRef.current[nodeId];
            if (!queue || queue.length === 0) {
                // Only stop if the server has finished sending data
                if (nodeStreamsCompleteRef.current.has(nodeId)) {
                    if (nodeDrainRef.current[nodeId]) {
                        clearInterval(nodeDrainRef.current[nodeId]);
                        delete nodeDrainRef.current[nodeId];
                    }
                    delete nodeQueuesRef.current[nodeId];
                    nodeStreamsCompleteRef.current.delete(nodeId);

                    setStreamingNodes((prev) => {
                        const next = { ...prev };
                        delete next[nodeId];
                        return next;
                    });
                }
                return;
            }
            const batch = queue.splice(0, CHARS_PER_TICK).join('');
            setStreamingNodes((prev) => ({
                ...prev,
                [nodeId]: (prev[nodeId] || '') + batch,
            }));
        }, NODE_CHAR_INTERVAL);
    }, []);

    const flushAllQueues = useCallback(() => {
        if (chatDrainRef.current) {
            clearInterval(chatDrainRef.current);
            chatDrainRef.current = null;
        }
        if (chatQueueRef.current.length > 0) {
            const remaining = chatQueueRef.current.splice(0).join('');
            setStreamingMessage((prev) => prev + remaining);
        }
        Object.keys(nodeDrainRef.current).forEach((nodeId) => {
            clearInterval(nodeDrainRef.current[nodeId]);
            delete nodeDrainRef.current[nodeId];
        });
        Object.keys(nodeQueuesRef.current).forEach((nodeId) => {
            const queue = nodeQueuesRef.current[nodeId];
            if (queue && queue.length > 0) {
                const remaining = queue.splice(0).join('');
                setStreamingNodes((prev) => ({
                    ...prev,
                    [nodeId]: (prev[nodeId] || '') + remaining,
                }));
            }
        });
    }, []);

    const token = useAuthStore((state) => state.token);

    const connectWs = useCallback((code: string) => {
        if (!token) return;

        const url = CollaborationService.getWsUrl(code, token);
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            setIsConnected(true);
        };

        ws.onclose = () => {
            setIsConnected(false);
            wsRef.current = null;
        };

        ws.onerror = () => {
            setIsConnected(false);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                switch (data.type) {
                    case 'session_state':
                        setUsers(data.users || []);
                        setLockedNodes(
                            Object.fromEntries(
                                Object.entries(data.locked_nodes || {}).map(([nodeId, user]: [string, any]) => [
                                    nodeId,
                                    { userId: user.id, username: user.username },
                                ])
                            )
                        );
                        if (data.workflow_data && callbacksRef.current.onRemoteWorkflowUpdate) {
                            callbacksRef.current.onRemoteWorkflowUpdate(data.workflow_data, { id: 0, username: 'session', role: 'owner' });
                        }
                        if (data.chat_id && callbacksRef.current.onConnectedToChat) {
                            callbacksRef.current.onConnectedToChat(data.chat_id);
                        }
                        break;

                    case 'user_joined':
                        setUsers((prev) => [...prev, data.user]);
                        break;

                    case 'user_left':
                        setUsers((prev) => prev.filter((u) => u.id !== data.user.id));
                        if (data.unlocked_nodes) {
                            setLockedNodes((prev) => {
                                const next = { ...prev };
                                data.unlocked_nodes.forEach((nodeId: string) => delete next[nodeId]);
                                return next;
                            });
                        }
                        break;

                    case 'workflow_update':
                        if (callbacksRef.current.onRemoteWorkflowUpdate) {
                            callbacksRef.current.onRemoteWorkflowUpdate(data.workflow_data, data.from_user);
                        }
                        break;

                    case 'node_lock':
                        setLockedNodes((prev) => ({
                            ...prev,
                            [data.node_id]: { userId: data.user.id, username: data.user.username },
                        }));
                        break;

                    case 'node_lock_denied':
                        console.warn(`Node ${data.node_id} is locked by ${data.locked_by.username}`);
                        break;

                    case 'node_unlock':
                        setLockedNodes((prev) => {
                            const next = { ...prev };
                            delete next[data.node_id];
                            return next;
                        });
                        break;

                    case 'input_locked':
                        setInputLocked(true);
                        setInputLockedBy(data.user);
                        if (callbacksRef.current.onInputLocked) {
                            callbacksRef.current.onInputLocked(data.user);
                        }
                        break;

                    case 'input_unlocked':
                        setInputLocked(false);
                        setInputLockedBy(null);
                        if (callbacksRef.current.onInputUnlocked) {
                            callbacksRef.current.onInputUnlocked();
                        }
                        break;

                    case 'nodes_locked':
                        if (data.node_ids && data.user) {
                            setLockedNodes((prev) => {
                                const next = { ...prev };
                                data.node_ids.forEach((nodeId: string) => {
                                    next[nodeId] = { userId: data.user.id, username: data.user.username };
                                });
                                return next;
                            });
                            if (callbacksRef.current.onNodesLocked) {
                                callbacksRef.current.onNodesLocked(data.node_ids, data.user);
                            }
                        }
                        break;

                    case 'nodes_unlocked':
                        if (data.node_ids) {
                            setLockedNodes((prev) => {
                                const next = { ...prev };
                                data.node_ids.forEach((nodeId: string) => delete next[nodeId]);
                                return next;
                            });
                            if (callbacksRef.current.onNodesUnlocked) {
                                callbacksRef.current.onNodesUnlocked(data.node_ids);
                            }
                        }
                        break;

                    case 'node_stream_start':
                        if (nodeDrainRef.current[data.node_id]) {
                            clearInterval(nodeDrainRef.current[data.node_id]);
                            delete nodeDrainRef.current[data.node_id];
                        }
                        delete nodeQueuesRef.current[data.node_id];
                        nodeStreamsCompleteRef.current.delete(data.node_id);

                        setStreamingNodes((prev) => ({ ...prev, [data.node_id]: '' }));
                        if (callbacksRef.current.onNodeStreamStart) {
                            callbacksRef.current.onNodeStreamStart(data.node_id, data.node_type);
                        }
                        break;

                    case 'node_stream_delta':
                        if (!nodeQueuesRef.current[data.node_id]) {
                            nodeQueuesRef.current[data.node_id] = [];
                        }
                        nodeQueuesRef.current[data.node_id].push(...data.content.split(''));
                        startNodeDrain(data.node_id);
                        if (callbacksRef.current.onNodeStreamDelta) {
                            callbacksRef.current.onNodeStreamDelta(data.node_id, data.content);
                        }
                        break;

                    case 'node_stream_done': {
                        nodeStreamsCompleteRef.current.add(data.node_id);

                        if (!nodeDrainRef.current[data.node_id]) {
                            delete nodeQueuesRef.current[data.node_id];
                            nodeStreamsCompleteRef.current.delete(data.node_id);
                            setStreamingNodes((prev) => {
                                const next = { ...prev };
                                delete next[data.node_id];
                                return next;
                            });
                        }

                        if (callbacksRef.current.onNodeStreamDone) {
                            callbacksRef.current.onNodeStreamDone(data.node_id, data.data, data.action);
                        }
                        break;
                    }

                    case 'ai_stream_delta':
                        chatQueueRef.current.push(...data.content.split(''));
                        if (isServerStreamDoneRef.current) isServerStreamDoneRef.current = false;
                        startChatDrain();
                        if (callbacksRef.current.onAiStreamDelta) {
                            callbacksRef.current.onAiStreamDelta(data.content);
                        }
                        break;

                    case 'ai_stream_done':
                        isServerStreamDoneRef.current = true;
                        finalAiMessageRef.current = data.message;
                        startChatDrain();
                        break;

                    case 'typing':
                        setTypingUser(data.user);
                        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                        typingTimeoutRef.current = setTimeout(() => {
                            setTypingUser(null);
                        }, 3000);
                        break;

                    case 'typing_done':
                        setTypingUser(null);
                        if (typingTimeoutRef.current) {
                            clearTimeout(typingTimeoutRef.current);
                            typingTimeoutRef.current = null;
                        }
                        break;

                    case 'kicked':
                        if (callbacksRef.current.onKicked) {
                            callbacksRef.current.onKicked();
                        }
                        setSessionCode(null);
                        sessionCodeRef.current = null;
                        setUsers([]);
                        setLockedNodes({});
                        setIsConnected(false);
                        setTypingUser(null);
                        setInputLocked(false);
                        setInputLockedBy(null);
                        setStreamingMessage('');
                        setStreamingNodes({});
                        wsRef.current = null;
                        break;

                    case 'title_update':
                        if (callbacksRef.current.onTitleUpdate && data.chat_id && data.title) {
                            callbacksRef.current.onTitleUpdate(data.chat_id, data.title);
                        }
                        break;

                    case 'member_added':
                        if (callbacksRef.current.onMemberAdded && data.chat_id) {
                            callbacksRef.current.onMemberAdded(data.chat_id);
                        }
                        break;

                    case 'new_message':
                        if (callbacksRef.current.onNewMessage) {
                            callbacksRef.current.onNewMessage(data.message);
                        }
                        break;

                    case 'ai_response':
                        if (callbacksRef.current.onAiResponse) {
                            callbacksRef.current.onAiResponse(data.message);
                        }
                        break;

                    case 'error':
                        console.error('Collaboration error:', data.message);
                        break;
                }
            } catch (e) {
                console.error('Failed to parse WS message:', e);
            }
        };
    }, [token]);

    const createSession = useCallback(async (chatId: number) => {
        const { code } = await CollaborationService.createSession(chatId);
        setSessionCode(code);
        sessionCodeRef.current = code;
        connectWs(code);
    }, [connectWs]);

    const joinSession = useCallback(async (code: string) => {
        setSessionCode(code);
        sessionCodeRef.current = code;
        connectWs(code);
    }, [connectWs]);

    const leaveSession = useCallback(() => {
        // Clean up typewriter queues
        if (chatDrainRef.current) {
            clearInterval(chatDrainRef.current);
            chatDrainRef.current = null;
        }
        chatQueueRef.current = [];
        Object.keys(nodeDrainRef.current).forEach((nodeId) => {
            clearInterval(nodeDrainRef.current[nodeId]);
        });
        nodeDrainRef.current = {};
        nodeQueuesRef.current = {};

        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setSessionCode(null);
        sessionCodeRef.current = null;
        setUsers([]);
        setLockedNodes({});
        setIsConnected(false);
        setTypingUser(null);
        setInputLocked(false);
        setInputLockedBy(null);
        setStreamingMessage('');
        setStreamingNodes({});
    }, []);

    const sendWorkflowUpdate = useCallback((workflowData: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'workflow_update', workflow_data: workflowData }));
        }
    }, []);

    const lockNode = useCallback((nodeId: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'node_lock', node_id: nodeId }));
        }
    }, []);

    const unlockNode = useCallback((nodeId: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'node_unlock', node_id: nodeId }));
        }
    }, []);

    const sendChatMessage = useCallback((content: string, selectedNodeIds?: string[]) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'chat_message',
                content,
                selected_node_ids: selectedNodeIds || [],
            }));
        }
    }, []);

    const sendTyping = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'typing' }));
        }
    }, []);

    const kickUser = useCallback((userId: number) => {
        setUsers((prev) => prev.filter((u) => u.id !== userId));
    }, []);

    useEffect(() => {
        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current);
            }
            // Clean up typewriter intervals
            if (chatDrainRef.current) {
                clearInterval(chatDrainRef.current);
            }
            Object.values(nodeDrainRef.current).forEach((id) => clearInterval(id));
        };
    }, []);

    return {
        sessionCode,
        users,
        lockedNodes,
        isConnected,
        typingUser,
        inputLocked,
        inputLockedBy,
        streamingMessage,
        streamingNodes,
        createSession,
        joinSession,
        leaveSession,
        sendWorkflowUpdate,
        lockNode,
        unlockNode,
        sendChatMessage,
        sendTyping,
        kickUser,
    };
}
