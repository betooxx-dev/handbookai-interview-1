'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { AuthForm, ChatList, ChatWindow, WorkflowVisualization, CollaborationPanel } from '@/components';
import { ChatService } from '@/services/chat.service';
import { useCollaboration } from '@/hooks/useCollaboration';
import { Message } from '@/types';
import '../styles/globals.css';
import styles from './page.module.css';

export default function Home() {
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [workflowData, setWorkflowData] = useState<string | null>(null);
  const [currentMessageId, setCurrentMessageId] = useState<number | null>(null);
  const [isRemoteUpdate, setIsRemoteUpdate] = useState(false);
  const [remoteMessages, setRemoteMessages] = useState<Message[]>([]);
  const [hasMounted, setHasMounted] = useState(false);

  const handleWorkflowUpdate = (data: string | null, messageId?: number) => {
    setWorkflowData(data);
    if (messageId) setCurrentMessageId(messageId);
  };

  const collaboration = useCollaboration({
    onRemoteWorkflowUpdate: (data, fromUser) => {
      setIsRemoteUpdate(true);
      setWorkflowData(data);
      // Reset remote flag after React processes the update
      setTimeout(() => setIsRemoteUpdate(false), 100);
    },
    onNewMessage: (message) => {
      setRemoteMessages((prev) => [...prev, {
        id: message.id,
        chat_id: message.chat_id,
        user_id: message.user_id,
        role: message.role,
        content: message.content,
        created_at: new Date().toISOString(),
      }]);
    },
    onAiResponse: (message) => {
      setRemoteMessages((prev) => [...prev, {
        id: message.id,
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        workflow_data: message.workflow_data,
        created_at: new Date().toISOString(),
      }]);
      // Update workflow if AI generated one
      if (message.workflow_data) {
        setIsRemoteUpdate(true);
        setWorkflowData(message.workflow_data);
        setTimeout(() => setIsRemoteUpdate(false), 100);
      }
    },
  });

  // Update handlePositionChange to use latest collaboration state
  const handlePositionChangeWithCollab = useCallback(async (updatedWorkflow: string) => {
    // Broadcast to collaborators immediately (don't wait for API)
    if (collaboration.isConnected) {
      collaboration.sendWorkflowUpdate(updatedWorkflow);
    }
    // Then persist to API (async, non-blocking for collaboration)
    if (currentMessageId) {
      try {
        await ChatService.updateWorkflowPositions(currentMessageId, updatedWorkflow);
      } catch (error) {
        console.error('Failed to save positions:', error);
      }
    }
  }, [currentMessageId, collaboration.isConnected, collaboration.sendWorkflowUpdate]);

  useEffect(() => {
    setHasMounted(true);
    checkAuth();
  }, [checkAuth]);

  // Clear remote messages when changing chats
  useEffect(() => {
    setRemoteMessages([]);
  }, [selectedChatId]);

  // Prevent hydration mismatch: don't render auth-dependent UI until client has mounted
  // and Zustand has rehydrated from localStorage
  if (!hasMounted) {
    return null;
  }

  if (!isAuthenticated) return <AuthForm />;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Workflow AI Assistant</h1>
        <div className={styles.userInfo}>
          <span>Welcome, {user?.username}</span>
          <button onClick={() => {
            collaboration.leaveSession();
            setSelectedChatId(null);
            setWorkflowData(null);
            logout();
          }} className={styles.logoutButton}>
            Logout
          </button>
        </div>
      </header>

      <div className={styles.mainContent}>
        <div className={styles.chatListSection}>
          <ChatList
            onSelectChat={(chatId) => {
              if (collaboration.isConnected) collaboration.leaveSession();
              setSelectedChatId(chatId);
            }}
            selectedChatId={selectedChatId}
          />
        </div>

        <div className={styles.chatWindowSection}>
          <ChatWindow
            chatId={selectedChatId}
            onWorkflowUpdate={handleWorkflowUpdate}
            isCollaborating={collaboration.isConnected}
            onSendCollabMessage={collaboration.sendChatMessage}
            remoteMessages={remoteMessages}
          />
        </div>

        <div className={styles.workflowSection}>
          <div className={styles.workflowHeader}>
            <CollaborationPanel
              chatId={selectedChatId}
              sessionCode={collaboration.sessionCode}
              users={collaboration.users}
              isConnected={collaboration.isConnected}
              onCreateSession={collaboration.createSession}
              onJoinSession={collaboration.joinSession}
              onLeaveSession={collaboration.leaveSession}
            />
          </div>
          <WorkflowVisualization
            workflowData={workflowData}
            chatId={selectedChatId}
            onPositionChange={handlePositionChangeWithCollab}
            lockedNodes={collaboration.lockedNodes}
            onNodeDragStart={collaboration.isConnected ? collaboration.lockNode : undefined}
            onNodeDragStop={collaboration.isConnected ? collaboration.unlockNode : undefined}
            isRemoteUpdate={isRemoteUpdate}
          />
        </div>
      </div>
    </div>
  );
}
