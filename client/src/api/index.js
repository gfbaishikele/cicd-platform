import axios from 'axios';
import { store } from '../store';
import { logout, setCredentials } from '../store/authSlice';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
});

// 请求拦截器：添加 Access Token
api.interceptors.request.use(
  (config) => {
    const token = store.getState().auth.accessToken;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 是否正在刷新 Token
let isRefreshing = false;
let refreshSubscribers = [];

// 添加刷新订阅者
function subscribeTokenRefresh(cb) {
  refreshSubscribers.push(cb);
}

// 通知所有订阅者
function onRefreshed(newToken) {
  refreshSubscribers.forEach((cb) => cb(newToken));
  refreshSubscribers = [];
}

// 响应拦截器：处理 Token 过期自动刷新
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Token 过期
    if (error.response?.status === 401 && error.response?.data?.code === 40101 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((newToken) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            resolve(api(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // 使用 refreshToken 获取新的 accessToken
        const response = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        const newToken = response.data.data.accessToken;

        store.dispatch(setCredentials({
          user: store.getState().auth.user,
          accessToken: newToken,
        }));

        isRefreshing = false;
        onRefreshed(newToken);

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        isRefreshing = false;
        refreshSubscribers = [];
        store.dispatch(logout());
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // 未登录
    if (error.response?.status === 401 && error.response?.data?.code === 40103) {
      store.dispatch(logout());
      window.location.href = '/login';
    }

    return Promise.reject(error);
  }
);

export default api;
