'use client';

import { useState } from 'react';
import styles from './styles.module.css';
import { CollaborationPanelProps } from "@/types";
import { CollaborationService } from '@/services/collaboration.service';

export default function CollaborationPanel({
    chatId,
    chatRole,
    sessionCode,
    users,
    isConnected,
    onCreateSession,
    onLeaveSession,
    onKickUser,
}: CollaborationPanelProps) {
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    const isOwner = chatRole === 'owner';

    const handleCreate = async () => {
        if (!chatId) return;
        setLoading(true);
        try {
            await onCreateSession(chatId);
        } catch (error) {
            console.error('Failed to create session:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleCopyCode = async () => {
        if (!sessionCode) return;
        await navigator.clipboard.writeText(sessionCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleKickUser = async (userId: number) => {
        if (!chatId || !isOwner) return;
        if (!confirm('Remove this user from the chat?')) return;

        try {
            await CollaborationService.removeMember(chatId, userId);
            if (onKickUser) onKickUser(userId);
        } catch (error) {
            console.error('Failed to kick user:', error);
        }
    };

    if (!chatId) return null;

    if (isConnected && sessionCode) {
        return (
            <div className={styles.panel}>
                <div className={styles.sessionInfo}>
                    <div className={styles.codeSection}>
                        <span className={styles.label}>Session:</span>
                        <button className={styles.codeButton} onClick={handleCopyCode} title="Click to copy">
                            {sessionCode}
                            <span className={styles.copyIcon}>{copied ? '✓' : '📋'}</span>
                        </button>
                    </div>
                    <div className={styles.usersSection}>
                        {users.map((user) => (
                            <span key={user.id} className={styles.userBadge}>
                                {user.username}
                                {isOwner && onKickUser && (
                                    <button
                                        className={styles.kickButton}
                                        onClick={() => handleKickUser(user.id)}
                                        title="Remove user"
                                    >
                                        ×
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                </div>
                <button className={styles.leaveButton} onClick={onLeaveSession}>
                    Leave
                </button>
            </div>
        );
    }

    return (
        <div className={styles.panel}>
            <button
                className={styles.createButton}
                onClick={handleCreate}
                disabled={loading}
            >
                {loading ? '...' : '🤝 Collaborate'}
            </button>
        </div>
    );
}
