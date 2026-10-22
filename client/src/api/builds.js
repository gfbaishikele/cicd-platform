import api from './index';

export const templateApi = {
  getList: (params) => api.get('/templates', { params }),
  getSystem: () => api.get('/templates/system'),
  getById: (id) => api.get(`/templates/${id}`),
  create: (data) => api.post('/templates', data),
  update: (id, data) => api.put(`/templates/${id}`, data),
  delete: (id) => api.delete(`/templates/${id}`),
  preview: (id, variables) => api.post(`/templates/${id}/preview`, variables),
};

export const buildApi = {
  trigger: (data) => api.post('/builds', data),
  getList: (params) => api.get('/builds', { params }),
  getById: (id) => api.get(`/builds/${id}`),
  getLog: (id, offset) => api.get(`/builds/${id}/log`, { params: { offset } }),
  cancel: (id) => api.post(`/builds/${id}/cancel`),
  retry: (id) => api.post(`/builds/${id}/retry`),
  delete: (id) => api.delete(`/builds/${id}`),
  clearAll: () => api.delete('/builds/all'),
};
