import api from './index';

export const clusterApi = {
  getNodes: (params) => api.get('/clusters/nodes', { params }),
  getNode: (id) => api.get(`/clusters/nodes/${id}`),
  createNode: (data) => api.post('/clusters/nodes', data),
  updateNode: (id, data) => api.put(`/clusters/nodes/${id}`, data),
  deleteNode: (id) => api.delete(`/clusters/nodes/${id}`),
  healthCheck: (id) => api.post(`/clusters/nodes/${id}/check`),
  getNodeStatus: (id) => api.get(`/clusters/nodes/${id}/status`),

  // 容器管理
  getContainers: (nodeId) => api.get(`/clusters/nodes/${nodeId}/containers`),
  containerAction: (nodeId, containerName, action) => api.post(`/clusters/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/${action}`),
  getContainerLogs: (nodeId, containerName, tail = 200) => api.get(`/clusters/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/logs`, { params: { tail } }),

  // 分组管理
  getGroups: () => api.get('/clusters/groups'),
  createGroup: (data) => api.post('/clusters/groups', data),
  updateGroup: (id, data) => api.put(`/clusters/groups/${id}`, data),
  deleteGroup: (id) => api.delete(`/clusters/groups/${id}`),
  getGroupNodes: (id) => api.get(`/clusters/groups/${id}/nodes`),
};
