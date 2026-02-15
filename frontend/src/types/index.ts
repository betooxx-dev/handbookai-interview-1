export interface User {
    id: number;
    username: string;
    email: string;
    created_at: string;
}

export interface Chat {
    id: number;
    title: string;
    created_at: string;
    updated_at: string;
}

export interface Message {
    id: number;
    chat_id: number;
    user_id?: number;
    role: 'user' | 'assistant';
    content: string;
    workflow_data?: string;
    created_at: string;
}

export interface ChatWithMessages extends Chat {
    messages: Message[];
}

export interface AuthState {
    isAuthenticated: boolean;
    user?: User;
    token?: string;
    errors: string[];

    login: (username: string, password: string) => Promise<void>;
    register: (username: string, email: string, password: string) => Promise<void>;
    logout: () => void;
    checkAuth: () => Promise<void>;
}

export interface CollabUser {
    id: number;
    username: string;
}

export interface CollaborationPanelProps {
    chatId: number | null;
    sessionCode: string | null;
    users: CollabUser[];
    isConnected: boolean;
    onCreateSession: (chatId: number) => Promise<void>;
    onJoinSession: (code: string) => Promise<void>;
    onLeaveSession: () => void;
}

export interface LockedNode {
    userId: number;
    username: string;
}

export interface WorkflowVisualizationProps {
    workflowData: string | null;
    chatId: number | null;
    onPositionChange?: (workflowData: string) => void;
    lockedNodes?: Record<string, LockedNode>;
    onNodeDragStart?: (nodeId: string) => void;
    onNodeDragStop?: (nodeId: string) => void;
    isRemoteUpdate?: boolean;
}

export interface UseCollaborationReturn {
    sessionCode: string | null;
    users: CollabUser[];
    lockedNodes: Record<string, LockedNode>;
    isConnected: boolean;
    createSession: (chatId: number) => Promise<void>;
    joinSession: (code: string) => Promise<void>;
    leaveSession: () => void;
    sendWorkflowUpdate: (workflowData: string) => void;
    lockNode: (nodeId: string) => void;
    unlockNode: (nodeId: string) => void;
    sendChatMessage: (content: string) => void;
}

export interface CollaborationCallbacks {
    onRemoteWorkflowUpdate?: (workflowData: string, fromUser: CollabUser) => void;
    onNewMessage?: (message: any) => void;
    onAiResponse?: (message: any) => void;
}