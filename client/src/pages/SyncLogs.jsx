import React, { useEffect, useState } from 'react';
import {
  Card, Table, Button, Space, Typography, Drawer, Popconfirm, message, Tooltip,
} from 'antd';
import {
  DeleteOutlined, EyeOutlined, DownloadOutlined, CopyOutlined,
} from '@ant-design/icons';
import { dbApi } from '../api/dbConnections';

const { Text } = Typography;

function SyncLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { fetchLogs(); }, []);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await dbApi.getSyncLogs();
      setLogs(res.data.data || []);
    } catch { message.error('获取同步日志失败'); }
    finally { setLoading(false); }
  };

  const handleViewDetail = async (id) => {
    setDetailLoading(true);
    setDetailVisible(true);
    try {
      const res = await dbApi.getSyncLogDetail(id);
      setDetail(res.data.data);
    } catch { message.error('获取日志详情失败'); }
    finally { setDetailLoading(false); }
  };

  const handleDelete = async (id) => {
    try {
      await dbApi.deleteSyncLog(id);
      message.success('删除成功');
      fetchLogs();
    } catch { message.error('删除失败'); }
  };

  const handleDownload = (log) => {
    const lines = [
      `同步日志 #${log.id}`,
      `时间: ${log.created_at}`,
      `源端: ${log.source_conn_name} (${log.source_db_type})`,
      `目标: ${log.target_conn_name} (${log.target_db_type})`,
      `表数: ${log.total_tables}  成功: ${log.success_count}  失败: ${log.fail_count}`,
      `状态: ${statusMap[log.status]?.label || log.status}`,
      '─'.repeat(50),
      '',
    ];
    if (log.logs && Array.isArray(log.logs)) {
      log.logs.forEach(l => lines.push(l.message));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sync-log-${log.id}-${log.created_at?.replace(/[: ]/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyDetail = () => {
    if (!detail?.logs) return;
    const text = detail.logs.map(l => l.message).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      message.success('日志已复制到剪贴板');
    }).catch(() => {
      message.error('复制失败');
    });
  };

  const statusMap = {
    completed: { label: '完成' },
    partial: { label: '部分成功' },
    aborted: { label: '已中止' },
    failed: { label: '失败' },
  };

  const dbTypeMap = { mysql: 'MySQL', pg: 'PostgreSQL', opengauss: 'OpenGauss' };

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '源端', key: 'source', width: 180,
      render: (_, r) => <><span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{dbTypeMap[r.source_db_type] || r.source_db_type}</span> {r.source_conn_name}</>,
    },
    { title: '目标', key: 'target', width: 180,
      render: (_, r) => <><span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{dbTypeMap[r.target_db_type] || r.target_db_type}</span> {r.target_conn_name}</>,
    },
    { title: '表数', dataIndex: 'total_tables', key: 'total_tables', width: 70, align: 'center' },
    { title: '成功', dataIndex: 'success_count', key: 'success_count', width: 70, align: 'center',
      render: (v) => <Text type="success">{v}</Text>,
    },
    { title: '失败', dataIndex: 'fail_count', key: 'fail_count', width: 70, align: 'center',
      render: (v) => v > 0 ? <Text type="danger">{v}</Text> : <Text>{v}</Text>,
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110,
      render: (s) => {
        const dotColors = { completed: '#34c759', partial: '#ff9500', aborted: '#c7c7c7', failed: '#ff3b30' };
        const info = statusMap[s] || { label: s };
        return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColors[s] || '#c7c7c7', display: 'inline-block' }} />{info.label}</span>;
      },
    },
    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 170 },
    { title: '操作', key: 'action', width: 150,
      render: (_, r) => (
        <Space size="small">
          <Tooltip title="查看详情"><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(r.id)} /></Tooltip>
          <Tooltip title="下载日志"><Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(r)} /></Tooltip>
          <Popconfirm title="确定删除此日志？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
            <Tooltip title="删除"><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>同步日志</div>
      </div>

      <Table
        dataSource={logs}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />

      <Drawer
        title={detail ? `同步日志 #${detail.id}` : '日志详情'}
        open={detailVisible}
        onClose={() => { setDetailVisible(false); setDetail(null); }}
        width={700}
        extra={
          detail && (
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopyDetail}>复制日志</Button>
          )
        }
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
        ) : detail && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space wrap>
                <span>源端: <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{dbTypeMap[detail.source_db_type]}</span> {detail.source_conn_name}</span>
                <span>目标: <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{dbTypeMap[detail.target_db_type]}</span> {detail.target_conn_name}</span>
              </Space>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Text>表数: {detail.total_tables}</Text>
                <Text type="success">成功: {detail.success_count}</Text>
                <Text type={detail.fail_count > 0 ? 'danger' : ''}>失败: {detail.fail_count}</Text>
                {statusMap[detail.status] && (() => {
                  const dotColors = { completed: '#34c759', partial: '#ff9500', aborted: '#c7c7c7', failed: '#ff3b30' };
                  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColors[detail.status] || '#c7c7c7', display: 'inline-block' }} />{statusMap[detail.status].label}</span>;
                })()}
              </Space>
            </div>
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary">时间: {detail.created_at} → {detail.finished_at}</Text>
            </div>

            {/* 结果表格 */}
            {detail.results && detail.results.length > 0 && (
              <Table
                dataSource={detail.results}
                rowKey="table"
                size="small"
                pagination={false}
                style={{ marginBottom: 16 }}
                columns={[
                  { title: '表名', dataIndex: 'table', key: 'table', width: 200 },
                  { title: '状态', key: 'status', width: 80,
                    render: (_, r) => r.success
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34c759', display: 'inline-block' }} />成功</span>
                      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff3b30', display: 'inline-block' }} />失败</span>,
                  },
                  { title: '数据量', key: 'data', width: 120,
                    render: (_, r) => r.success ? `${r.synced}/${r.total}` : '-',
                  },
                  { title: '错误', dataIndex: 'error', key: 'error',
                    render: (e) => e ? <Text type="danger" style={{ fontSize: 12 }}>{e}</Text> : '-',
                  },
                ]}
              />
            )}

            {/* 日志终端 */}
            <div style={{
              background: '#1e1e1e', borderRadius: 6, padding: 12, maxHeight: 400,
              overflow: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: '22px',
            }}>
              {detail.logs && detail.logs.map((log, i) => (
                <div key={i} style={{
                  color: log.type === 'error' ? '#ff4d4f' : log.type === 'success' ? '#52c41a' : '#d4d4d4',
                }}>
                  {log.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

export default SyncLogs;
