import axios from 'axios';
import { useAuthStore } from '@/store/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const api = axios.create({
    baseURL: API_URL,
});

api.interceptors.request.use((config: any) => {
    const token = useAuthStore.getState().token;
    if (token) config.headers["Authorization"] = `Bearer ${token}`;
    return config;
});

export default api;
