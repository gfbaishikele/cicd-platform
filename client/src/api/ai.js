import api from './index';

export const aiApi = {
  // AI 对话
  chat: (data) => api.post('/ai/chat', data),

  // 获取对话历史
  getConversations: (sessionId) => api.get('/ai/conversations', { params: { session_id: sessionId } }),

  // 获取 AI 配置列表
  getConfig: (params) => api.get('/ai/config', { params }),

  // 新增 AI 配置
  createConfig: (data) => api.post('/ai/config', data),

  // 更新 AI 配置
  updateConfig: (id, data) => api.put(`/ai/config/${id}`, data),

  // 删除 AI 配置
  deleteConfig: (id) => api.delete(`/ai/config/${id}`),

  // 启用/停用 AI 配置
  toggleConfig: (id, enabled) => api.patch(`/ai/config/${id}/toggle`, { enabled }),

  // 测试 AI 连接
  test: (data) => api.post('/ai/test', data),
};
