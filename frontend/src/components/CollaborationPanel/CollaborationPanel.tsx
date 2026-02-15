'use client';

import { useState } from 'react';
import styles from './styles.module.css';
import { CollaborationPanelProps } from "@/types";

export default function CollaborationPanel({
    chatId,
    sessionCode,
    users,
    isConnected,
    onCreateSession,
    onJoinSession,
    onLeaveSession,
}: CollaborationPanelProps) {
    const [joinCode, setJoinCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

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

    const handleJoin = async () => {
        if (!joinCode.trim()) return;
        setLoading(true);
        try {
            await onJoinSession(joinCode.trim().toUpperCase());
            setJoinCode('');
        } catch (error) {
            console.error('Failed to join session:', error);
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
            <div className={styles.divider} />
            <div className={styles.joinSection}>
                <input
                    type="text"
                    className={styles.joinInput}
                    placeholder="Enter code"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <button
                    className={styles.joinButton}
                    onClick={handleJoin}
                    disabled={loading || joinCode.length < 6}
                >
                    Join
                </button>
            </div>
        </div>
    );
}
