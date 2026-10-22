import React, { useEffect, useState, useRef } from 'react';
import { Table, Button, Space, message, Typography, Popconfirm, Modal, Select, Input, InputNumber, Drawer, Radio, Tooltip } from 'antd';
import { CaretRightOutlined, StopOutlined, ReloadOutlined, DeleteOutlined, ConsoleSqlOutlined, DownloadOutlined, SearchOutlined, ClearOutlined } from '@ant-design/icons';
import { buildApi } from '../api/builds';
import { projectApi, businessProjectsApi } from '../api/projects';
import { io } from 'socket.io-client';
import { useSelector } from 'react-redux';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';

const { Text } = Typography;


function Builds() {
  const [builds, setBuilds] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [filterProject, setFilterProject] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterBusinessProject, setFilterBusinessProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [businessProjects, setBusinessProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [triggerVisible, setTriggerVisible] = useState(false);
  const [triggerForm, setTriggerForm] = useState({
    project_id: null, branch: 'main', dockerfile_source: 'template',
    dockerfile_template_id: null, image_name: '', image_tag: '',
  });
  const [logDrawer, setLogDrawer] = useState(null);
  const [logContent, setLogContent] = useState('');
  const [logSearch, setLogSearch] = useState('');
  const [highlightedRow, setHighlightedRow] = useState(null);
  const logRef = useRef(null);
  const socketRef = useRef(null);
  const { user } = useSelector((state) => state.auth);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');

  // 判断当前用户是否有写权限（admin/owner/developer）
  const canWrite = (projectId) => {
    if (user.role === 'admin') return true;
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;
    return ['admin', 'owner', 'developer'].includes(project.current_user_role);
  };

  // 当前筛选项目是否有写权限
  const hasWriteAccess = filterProject ? canWrite(filterProject) : true;

  const fetchBuilds = async () => {
    setLoading(true);
    try {
      const params = { page, pageSize: 20 };
      if (filterProject) params.project_id = filterProject;
      if (filterStatus) params.status = filterStatus;
      if (filterBusinessProject) params.business_project_id = filterBusinessProject;
      const res = await buildApi.getList(params);
      setBuilds(res.data.data.list);
      setTotal(res.data.data.total);

      // 高亮指定行
      if (highlightId) {
        const id = parseInt(highlightId, 10);
        const found = res.data.data.list.find(b => b.id === id);
        if (found) {
          setHighlightedRow(id);
          setTimeout(() => {
            const el = document.querySelector(`tr[data-row-key="${id}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => setHighlightedRow(null), 3000);
          }, 100);
        }
      }
    } catch {
      message.error('获取构建列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBuilds(); }, [page, filterProject, filterStatus, filterBusinessProject]);

  useEffect(() => {
    projectApi.getList({ pageSize: 100 }).then(res => setProjects(res.data.data.list)).catch(() => {});
    businessProjectsApi.getList().then(res => setBusinessProjects(res.data.data)).catch(() => {});
  }, []);

  // Socket.IO 连接
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const socket = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('build-log', (data) => {
      if (logDrawer && data.buildId === logDrawer.id) {
        setLogContent(prev => prev + data.line);
      }
    });

    socket.on('build-status', (data) => {
      if (logDrawer && data.buildId === logDrawer.id) {
        setLogDrawer(prev => prev ? { ...prev, status: data.status } : null);
        fetchBuilds();
      }
    });

    return () => { socket.disconnect(); };
  }, [logDrawer]);

  // 自动滚动日志
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logContent]);

  const handleTrigger = async () => {
    if (!triggerForm.project_id) return message.warning('请选择项目');
    try {
      await buildApi.trigger(triggerForm);
      message.success('构建已触发');
      setTriggerVisible(false);
      fetchBuilds();
    } catch (err) {
      message.error(err.response?.data?.message || '触发构建失败');
    }
  };

  const handleCancel = async (id) => {
    try {
      await buildApi.cancel(id);
      message.success('构建已取消');
      fetchBuilds();
    } catch (err) {
      message.error(err.response?.data?.message || '取消失败');
    }
  };

  const handleRetry = async (id) => {
    try {
      await buildApi.retry(id);
      message.success('构建已重试');
      fetchBuilds();
    } catch (err) {
      message.error(err.response?.data?.message || '重试失败');
    }
  };

  const handleViewLog = async (build) => {
    setLogDrawer(build);
    try {
      const res = await buildApi.getLog(build.id);
      setLogContent(res.data.data.log);

      // 订阅实时日志
      if (socketRef.current && build.status === 'building') {
        socketRef.current.emit('subscribe-build', build.id);
      }
    } catch {
      setLogContent('获取日志失败');
    }
  };

  const closeLogDrawer = () => {
    if (socketRef.current && logDrawer) {
      socketRef.current.emit('unsubscribe-build', logDrawer.id);
    }
    setLogDrawer(null);
    setLogContent('');
    setLogSearch('');
  };

  const handleDownloadLog = async (build) => {
    try {
      const res = await buildApi.getLog(build.id);
      const blob = new Blob([res.data.data.log || ''], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${build.project_name}_${build.branch}_build-${build.id}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      message.error('下载日志失败');
    }
  };

  const handleClearAll = async () => {
    try {
      const res = await buildApi.clearAll();
      message.success(res.data.message || '构建记录已清除');
      fetchBuilds();
    } catch (err) {
      message.error(err.response?.data?.message || '清除失败');
    }
  };

  const filteredLogContent = logSearch
    ? logContent.split('\n').filter(line => line.toLowerCase().includes(logSearch.toLowerCase())).join('\n')
    : logContent;

  const columns = [
    { title: '#', dataIndex: 'id', width: 60 },
    { title: '项目', dataIndex: 'business_project_name', width: 130, ellipsis: true, render: (t) => t || '-' },
    { title: '应用名称', dataIndex: 'project_name', width: 110, ellipsis: true, render: (t) => t || '-' },
    { title: '分支', dataIndex: 'branch', width: 100, ellipsis: true },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s) => {
        const map = { pending: { color: '#c7c7c7', label: '等待中' }, building: { color: '#ff9500', label: '构建中' }, success: { color: '#34c759', label: '成功' }, failed: { color: '#ff3b30', label: '失败' }, cancelled: { color: '#c7c7c7', label: '已取消' } };
        const cfg = map[s] || { color: '#c7c7c7', label: s };
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
            {cfg.label}
          </span>
        );
      },
    },
    { title: '类型', dataIndex: 'build_type', width: 70 },
    {
      title: '镜像', dataIndex: 'image_tag', width: 200, ellipsis: true,
      render: (t) => t || '-',
    },
    {
      title: '耗时', dataIndex: 'duration', width: 70,
      render: (d) => d ? `${d}s` : '-',
    },
    { title: '触发者', dataIndex: 'triggered_by_name', width: 90, ellipsis: true },
    {
      title: '时间', dataIndex: 'created_at', width: 160,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作', width: 180, fixed: 'right',
      render: (_, record) => {
        const hasAccess = canWrite(record.project_id);
        return (
          <Space>
            <Button type="link" size="small" icon={<ConsoleSqlOutlined />} onClick={() => handleViewLog(record)}>日志</Button>
            {hasAccess && record.status === 'building' && (
              <Popconfirm title="确认取消构建？" onConfirm={() => handleCancel(record.id)}>
                <Button type="link" size="small" danger icon={<StopOutlined />}>取消</Button>
              </Popconfirm>
            )}
            {hasAccess && ['success', 'failed', 'cancelled'].includes(record.status) && (
              <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => handleRetry(record.id)}>重试</Button>
            )}
            {hasAccess && record.status !== 'building' && (
              <Popconfirm title="确认删除？" onConfirm={() => buildApi.delete(record.id).then(() => { message.success('已删除'); fetchBuilds(); })}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <style>{`
        .highlight-row {
          background-color: #fffbe6 !important;
          animation: highlight-fade 3s ease-out;
        }
        @keyframes highlight-fade {
          0% { background-color: #fff1b8; }
          100% { background-color: transparent; }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>构建记录</div>
        <Space>
          <Select
            placeholder="筛选项目管理"
            allowClear
            style={{ width: 160 }}
            value={filterBusinessProject}
            onChange={(val) => { setFilterBusinessProject(val); setFilterProject(null); }}
          >
            {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
          </Select>
          <Select
            placeholder="筛选应用"
            allowClear
            showSearch
            optionFilterProp="children"
            style={{ width: 180 }}
            value={filterProject}
            onChange={setFilterProject}
          >
            {(filterBusinessProject ? projects.filter(p => p.business_project_id === filterBusinessProject) : projects).map(p => <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>)}
          </Select>
          <Select
            placeholder="筛选状态"
            allowClear
            style={{ width: 120 }}
            value={filterStatus}
            onChange={setFilterStatus}
          >
            <Select.Option value="pending">等待中</Select.Option>
            <Select.Option value="building">构建中</Select.Option>
            <Select.Option value="success">成功</Select.Option>
            <Select.Option value="failed">失败</Select.Option>
            <Select.Option value="cancelled">已取消</Select.Option>
          </Select>
          <Button type="primary" icon={<CaretRightOutlined />} onClick={async () => {
            setTriggerForm({
              project_id: null, branch: 'main', dockerfile_source: 'template',
              dockerfile_template_id: null, image_name: '', image_tag: '',
            });
            try {
              const res = await import('../api/index').then(api => api.default.get('/templates'));
              setTemplates(res.data.data);
            } catch {
              // ignore
            }
            setTriggerVisible(true);
          }} disabled={!hasWriteAccess}>
            触发构建
          </Button>
          <Popconfirm title="确认清除所有构建记录？" description="正在构建中的记录不会被删除" onConfirm={handleClearAll}>
            <Button danger icon={<ClearOutlined />} disabled={!hasWriteAccess || total === 0}>一键清除</Button>
          </Popconfirm>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={builds}
        loading={loading}
        rowClassName={(record) => record.id === highlightedRow ? 'highlight-row' : ''}
        pagination={{
          current: page,
          total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: 1200 }}
        size="middle"
      />

      {/* 触发构建弹窗 */}
      <Modal title="触发构建" open={triggerVisible} onOk={handleTrigger} onCancel={() => setTriggerVisible(false)} width={560}>
        <div style={{ marginBottom: 16 }}>
          <Text>选择项目：</Text>
          <Select
            showSearch
            style={{ width: '100%', marginTop: 8 }}
            placeholder="选择项目"
            optionFilterProp="children"
            value={triggerForm.project_id}
            onChange={(val) => {
              const project = projects.find(p => p.id === val);
              setTriggerForm({ ...triggerForm, project_id: val, branch: project?.default_branch || 'main' });
            }}
          >
            {projects.map(p => <Select.Option key={p.id} value={p.id}>{p.business_project_name ? `[${p.business_project_name}] ` : ''}{p.name} ({p.repo_path})</Select.Option>)}
          </Select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>分支：</Text>
          <Input
            style={{ width: '100%', marginTop: 8 }}
            value={triggerForm.branch}
            onChange={(e) => setTriggerForm({ ...triggerForm, branch: e.target.value })}
            placeholder="main"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>Dockerfile 来源：</Text>
          <div style={{ marginTop: 8 }}>
            <Radio.Group
              value={triggerForm.dockerfile_source}
              onChange={(e) => setTriggerForm({ ...triggerForm, dockerfile_source: e.target.value })}
            >
              <Radio value="template">使用模板</Radio>
              <Radio value="repository">使用代码仓库</Radio>
            </Radio.Group>
          </div>
        </div>
        {triggerForm.dockerfile_source === 'template' && (
          <div style={{ marginBottom: 16 }}>
            <Text>Dockerfile 模板：</Text>
            <Select
              showSearch
              style={{ width: '100%', marginTop: 8 }}
              placeholder="选择模板（可选）"
              optionFilterProp="children"
              allowClear
              value={triggerForm.dockerfile_template_id}
              onChange={(val) => setTriggerForm({ ...triggerForm, dockerfile_template_id: val })}
            >
              {templates.map(t => <Select.Option key={t.id} value={t.id}>{t.name} ({t.build_type})</Select.Option>)}
            </Select>
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <Text>镜像名称（可选，默认使用项目名）：</Text>
          <Input
            style={{ width: '100%', marginTop: 8 }}
            value={triggerForm.image_name}
            onChange={(e) => setTriggerForm({ ...triggerForm, image_name: e.target.value })}
            placeholder="例如：myregistry/my-app"
          />
        </div>
        <div>
          <Text>镜像标签（可选，默认 yymmddhhmmss）：</Text>
          <Input
            style={{ width: '100%', marginTop: 8 }}
            value={triggerForm.image_tag}
            onChange={(e) => setTriggerForm({ ...triggerForm, image_tag: e.target.value })}
            placeholder="例如：latest、v1.0"
          />
        </div>
      </Modal>

      {/* 日志抽屉 */}
      <Drawer
        title={
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Space>
                <span>构建日志 #{logDrawer?.id}</span>
                {logDrawer && (() => {
                  const map = { pending: { color: '#c7c7c7', label: '等待中' }, building: { color: '#ff9500', label: '构建中' }, success: { color: '#34c759', label: '成功' }, failed: { color: '#ff3b30', label: '失败' }, cancelled: { color: '#c7c7c7', label: '已取消' } };
                  const cfg = map[logDrawer.status] || { color: '#c7c7c7', label: logDrawer.status };
                  return (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666', marginLeft: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
                      {cfg.label}
                    </span>
                  );
                })()}
              </Space>
              <Space>
                <Input
                  prefix={<SearchOutlined />}
                  placeholder="搜索日志..."
                  allowClear
                  size="small"
                  style={{ width: 200 }}
                  value={logSearch}
                  onChange={e => setLogSearch(e.target.value)}
                />
                <Tooltip title="下载日志">
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() => logDrawer && handleDownloadLog(logDrawer)}
                  />
                </Tooltip>
              </Space>
            </div>
          </div>
        }
        open={!!logDrawer}
        onClose={closeLogDrawer}
        width={700}
        styles={{ body: { padding: 0 } }}
      >
        <div
          ref={logRef}
          style={{
            background: '#1e1e1e',
            color: '#d4d4d4',
            padding: 16,
            fontFamily: "'Consolas', 'Monaco', monospace",
            fontSize: 12,
            lineHeight: 1.6,
            height: '100%',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {filteredLogContent || '等待日志输出...'}
        </div>
      </Drawer>
    </div>
  );
}

export default Builds;
