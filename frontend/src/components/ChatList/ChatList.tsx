'use client';

import { useState, useEffect } from 'react';
import { ChatService } from '@/services/chat.service';
import { Chat } from '@/types';
import styles from './styles.module.css';

interface ChatListProps {
    onSelectChat: (chatId: number | null) => void;
    selectedChatId: number | null;
    refreshKey?: number;
    onJoinWithCode?: (code: string) => void;
}

export default function ChatList({ onSelectChat, selectedChatId, refreshKey, onJoinWithCode }: ChatListProps) {
    const [chats, setChats] = useState<Chat[]>([]);
    const [loading, setLoading] = useState(true);
    const [showJoinInput, setShowJoinInput] = useState(false);
    const [joinCode, setJoinCode] = useState('');
    const [joining, setJoining] = useState(false);

    useEffect(() => {
        loadChats();
    }, [refreshKey]);

    const loadChats = async () => {
        try {
            const data = await ChatService.getChats();
            setChats(data);
        } catch (error) {
            console.error('Failed to load chats:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleNewChat = async () => {
        try {
            const newChat = await ChatService.createChat('New Conversation');
            setChats([newChat, ...chats]);
            onSelectChat(newChat.id);
        } catch (error) {
            console.error('Failed to create chat:', error);
        }
    };

    const handleDeleteChat = async (chatId: number, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm('Delete this chat?')) return;

        try {
            await ChatService.deleteChat(chatId);
            const updatedChats = chats.filter(chat => chat.id !== chatId);
            setChats(updatedChats);

            if (selectedChatId === chatId) onSelectChat(null);

        } catch (error) {
            console.error('Failed to delete chat:', error);
        }
    };

    const handleJoin = () => {
        if (!joinCode.trim() || joinCode.length < 6 || !onJoinWithCode) return;
        setJoining(true);
        onJoinWithCode(joinCode.trim().toUpperCase());
        setJoinCode('');
        setShowJoinInput(false);
        setJoining(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h2>Conversations</h2>
                <div className={styles.headerButtons}>
                    <button onClick={handleNewChat} className={styles.iconButton} title="New conversation">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                    <button
                        onClick={() => setShowJoinInput(!showJoinInput)}
                        className={`${styles.iconButton} ${styles.collabButton} ${showJoinInput ? styles.iconButtonActive : ''}`}
                        title="Join with code"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                            <line x1="19" y1="8" x2="19" y2="14" />
                            <line x1="22" y1="11" x2="16" y2="11" />
                        </svg>
                    </button>
                </div>
            </div>

            {showJoinInput && (
                <div className={styles.joinBar}>
                    <input
                        type="text"
                        className={styles.joinInput}
                        placeholder="ABC123"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        maxLength={6}
                        onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                        autoFocus
                    />
                    <button
                        className={styles.joinButton}
                        onClick={handleJoin}
                        disabled={joining || joinCode.length < 6}
                    >
                        Join
                    </button>
                </div>
            )}

            <div className={styles.chatList}>
                {loading ? (
                    <div className={styles.loading}>Loading...</div>
                ) : chats.length === 0 ? (
                    <div className={styles.empty}>No conversations yet</div>
                ) : (
                    chats.map(chat => (
                        <div
                            key={chat.id}
                            className={`${styles.chatItem} ${selectedChatId === chat.id ? styles.active : ''} ${chat.role === 'collaborator' ? styles.shared : ''}`}
                            onClick={() => onSelectChat(chat.id)}
                        >
                            <div className={styles.chatTitleRow}>
                                <div className={styles.chatTitle}>{chat.title}</div>
                                {chat.role === 'collaborator' && (
                                    <span className={styles.sharedBadge}>Shared</span>
                                )}
                            </div>
                            {chat.role !== 'collaborator' && (
                                <button
                                    onClick={(e) => handleDeleteChat(chat.id, e)}
                                    className={styles.deleteButton}
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
