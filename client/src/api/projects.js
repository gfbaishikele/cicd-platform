import api from './index';

export const gitlabApi = {
  // 获取连接列表
  getConnections: (params) => api.get('/gitlab/connections', { params }),

  // 添加连接
  createConnection: (data) => api.post('/gitlab/connections', data),

  // 测试连接
  testConnection: (id) => api.get(`/gitlab/connections/${id}/test`),

  // 更新连接
  updateConnection: (id, data) => api.put(`/gitlab/connections/${id}`, data),

  // 删除连接
  deleteConnection: (id) => api.delete(`/gitlab/connections/${id}`),

  // 获取 GitLab 项目列表
  getGitLabProjects: (connectionId, params) =>
    api.get(`/gitlab/connections/${connectionId}/projects`, { params }),

  // 获取分支列表
  getBranches: (connectionId, projectId) =>
    api.get(`/gitlab/connections/${connectionId}/projects/${encodeURIComponent(projectId)}/branches`),
};

export const businessProjectsApi = {
  // 项目管理列表
  getList: (params) => api.get('/business-projects', { params }),

  // 项目管理详情（含模块列表）
  getById: (id) => api.get(`/business-projects/${id}`),

  // 创建项目管理
  create: (data) => api.post('/business-projects', data),

  // 更新项目管理
  update: (id, data) => api.put(`/business-projects/${id}`, data),

  // 删除项目管理
  delete: (id) => api.delete(`/business-projects/${id}`),
};

export const projectApi = {
  // 项目列表
  getList: (params) => api.get('/projects', { params }),

  // 项目详情
  getById: (id) => api.get(`/projects/${id}`),

  // 创建项目
  create: (data) => api.post('/projects', data),

  // 更新项目
  update: (id, data) => api.put(`/projects/${id}`, data),

  // 删除项目
  delete: (id) => api.delete(`/projects/${id}`),

  // 添加成员
  addMember: (id, data) => api.post(`/projects/${id}/members`, data),

  // 更新成员
  updateMember: (id, userId, data) => api.put(`/projects/${id}/members/${userId}`, data),

  // 移除成员
  removeMember: (id, userId) => api.delete(`/projects/${id}/members/${userId}`),

  // 触发构建
  build: (id, data) => api.post(`/projects/${id}/build`, data),

  // 触发部署
  deploy: (id, data) => api.post(`/projects/${id}/deploy`, data),

  // 一键构建部署
  buildAndDeploy: (id, data) => api.post(`/projects/${id}/build-and-deploy`, data),
};

// 别名，兼容新页面引用
export const projectsApi = projectApi;
