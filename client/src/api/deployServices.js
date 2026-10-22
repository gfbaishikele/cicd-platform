import api from './index';

export const deployServiceApi = {
  getList: (params) => api.get('/deploy-services', { params }),
  getById: (id) => api.get(`/deploy-services/${id}`),
  create: (data) => api.post('/deploy-services', data),
  update: (id, data) => api.put(`/deploy-services/${id}`, data),
  delete: (id) => api.delete(`/deploy-services/${id}`),
  build: (id, data) => api.post(`/deploy-services/${id}/build`, data),
  deploy: (id, data) => api.post(`/deploy-services/${id}/deploy`, data),
  buildAndDeploy: (id, data) => api.post(`/deploy-services/${id}/build-and-deploy`, data),
};
