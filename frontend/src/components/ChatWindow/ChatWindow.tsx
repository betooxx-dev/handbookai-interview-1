'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { ChatService } from '@/services/chat.service';
import { Message, ChatWindowProps } from "@/types";
import styles from './styles.module.css';

interface WorkflowNode {
    id: string;
    label: string;
    type: string;
}

function parseNodes(workflowData: string | null | undefined): WorkflowNode[] {
    if (!workflowData) return [];
    try {
        const wf = JSON.parse(workflowData);
        return (wf.nodes || []).map((n: any) => ({
            id: n.id,
            label: n.label || 'Node',
            type: n.type || 'process',
        }));
    } catch {
        return [];
    }
}

export default function ChatWindow({
    chatId,
    onWorkflowUpdate,
    onTitleUpdate,
    isCollaborating = false,
    onSendCollabMessage,
    remoteMessages,
    typingUser,
    onTyping,
    inputLocked = false,
    inputLockedBy,
    streamingMessage,
    workflowData,
}: ChatWindowProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
    const [selectorOpen, setSelectorOpen] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const typingDebounceRef = useRef<NodeJS.Timeout | null>(null);

    const isInputBlocked = inputLocked || !!typingUser;
    const isStreaming = !!streamingMessage;
    const prevStreamingRef = useRef(false);

    const availableNodes = useMemo(() => parseNodes(workflowData), [workflowData]);
    const hasWorkflow = availableNodes.length > 0;
    const allSelected = hasWorkflow && selectedNodeIds.length === availableNodes.length;

    useEffect(() => {
        if (chatId) {
            loadMessages();
        } else {
            setMessages([]);
            onWorkflowUpdate(null);
        }
        setSelectedNodeIds([]);
        setSelectorOpen(false);
    }, [chatId]);

    useEffect(() => {
        if (remoteMessages && remoteMessages.length > 0) {
            setMessages((prev) => {
                const existingIds = new Set(prev.map((m) => m.id));
                const newMsgs = remoteMessages.filter((m) => !existingIds.has(m.id));
                if (newMsgs.length === 0) return prev;
                return [...prev, ...newMsgs];
            });
        }
    }, [remoteMessages]);

    useEffect(() => {
        scrollToBottom();
    }, [messages, streamingMessage]);

    useEffect(() => {
        const wasStreaming = prevStreamingRef.current;
        prevStreamingRef.current = isStreaming;
        if (wasStreaming && !isStreaming && chatId) {
            loadMessages();
        }
    }, [isStreaming, chatId]);

    useEffect(() => {
        setSelectedNodeIds((prev) => {
            const validIds = new Set(availableNodes.map((n) => n.id));
            const filtered = prev.filter((id) => validIds.has(id));
            return filtered.length !== prev.length ? filtered : prev;
        });
    }, [availableNodes]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const loadMessages = async () => {
        if (!chatId) return;
        try {
            const chat = await ChatService.getChat(chatId);
            setMessages(chat.messages);
            const lastWorkflow = [...chat.messages]
                .reverse()
                .find((msg) => msg.role === 'assistant' && msg.workflow_data);
            onWorkflowUpdate(lastWorkflow?.workflow_data || null, lastWorkflow?.id);
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (isCollaborating && onTyping && e.target.value.trim()) {
            if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
            typingDebounceRef.current = setTimeout(() => {
                onTyping();
            }, 300);
        }
    };

    const toggleNode = (nodeId: string) => {
        setSelectedNodeIds((prev) =>
            prev.includes(nodeId)
                ? prev.filter((id) => id !== nodeId)
                : [...prev, nodeId]
        );
    };

    const toggleAll = () => {
        if (allSelected) {
            setSelectedNodeIds([]);
        } else {
            setSelectedNodeIds(availableNodes.map((n) => n.id));
        }
    };

    const noNodesSelected = isCollaborating && hasWorkflow && selectedNodeIds.length === 0;

    const handleSend = async () => {
        if (!input.trim() || !chatId || loading || isInputBlocked) return;

        const userMessage = input;
        setInput('');

        if (isCollaborating && onSendCollabMessage) {
            const tempUserMessage: Message = {
                id: Date.now(),
                chat_id: chatId,
                role: 'user',
                content: userMessage,
                created_at: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, tempUserMessage]);
            onSendCollabMessage(userMessage, selectedNodeIds.length > 0 ? selectedNodeIds : undefined);
            setSelectedNodeIds([]);
            setSelectorOpen(false);
            return;
        }

        setLoading(true);

        const tempUserMessage: Message = {
            id: Date.now(),
            chat_id: chatId,
            role: 'user',
            content: userMessage,
            created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, tempUserMessage]);

        try {
            const response = await ChatService.sendMessage(
                chatId,
                userMessage,
                selectedNodeIds.length > 0 ? selectedNodeIds : undefined,
            );
            await loadMessages();

            if (response.workflow_data)
                onWorkflowUpdate(response.workflow_data, response.id);

            if (response.chat_title && onTitleUpdate)
                onTitleUpdate(chatId, response.chat_title);

        } catch (error) {
            console.error('Failed to send message:', error);
            setMessages((prev) => prev.filter((msg) => msg.id !== tempUserMessage.id));
        } finally {
            setLoading(false);
            setSelectedNodeIds([]);
            setSelectorOpen(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleUndo = async () => {
        if (!chatId || loading) return;

        setLoading(true);
        try {
            const result = await ChatService.undoWorkflow(chatId);
            await loadMessages();

            if (result.workflow_data) {
                onWorkflowUpdate(result.workflow_data);
            } else {
                onWorkflowUpdate(null);
            }
        } catch (error) {
            console.error('Failed to undo:', error);
            alert('Could not undo. There may be no previous messages.');
        } finally {
            setLoading(false);
        }
    };

    const getInputPlaceholder = (): string => {
        if (inputLocked && inputLockedBy) {
            return `${inputLockedBy.username} is waiting for AI response...`;
        }
        if (isInputBlocked && typingUser) {
            return `${typingUser.username} is typing...`;
        }
        if (hasWorkflow && selectedNodeIds.length === 0) {
            return "Please select at least one node (or 'All') to send a message...";
        }
        if (selectedNodeIds.length > 0) {
            return `${selectedNodeIds.length} node(s) selected — describe what to change...`;
        }
        return "Describe the workflow you need...";
    };

    if (!chatId) {
        return (
            <div className={styles.container}>
                <div className={styles.emptyState}>
                    <h3>Welcome to Workflow AI Assistant</h3>
                    <p>Select a conversation or create a new one to get started</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.messages}>
                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={`${styles.message} ${message.role === 'user' ? styles.userMessage : styles.assistantMessage
                            }`}
                    >
                        <div className={styles.messageContent}>
                            {message.content}
                        </div>
                        <div className={styles.messageTime}>
                            {new Date(message.created_at).toLocaleTimeString()}
                        </div>
                    </div>
                ))}
                {/* Streaming AI message bubble */}
                {isStreaming && (
                    <div className={`${styles.message} ${styles.assistantMessage}`}>
                        <div className={`${styles.messageContent} ${styles.streamingContent}`}>
                            {streamingMessage}
                            <span className={styles.streamCursor}>|</span>
                        </div>
                    </div>
                )}
                {/* Loading dots (non-streaming fallback) */}
                {loading && !isStreaming && (
                    <div className={`${styles.message} ${styles.assistantMessage}`}>
                        <div className={styles.messageContent}>
                            <div className={styles.typing}>
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                        </div>
                    </div>
                )}
                {/* Input locked indicator (streaming in progress) */}
                {inputLocked && !isStreaming && !loading && (
                    <div className={`${styles.message} ${styles.assistantMessage}`}>
                        <div className={styles.messageContent}>
                            <div className={styles.typing}>
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputArea}>
                {/* Node selector */}
                {hasWorkflow && !isInputBlocked && (
                    <div className={styles.nodeSelector}>
                        <button
                            type="button"
                            className={styles.nodeSelectorToggle}
                            onClick={() => setSelectorOpen((v) => !v)}
                        >
                            <span className={styles.nodeSelectorIcon}>
                                {selectedNodeIds.length > 0 ? (
                                    <>{selectedNodeIds.length} node{selectedNodeIds.length > 1 ? 's' : ''} selected</>
                                ) : (
                                    <span style={{ color: '#ff4444' }}>⚠ Select nodes required</span>
                                )}
                            </span>
                            <span className={styles.nodeSelectorArrow}>{selectorOpen ? '\u25B2' : '\u25BC'}</span>
                        </button>
                        {selectorOpen && (
                            <div className={styles.nodeSelectorDropdown}>
                                <label className={`${styles.nodeSelectorItem} ${styles.nodeSelectorAll}`}>
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={toggleAll}
                                    />
                                    <span>All nodes</span>
                                </label>
                                <div className={styles.nodeSelectorDivider} />
                                {availableNodes.map((node) => (
                                    <label key={node.id} className={styles.nodeSelectorItem}>
                                        <input
                                            type="checkbox"
                                            checked={selectedNodeIds.includes(node.id)}
                                            onChange={() => toggleNode(node.id)}
                                        />
                                        <span className={styles.nodeSelectorLabel}>
                                            <span className={`${styles.nodeTypeDot} ${styles[`dot_${node.type}`]}`} />
                                            <span className={styles.nodeIdBadge}>#{node.id}</span>
                                            {node.label}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {/* Input locked banner */}
                {inputLocked && inputLockedBy && (
                    <div className={styles.inputLockedBanner}>
                        <div className={styles.typingDots}>
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                        <span>{inputLockedBy.username} is waiting for AI response...</span>
                    </div>
                )}
                {/* Typing indicator (legacy) */}
                {typingUser && !inputLocked && (
                    <div className={styles.typingIndicator}>
                        <div className={styles.typingDots}>
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                        <span>{typingUser.username} is typing...</span>
                    </div>
                )}
                <div className={styles.inputRow}>
                    <button
                        onClick={handleUndo}
                        className={styles.undoButton}
                        disabled={loading || messages.length < 2 || isInputBlocked}
                        title="Undo last change"
                    >
                        &#8630; Undo
                    </button>
                    <textarea
                        value={input}
                        onChange={handleInputChange}
                        onKeyPress={handleKeyPress}
                        placeholder={getInputPlaceholder()}
                        className={`${styles.input} ${isInputBlocked ? styles.inputBlocked : ''}`}
                        rows={3}
                        disabled={loading || isInputBlocked || (hasWorkflow && selectedNodeIds.length === 0)}
                    />
                    <button
                        onClick={handleSend}
                        className={styles.sendButton}
                        disabled={loading || !input.trim() || isInputBlocked || (hasWorkflow && selectedNodeIds.length === 0)}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
