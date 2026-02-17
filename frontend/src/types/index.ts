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
    role?: "owner" | "collaborator";
}

export interface Message {
    id: number;
    chat_id: number;
    user_id?: number;
    role: 'user' | 'assistant';
    content: string;
    workflow_data?: string;
    chat_title?: string;
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
    role: "owner" | "collaborator" | null;
}

export interface CollaborationPanelProps {
    chatId: number | null;
    chatRole?: "owner" | "collaborator" | null;
    sessionCode: string | null;
    users: CollabUser[];
    isConnected: boolean;
    onCreateSession: (chatId: number) => Promise<void>;
    onJoinSession: (code: string) => Promise<void>;
    onLeaveSession: () => void;
    onKickUser?: (userId: number) => void;
    refreshMembersKey?: number;
}

export interface LockedNode {
    userId: number;
    username: string;
}

export interface UseCollaborationReturn {
    sessionCode: string | null;
    users: CollabUser[];
    lockedNodes: Record<string, LockedNode>;
    isConnected: boolean;
    typingUser: CollabUser | null;
    inputLocked: boolean;
    inputLockedBy: { id: number; username: string } | null;
    streamingMessage: string;
    streamingNodes: Record<string, string>;
    createSession: (chatId: number) => Promise<void>;
    joinSession: (code: string) => Promise<void>;
    leaveSession: () => void;
    sendWorkflowUpdate: (workflowData: string) => void;
    lockNode: (nodeId: string) => void;
    unlockNode: (nodeId: string) => void;
    sendChatMessage: (content: string, selectedNodeIds?: string[]) => void;
    sendTyping: () => void;
    kickUser: (userId: number) => void;
}

export interface CollaborationCallbacks {
    onRemoteWorkflowUpdate?: (workflowData: string, fromUser: CollabUser) => void;
    onNewMessage?: (message: any) => void;
    onAiResponse?: (message: any) => void;
    onKicked?: () => void;
    onConnectedToChat?: (chatId: number) => void;
    onTitleUpdate?: (chatId: number, title: string) => void;
    onMemberAdded?: (chatId: number) => void;
    onInputLocked?: (user: { id: number; username: string }) => void;
    onInputUnlocked?: () => void;
    onNodesLocked?: (nodeIds: string[], user: { id: number; username: string }) => void;
    onNodesUnlocked?: (nodeIds: string[]) => void;
    onNodeStreamStart?: (nodeId: string, nodeType?: string) => void;
    onNodeStreamDelta?: (nodeId: string, content: string) => void;
    onNodeStreamDone?: (nodeId: string, data: any, action?: string) => void;
    onAiStreamDelta?: (content: string) => void;
    onAiStreamDone?: (message: any) => void;
}

export interface ChatListProps {
    onSelectChat: (chatId: number | null) => void;
    selectedChatId: number | null;
    refreshKey?: number;
    onJoinWithCode?: (code: string) => void;
}

export interface ChatWindowProps {
    chatId: number | null;
    onWorkflowUpdate: (workflowData: string | null, messageId?: number) => void;
    onTitleUpdate?: (chatId: number, title: string) => void;
    isCollaborating?: boolean;
    onSendCollabMessage?: (content: string, selectedNodeIds?: string[]) => void;
    remoteMessages?: Message[];
    typingUser?: CollabUser | null;
    onTyping?: () => void;
    inputLocked?: boolean;
    inputLockedBy?: { id: number; username: string } | null;
    streamingMessage?: string;
    workflowData?: string | null;
}

export interface WorkflowVisualizationProps {
    workflowData: string | null;
    chatId: number | null;
    onPositionChange?: (workflowData: string) => void;
    lockedNodes?: Record<string, LockedNode>;
    onNodeDragStart?: (nodeId: string) => void;
    onNodeDragStop?: (nodeId: string) => void;
    isRemoteUpdate?: boolean;
    streamingNodes?: Record<string, string>;
}