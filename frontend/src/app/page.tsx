'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { AuthForm, ChatList, ChatWindow, WorkflowVisualization } from '@/components';
import { ChatService } from '@/services/chat.service';
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

  const handleWorkflowUpdate = (data: string | null, messageId?: number) => {
    setWorkflowData(data);
    if (messageId) setCurrentMessageId(messageId);
  };

  const handlePositionChange = async (updatedWorkflow: string) => {
    if (currentMessageId) {
      try {
        await ChatService.updateWorkflowPositions(currentMessageId, updatedWorkflow);
      } catch (error) {
        console.error('Failed to save positions:', error);
      }
    }
  };

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (!isAuthenticated) {
    return <AuthForm />;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Workflow AI Assistant</h1>
        <div className={styles.userInfo}>
          <span>Welcome, {user?.username}</span>
          <button onClick={() => {
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
            onSelectChat={setSelectedChatId}
            selectedChatId={selectedChatId}
          />
        </div>

        <div className={styles.chatWindowSection}>
          <ChatWindow
            chatId={selectedChatId}
            onWorkflowUpdate={handleWorkflowUpdate}
          />
        </div>

        <div className={styles.workflowSection}>
          <WorkflowVisualization
            workflowData={workflowData}
            chatId={selectedChatId}
            onPositionChange={handlePositionChange}
          />
        </div>
      </div>
    </div>
  );
}
