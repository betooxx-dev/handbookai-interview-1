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
    role: 'user' | 'assistant';
    content: string;
    workflow_data?: string;
    created_at: string;
}

export interface ChatWithMessages extends Chat {
    messages: Message[];
}

export interface AuthState {
    user: User | null;
    token: string | null;
    isLoading: boolean;
    login: (username: string, password: string) => Promise<void>;
    register: (username: string, email: string, password: string) => Promise<void>;
    logout: () => void;
    checkAuth: () => Promise<void>;
}
