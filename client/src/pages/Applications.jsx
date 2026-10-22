import React, { useEffect, useState, useRef } from 'react';
import {
  Table, Button, Space, Tag, message, Typography, Popconfirm, Modal, Form, Input, Select,
  InputNumber, Card, Row, Col, Tooltip, Drawer, Descriptions, Tabs, Divider, Radio, Timeline,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, RocketOutlined, BuildOutlined,
  CloudServerOutlined, ApiOutlined, EyeOutlined, SendOutlined, MinusCircleOutlined,
  ThunderboltOutlined, CaretRightOutlined, SearchOutlined,
} from '@ant-design/icons';
import { projectsApi, businessProjectsApi, gitlabApi } from '../api/projects';
import { registriesApi } from '../api/registries';
import { clusterApi } from '../api/clusters';
import { templateApi, buildApi } from '../api/builds';
import { deploymentApi } from '../api/deployments';
import { io } from 'socket.io-client';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const { Text } = Typography;
const { TextArea } = Input;

const buildStatusDotColors = { pending: '#c7c7c7', building: '#ff9500', success: '#34c759', failed: '#ff3b30', cancelled: '#c7c7c7' };
const buildStatusLabels = { pending: '等待', building: '构建中', success: '成功', failed: '失败', cancelled: '已取消' };
const deployStatusDotColors = { pending: '#c7c7c7', deploying: '#ff9500', success: '#34c759', failed: '#ff3b30', rolled_back: '#ff9500', cancelled: '#c7c7c7' };
const deployStatusLabels = { pending: '等待', deploying: '部署中', success: '成功', failed: '失败', rolled_back: '已回滚', cancelled: '已取消' };

function Applications() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filterBusinessProject, setFilterBusinessProject] = useState(null);
  const [filterName, setFilterName] = useState('');
  const [filterRepo, setFilterRepo] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailApp, setDetailApp] = useState(null);
  const [form] = Form.useForm();
  const formDockerfileSource = Form.useWatch('dockerfile_source', form);

  // 下拉数据
  const [businessProjects, setBusinessProjects] = useState([]);
  const [connections, setConnections] = useState([]);
  const [registries, setRegistries] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [templates, setTemplates] = useState([]);

  // 目标节点模式
  const [deployMode, setDeployMode] = useState('nodes');
  const [groupIds, setGroupIds] = useState([]);

  // 构建/部署相关
  const [buildModalVisible, setBuildModalVisible] = useState(false);
  const [buildApp, setBuildApp] = useState(null);
  const [buildForm, setBuildForm] = useState({ branch: 'main', dockerfile_source: 'repository', dockerfile_template_id: null, dockerfile_path: '', image_name: '', image_tag: '' });

  const [deployModalVisible, setDeployModalVisible] = useState(false);
  const [deploySelectModalVisible, setDeploySelectModalVisible] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState(null);
  const [deployBuilds, setDeployBuilds] = useState([]);
  const [deployBuildsLoading, setDeployBuildsLoading] = useState(false);
  const [deployOverrides, setDeployOverrides] = useState({ ports: [], env_vars: [], volumes: [] });
  const [deployConfig, setDeployConfig] = useState({ node_ids: [], container_name: '', strategy: 'recreate' });
  const [deployModalMode, setDeployModalMode] = useState('nodes');
  const [deployModalGroupIds, setDeployModalGroupIds] = useState([]);

  const [builds, setBuilds] = useState([]);
  const [deployments, setDeployments] = useState([]);

  // 构建并部署（直接执行，不弹窗，无需额外状态）

  // 合并日志面板
  const [mergedLogVisible, setMergedLogVisible] = useState(false);
  const [mergedLogContent, setMergedLogContent] = useState('');
  const [mergedLogPhase, setMergedLogPhase] = useState('idle');
  const [mergedLogBuildId, setMergedLogBuildId] = useState(null);
  const mergedLogRef = useRef(null);
  const mergedSocketRef = useRef(null);

  const canEdit = (app) => {
    if (!app) return false;
    if (currentUser.role === 'admin') return true;
    return app.created_by === currentUser.id || ['admin', 'owner', 'developer'].includes(app.current_user_role);
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = { page: 1, pageSize: 100, sort: 'id_desc' };
      if (filterBusinessProject) params.business_project_id = filterBusinessProject;
      if (filterName) params.name = filterName;
      if (filterRepo) params.repo_path = filterRepo;
      const [appsRes, bpRes, connRes, regRes, nodesRes, tplRes, groupsRes] = await Promise.all([
        projectsApi.getList(params),
        businessProjectsApi.getList(),
        gitlabApi.getConnections(),
        registriesApi.getList(),
        clusterApi.getNodes(),
        templateApi.getList(),
        clusterApi.getGroups(),
      ]);
      setApplications(appsRes.data.data?.list || appsRes.data.data || []);
      setBusinessProjects(bpRes.data.data || []);
      setConnections(connRes.data.data || []);
      setRegistries(regRes.data.data || []);
      setNodes(nodesRes.data.data || []);
      setTemplates(tplRes.data.data || []);
      setGroups(groupsRes.data.data || []);
    } catch {
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [filterBusinessProject, filterName, filterRepo]);

  // ===== 部署覆盖参数操作函数 =====
  const addDeployPort = () => setDeployOverrides({ ...deployOverrides, ports: [...deployOverrides.ports, { host: '', container: '' }] });
  const removeDeployPort = (i) => setDeployOverrides({ ...deployOverrides, ports: deployOverrides.ports.filter((_, idx) => idx !== i) });
  const updateDeployPort = (i, field, val) => { const next = [...deployOverrides.ports]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, ports: next }); };

  const addDeployEnv = () => setDeployOverrides({ ...deployOverrides, env_vars: [...deployOverrides.env_vars, { key: '', value: '' }] });
  const removeDeployEnv = (i) => setDeployOverrides({ ...deployOverrides, env_vars: deployOverrides.env_vars.filter((_, idx) => idx !== i) });
  const updateDeployEnv = (i, field, val) => { const next = [...deployOverrides.env_vars]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, env_vars: next }); };

  const addDeployVolume = () => setDeployOverrides({ ...deployOverrides, volumes: [...deployOverrides.volumes, { host: '', container: '' }] });
  const removeDeployVolume = (i) => setDeployOverrides({ ...deployOverrides, volumes: deployOverrides.volumes.filter((_, idx) => idx !== i) });
  const updateDeployVolume = (i, field, val) => { const next = [...deployOverrides.volumes]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, volumes: next }); };

  // ===== 创建/编辑弹窗 =====
  const openModal = (app = null) => {
    setEditing(app);
    if (app) {
      const nodeIds = app.node_ids ? JSON.parse(app.node_ids) : [];
      const ports = app.ports ? JSON.parse(app.ports) : [];
      const envVarsObj = JSON.parse(app.env_vars || '{}');
      const envVars = Object.entries(envVarsObj).map(([k, v]) => ({ key: k, value: v }));
      const volumes = app.volumes ? JSON.parse(app.volumes) : [];
      form.setFieldsValue({
        name: app.name,
        business_project_id: app.business_project_id,
        description: app.description || '',
        gitlab_connection_id: app.gitlab_connection || null,
        repo_path: app.repo_path || '',
        default_branch: app.default_branch || 'main',
        build_type: app.build_type || 'java',
        dockerfile_source: app.dockerfile_source || 'repository',
        dockerfile_template_id: app.dockerfile_template_id || null,
        dockerfile_path: app.dockerfile_path || '',
        registry_id: app.registry_id || null,
        image_name: app.image_name || '',
        image_tag: app.image_tag || '',
        strategy: app.strategy || 'recreate',
        container_name: app.container_name || '',
        node_ids: nodeIds,
        ports,
        env_vars: envVars,
        volumes,
      });
      // 判断节点模式
      if (nodeIds.length > 0) {
        setDeployMode('nodes');
      } else {
        setDeployMode('nodes');
      }
      setGroupIds([]);
    } else {
      form.resetFields();
      form.setFieldsValue({
        default_branch: 'main',
        build_type: 'java',
        strategy: 'recreate',
        dockerfile_source: 'repository',
        node_ids: [],
        ports: [],
        env_vars: [],
        volumes: [],
      });
      setDeployMode('nodes');
      setGroupIds([]);
    }
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // 校验目标节点/分组
      if (deployMode === 'nodes' && (!values.node_ids || values.node_ids.length === 0)) {
        return message.warning('请选择目标节点');
      }
      if (deployMode === 'group' && groupIds.length === 0) {
        return message.warning('请选择目标分组');
      }

      const data = {
        ...values,
        gitlab_connection: values.gitlab_connection_id || null,
        node_ids: deployMode === 'group' ? undefined : JSON.stringify(values.node_ids || []),
        ports: JSON.stringify((values.ports || []).filter(p => p && p.host && p.container)),
        env_vars: JSON.stringify((values.env_vars || []).filter(e => e && e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {})),
        volumes: JSON.stringify((values.volumes || []).filter(v => v && v.host && v.container)),
      };
      delete data.gitlab_connection_id;

      if (deployMode === 'group') {
        data.group_ids = groupIds;
        delete data.node_ids;
      }

      if (editing) {
        await projectsApi.update(editing.id, data);
        message.success('应用已更新');
      } else {
        await projectsApi.create(data);
        message.success('应用已创建');
      }
      setModalVisible(false);
      fetchData();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.message || '操作失败');
    }
  };

  const handleDelete = async (id) => {
    try {
      await projectsApi.delete(id);
      message.success('应用已删除');
      fetchData();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  // ===== 详情抽屉 =====
  const handleViewDetail = async (app) => {
    setDetailApp(app);
    setDetailVisible(true);
    try {
      const [appRes, buildsRes, deploymentsRes] = await Promise.all([
        projectsApi.getById(app.id),
        buildApi.getList({ project_id: app.id, page: 1, pageSize: 20 }),
        deploymentApi.getList({ project_id: app.id, page: 1, pageSize: 20 }),
      ]);
      setDetailApp(appRes.data.data);
      setBuilds(buildsRes.data.data?.list || buildsRes.data.data || []);
      setDeployments(deploymentsRes.data.data?.list || deploymentsRes.data.data || []);
    } catch {
      message.error('获取详情失败');
    }
  };

  // ===== 构建弹窗 =====
  const openBuildModal = (app) => {
    setBuildApp(app);
    setBuildForm({
      branch: app.default_branch || 'main',
      dockerfile_source: app.dockerfile_source || 'repository',
      dockerfile_template_id: app.dockerfile_template_id || null,
      dockerfile_path: app.dockerfile_path || '',
      image_name: app.image_name || '',
      image_tag: app.image_tag || '',
    });
    setBuildModalVisible(true);
  };

  const doBuild = async () => {
    if (!buildApp) return message.error('未选择应用');
    try {
      await projectsApi.build(buildApp.id, buildForm);
      message.success('构建已触发');
      setBuildModalVisible(false);
      fetchData();
    } catch (err) {
      message.error(err.response?.data?.message || '构建失败');
    }
  };

  // ===== 部署弹窗 =====
  const handleOpenDeploy = async (app) => {
    setDetailApp(app);
    setSelectedBuildId(null);
    // 从应用配置初始化部署参数
    const ports = JSON.parse(app.ports || '[]');
    const envVarsObj = JSON.parse(app.env_vars || '{}');
    const envVars = Object.entries(envVarsObj).map(([key, value]) => ({ key, value }));
    const volumes = JSON.parse(app.volumes || '[]');
    setDeployOverrides({ ports, env_vars: envVars, volumes });
    // 初始化目标节点/容器名称/部署策略
    const nodeIds = JSON.parse(app.node_ids || '[]');
    setDeployConfig({
      node_ids: nodeIds,
      container_name: app.container_name || '',
      strategy: app.strategy || 'recreate',
    });
    setDeployModalMode('nodes');
    setDeployModalGroupIds([]);
    setDeployBuildsLoading(true);
    try {
      const res = await buildApi.getList({ project_id: app.id, status: 'success', page: 1, pageSize: 50 });
      setDeployBuilds(res.data.data?.list || res.data.data || []);
      setDeploySelectModalVisible(true);
    } catch {
      setDeployBuilds([]);
      message.error('获取构建列表失败');
    } finally {
      setDeployBuildsLoading(false);
    }
  };

  const doDeploy = async () => {
    if (!selectedBuildId) {
      return message.warning('请选择要部署的构建版本');
    }
    if (deployModalMode === 'nodes' && deployConfig.node_ids.length === 0) {
      return message.warning('请选择目标节点');
    }
    if (deployModalMode === 'group' && deployModalGroupIds.length === 0) {
      return message.warning('请选择目标分组');
    }
    try {
      const ports = deployOverrides.ports.filter(p => p.host && p.container);
      const env_vars = deployOverrides.env_vars.filter(e => e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {});
      const volumes = deployOverrides.volumes.filter(v => v.host && v.container);
      const payload = {
        build_id: selectedBuildId,
        ports,
        env_vars,
        volumes,
        container_name: deployConfig.container_name || undefined,
        strategy: deployConfig.strategy,
      };
      if (deployModalMode === 'group') {
        payload.group_ids = deployModalGroupIds;
      } else {
        payload.node_ids = deployConfig.node_ids;
      }
      await projectsApi.deploy(detailApp.id, payload);
      message.success('部署已触发');
      setDeploySelectModalVisible(false);
      fetchData();
    } catch (err) {
      message.error(err.response?.data?.message || '部署失败');
    }
  };

  // ===== 构建并部署（直接执行，不弹窗） =====
  const handleBuildAndDeploy = async (app) => {
    // 校验节点配置
    const nodeIds = JSON.parse(app.node_ids || '[]');
    if (nodeIds.length === 0) {
      return message.warning('应用未配置目标节点，请先编辑应用配置');
    }
    try {
      const res = await projectsApi.buildAndDeploy(app.id, {});
      const buildId = res.data.data?.build?.id;
      message.success('一键构建部署已触发');
      fetchData();

      if (buildId) {
        // 打开合并日志面板
        setMergedLogContent('');
        setMergedLogPhase('building');
        setMergedLogBuildId(buildId);
        setMergedLogVisible(true);

        // 建立 WebSocket 连接
        const token = localStorage.getItem('accessToken');
        if (mergedSocketRef.current) mergedSocketRef.current.disconnect();
        const socket = io('/', { auth: { token }, transports: ['websocket', 'polling'] });
        mergedSocketRef.current = socket;

        socket.on('connect', () => {
          socket.emit('subscribe-build', buildId);
        });

        socket.on('build-log', (data) => {
          if (data.buildId === buildId) {
            setMergedLogContent(prev => prev + data.line);
          }
        });

        socket.on('build-status', (data) => {
          if (data.buildId === buildId) {
            if (data.status === 'success') {
              setMergedLogContent(prev => prev + '\n═══════════ 部署阶段 ═══════════\n\n');
              setMergedLogPhase('deploying');
              deploymentApi.getList({ project_id: app.id, pageSize: 1 }).then(depRes => {
                const deps = depRes.data.data?.list || depRes.data.data || [];
                if (deps.length > 0 && (deps[0].status === 'deploying' || deps[0].status === 'pending')) {
                  const deployId = deps[0].id;
                  socket.emit('subscribe-deploy', deployId);
                }
              }).catch(() => {});
            } else if (data.status === 'failed') {
              setMergedLogPhase('done');
              fetchData();
            }
          }
        });

        socket.on('deploy-log', (data) => {
          setMergedLogContent(prev => prev + data.line);
        });

        socket.on('deploy-status', (data) => {
          if (['success', 'failed', 'cancelled'].includes(data.status)) {
            setMergedLogPhase('done');
            fetchData();
          }
        });
      }
    } catch (err) {
      message.error(err.response?.data?.message || '触发构建并部署失败');
    }
  };

  const closeMergedLog = () => {
    if (mergedSocketRef.current) {
      mergedSocketRef.current.disconnect();
      mergedSocketRef.current = null;
    }
    setMergedLogVisible(false);
    setMergedLogContent('');
    setMergedLogPhase('idle');
    setMergedLogBuildId(null);
  };

  // 合并日志自动滚动
  useEffect(() => {
    if (mergedLogRef.current) {
      mergedLogRef.current.scrollTop = mergedLogRef.current.scrollHeight;
    }
  }, [mergedLogContent]);

  // 组件卸载时清理 WebSocket
  useEffect(() => {
    return () => {
      if (mergedSocketRef.current) {
        mergedSocketRef.current.disconnect();
      }
    };
  }, []);

  // ===== 表格列 =====
  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    {
      title: '应用名称', dataIndex: 'name', width: 180, ellipsis: true,
      render: (name, record) => (
        <a onClick={() => handleViewDetail(record)}>{name}</a>
      ),
    },
    {
      title: '所属项目', dataIndex: 'business_project_name', width: 120, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '仓库', dataIndex: 'repo_path', width: 200, ellipsis: true,
      render: (v) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: '构建类型', dataIndex: 'build_type', width: 90,
      render: (t) => <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{t}</span>,
    },
    {
      title: '最新构建', width: 100,
      render: (_, record) => {
        const status = record.last_build_status;
        if (!status) return <span style={{ fontSize: 12, fontWeight: 300, color: '#999' }}>无</span>;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: buildStatusDotColors[status] || '#c7c7c7' }} />
            <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{buildStatusLabels[status] || status}</span>
          </span>
        );
      },
    },
    {
      title: '分支', dataIndex: 'last_build_branch', width: 100, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '最新部署', width: 100,
      render: (_, record) => {
        const status = record.last_deploy_status;
        if (!status) return <span style={{ fontSize: 12, fontWeight: 300, color: '#999' }}>无</span>;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: deployStatusDotColors[status] || '#c7c7c7' }} />
            <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{deployStatusLabels[status] || status}</span>
          </span>
        );
      },
    },
    {
      title: '创建人', dataIndex: 'created_by_name', width: 90, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '创建时间', dataIndex: 'created_at', width: 150,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作', width: 220, fixed: 'right',
      render: (_, record) => {
        const editable = canEdit(record);
        return (
          <Space>
            <Tooltip title="构建">
              <Button type="link" size="small" icon={<BuildOutlined />} onClick={() => openBuildModal(record)} disabled={!editable} />
            </Tooltip>
            <Tooltip title="部署">
              <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleOpenDeploy(record)} disabled={!editable} />
            </Tooltip>
            <Tooltip title="一键构建部署">
              <Button type="link" size="small" icon={<ThunderboltOutlined />} style={{ color: editable ? '#111' : undefined }} onClick={() => handleBuildAndDeploy(record)} disabled={!editable} />
            </Tooltip>
            <Tooltip title="查看详情">
              <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record)} />
            </Tooltip>
            <Tooltip title={!editable ? '无权操作' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)} disabled={!editable} />
            </Tooltip>
            <Tooltip title={!editable ? '无权操作' : ''}>
              <Popconfirm title="确认删除此应用？" onConfirm={() => handleDelete(record.id)} disabled={!editable}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!editable} />
              </Popconfirm>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const buildColumns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '分支', dataIndex: 'branch', width: 100 },
    {
      title: '状态', dataIndex: 'status', width: 80,
      render: (s) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: buildStatusDotColors[s] || '#c7c7c7' }} />
          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{buildStatusLabels[s] || s}</span>
        </span>
      ),
    },
    { title: '镜像', dataIndex: 'image_tag', width: 200, ellipsis: true },
    {
      title: '时间', dataIndex: 'created_at', width: 160,
      render: (t) => dayjs(t).format('YYYY-MM-DD HH:mm'),
    },
  ];

  const deployColumns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: deployStatusDotColors[s] || '#c7c7c7' }} />
          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{deployStatusLabels[s] || s}</span>
        </span>
      ),
    },
    { title: '镜像', dataIndex: 'image_tag', width: 200, ellipsis: true },
    {
      title: '时间', dataIndex: 'created_at', width: 160,
      render: (t) => dayjs(t).format('YYYY-MM-DD HH:mm'),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>应用管理</div>
        <Space wrap>
          <Select
            placeholder="按项目名称筛选"
            allowClear
            showSearch
            optionFilterProp="children"
            style={{ width: 180 }}
            value={filterBusinessProject}
            onChange={setFilterBusinessProject}
          >
            {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
          </Select>
          <Input placeholder="按应用名称筛选" prefix={<SearchOutlined />} value={filterName} onChange={(e) => setFilterName(e.target.value)} style={{ width: 180 }} allowClear />
          <Input placeholder="按仓库筛选" prefix={<SearchOutlined />} value={filterRepo} onChange={(e) => setFilterRepo(e.target.value)} style={{ width: 200 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新建应用</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={applications}
        loading={loading}
        scroll={{ x: 1200 }}
        size="middle"
      />

      {/* ===== 新建/编辑弹窗 ===== */}
      <Modal
        title={editing ? '编辑应用' : '新建应用'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={700}
        destroyOnHidden
      >
        <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Divider orientation="left" orientationMargin="0" plain>基本信息</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '请输入应用名称' }]}>
                <Input placeholder="如：用户服务" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="business_project_id" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
                <Select placeholder="选择所属项目" showSearch optionFilterProp="children">
                  {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
                </Select>
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="描述">
            <Input placeholder="应用描述（可选）" />
          </Form.Item>

          <Divider orientation="left" orientationMargin="0" plain>代码源</Divider>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="gitlab_connection_id" label="GitLab 连接">
                <Select placeholder="选择连接" allowClear showSearch optionFilterProp="children">
                  {connections.map(c => <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="repo_path" label="仓库路径" rules={[{ required: true, message: '请输入仓库路径' }]}>
                <Input placeholder="如：group/project-name" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="default_branch" label="默认分支">
                <Input placeholder="main" />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" orientationMargin="0" plain>构建配置</Divider>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="build_type" label="构建类型" rules={[{ required: true }]}>
                <Select>
                  <Select.Option value="java">Java</Select.Option>
                  <Select.Option value="nodejs">Node.js</Select.Option>
                  <Select.Option value="custom">自定义</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="dockerfile_source" label="Dockerfile 来源">
                <Select>
                  <Select.Option value="repository">仓库</Select.Option>
                  <Select.Option value="template">模板</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              {formDockerfileSource === 'template' && (
                <Form.Item name="dockerfile_template_id" label="Dockerfile 模板">
                  <Select placeholder="选择模板" allowClear showSearch optionFilterProp="children">
                    {templates.map(t => <Select.Option key={t.id} value={t.id}>{t.name} ({t.build_type})</Select.Option>)}
                  </Select>
                </Form.Item>
              )}
              {formDockerfileSource === 'repository' && (
                <Form.Item name="dockerfile_path" label="Dockerfile 路径">
                  <Input placeholder="如：docker/Dockerfile" />
                </Form.Item>
              )}
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="image_name" label="镜像名称">
                <Input placeholder="默认使用仓库名" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="image_tag" label="镜像标签">
                <Input placeholder="默认 yymmddhhmmss" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="registry_id" label="目标镜像仓库">
                <Select placeholder="选择仓库" allowClear showSearch optionFilterProp="children">
                  {registries.map(r => <Select.Option key={r.id} value={r.id}>{r.name}</Select.Option>)}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" orientationMargin="0" plain>部署配置</Divider>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>目标节点：</Text>
              <Radio.Group
                value={deployMode}
                onChange={(e) => { setDeployMode(e.target.value); setGroupIds([]); form.setFieldsValue({ node_ids: [] }); }}
                style={{ marginLeft: 12 }}
              >
                <Radio.Button value="nodes">主机节点</Radio.Button>
                <Radio.Button value="group">按分组</Radio.Button>
              </Radio.Group>
            </div>
            {deployMode === 'nodes' ? (
              <Form.Item name="node_ids" rules={[{ required: deployMode === 'nodes', message: '请选择至少一个节点' }]}>
                <Select mode="multiple" placeholder="选择部署节点（支持多选）" optionFilterProp="children">
                  {nodes.map(n => (
                    <Select.Option key={n.id} value={n.id}>
                      {n.name}（{n.host}）{n.group_name ? ` - ${n.group_name}` : ''}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            ) : (
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="children"
                style={{ width: '100%' }}
                placeholder="选择分组（将部署到分组内所有主机）"
                value={groupIds}
                onChange={setGroupIds}
              >
                {groups.map(g => (
                  <Select.Option key={g.id} value={g.id}>
                    {g.name}（{g.node_count || 0} 台主机）
                  </Select.Option>
                ))}
              </Select>
            )}
          </div>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="container_name" label="容器名称">
                <Input placeholder="自动生成" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="strategy" label="部署策略">
                <Select>
                  <Select.Option value="recreate">重新创建 (recreate)</Select.Option>
                  <Select.Option value="rolling">滚动更新 (rolling)</Select.Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" orientationMargin="0" plain>端口映射</Divider>
          <Form.List name="ports">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item {...restField} name={[name, 'host']} style={{ marginBottom: 0 }}>
                      <InputNumber placeholder="Host 端口" style={{ width: 130 }} />
                    </Form.Item>
                    <span>:</span>
                    <Form.Item {...restField} name={[name, 'container']} style={{ marginBottom: 0 }}>
                      <InputNumber placeholder="Container 端口" style={{ width: 130 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(name)} style={{ color: '#ff4d4f' }} />
                  </Space>
                ))}
                <Button type="dashed" size="small" onClick={() => add()} block icon={<PlusOutlined />}>添加端口映射</Button>
              </>
            )}
          </Form.List>

          <Divider orientation="left" orientationMargin="0" plain>环境变量</Divider>
          <Form.List name="env_vars">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item {...restField} name={[name, 'key']} style={{ marginBottom: 0 }}>
                      <Input placeholder="KEY" style={{ width: 140 }} />
                    </Form.Item>
                    <span>=</span>
                    <Form.Item {...restField} name={[name, 'value']} style={{ marginBottom: 0 }}>
                      <Input placeholder="VALUE" style={{ width: 180 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(name)} style={{ color: '#ff4d4f' }} />
                  </Space>
                ))}
                <Button type="dashed" size="small" onClick={() => add()} block icon={<PlusOutlined />}>添加环境变量</Button>
              </>
            )}
          </Form.List>

          <Divider orientation="left" orientationMargin="0" plain>卷挂载</Divider>
          <Form.List name="volumes">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item {...restField} name={[name, 'host']} style={{ marginBottom: 0 }}>
                      <Input placeholder="Host 路径" style={{ width: 180 }} />
                    </Form.Item>
                    <span>:</span>
                    <Form.Item {...restField} name={[name, 'container']} style={{ marginBottom: 0 }}>
                      <Input placeholder="Container 路径" style={{ width: 180 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(name)} style={{ color: '#ff4d4f' }} />
                  </Space>
                ))}
                <Button type="dashed" size="small" onClick={() => add()} block icon={<PlusOutlined />}>添加卷挂载</Button>
              </>
            )}
          </Form.List>
        </Form>
        </div>
      </Modal>

      {/* ===== 构建弹窗（增强版） ===== */}
      <Modal
        title="触发构建"
        open={buildModalVisible}
        onOk={doBuild}
        onCancel={() => setBuildModalVisible(false)}
        width={500}
      >
        <div style={{ marginBottom: 16 }}>
          <Text>分支：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.branch} onChange={e => setBuildForm({ ...buildForm, branch: e.target.value })} placeholder="main" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>Dockerfile 来源：</Text>
          <div style={{ marginTop: 8 }}>
            <Select style={{ width: '100%' }} value={buildForm.dockerfile_source} onChange={val => setBuildForm({ ...buildForm, dockerfile_source: val })}>
              <Select.Option value="repository">使用代码仓库dockerfile</Select.Option>
              <Select.Option value="template">使用模板</Select.Option>
            </Select>
          </div>
        </div>
        {buildForm.dockerfile_source === 'template' && (
          <div style={{ marginBottom: 16 }}>
            <Text>Dockerfile 模板：</Text>
            <Select showSearch style={{ width: '100%', marginTop: 8 }} placeholder="选择模板（可选）" optionFilterProp="children" allowClear value={buildForm.dockerfile_template_id} onChange={val => setBuildForm({ ...buildForm, dockerfile_template_id: val })}>
              {templates.map(t => <Select.Option key={t.id} value={t.id}>{t.name} ({t.build_type})</Select.Option>)}
            </Select>
          </div>
        )}
        {buildForm.dockerfile_source === 'repository' && (
          <div style={{ marginBottom: 16 }}>
            <Text>Dockerfile 路径：</Text>
            <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.dockerfile_path} onChange={e => setBuildForm({ ...buildForm, dockerfile_path: e.target.value })} placeholder="可选，如 docker/Dockerfile" />
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <Text>镜像名称（可选）：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.image_name} onChange={e => setBuildForm({ ...buildForm, image_name: e.target.value })} placeholder="默认使用应用名" />
        </div>
        <div>
          <Text>镜像标签（可选）：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.image_tag} onChange={e => setBuildForm({ ...buildForm, image_tag: e.target.value })} placeholder="默认 yymmddhhmmss" />
        </div>
      </Modal>

      {/* ===== 选择构建版本部署弹窗（带覆盖参数） ===== */}
      <Modal
        title={`选择构建版本部署 - ${detailApp?.name || ''}`}
        open={deploySelectModalVisible}
        onOk={doDeploy}
        onCancel={() => setDeploySelectModalVisible(false)}
        okText="确认部署"
        width={680}
      >
        <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
        <div style={{ marginBottom: 8 }}>
          <Text>选择要部署的构建版本：</Text>
        </div>
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择构建版本"
          optionFilterProp="children"
          value={selectedBuildId}
          onChange={setSelectedBuildId}
          loading={deployBuildsLoading}
        >
          {deployBuilds.map(b => (
            <Select.Option key={b.id} value={b.id}>
              #{b.id} | {b.image_tag || '无镜像'} | {dayjs(b.created_at).format('MM-DD HH:mm')} | <Tag color={buildStatusDotColors[b.status]} style={{ margin: 0 }}>{b.status}</Tag>
            </Select.Option>
          ))}
        </Select>
        {selectedBuildId && (() => {
          const b = deployBuilds.find(x => x.id === selectedBuildId);
          return b ? (
            <div style={{ marginTop: 16, padding: 12, background: '#f5f5f5', borderRadius: 6 }}>
              <div><Text strong>构建 #{b.id}</Text></div>
              <div>镜像：{b.image_tag || '-'}</div>
              <div>分支：{b.branch}</div>
              <div>时间：{dayjs(b.created_at).format('YYYY-MM-DD HH:mm:ss')}</div>
            </div>
          ) : null;
        })()}

        <Divider style={{ margin: '16px 0 12px' }}>部署配置</Divider>
        <div style={{ padding: 12, background: '#fafafa', borderRadius: 6, marginBottom: 8 }}>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">目标节点：</Text>
            <Radio.Group
              value={deployModalMode}
              onChange={(e) => {
                setDeployModalMode(e.target.value);
                setDeployModalGroupIds([]);
                setDeployConfig({ ...deployConfig, node_ids: [] });
              }}
              style={{ marginLeft: 12 }}
              size="small"
            >
              <Radio.Button value="nodes">主机节点</Radio.Button>
              <Radio.Button value="group">按分组</Radio.Button>
            </Radio.Group>
            {deployModalMode === 'nodes' ? (
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="children"
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择部署节点"
                value={deployConfig.node_ids}
                onChange={(val) => setDeployConfig({ ...deployConfig, node_ids: val })}
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
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择分组（将部署到分组内所有主机）"
                value={deployModalGroupIds}
                onChange={setDeployModalGroupIds}
              >
                {groups.map(g => (
                  <Select.Option key={g.id} value={g.id}>
                    {g.name}（{g.node_count || 0} 台主机）
                  </Select.Option>
                ))}
              </Select>
            )}
          </div>
          <Row gutter={16}>
            <Col span={12}>
              <Text type="secondary">容器名称：</Text>
              <Input
                style={{ marginTop: 8 }}
                placeholder="自动生成"
                value={deployConfig.container_name}
                onChange={(e) => setDeployConfig({ ...deployConfig, container_name: e.target.value })}
              />
            </Col>
            <Col span={12}>
              <Text type="secondary">部署策略：</Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                value={deployConfig.strategy}
                onChange={(val) => setDeployConfig({ ...deployConfig, strategy: val })}
              >
                <Select.Option value="recreate">重新创建 (recreate)</Select.Option>
                <Select.Option value="rolling">滚动更新 (rolling)</Select.Option>
              </Select>
            </Col>
          </Row>
        </div>

        <Divider style={{ margin: '16px 0 12px' }}>端口映射</Divider>
        {deployOverrides.ports.map((p, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <InputNumber placeholder="Host 端口" value={p.host} onChange={(v) => updateDeployPort(i, 'host', v)} style={{ width: 130 }} />
            <span>:</span>
            <InputNumber placeholder="Container 端口" value={p.container} onChange={(v) => updateDeployPort(i, 'container', v)} style={{ width: 130 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeDeployPort(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addDeployPort}>添加端口</Button>

        <Divider style={{ margin: '16px 0 12px' }}>环境变量</Divider>
        {deployOverrides.env_vars.map((e, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input placeholder="KEY" value={e.key} onChange={(ev) => updateDeployEnv(i, 'key', ev.target.value)} style={{ width: 140 }} />
            <span>=</span>
            <Input placeholder="VALUE" value={e.value} onChange={(ev) => updateDeployEnv(i, 'value', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeDeployEnv(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addDeployEnv}>添加变量</Button>

        <Divider style={{ margin: '16px 0 12px' }}>卷挂载</Divider>
        {deployOverrides.volumes.map((v, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input placeholder="Host 路径" value={v.host} onChange={(ev) => updateDeployVolume(i, 'host', ev.target.value)} style={{ width: 180 }} />
            <span>:</span>
            <Input placeholder="Container 路径" value={v.container} onChange={(ev) => updateDeployVolume(i, 'container', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeDeployVolume(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addDeployVolume}>添加挂载</Button>
        </div>
      </Modal>

      {/* ===== 详情抽屉（增强版） ===== */}
      <Drawer
        title={
          <Space>
            <span>{detailApp?.name}</span>
            {detailApp && <span style={{ fontSize: 12, fontWeight: 300, color: '#999', marginLeft: 8 }}>{detailApp.strategy || 'recreate'}</span>}
          </Space>
        }
        open={detailVisible}
        onClose={() => setDetailVisible(false)}
        width={800}
      >
        {detailApp && (
          <>
            <Descriptions bordered column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="应用名称">{detailApp.name}</Descriptions.Item>
              <Descriptions.Item label="所属项目">{detailApp.business_project_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="仓库路径" span={2}>{detailApp.repo_path}</Descriptions.Item>
              <Descriptions.Item label="构建类型">{detailApp.build_type}</Descriptions.Item>
              <Descriptions.Item label="分支">{detailApp.default_branch || 'main'}</Descriptions.Item>
              <Descriptions.Item label="Dockerfile 来源">
                {detailApp.dockerfile_source === 'repository' ? '代码仓库' : detailApp.dockerfile_source === 'template' ? '模板' : detailApp.dockerfile_source || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Dockerfile 路径">
                {detailApp.dockerfile_source === 'repository' ? (detailApp.dockerfile_path || 'Dockerfile（根目录）') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="镜像名称">{detailApp.image_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="镜像标签">{detailApp.image_tag || '-'}</Descriptions.Item>
              <Descriptions.Item label="容器名称">{detailApp.container_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="部署策略">{detailApp.strategy === 'recreate' ? '重新创建' : detailApp.strategy === 'rolling' ? '滚动更新' : detailApp.strategy || '-'}</Descriptions.Item>
              <Descriptions.Item label="目标节点" span={2}>
                {detailApp.node_ids ? (() => {
                  const ids = JSON.parse(detailApp.node_ids || '[]');
                  return ids.length > 0
                    ? ids.map(id => {
                        const node = nodes.find(n => n.id === id);
                        return node ? <Tag key={id}>{node.name} ({node.host})</Tag> : <Tag key={id}>#{id}</Tag>;
                      })
                    : '-';
                })() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="端口映射" span={2}>
                {(() => {
                  const ports = JSON.parse(detailApp.ports || '[]');
                  return ports.length > 0
                    ? ports.map((p, i) => <Tag key={i}>{p.host}:{p.container}</Tag>)
                    : '-';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="环境变量" span={2}>
                {(() => {
                  const envVars = JSON.parse(detailApp.env_vars || '{}');
                  const entries = Object.entries(envVars);
                  return entries.length > 0
                    ? entries.map(([k, v], i) => <Tag key={i}>{k}={v}</Tag>)
                    : '-';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="卷挂载" span={2}>
                {(() => {
                  const volumes = JSON.parse(detailApp.volumes || '[]');
                  return volumes.length > 0
                    ? volumes.map((v, i) => <Tag key={i}>{v.host}:{v.container}</Tag>)
                    : '-';
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{detailApp.description || '-'}</Descriptions.Item>
            </Descriptions>

            <Tabs items={[
              {
                key: 'builds',
                label: `构建历史 (${builds.length})`,
                children: (
                  <Table
                    rowKey="id"
                    columns={buildColumns}
                    dataSource={builds}
                    pagination={false}
                    size="small"
                  />
                ),
              },
              {
                key: 'deployments',
                label: `部署历史 (${deployments.length})`,
                children: (
                  <Table
                    rowKey="id"
                    columns={deployColumns}
                    dataSource={deployments}
                    pagination={false}
                    size="small"
                  />
                ),
              },
            ]} />
          </>
        )}
      </Drawer>

      {/* ===== 合并日志面板 ===== */}
      <Drawer
        title={
          <Space>
            <ThunderboltOutlined style={{ color: '#111' }} />
            <span>构建并部署</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: { building: '#ff9500', deploying: '#ff9500', done: '#34c759', idle: '#c7c7c7' }[mergedLogPhase] || '#c7c7c7' }} />
              <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{mergedLogPhase === 'building' ? '构建中' : mergedLogPhase === 'deploying' ? '部署中' : mergedLogPhase === 'done' ? '完成' : '等待中'}</span>
            </span>
          </Space>
        }
        open={mergedLogVisible}
        onClose={closeMergedLog}
        width={750}
        styles={{ body: { padding: 0 } }}
      >
        <div
          ref={mergedLogRef}
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
          {mergedLogContent || '等待日志输出...'}
        </div>
      </Drawer>
    </div>
  );
}

export default Applications;
