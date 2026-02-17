'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuthStore } from '@/store/auth.store';
import { AuthForm, ChatList, ChatWindow, WorkflowVisualization, CollaborationPanel } from '@/components';
import { ChatService } from '@/services/chat.service';
import { CollaborationService } from '@/services/collaboration.service';
import { useCollaboration } from '@/hooks/useCollaboration';
import { Chat, Message } from '@/types';
import '../styles/globals.css';
import styles from './page.module.css';

export default function Home() {
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [selectedChatRole, setSelectedChatRole] = useState<"owner" | "collaborator" | null>(null);
  const [workflowData, setWorkflowData] = useState<string | null>(null);
  const [currentMessageId, setCurrentMessageId] = useState<number | null>(null);
  const [isRemoteUpdate, setIsRemoteUpdate] = useState(false);
  const [remoteMessages, setRemoteMessages] = useState<Message[]>([]);
  const [hasMounted, setHasMounted] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [refreshChatsKey, setRefreshChatsKey] = useState(0);
  const [refreshMembersKey, setRefreshMembersKey] = useState(0);

  const workflowDataRef = useRef(workflowData);
  workflowDataRef.current = workflowData;

  const handleWorkflowUpdate = (data: string | null, messageId?: number) => {
    setWorkflowData(data);
    if (messageId) setCurrentMessageId(messageId);
  };

  const handleTitleUpdate = useCallback((chatId: number, title: string) => {
    setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, title } : c));
    setRefreshChatsKey((k) => k + 1);
  }, []);

  const collaboration = useCollaboration({
    onRemoteWorkflowUpdate: (data, fromUser) => {
      setIsRemoteUpdate(true);
      setWorkflowData(data);
      setTimeout(() => setIsRemoteUpdate(false), 100);
    },
    onNewMessage: (message) => {
      setRemoteMessages((prev) => [...prev, {
        id: message.id,
        chat_id: message.chat_id,
        user_id: message.user_id,
        role: message.role,
        content: message.content,
        created_at: message.created_at || new Date().toISOString(),
      }]);
    },
    onAiResponse: (message) => {
      setRemoteMessages((prev) => [...prev, {
        id: message.id,
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        workflow_data: message.workflow_data,
        created_at: message.created_at || new Date().toISOString(),
      }]);
      if (message.workflow_data) {
        setIsRemoteUpdate(true);
        setWorkflowData(message.workflow_data);
        setTimeout(() => setIsRemoteUpdate(false), 100);
      }
    },
    onKicked: () => {
      setSelectedChatId(null);
      setSelectedChatRole(null);
      setWorkflowData(null);
      setRemoteMessages([]);
      reloadAllChats();
    },
    onConnectedToChat: async (chatId) => {
      if (chatId !== selectedChatId) {
        const freshChats = await reloadAllChats();
        const chat = freshChats.find((c: Chat) => c.id === chatId);
        setSelectedChatRole((chat?.role as "owner" | "collaborator") || 'collaborator');
        setSelectedChatId(chatId);
      }
    },
    onTitleUpdate: handleTitleUpdate,
    onMemberAdded: () => {
      setRefreshMembersKey((k) => k + 1);
    },
    onNodeStreamStart: (nodeId, nodeType) => {
      setWorkflowData((prev) => {
        if (!prev) return prev;
        try {
          const workflow = JSON.parse(prev);
          const exists = workflow.nodes.some((n: any) => n.id === nodeId);
          if (!exists) {
            workflow.nodes.push({
              id: nodeId,
              label: '...',
              type: nodeType || 'process',
            });
            return JSON.stringify(workflow);
          }
        } catch {
        }
        return prev;
      });
    },
    onNodeStreamDone: (nodeId, nodeData, action) => {
      setWorkflowData((prev) => {
        if (!prev) return prev;
        try {
          const workflow = JSON.parse(prev);

          if (action === 'delete') {
            const sources = workflow.edges
              .filter((e: any) => e.to === nodeId)
              .map((e: any) => e.from);
            const targets = workflow.edges
              .filter((e: any) => e.from === nodeId)
              .map((e: any) => e.to);

            workflow.nodes = workflow.nodes.filter((n: any) => n.id !== nodeId);
            workflow.edges = workflow.edges.filter(
              (e: any) => e.from !== nodeId && e.to !== nodeId
            );
            const existingEdges = new Set(
              workflow.edges.map((e: any) => `${e.from}->${e.to}`)
            );
            for (const src of sources) {
              for (const tgt of targets) {
                if (src !== tgt && !existingEdges.has(`${src}->${tgt}`)) {
                  workflow.edges.push({ from: src, to: tgt });
                }
              }
            }
            return JSON.stringify(workflow);
          }

          const nodeIndex = workflow.nodes.findIndex((n: any) => n.id === nodeId);
          if (nodeIndex >= 0) {
            if (nodeData.label) workflow.nodes[nodeIndex].label = nodeData.label;
            if (nodeData.type) workflow.nodes[nodeIndex].type = nodeData.type;
            if (nodeData.description) workflow.nodes[nodeIndex].description = nodeData.description;
          } else if (action === 'add') {
            workflow.nodes.push({
              id: nodeId,
              label: nodeData.label || 'New Node',
              type: nodeData.type || 'process',
              ...(nodeData.description ? { description: nodeData.description } : {}),
            });
          }
          return JSON.stringify(workflow);
        } catch {
        }
        return prev;
      });
      setIsRemoteUpdate(true);
      setTimeout(() => setIsRemoteUpdate(false), 100);
    },
    onAiStreamDone: (message) => {
      setRemoteMessages((prev) => [...prev, {
        id: message.id,
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        workflow_data: message.workflow_data,
        created_at: message.created_at || new Date().toISOString(),
      }]);
      if (message.workflow_data) {
        setIsRemoteUpdate(true);
        setWorkflowData(message.workflow_data);
        setTimeout(() => setIsRemoteUpdate(false), 100);
      }
    },
  });

  const reloadAllChats = async (): Promise<Chat[]> => {
    try {
      const data = await ChatService.getChats();
      setChats(data);
      setRefreshChatsKey((k) => k + 1);
      return data;
    } catch (error) {
      console.error('Failed to load chats:', error);
      return [];
    }
  };

  const handleSelectChat = useCallback(async (chatId: number | null) => {
    if (collaboration.isConnected) {
      collaboration.leaveSession();
    }

    setRemoteMessages([]);

    if (!chatId) {
      setSelectedChatId(null);
      setSelectedChatRole(null);
      return;
    }

    try {
      await ChatService.getChat(chatId);
    } catch {
      setSelectedChatId(null);
      setSelectedChatRole(null);
      await reloadAllChats();
      return;
    }

    setSelectedChatId(chatId);

    const chat = chats.find((c) => c.id === chatId);
    const role = chat?.role || 'owner';
    setSelectedChatRole(role as "owner" | "collaborator");

    try {
      const sessionInfo = await CollaborationService.getSessionForChat(chatId);
      if (sessionInfo.code) {
        collaboration.joinSession(sessionInfo.code);
      } else {
        await collaboration.createSession(chatId);
      }
    } catch (error) {
      try {
        await collaboration.createSession(chatId);
      } catch (createError) {
        console.debug('Could not create streaming session, falling back to HTTP');
      }
    }
  }, [collaboration.isConnected, collaboration.leaveSession, collaboration.joinSession, chats]);

  const handleJoinWithCode = useCallback((code: string) => {
    if (collaboration.isConnected) collaboration.leaveSession();

    collaboration.joinSession(code);
  }, [collaboration.isConnected, collaboration.leaveSession, collaboration.joinSession]);

  const handlePositionChangeWithCollab = useCallback(
    async (updatedWorkflow: string) => {
      if (collaboration.isConnected) {
        collaboration.sendWorkflowUpdate(updatedWorkflow);
      } else if (currentMessageId) {
        try {
          await ChatService.updateWorkflowPositions(
            currentMessageId,
            updatedWorkflow,
          );
        } catch (error) {
          console.error("Failed to save positions:", error);
        }
      }
    },
    [
      currentMessageId,
      collaboration.isConnected,
      collaboration.sendWorkflowUpdate,
    ],
  );

  useEffect(() => {
    setHasMounted(true);
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (isAuthenticated) {
      reloadAllChats();
    }
  }, [isAuthenticated]);

  if (!hasMounted) return null;

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
            setSelectedChatRole(null);
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
            onSelectChat={handleSelectChat}
            selectedChatId={selectedChatId}
            refreshKey={refreshChatsKey}
            onJoinWithCode={handleJoinWithCode}
          />
        </div>

        <div className={styles.chatWindowSection}>
          <ChatWindow
            chatId={selectedChatId}
            onWorkflowUpdate={handleWorkflowUpdate}
            onTitleUpdate={handleTitleUpdate}
            isCollaborating={collaboration.isConnected}
            onSendCollabMessage={collaboration.sendChatMessage}
            remoteMessages={remoteMessages}
            typingUser={collaboration.typingUser}
            onTyping={collaboration.sendTyping}
            inputLocked={collaboration.inputLocked}
            inputLockedBy={collaboration.inputLockedBy}
            streamingMessage={collaboration.streamingMessage}
            workflowData={workflowData}
          />
        </div>

        <div className={styles.workflowSection}>
          <div className={styles.workflowHeader}>
            <CollaborationPanel
              chatId={selectedChatId}
              chatRole={selectedChatRole}
              sessionCode={collaboration.sessionCode}
              users={collaboration.users}
              isConnected={collaboration.isConnected}
              onCreateSession={collaboration.createSession}
              onJoinSession={collaboration.joinSession}
              onLeaveSession={collaboration.leaveSession}
              onKickUser={collaboration.kickUser}
              refreshMembersKey={refreshMembersKey}
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
            streamingNodes={collaboration.streamingNodes}
          />
        </div>
      </div>
    </div>
  );
}
