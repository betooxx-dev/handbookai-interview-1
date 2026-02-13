import { create } from 'zustand';
import { authApi } from '@/services/auth.service';
import { AuthState } from '@/types';

export const useAuthStore = create<AuthState>((set) => ({
    user: null,
    token: null,
    isLoading: true,
    login: async (username: string, password: string) => {
        const data = await authApi.login(username, password);
        localStorage.setItem('token', data.access_token);
        const user = await authApi.getMe();
        set({ user, token: data.access_token });
    },
    register: async (username: string, email: string, password: string) => {
        await authApi.register(username, email, password);
        // Auto-login after registration
        const data = await authApi.login(username, password);
        localStorage.setItem('token', data.access_token);
        const user = await authApi.getMe();
        set({ user, token: data.access_token });
    },
    logout: () => {
        localStorage.removeItem('token');
        set({ user: null, token: null });
    },
    checkAuth: async () => {
        const token = localStorage.getItem('token');
        if (token) {
            try {
                const user = await authApi.getMe();
                set({ user, token, isLoading: false });
            } catch (error) {
                localStorage.removeItem('token');
                set({ user: null, token: null, isLoading: false });
            }
        } else {
            set({ isLoading: false });
        }
    },
}));
