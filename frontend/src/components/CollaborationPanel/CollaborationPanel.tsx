'use client';

import { useState, useEffect } from 'react';
import styles from './styles.module.css';
import { CollaborationPanelProps } from "@/types";
import { CollaborationService } from '@/services/collaboration.service';
import { useAuthStore } from '@/store/auth.store';

interface ChatMember {
    id: number;
    username: string;
    role: string;
}

export default function CollaborationPanel({
    chatId,
    chatRole,
    sessionCode,
    users,
    isConnected,
    onCreateSession,
    onLeaveSession,
    onKickUser,
    refreshMembersKey,
}: CollaborationPanelProps) {
    const currentUser = useAuthStore((state) => state.user);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [members, setMembers] = useState<ChatMember[]>([]);

    const isOwner = chatRole === 'owner';

    useEffect(() => {
        if (chatId) {
            loadMembers();
        } else {
            setMembers([]);
        }
    }, [chatId, refreshMembersKey, users.length]);

    const loadMembers = async () => {
        if (!chatId) return;
        try {
            const data = await CollaborationService.getMembers(chatId);
            setMembers(data);
        } catch (error) {
            console.error('Failed to load members:', error);
        }
    };

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
            setMembers((prev) => prev.filter((m) => m.id !== userId));
        } catch (error) {
            console.error('Failed to kick user:', error);
        }
    };

    if (!chatId) return null;

    const collaborators = members.filter(
        (m) => m.role === 'collaborator' && m.id !== currentUser?.id
    );

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
                        {members.map((member) => (
                            <span key={member.id} className={styles.userBadge}>
                                {member.username}
                                {isOwner && member.id !== currentUser?.id && (
                                    <button
                                        className={styles.kickButton}
                                        onClick={() => handleKickUser(member.id)}
                                        title="Remove user"
                                    >
                                        ×
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                </div>
                {!isOwner && (
                    <button className={styles.leaveButton} onClick={onLeaveSession}>
                        Leave
                    </button>
                )}
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
            {isOwner && collaborators.length > 0 && (
                <div className={styles.usersSection}>
                    {collaborators.map((member) => (
                        <span key={member.id} className={styles.userBadge}>
                            {member.username}
                            <button
                                className={styles.kickButton}
                                onClick={() => handleKickUser(member.id)}
                                title="Remove user"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
