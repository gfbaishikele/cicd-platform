import React, { useEffect, useState, useRef } from 'react';
import {
  Table, Button, Space, message, Typography, Popconfirm, Modal, Select,
  Input, InputNumber, Drawer, Divider, Radio,
} from 'antd';
import {
  RocketOutlined, RollbackOutlined, DeleteOutlined, ConsoleSqlOutlined,
  PlusOutlined, MinusCircleOutlined, StopOutlined, ReloadOutlined, ClearOutlined,
} from '@ant-design/icons';
import { deploymentApi } from '../api/deployments';
import { projectApi, businessProjectsApi } from '../api/projects';
import { clusterApi } from '../api/clusters';
import { buildApi } from '../api/builds';
import { io } from 'socket.io-client';
import { useSelector } from 'react-redux';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';

const { Text } = Typography;

const statusLabels = {
  pending: '等待中',
  deploying: '部署中',
  success: '成功',
  failed: '失败',
  rolled_back: '已回滚',
  cancelled: '已取消',
};

function Deployments() {
  const [deployments, setDeployments] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [filterProject, setFilterProject] = useState(null);
  const [filterNode, setFilterNode] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterBusinessProject, setFilterBusinessProject] = useState(null);

  const [projects, setProjects] = useState([]);
  const [businessProjects, setBusinessProjects] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [groups, setGroups] = useState([]);

  // 部署弹窗
  const [deployVisible, setDeployVisible] = useState(false);
  const [deployForm, setDeployForm] = useState({
    project_id: null, build_id: null, node_ids: [], group_ids: [], deployMode: 'nodes',
    image_tag: '', container_name: '', ports: [], env_vars: [], volumes: [], strategy: 'recreate',
  });
  const [builds, setBuilds] = useState([]);
  const [buildsLoading, setBuildsLoading] = useState(false);

  // 日志抽屉
  const [logDrawer, setLogDrawer] = useState(null);
  const [logContent, setLogContent] = useState('');
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

  // 加载基础数据
  useEffect(() => {
    projectApi.getList({ pageSize: 100 }).then(res => setProjects(res.data.data.list)).catch(() => {});
    businessProjectsApi.getList().then(res => setBusinessProjects(res.data.data)).catch(() => {});
    clusterApi.getNodes().then(res => setNodes(Array.isArray(res.data.data) ? res.data.data : [])).catch(() => {});
    clusterApi.getGroups().then(res => setGroups(res.data.data)).catch(() => {});
  }, []);

  // 加载部署列表
  const fetchDeployments = async () => {
    setLoading(true);
    try {
      const params = { page, pageSize: 20 };
      if (filterProject) params.project_id = filterProject;
      if (filterNode) params.node_id = filterNode;
      if (filterStatus) params.status = filterStatus;
      if (filterBusinessProject) params.business_project_id = filterBusinessProject;
      const res = await deploymentApi.getList(params);
      setDeployments(res.data.data.list);
      setTotal(res.data.data.total);

      // 高亮指定行
      if (highlightId) {
        const id = parseInt(highlightId, 10);
        const found = res.data.data.list.find(d => d.id === id);
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
      message.error('获取部署列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDeployments(); }, [page, filterProject, filterNode, filterStatus, filterBusinessProject]);

  // Socket.IO 连接
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const socket = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('deploy-log', (data) => {
      if (logDrawer && data.deploymentId === logDrawer.id) {
        setLogContent(prev => prev + data.line);
      }
    });

    socket.on('deploy-status', (data) => {
      if (logDrawer && data.deploymentId === logDrawer.id) {
        setLogDrawer(prev => prev ? { ...prev, status: data.status } : null);
        fetchDeployments();
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

  // 项目变更 → 加载构建列表
  const handleProjectChange = async (projectId) => {
    setDeployForm({ ...deployForm, project_id: projectId, build_id: null, image_tag: '' });
    if (!projectId) { setBuilds([]); return; }
    setBuildsLoading(true);
    try {
      const res = await buildApi.getList({ project_id: projectId, status: 'success', pageSize: 100 });
      setBuilds(res.data.data.list);
    } catch {
      setBuilds([]);
    } finally {
      setBuildsLoading(false);
    }
  };

  // 构建变更 → 填充镜像标签
  const handleBuildChange = (buildId) => {
    const build = builds.find(b => b.id === buildId);
    setDeployForm({
      ...deployForm,
      build_id: buildId,
      image_tag: build?.image_tag || '',
    });
  };

  // 打开部署弹窗
  const openDeployModal = () => {
    setDeployForm({
      project_id: null, build_id: null, node_ids: [], group_ids: [], deployMode: 'nodes',
      image_tag: '', container_name: '', ports: [], env_vars: [], volumes: [], strategy: 'recreate',
    });
    setBuilds([]);
    setDeployVisible(true);
  };

  // 提交部署
  const handleDeploy = async () => {
    const { project_id, build_id, node_ids, group_ids, deployMode, image_tag } = deployForm;
    if (!project_id) return message.warning('请选择项目');
    if (!build_id) return message.warning('请选择构建版本');
    if (deployMode === 'nodes' && node_ids.length === 0) return message.warning('请选择目标节点');
    if (deployMode === 'group' && group_ids.length === 0) return message.warning('请选择目标分组');
    if (!image_tag) return message.warning('请填写镜像标签');

    try {
      const payload = {
        project_id, build_id, image_tag,
        container_name: deployForm.container_name || undefined,
        ports: deployForm.ports.filter(p => p.host && p.container),
        env_vars: deployForm.env_vars.filter(e => e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {}),
        volumes: deployForm.volumes.filter(v => v.host && v.container),
        strategy: deployForm.strategy,
      };
      if (deployMode === 'nodes') {
        payload.node_ids = node_ids;
      } else {
        payload.group_ids = group_ids;
      }
      const res = await deploymentApi.create(payload);
      message.success(res.data.message || `已创建部署任务`);
      setDeployVisible(false);
      fetchDeployments();
    } catch (err) {
      message.error(err.response?.data?.message || '创建部署失败');
    }
  };

  // 回滚
  const handleRollback = async (id) => {
    try {
      await deploymentApi.rollback(id);
      message.success('回滚已启动');
      fetchDeployments();
    } catch (err) {
      message.error(err.response?.data?.message || '回滚失败');
    }
  };

  const handleRetry = async (id) => {
    try {
      await deploymentApi.retry(id);
      message.success('部署已重试');
      fetchDeployments();
    } catch (err) {
      message.error(err.response?.data?.message || '重试失败');
    }
  };

  // 查看日志
  const handleViewLog = async (deployment) => {
    setLogDrawer(deployment);
    try {
      const res = await deploymentApi.getLog(deployment.id);
      setLogContent(res.data.data.log);
      if (socketRef.current && deployment.status === 'deploying') {
        socketRef.current.emit('subscribe-deploy', deployment.id);
      }
    } catch {
      setLogContent('获取日志失败');
    }
  };

  const closeLogDrawer = () => {
    if (socketRef.current && logDrawer) {
      socketRef.current.emit('unsubscribe-deploy', logDrawer.id);
    }
    setLogDrawer(null);
    setLogContent('');
  };

  const handleClearAll = async () => {
    try {
      const res = await deploymentApi.clearAll();
      message.success(res.data.message || '部署记录已清除');
      fetchDeployments();
    } catch (err) {
      message.error(err.response?.data?.message || '清除失败');
    }
  };

  // 动态表单 helpers
  const addPort = () => setDeployForm({ ...deployForm, ports: [...deployForm.ports, { host: '', container: '' }] });
  const removePort = (i) => setDeployForm({ ...deployForm, ports: deployForm.ports.filter((_, idx) => idx !== i) });
  const updatePort = (i, field, val) => {
    const next = [...deployForm.ports]; next[i] = { ...next[i], [field]: val };
    setDeployForm({ ...deployForm, ports: next });
  };

  const addEnv = () => setDeployForm({ ...deployForm, env_vars: [...deployForm.env_vars, { key: '', value: '' }] });
  const removeEnv = (i) => setDeployForm({ ...deployForm, env_vars: deployForm.env_vars.filter((_, idx) => idx !== i) });
  const updateEnv = (i, field, val) => {
    const next = [...deployForm.env_vars]; next[i] = { ...next[i], [field]: val };
    setDeployForm({ ...deployForm, env_vars: next });
  };

  const addVolume = () => setDeployForm({ ...deployForm, volumes: [...deployForm.volumes, { host: '', container: '' }] });
  const removeVolume = (i) => setDeployForm({ ...deployForm, volumes: deployForm.volumes.filter((_, idx) => idx !== i) });
  const updateVolume = (i, field, val) => {
    const next = [...deployForm.volumes]; next[i] = { ...next[i], [field]: val };
    setDeployForm({ ...deployForm, volumes: next });
  };

  const columns = [
    { title: '#', dataIndex: 'id', width: 60 },
    { title: '项目', dataIndex: 'business_project_name', width: 120, ellipsis: true, render: (t) => t || '-' },
    { title: '应用名称', dataIndex: 'project_name', width: 110, ellipsis: true, render: (t) => t || '-' },
    { title: '节点', dataIndex: 'node_name', width: 100, ellipsis: true },
    { title: '镜像', dataIndex: 'image_tag', width: 200, ellipsis: true },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (s) => {
        const cfg = { pending: { color: '#c7c7c7', label: '等待中' }, deploying: { color: '#ff9500', label: '部署中' }, success: { color: '#34c759', label: '成功' }, failed: { color: '#ff3b30', label: '失败' }, rolled_back: { color: '#ff9500', label: '已回滚' }, cancelled: { color: '#c7c7c7', label: '已取消' } };
        const c = cfg[s] || { color: '#c7c7c7', label: s };
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
            {c.label}
          </span>
        );
      },
    },
    {
      title: '耗时', dataIndex: 'duration', width: 70,
      render: (d) => d ? `${d}s` : '-',
    },
    { title: '操作者', dataIndex: 'deployed_by_name', width: 90, ellipsis: true },
    {
      title: '时间', dataIndex: 'created_at', width: 160,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作', width: 200, fixed: 'right',
      render: (_, record) => {
        const hasAccess = canWrite(record.project_id);
        return (
          <Space>
            <Button type="link" size="small" icon={<ConsoleSqlOutlined />} onClick={() => handleViewLog(record)}>日志</Button>
            {hasAccess && ['pending', 'deploying'].includes(record.status) && (
              <Popconfirm title="确认取消此部署？" onConfirm={() => deploymentApi.cancel(record.id).then(() => { message.success('取消请求已发送'); fetchDeployments(); })}>
                <Button type="link" size="small" danger icon={<StopOutlined />}>取消</Button>
              </Popconfirm>
            )}
            {hasAccess && ['success', 'failed'].includes(record.status) && (
              <Popconfirm title="确认回滚此部署？" onConfirm={() => handleRollback(record.id)}>
                <Button type="link" size="small" icon={<RollbackOutlined />}>回滚</Button>
              </Popconfirm>
            )}
            {hasAccess && !['pending', 'deploying'].includes(record.status) && (
              <Popconfirm title="确认重试此部署？将使用相同参数创建新的部署任务" onConfirm={() => handleRetry(record.id)}>
                <Button type="link" size="small" icon={<ReloadOutlined />}>重试</Button>
              </Popconfirm>
            )}
            {hasAccess && !['deploying', 'pending'].includes(record.status) && (
              <Popconfirm title="确认删除此部署记录？" onConfirm={() => deploymentApi.delete(record.id).then(() => { message.success('已删除'); fetchDeployments(); })}>
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
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>部署记录</div>
        <Space>
          <Select placeholder="筛选项目管理" allowClear style={{ width: 160 }} value={filterBusinessProject} onChange={(val) => { setFilterBusinessProject(val); setFilterProject(null); }}>
            {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
          </Select>
          <Select placeholder="筛选应用" allowClear showSearch optionFilterProp="children" style={{ width: 180 }} value={filterProject} onChange={setFilterProject}>
            {(filterBusinessProject ? projects.filter(p => p.business_project_id === filterBusinessProject) : projects).map(p => <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>)}
          </Select>
          <Select placeholder="筛选节点" allowClear style={{ width: 130 }} value={filterNode} onChange={setFilterNode}>
            {nodes.map(n => <Select.Option key={n.id} value={n.id}>{n.name}</Select.Option>)}
          </Select>
          <Select placeholder="筛选状态" allowClear style={{ width: 110 }} value={filterStatus} onChange={setFilterStatus}>
            {Object.entries(statusLabels).map(([k, v]) => <Select.Option key={k} value={k}>{v}</Select.Option>)}
          </Select>
          <Button type="primary" icon={<RocketOutlined />} onClick={openDeployModal} disabled={!hasWriteAccess}>新建部署</Button>
          <Popconfirm title="确认清除所有部署记录？" description="正在部署中的记录不会被删除" onConfirm={handleClearAll}>
            <Button danger icon={<ClearOutlined />} disabled={!hasWriteAccess || total === 0}>一键清除</Button>
          </Popconfirm>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={deployments}
        loading={loading}
        rowClassName={(record) => record.id === highlightedRow ? 'highlight-row' : ''}
        pagination={{ current: page, total, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
        scroll={{ x: 1200 }}
        size="middle"
      />

      {/* 新建部署弹窗 */}
      <Modal title="新建部署" open={deployVisible} onOk={handleDeploy} onCancel={() => setDeployVisible(false)} width={640}>
        <div style={{ marginBottom: 16 }}>
          <Text>选择项目：</Text>
          <Select showSearch style={{ width: '100%', marginTop: 8 }} placeholder="选择项目" optionFilterProp="children"
            value={deployForm.project_id} onChange={handleProjectChange}>
            {projects.map(p => <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>)}
          </Select>
        </div>

        <div style={{ marginBottom: 16 }}>
          <Text>选择构建版本：</Text>
          <Select showSearch style={{ width: '100%', marginTop: 8 }} placeholder="选择成功构建" optionFilterProp="children"
            loading={buildsLoading} value={deployForm.build_id} onChange={handleBuildChange}
            disabled={!deployForm.project_id}>
            {builds.map(b => (
              <Select.Option key={b.id} value={b.id}>
                #{b.id} - {b.branch} {b.image_tag ? `(${b.image_tag})` : ''} {dayjs(b.created_at).format('YYYY-MM-DD HH:mm')}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div style={{ marginBottom: 16 }}>
          <Text>目标节点：</Text>
          <div style={{ marginTop: 8 }}>
            <Radio.Group
              value={deployForm.deployMode}
              onChange={(e) => setDeployForm({ ...deployForm, deployMode: e.target.value, node_ids: [], group_ids: [] })}
              style={{ marginBottom: 12 }}
            >
              <Radio.Button value="nodes">主机节点</Radio.Button>
              <Radio.Button value="group">按分组</Radio.Button>
            </Radio.Group>

            {deployForm.deployMode === 'nodes' ? (
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="children"
                style={{ width: '100%' }}
                placeholder="选择主机节点（支持多选）"
                value={deployForm.node_ids}
                onChange={(vals) => setDeployForm({ ...deployForm, node_ids: vals })}
              >
                {nodes.map(n => (
                  <Select.Option key={n.id} value={n.id}>
                    {n.name}（{n.host}）{n.group_name ? ` - ${n.group_name}` : ''}
                  </Select.Option>
                ))}
              </Select>
            ) : (
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="children"
                style={{ width: '100%' }}
                placeholder="选择分组（支持多选，将部署到分组内所有主机）"
                value={deployForm.group_ids}
                onChange={(vals) => setDeployForm({ ...deployForm, group_ids: vals })}
              >
                {groups.map(g => (
                  <Select.Option key={g.id} value={g.id}>
                    {g.name}（{g.node_count || 0} 台主机）
                  </Select.Option>
                ))}
              </Select>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <Text>镜像标签：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={deployForm.image_tag}
            onChange={(e) => setDeployForm({ ...deployForm, image_tag: e.target.value })}
            placeholder="例如: myapp:latest" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <Text>容器名称：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={deployForm.container_name}
            onChange={(e) => setDeployForm({ ...deployForm, container_name: e.target.value })}
            placeholder="可选，默认使用仓库名-app" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <Text>部署策略：</Text>
          <Select style={{ width: 200, marginTop: 8, marginLeft: 8 }} value={deployForm.strategy}
            onChange={(val) => setDeployForm({ ...deployForm, strategy: val })}>
            <Select.Option value="recreate">重建（先停后启）</Select.Option>
            <Select.Option value="rolling">滚动更新</Select.Option>
          </Select>
        </div>

        <Divider style={{ margin: '12px 0' }}>端口映射</Divider>
        {deployForm.ports.map((p, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }}>
            <InputNumber placeholder="Host 端口" value={p.host} onChange={(v) => updatePort(i, 'host', v)} style={{ width: 120 }} />
            <span>:</span>
            <InputNumber placeholder="Container 端口" value={p.container} onChange={(v) => updatePort(i, 'container', v)} style={{ width: 120 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removePort(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addPort}>添加端口</Button>

        <Divider style={{ margin: '12px 0' }}>环境变量</Divider>
        {deployForm.env_vars.map((e, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }}>
            <Input placeholder="KEY" value={e.key} onChange={(ev) => updateEnv(i, 'key', ev.target.value)} style={{ width: 140 }} />
            <span>=</span>
            <Input placeholder="VALUE" value={e.value} onChange={(ev) => updateEnv(i, 'value', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeEnv(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addEnv}>添加变量</Button>

        <Divider style={{ margin: '12px 0' }}>卷挂载</Divider>
        {deployForm.volumes.map((v, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }}>
            <Input placeholder="Host 路径" value={v.host} onChange={(ev) => updateVolume(i, 'host', ev.target.value)} style={{ width: 180 }} />
            <span>:</span>
            <Input placeholder="Container 路径" value={v.container} onChange={(ev) => updateVolume(i, 'container', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeVolume(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addVolume}>添加挂载</Button>
      </Modal>

      {/* 日志抽屉 */}
      <Drawer
        title={
          <Space>
            <span>部署日志 #{logDrawer?.id}</span>
            {logDrawer && (() => {
              const cfg = { pending: { color: '#c7c7c7', label: '等待中' }, deploying: { color: '#ff9500', label: '部署中' }, success: { color: '#34c759', label: '成功' }, failed: { color: '#ff3b30', label: '失败' }, rolled_back: { color: '#ff9500', label: '已回滚' }, cancelled: { color: '#c7c7c7', label: '已取消' } };
              const c = cfg[logDrawer.status] || { color: '#c7c7c7', label: logDrawer.status };
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666', marginLeft: 8 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
                  {c.label}
                </span>
              );
            })()}
          </Space>
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
          {logContent || '等待日志输出...'}
        </div>
      </Drawer>
    </div>
  );
}

export default Deployments;
