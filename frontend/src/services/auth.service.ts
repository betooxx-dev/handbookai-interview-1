import api from './api';
import { User } from '@/types';

export class AuthService {
    static login = async (username: string, password: string) => {
        try {
            const { data } = await api.post('/auth/login', { username, password });
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to login');
        }
    };

    static register = async (username: string, email: string, password: string) => {
        try {
            const { data } = await api.post('/auth/register', { username, email, password });
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to register');
        }
    };

    static getMe = async () => {
        try {
            const { data } = await api.get<User>('/auth/me');
            return data;
        } catch (error) {
            console.log(error);
            throw new Error('An error occurred while trying to get user info');
        }
    };
}
