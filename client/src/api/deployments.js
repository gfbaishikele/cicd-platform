import api from './index';

export const deploymentApi = {
  create: (data) => api.post('/deployments', data),
  getList: (params) => api.get('/deployments', { params }),
  getById: (id) => api.get(`/deployments/${id}`),
  rollback: (id, targetBuildId) => api.post(`/deployments/${id}/rollback`, { target_build_id: targetBuildId }),
  retry: (id) => api.post(`/deployments/${id}/retry`),
  cancel: (id) => api.post(`/deployments/${id}/cancel`),
  getLog: (id) => api.get(`/deployments/${id}/log`),
  delete: (id) => api.delete(`/deployments/${id}`),
  clearAll: () => api.delete('/deployments/all'),
};
