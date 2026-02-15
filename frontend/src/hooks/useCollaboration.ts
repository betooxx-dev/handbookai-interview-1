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

    const wsRef = useRef<WebSocket | null>(null);
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionCodeRef = useRef<string | null>(null);

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
                            callbacksRef.current.onRemoteWorkflowUpdate(data.workflow_data, { id: 0, username: 'session' });
                        }
                        // Notify which chat we connected to
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

    const sendChatMessage = useCallback((content: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'chat_message', content }));
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
        };
    }, []);

    return {
        sessionCode,
        users,
        lockedNodes,
        isConnected,
        typingUser,
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
