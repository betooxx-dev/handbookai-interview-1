import api from './api';
import { Chat, ChatWithMessages, Message } from '@/types';

export class ChatService {
    static getChats = async () => {
        try {
            const { data } = await api.get<Chat[]>('/chats');
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to get chats');
        }
    };

    static createChat = async (title: string) => {
        try {
            const { data } = await api.post<Chat>('/chats', { title });
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to create chat');
        }
    };

    static getChat = async (chatId: number) => {
        try {
            const { data } = await api.get<ChatWithMessages>(`/chats/${chatId}`);
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to get chat');
        }
    };

    static deleteChat = async (chatId: number) => {
        try {
            const { data } = await api.delete(`/chats/${chatId}`);
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to delete chat');
        }
    };

    static sendMessage = async (chatId: number, content: string) => {
        try {
            const { data } = await api.post<Message>(`/chats/${chatId}/messages`, { content });
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to send message');
        }
    };

    static updateWorkflowPositions = async (messageId: number, workflowData: string) => {
        try {
            const { data } = await api.patch(`/messages/${messageId}/workflow`, { workflow_data: workflowData });
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to update workflow positions');
        }
    };

    static undoWorkflow = async (chatId: number) => {
        try {
            const { data } = await api.post(`/chats/${chatId}/workflows/undo`);
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to undo workflow');
        }
    };

    static getWorkflowHistory = async (chatId: number) => {
        try {
            const { data } = await api.get(`/chats/${chatId}/workflows/history`);
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to get workflow history');
        }
    };
}
