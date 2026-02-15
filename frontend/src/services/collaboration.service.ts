import api from './api';

const WS_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/^http/, 'ws') || 'ws://localhost:8000';

export class CollaborationService {
    static createSession = async (chatId: number) => {
        try {
            const { data } = await api.post(`/chats/${chatId}/collaborate`);
            return data as { code: string; chat_id: number };
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while creating collaboration session');
        }
    };

    static getSessionForChat = async (chatId: number) => {
        try {
            const { data } = await api.get(`/chats/${chatId}/collaboration`);
            return data as { code: string | null; chat_id: number };
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while getting collaboration session');
        }
    };

    static removeMember = async (chatId: number, userId: number) => {
        try {
            const { data } = await api.delete(`/chats/${chatId}/members/${userId}`);
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while removing member');
        }
    };

    static getWsUrl = (code: string, token: string) => {
        return `${WS_BASE}/ws/collaborate/${code}?token=${token}`;
    };
}
