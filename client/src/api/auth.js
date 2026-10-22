import api from './index';

export const authApi = {
  // 注册
  register: (data) => api.post('/auth/register', data),

  // 登录
  login: (data) => api.post('/auth/login', data),

  // 刷新 Token
  refresh: () => api.post('/auth/refresh'),

  // 退出登录
  logout: () => api.post('/auth/logout'),

  // 获取当前用户信息
  getMe: () => api.get('/auth/me'),
};

export const userApi = {
  // 用户列表
  getList: (params) => api.get('/users', { params }),

  // 用户详情
  getById: (id) => api.get(`/users/${id}`),

  // 更新用户
  update: (id, data) => api.put(`/users/${id}`, data),

  // 修改密码
  updatePassword: (id, data) => api.put(`/users/${id}/password`, data),

  // 删除用户
  delete: (id) => api.delete(`/users/${id}`),

  // 获取用户项目关联
  getUserProjects: (id) => api.get(`/users/${id}/projects`),

  // 更新用户项目关联
  updateUserProjects: (id, data) => api.put(`/users/${id}/projects`, data),
};
