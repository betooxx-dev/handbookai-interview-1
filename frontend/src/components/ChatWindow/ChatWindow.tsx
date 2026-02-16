'use client';

import { useState, useEffect, useRef } from 'react';
import { ChatService } from '@/services/chat.service';
import { Message, ChatWindowProps } from "@/types";
import styles from './styles.module.css';

export default function ChatWindow({
    chatId,
    onWorkflowUpdate,
    onTitleUpdate,
    isCollaborating = false,
    onSendCollabMessage,
    remoteMessages,
    typingUser,
    onTyping,
}: ChatWindowProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const typingDebounceRef = useRef<NodeJS.Timeout | null>(null);

    const isInputBlocked = !!typingUser;

    useEffect(() => {
        if (chatId) {
            loadMessages();
        } else {
            setMessages([]);
            onWorkflowUpdate(null);
        }
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
    }, [messages]);

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
            onSendCollabMessage(userMessage);
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
            const response = await ChatService.sendMessage(chatId, userMessage);
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
                {loading && (
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
                {typingUser && (
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
                        ↶ Undo
                    </button>
                    <textarea
                        value={input}
                        onChange={handleInputChange}
                        onKeyPress={handleKeyPress}
                        placeholder={isInputBlocked ? `${typingUser?.username} is typing...` : "Describe the workflow you need..."}
                        className={`${styles.input} ${isInputBlocked ? styles.inputBlocked : ''}`}
                        rows={3}
                        disabled={loading || isInputBlocked}
                    />
                    <button
                        onClick={handleSend}
                        className={styles.sendButton}
                        disabled={loading || !input.trim() || isInputBlocked}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
