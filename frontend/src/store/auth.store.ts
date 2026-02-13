import { StateCreator, create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { AuthService } from '@/services/auth.service';
import { AuthState } from '@/types';

const storeApi: StateCreator<AuthState> = (set) => ({
    isAuthenticated: false,
    token: undefined,
    user: undefined,
    errors: [],

    login: async (username: string, password: string) => {
        try {
            const data = await AuthService.login(username, password);
            const user = await AuthService.getMe();
            set(() => ({
                isAuthenticated: true,
                token: data.access_token,
                user,
                errors: [],
            }));
        } catch (error: any) {
            set(() => ({
                errors: [error.response?.data?.detail || 'An error occurred while trying to login'],
            }));
            throw error;
        }
    },

    register: async (username: string, email: string, password: string) => {
        try {
            await AuthService.register(username, email, password);
            const data = await AuthService.login(username, password);
            const user = await AuthService.getMe();
            set(() => ({
                isAuthenticated: true,
                token: data.access_token,
                user,
                errors: [],
            }));
        } catch (error: any) {
            set(() => ({
                errors: [error.response?.data?.detail || 'An error occurred while trying to register'],
            }));
            throw error;
        }
    },

    logout: () => {
        set(() => ({
            isAuthenticated: false,
            token: undefined,
            user: undefined,
            errors: [],
        }));
    },

    checkAuth: async () => {
        const state = useAuthStore.getState();
        if (state.token) {
            try {
                const user = await AuthService.getMe();
                set(() => ({ isAuthenticated: true, user }));
            } catch {
                set(() => ({
                    isAuthenticated: false,
                    token: undefined,
                    user: undefined,
                }));
            }
        }
    },
});

export const useAuthStore = create<AuthState>()(
    devtools(persist(storeApi, { name: 'auth' }))
);
