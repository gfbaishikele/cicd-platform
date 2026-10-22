import api from './index';

export const registriesApi = {
  getList: (params) => api.get('/registries', { params }),
  getById: (id) => api.get(`/registries/${id}`),
  create: (data) => api.post('/registries', data),
  update: (id, data) => api.put(`/registries/${id}`, data),
  delete: (id) => api.delete(`/registries/${id}`),
  test: (id) => api.post(`/registries/${id}/test`),
  getImages: (id) => api.get(`/registries/${id}/images`),
  getTags: (id, image) => api.get(`/registries/${id}/images/${encodeURIComponent(image)}/tags`),
  deleteTag: (id, image, tag) => api.delete(`/registries/${id}/images/${encodeURIComponent(image)}/tags/${tag}`),
};
