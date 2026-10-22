import api from './index';
import { store } from '../store';

export const dbApi = {
  // 连接管理
  getList: () => api.get('/db-connections'),
  create: (data) => api.post('/db-connections', data),
  update: (id, data) => api.put(`/db-connections/${id}`, data),
  delete: (id) => api.delete(`/db-connections/${id}`),
  test: (id) => api.post(`/db-connections/${id}/test`),

  // 数据库/表
  getDatabases: (id) => api.get(`/db-connections/${id}/databases`),
  getSchemas: (id) => api.get(`/db-connections/${id}/schemas`),
  getTables: (id, database, schema) => api.get(`/db-connections/${id}/tables`, { params: { database, schema } }),
  getTableStructure: (id, tableName, schema) => api.get(`/db-connections/${id}/tables/${tableName}/structure`, { params: { schema } }),
  getDDL: (id, tableName, schema) => api.get(`/db-connections/${id}/tables/${tableName}/ddl`, { params: { schema } }),

  // 分表
  partitionPreview: (id, data) => api.post(`/db-connections/${id}/partition/preview`, data),
  partitionExecute: (id, data) => api.post(`/db-connections/${id}/partition/execute`, data),

  // 跨库同步
  syncPreview: (data) => api.post('/db-connections/sync/preview', data),
  syncExecute: (data) => api.post('/db-connections/sync/execute', data),
  syncBatchExecute: (data) => api.post('/db-connections/sync/batch-execute', data),
  syncBatchStream: (data, signal) => fetch('/api/db-connections/sync/batch-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.getState().auth.accessToken}` },
    body: JSON.stringify(data),
    signal,
  }),

  // 同步日志
  getSyncLogs: () => api.get('/db-connections/sync/logs'),
  getSyncLogDetail: (id) => api.get(`/db-connections/sync/logs/${id}`),
  deleteSyncLog: (id) => api.delete(`/db-connections/sync/logs/${id}`),
};
