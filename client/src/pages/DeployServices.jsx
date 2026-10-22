import React, { useEffect, useState, useRef } from 'react';
import {
  Table, Button, Space, Tag, message, Typography, Modal, Form, Input, InputNumber, Select, Checkbox,
  Popconfirm, Drawer, Descriptions, Timeline, Card, Row, Col, Statistic, Divider, Radio, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, CaretRightOutlined, MinusCircleOutlined,
  RocketOutlined, ArrowLeftOutlined, SettingOutlined, ThunderboltOutlined, ConsoleSqlOutlined,
} from '@ant-design/icons';
import { deployServiceApi } from '../api/deployServices';
import { buildApi } from '../api/builds';
import { projectApi, businessProjectsApi } from '../api/projects';
import { clusterApi } from '../api/clusters';
import { deploymentApi } from '../api/deployments';
import { io } from 'socket.io-client';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const buildStatusDotColors = { pending: '#c7c7c7', building: '#ff9500', success: '#34c759', failed: '#ff3b30', cancelled: '#c7c7c7' };
const buildStatusLabels = { pending: '等待', building: '构建中', success: '成功', failed: '失败', cancelled: '已取消' };
const deployStatusDotColors = { pending: '#c7c7c7', deploying: '#ff9500', success: '#34c759', failed: '#ff3b30', rolled_back: '#ff9500', cancelled: '#c7c7c7' };
const deployStatusLabels = { pending: '等待', deploying: '部署中', success: '成功', failed: '失败', rolled_back: '已回滚', cancelled: '已取消' };

function DeployServices() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [projects, setProjects] = useState([]);
  const [businessProjects, setBusinessProjects] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [form] = Form.useForm();
  const formDockerfileSource = Form.useWatch('dockerfile_source', form);
  const formBusinessProject = Form.useWatch('business_project_id', form);
  const { user } = useSelector((state) => state.auth);
  const navigate = useNavigate();

  // 目标节点模式
  const [deployMode, setDeployMode] = useState('nodes');
  const [groupIds, setGroupIds] = useState([]);

  // 详情抽屉
  const [detailDrawer, setDetailDrawer] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 构建弹窗
  const [buildModalVisible, setBuildModalVisible] = useState(false);
  const [buildService, setBuildService] = useState(null);
  const [buildForm, setBuildForm] = useState({ branch: 'main', dockerfile_source: 'template', dockerfile_template_id: null, dockerfile_path: '', image_name: '', image_tag: '' });
  const [templates, setTemplates] = useState([]);

  // 部署弹窗
  const [deployModalVisible, setDeployModalVisible] = useState(false);
  const [deployService, setDeployService] = useState(null);
  const [deployBuilds, setDeployBuilds] = useState([]);
  const [deployBuildsLoading, setDeployBuildsLoading] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState(null);
  const [deployOverrides, setDeployOverrides] = useState({ ports: [], env_vars: [], volumes: [] });

  // 构建并部署
  const [bdModalVisible, setBdModalVisible] = useState(false);
  const [bdService, setBdService] = useState(null);
  const [bdForm, setBdForm] = useState({ branch: 'main', dockerfile_source: 'repository', dockerfile_template_id: null, dockerfile_path: '', image_name: '', image_tag: '' });
  const [bdLoading, setBdLoading] = useState(false);
  const [bdOverrides, setBdOverrides] = useState({ ports: [], env_vars: [], volumes: [] });

  // 合并日志面板
  const [mergedLogVisible, setMergedLogVisible] = useState(false);
  const [mergedLogContent, setMergedLogContent] = useState('');
  const [mergedLogPhase, setMergedLogPhase] = useState('idle'); // idle | building | deploying | done
  const [mergedLogBuildId, setMergedLogBuildId] = useState(null);
  const mergedLogRef = useRef(null);
  const mergedSocketRef = useRef(null);

  const addDeployPort = () => setDeployOverrides({ ...deployOverrides, ports: [...deployOverrides.ports, { host: '', container: '' }] });
  const removeDeployPort = (i) => setDeployOverrides({ ...deployOverrides, ports: deployOverrides.ports.filter((_, idx) => idx !== i) });
  const updateDeployPort = (i, field, val) => { const next = [...deployOverrides.ports]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, ports: next }); };

  const addDeployEnv = () => setDeployOverrides({ ...deployOverrides, env_vars: [...deployOverrides.env_vars, { key: '', value: '' }] });
  const removeDeployEnv = (i) => setDeployOverrides({ ...deployOverrides, env_vars: deployOverrides.env_vars.filter((_, idx) => idx !== i) });
  const updateDeployEnv = (i, field, val) => { const next = [...deployOverrides.env_vars]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, env_vars: next }); };

  const addDeployVolume = () => setDeployOverrides({ ...deployOverrides, volumes: [...deployOverrides.volumes, { host: '', container: '' }] });
  const removeDeployVolume = (i) => setDeployOverrides({ ...deployOverrides, volumes: deployOverrides.volumes.filter((_, idx) => idx !== i) });
  const updateDeployVolume = (i, field, val) => { const next = [...deployOverrides.volumes]; next[i] = { ...next[i], [field]: val }; setDeployOverrides({ ...deployOverrides, volumes: next }); };

  // 构建并部署 - 端口/环境变量/卷挂载 操作函数
  const addBdPort = () => setBdOverrides({ ...bdOverrides, ports: [...bdOverrides.ports, { host: '', container: '' }] });
  const removeBdPort = (i) => setBdOverrides({ ...bdOverrides, ports: bdOverrides.ports.filter((_, idx) => idx !== i) });
  const updateBdPort = (i, field, val) => { const next = [...bdOverrides.ports]; next[i] = { ...next[i], [field]: val }; setBdOverrides({ ...bdOverrides, ports: next }); };

  const addBdEnv = () => setBdOverrides({ ...bdOverrides, env_vars: [...bdOverrides.env_vars, { key: '', value: '' }] });
  const removeBdEnv = (i) => setBdOverrides({ ...bdOverrides, env_vars: bdOverrides.env_vars.filter((_, idx) => idx !== i) });
  const updateBdEnv = (i, field, val) => { const next = [...bdOverrides.env_vars]; next[i] = { ...next[i], [field]: val }; setBdOverrides({ ...bdOverrides, env_vars: next }); };

  const addBdVolume = () => setBdOverrides({ ...bdOverrides, volumes: [...bdOverrides.volumes, { host: '', container: '' }] });
  const removeBdVolume = (i) => setBdOverrides({ ...bdOverrides, volumes: bdOverrides.volumes.filter((_, idx) => idx !== i) });
  const updateBdVolume = (i, field, val) => { const next = [...bdOverrides.volumes]; next[i] = { ...next[i], [field]: val }; setBdOverrides({ ...bdOverrides, volumes: next }); };

  const canWrite = (projectId) => {
    if (user.role === 'admin') return true;
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;
    return ['admin', 'owner', 'developer'].includes(project.current_user_role);
  };

  const fetchServices = async () => {
    setLoading(true);
    try {
      const res = await deployServiceApi.getList();
      setServices(res.data.data);
    } catch {
      message.error('获取应用发布列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServices();
    projectApi.getList({ pageSize: 100 }).then(res => setProjects(res.data.data.list)).catch(() => {});
    businessProjectsApi.getList().then(res => setBusinessProjects(res.data.data)).catch(() => {});
    clusterApi.getNodes().then(res => setNodes(res.data.data)).catch(() => {});
    clusterApi.getGroups().then(res => setGroups(res.data.data)).catch(() => {});
  }, []);

  const openCreateModal = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ strategy: 'recreate', is_default: false, branch: 'main', dockerfile_source: 'repository' });
    setDeployMode('nodes');
    setGroupIds([]);
    setModalVisible(true);
    // 加载 Dockerfile 模板列表
    import('../api/index').then(api => api.default.get('/templates'))
      .then(res => setTemplates(res.data.data))
      .catch(() => {});
  };

  const openEditModal = (service) => {
    setEditing(service);
    const envVarsObj = JSON.parse(service.env_vars || '{}');
    const envVarsArr = Object.entries(envVarsObj).map(([key, value]) => ({ key, value }));
    const project = projects.find(p => p.id === service.project_id);
    form.setFieldsValue({
      business_project_id: project?.business_project_id || null,
      project_id: service.project_id,
      node_ids: JSON.parse(service.node_ids || '[]'),
      ports: JSON.parse(service.ports || '[]'),
      env_vars: envVarsArr,
      volumes: JSON.parse(service.volumes || '[]'),
      strategy: service.strategy,
      container_name: service.container_name,
      description: service.description,
      is_default: !!service.is_default,
      branch: service.branch || 'main',
      dockerfile_source: service.dockerfile_source || 'repository',
      dockerfile_template_id: service.dockerfile_template_id || null,
      dockerfile_path: service.dockerfile_path || '',
      image_name: service.image_name || '',
      image_tag: service.image_tag || '',
    });
    setModalVisible(true);
    // 加载 Dockerfile 模板列表
    import('../api/index').then(api => api.default.get('/templates'))
      .then(res => setTemplates(res.data.data))
      .catch(() => {});
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

      const payload = {
        ...values,
        ports: (values.ports || []).filter(p => p && p.host && p.container),
        env_vars: (values.env_vars || []).filter(e => e && e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {}),
        volumes: (values.volumes || []).filter(v => v && v.host && v.container),
      };
      delete payload.business_project_id;

      if (deployMode === 'group') {
        payload.group_ids = groupIds;
        delete payload.node_ids;
      }

      if (editing) {
        await deployServiceApi.update(editing.id, payload);
        message.success('应用发布已更新');
      } else {
        await deployServiceApi.create(payload);
        message.success('应用发布已创建');
      }
      setModalVisible(false);
      fetchServices();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deployServiceApi.delete(id);
      message.success('应用发布已删除');
      fetchServices();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handleViewDetail = async (service) => {
    setDetailDrawer(service);
    setDetailLoading(true);
    try {
      const res = await deployServiceApi.getById(service.id);
      setDetailDrawer(res.data.data);
    } catch {
      message.error('获取详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const openBuildModal = (service) => {
    setBuildService(service);
    setBuildForm({
      branch: service.branch || 'main',
      dockerfile_source: service.dockerfile_source || 'repository',
      dockerfile_template_id: service.dockerfile_template_id || null,
      dockerfile_path: service.dockerfile_path || '',
      image_name: service.image_name || '',
      image_tag: service.image_tag || '',
    });
    setBuildModalVisible(true);
    // 加载模板
    import('../api/index').then(api => api.default.get('/templates'))
      .then(res => setTemplates(res.data.data))
      .catch(() => {});
  };

  const handleTriggerBuild = async (service) => {
    if (!service) return message.error('未选择服务');
    try {
      await deployServiceApi.build(service.id, buildForm);
      message.success('构建已触发');
      setBuildModalVisible(false);
      fetchServices();
    } catch (err) {
      message.error(err.response?.data?.message || '触发构建失败');
    }
  };

  const openDeployModal = async (service) => {
    setDeployService(service);
    setSelectedBuildId(null);
    // 从服务配置初始化端口/环境变量/卷挂载
    const ports = JSON.parse(service.ports || '[]');
    const envVarsObj = JSON.parse(service.env_vars || '{}');
    const envVars = Object.entries(envVarsObj).map(([key, value]) => ({ key, value }));
    const volumes = JSON.parse(service.volumes || '[]');
    setDeployOverrides({ ports, env_vars: envVars, volumes });
    setDeployBuildsLoading(true);
    try {
      const res = await buildApi.getList({ project_id: service.project_id, status: 'success', pageSize: 50 });
      setDeployBuilds(res.data.data.list);
      setDeployModalVisible(true);
    } catch {
      message.error('获取构建列表失败');
    } finally {
      setDeployBuildsLoading(false);
    }
  };

  const handleTriggerDeploy = async (service) => {
    if (!service) return message.error('未选择服务');
    if (!selectedBuildId) return message.warning('请选择构建版本');
    try {
      const ports = deployOverrides.ports.filter(p => p.host && p.container);
      const env_vars = deployOverrides.env_vars.filter(e => e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {});
      const volumes = deployOverrides.volumes.filter(v => v.host && v.container);
      await deployServiceApi.deploy(service.id, { build_id: selectedBuildId, ports, env_vars, volumes });
      message.success('部署已触发');
      setDeployModalVisible(false);
      fetchServices();
    } catch (err) {
      message.error(err.response?.data?.message || '部署失败');
    }
  };

  // ===== 构建并部署 =====
  const openBuildAndDeploy = (service) => {
    setBdService(service);
    setBdForm({
      branch: service.branch || 'main',
      dockerfile_source: service.dockerfile_source || 'repository',
      dockerfile_template_id: service.dockerfile_template_id || null,
      dockerfile_path: service.dockerfile_path || '',
      image_name: service.image_name || '',
      image_tag: service.image_tag || '',
    });
    // 从服务配置初始化端口/环境变量/卷挂载
    const ports = JSON.parse(service.ports || '[]');
    const envVarsObj = JSON.parse(service.env_vars || '{}');
    const envVars = Object.entries(envVarsObj).map(([key, value]) => ({ key, value }));
    const volumes = JSON.parse(service.volumes || '[]');
    setBdOverrides({ ports, env_vars: envVars, volumes });
    setBdModalVisible(true);
    import('../api/index').then(api => api.default.get('/templates'))
      .then(res => setTemplates(res.data.data))
      .catch(() => {});
  };

  const handleBuildAndDeploy = async () => {
    if (!bdService) return;
    setBdLoading(true);
    try {
      const ports = bdOverrides.ports.filter(p => p.host && p.container);
      const env_vars = bdOverrides.env_vars.filter(e => e.key).reduce((acc, e) => { acc[e.key] = e.value; return acc; }, {});
      const volumes = bdOverrides.volumes.filter(v => v.host && v.container);
      const res = await deployServiceApi.buildAndDeploy(bdService.id, { ...bdForm, ports, env_vars, volumes });
      const { build_id } = res.data.data;
      message.success('构建并部署已触发');
      setBdModalVisible(false);
      fetchServices();

      // 打开合并日志面板
      setMergedLogContent('');
      setMergedLogPhase('building');
      setMergedLogBuildId(build_id);
      setMergedLogVisible(true);

      // 建立 WebSocket 连接
      const token = localStorage.getItem('accessToken');
      if (mergedSocketRef.current) mergedSocketRef.current.disconnect();
      const socket = io('/', { auth: { token }, transports: ['websocket', 'polling'] });
      mergedSocketRef.current = socket;

      // 订阅构建日志
      socket.on('connect', () => {
        socket.emit('subscribe-build', build_id);
      });

      socket.on('build-log', (data) => {
        if (data.buildId === build_id) {
          setMergedLogContent(prev => prev + data.line);
        }
      });

      socket.on('build-status', (data) => {
        if (data.buildId === build_id) {
          if (data.status === 'success') {
            setMergedLogContent(prev => prev + '\n═══════════ 部署阶段 ═══════════\n\n');
            setMergedLogPhase('deploying');
            // 构建成功后，查找最新的部署记录并订阅部署日志
            deploymentApi.getList({ deploy_service_id: bdService.id, pageSize: 1 }).then(depRes => {
              const deps = depRes.data.data.list;
              if (deps && deps.length > 0 && (deps[0].status === 'deploying' || deps[0].status === 'pending')) {
                const deployId = deps[0].id;
                socket.emit('subscribe-deploy', deployId);
              }
            }).catch(() => {});
          } else if (data.status === 'failed') {
            setMergedLogPhase('done');
            fetchServices();
          }
        }
      });

      socket.on('deploy-log', (data) => {
        setMergedLogContent(prev => prev + data.line);
      });

      socket.on('deploy-status', (data) => {
        if (['success', 'failed', 'cancelled'].includes(data.status)) {
          setMergedLogPhase('done');
          fetchServices();
        }
      });
    } catch (err) {
      message.error(err.response?.data?.message || '触发构建并部署失败');
    } finally {
      setBdLoading(false);
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

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    {
      title: '项目', dataIndex: 'business_project_name', width: 120, ellipsis: true,
      render: (name) => name || '-',
    },
    {
      title: '模块', dataIndex: 'project_name', width: 130, ellipsis: true,
      render: (name, record) => (
        <a onClick={() => {}} >{name}</a>
      ),
    },
    {
      title: '最新构建', width: 120,
      render: (_, record) => record.latest_build ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: buildStatusDotColors[record.latest_build.status] || '#c7c7c7' }} />
          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{buildStatusLabels[record.latest_build.status] || record.latest_build.status}</span>
        </span>
      ) : '-',
    },
    {
      title: '最新部署', width: 120,
      render: (_, record) => record.latest_deploy ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: deployStatusDotColors[record.latest_deploy.status] || '#c7c7c7' }} />
          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{deployStatusLabels[record.latest_deploy.status] || record.latest_deploy.status}</span>
        </span>
      ) : '-',
    },
    {
      title: '策略', dataIndex: 'strategy', width: 80,
      render: (s) => <span style={{ fontSize: 12, fontWeight: 300, color: '#666' }}>{s}</span>,
    },
    {
      title: '操作', width: 350, fixed: 'right',
      render: (_, record) => {
        const hasAccess = canWrite(record.project_id);
        return (
          <Space>
            <Button type="link" size="small" onClick={() => handleViewDetail(record)}>详情</Button>
            {hasAccess && (
              <>
                <Button type="link" size="small" icon={<CaretRightOutlined />} onClick={() => openBuildModal(record)}>构建</Button>
                <Button type="link" size="small" icon={<RocketOutlined />} onClick={() => openDeployModal(record)}>部署</Button>
                <Button type="link" size="small" icon={<ThunderboltOutlined />} style={{ color: '#111' }} onClick={() => openBuildAndDeploy(record)}>构建并部署</Button>
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditModal(record)} />
                <Popconfirm title="确认删除？删除后历史记录不会丢失" onConfirm={() => handleDelete(record.id)}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111', marginBottom: 16 }}>应用发布</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>新建应用发布</Button>
      </div>

      <Table rowKey="id" columns={columns} dataSource={services} loading={loading} scroll={{ x: 1200 }} size="middle" />

      {/* 创建/编辑弹窗 */}
      <Modal
        title={editing ? '编辑应用发布' : '新建应用发布'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={680}
        destroyOnClose
      >
        <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
        <Form form={form} layout="vertical">
          <Form.Item name="business_project_id" label="所属项目">
            <Select
              placeholder="选择项目"
              showSearch
              optionFilterProp="children"
              allowClear
              onChange={(val) => {
                form.setFieldsValue({ project_id: undefined });
              }}
            >
              {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="project_id" label="所属模块" rules={[{ required: true }]}>
            <Select placeholder="选择模块" showSearch optionFilterProp="children">
              {(formBusinessProject ? projects.filter(p => p.business_project_id === formBusinessProject) : projects).map(p => (
                <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Divider orientation="left" style={{ margin: '8px 0 16px', fontSize: 13 }}>构建配置</Divider>
          <Form.Item name="branch" label="分支">
            <Input placeholder="默认 main" />
          </Form.Item>
          <Form.Item name="dockerfile_source" label="Dockerfile 来源">
            <Radio.Group>
              <Radio value="repository">使用代码仓库dockerfile</Radio>
              <Radio value="template">使用模板</Radio>
            </Radio.Group>
          </Form.Item>
          {formDockerfileSource === 'template' && (
            <Form.Item name="dockerfile_template_id" label="Dockerfile 模板">
              <Select showSearch placeholder="选择模板（可选）" optionFilterProp="children" allowClear>
                {templates.map(t => <Select.Option key={t.id} value={t.id}>{t.name} ({t.build_type})</Select.Option>)}
              </Select>
            </Form.Item>
          )}
          {formDockerfileSource === 'repository' && (
            <Form.Item name="dockerfile_path" label="Dockerfile 路径">
              <Input placeholder="可选，相对于仓库根目录，如 docker/Dockerfile" />
            </Form.Item>
          )}
          <Form.Item name="image_name" label="镜像名称">
            <Input placeholder="可选，例如：myregistry/my-app" />
          </Form.Item>
          <Form.Item name="image_tag" label="镜像标签">
            <Input placeholder="可选，例如：latest、v1.0" />
          </Form.Item>
          <Divider orientation="left" style={{ margin: '8px 0 16px', fontSize: 13 }}>部署配置</Divider>
          <div style={{ marginBottom: 24 }}>
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
                placeholder="选择分组（支持多选，将部署到分组内所有主机）"
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
          <Form.Item name="strategy" label="部署策略">
            <Select>
              <Select.Option value="recreate">重新创建 (recreate)</Select.Option>
              <Select.Option value="rolling">滚动更新 (rolling)</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="container_name" label="容器名称">
            <Input placeholder="可选，默认使用仓库名-app" />
          </Form.Item>
          <Divider orientation="left" style={{ margin: '8px 0 16px', fontSize: 13 }}>端口映射</Divider>
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
          <Divider orientation="left" style={{ margin: '16px 0 12px', fontSize: 13 }}>环境变量</Divider>
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
          <Divider orientation="left" style={{ margin: '16px 0 12px', fontSize: 13 }}>卷挂载</Divider>
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
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
          <Form.Item name="is_default" valuePropName="checked">
            <Checkbox>设为默认应用发布</Checkbox>
          </Form.Item>
        </Form>
        </div>
      </Modal>
      <Modal
        title="触发构建"
        open={buildModalVisible}
        onOk={() => handleTriggerBuild(buildService)}
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
          <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.image_name} onChange={e => setBuildForm({ ...buildForm, image_name: e.target.value })} placeholder="例如：myregistry/my-app" />
        </div>
        <div>
          <Text>镜像标签（可选）：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={buildForm.image_tag} onChange={e => setBuildForm({ ...buildForm, image_tag: e.target.value })} placeholder="例如：latest、v1.0" />
        </div>
      </Modal>

      {/* 部署弹窗 */}
      <Modal
        title="选择构建版本部署"
        open={deployModalVisible}
        onOk={() => handleTriggerDeploy(deployService)}
        onCancel={() => setDeployModalVisible(false)}
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

      {/* 详情抽屉 */}
      <Drawer
        title={
          <Space>
            <span>{detailDrawer?.project_name}</span>
            {detailDrawer && <span style={{ fontSize: 12, fontWeight: 300, color: '#999', marginLeft: 8 }}>{detailDrawer.strategy}</span>}
          </Space>
        }
        open={!!detailDrawer}
        onClose={() => setDetailDrawer(null)}
        width={700}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
        ) : detailDrawer ? (
          <div>
            <Descriptions bordered column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="项目">{detailDrawer.business_project_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="模块">{detailDrawer.project_name}</Descriptions.Item>
              <Descriptions.Item label="策略">{detailDrawer.strategy}</Descriptions.Item>
              <Descriptions.Item label="分支">{detailDrawer.branch || 'main'}</Descriptions.Item>
              <Descriptions.Item label="Dockerfile 来源">
                {detailDrawer.dockerfile_source === 'repository' ? '使用代码仓库dockerfile' : detailDrawer.dockerfile_source === 'template' ? '使用模板' : detailDrawer.dockerfile_source || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Dockerfile 路径">
                {detailDrawer.dockerfile_source === 'repository' ? (detailDrawer.dockerfile_path || 'Dockerfile（根目录）') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="镜像名称">{detailDrawer.image_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="镜像标签">{detailDrawer.image_tag || '-'}</Descriptions.Item>
              <Descriptions.Item label="容器名称">{detailDrawer.container_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="描述">{detailDrawer.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="端口映射" span={2}>
                {detailDrawer.ports?.length > 0
                  ? detailDrawer.ports.map((p, i) => <Tag key={i}>{p.host}:{p.container}</Tag>)
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="环境变量" span={2}>
                {detailDrawer.env_vars && Object.keys(detailDrawer.env_vars).length > 0
                  ? Object.entries(detailDrawer.env_vars).map(([k, v], i) => <Tag key={i}>{k}={v}</Tag>)
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="卷挂载" span={2}>
                {detailDrawer.volumes?.length > 0
                  ? detailDrawer.volumes.map((v, i) => <Tag key={i}>{v.host}:{v.container}</Tag>)
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="目标节点" span={2}>
                {detailDrawer.nodes?.map(n => <Tag key={n.id}>{n.name} ({n.host})</Tag>)}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left" style={{ margin: '16px 0 12px' }}>操作时间线</Divider>

            {detailDrawer.timeline && detailDrawer.timeline.length > 0 ? (
              <Timeline
                items={detailDrawer.timeline.map(item => ({
                  color: item.type === 'build'
                    ? (item.status === 'success' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'building' ? 'blue' : 'gray')
                    : (item.status === 'success' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'deploying' ? 'blue' : 'gray'),
                  children: (
                    <div
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/${item.type === 'build' ? 'builds' : 'deployments'}?highlight=${item.id}`)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 400, color: '#999' }}>{item.type === 'build' ? '构建' : '部署'}</span>
                        <Text strong>#{item.id}</Text>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: (item.type === 'build' ? buildStatusDotColors : deployStatusDotColors)[item.status] || '#c7c7c7' }} />
                          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{item.type === 'build' ? item.status : (deployStatusLabels[item.status] || item.status)}</span>
                        </span>
                        {item.image_tag && <Text code style={{ fontSize: 11 }}>{item.image_tag}</Text>}
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                        {item.type === 'build' && <>分支: {item.branch} | 耗时: {item.duration ? `${item.duration}s` : '-'} | {item.triggered_by_name || ''}</>}
                        {item.type === 'deploy' && <>节点: {item.node_name || item.node_host} | 耗时: {item.duration ? `${item.duration}s` : '-'} | {item.deployed_by_name || ''}</>}
                        <br />
                        {dayjs(item.created_at).format('YYYY-MM-DD HH:mm:ss')}
                      </div>
                    </div>
                  ),
                }))}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>暂无记录</div>
            )}
          </div>
        ) : null}
      </Drawer>

      {/* 构建并部署确认弹窗 */}
      <Modal
        title="构建并部署"
        open={bdModalVisible}
        onOk={handleBuildAndDeploy}
        onCancel={() => setBdModalVisible(false)}
        confirmLoading={bdLoading}
        width={680}
      >
        <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary">确认构建参数后将自动执行：构建 → 推送 → 部署。构建失败则不会触发部署。</Text>
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>分支：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={bdForm.branch} onChange={e => setBdForm({ ...bdForm, branch: e.target.value })} placeholder="main" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>Dockerfile 来源：</Text>
          <div style={{ marginTop: 8 }}>
            <Select style={{ width: '100%' }} value={bdForm.dockerfile_source} onChange={val => setBdForm({ ...bdForm, dockerfile_source: val })}>
              <Select.Option value="repository">使用代码仓库dockerfile</Select.Option>
              <Select.Option value="template">使用模板</Select.Option>
            </Select>
          </div>
        </div>
        {bdForm.dockerfile_source === 'template' && (
          <div style={{ marginBottom: 16 }}>
            <Text>Dockerfile 模板：</Text>
            <Select showSearch style={{ width: '100%', marginTop: 8 }} placeholder="选择模板（可选）" optionFilterProp="children" allowClear value={bdForm.dockerfile_template_id} onChange={val => setBdForm({ ...bdForm, dockerfile_template_id: val })}>
              {templates.map(t => <Select.Option key={t.id} value={t.id}>{t.name} ({t.build_type})</Select.Option>)}
            </Select>
          </div>
        )}
        {bdForm.dockerfile_source === 'repository' && (
          <div style={{ marginBottom: 16 }}>
            <Text>Dockerfile 路径：</Text>
            <Input style={{ width: '100%', marginTop: 8 }} value={bdForm.dockerfile_path} onChange={e => setBdForm({ ...bdForm, dockerfile_path: e.target.value })} placeholder="可选，如 docker/Dockerfile" />
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <Text>镜像名称（可选）：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={bdForm.image_name} onChange={e => setBdForm({ ...bdForm, image_name: e.target.value })} placeholder="默认使用项目名" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text>镜像标签（可选）：</Text>
          <Input style={{ width: '100%', marginTop: 8 }} value={bdForm.image_tag} onChange={e => setBdForm({ ...bdForm, image_tag: e.target.value })} placeholder="默认 yymmddhhmmss" />
        </div>

        <Divider style={{ margin: '16px 0 12px' }}>端口映射</Divider>
        {bdOverrides.ports.map((p, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <InputNumber placeholder="Host 端口" value={p.host} onChange={(v) => updateBdPort(i, 'host', v)} style={{ width: 130 }} />
            <span>:</span>
            <InputNumber placeholder="Container 端口" value={p.container} onChange={(v) => updateBdPort(i, 'container', v)} style={{ width: 130 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeBdPort(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addBdPort}>添加端口</Button>

        <Divider style={{ margin: '16px 0 12px' }}>环境变量</Divider>
        {bdOverrides.env_vars.map((e, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input placeholder="KEY" value={e.key} onChange={(ev) => updateBdEnv(i, 'key', ev.target.value)} style={{ width: 140 }} />
            <span>=</span>
            <Input placeholder="VALUE" value={e.value} onChange={(ev) => updateBdEnv(i, 'value', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeBdEnv(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addBdEnv}>添加变量</Button>

        <Divider style={{ margin: '16px 0 12px' }}>卷挂载</Divider>
        {bdOverrides.volumes.map((v, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input placeholder="Host 路径" value={v.host} onChange={(ev) => updateBdVolume(i, 'host', ev.target.value)} style={{ width: 180 }} />
            <span>:</span>
            <Input placeholder="Container 路径" value={v.container} onChange={(ev) => updateBdVolume(i, 'container', ev.target.value)} style={{ width: 180 }} />
            <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => removeBdVolume(i)} />
          </Space>
        ))}
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addBdVolume}>添加挂载</Button>
        </div>
      </Modal>

      {/* 合并日志面板 */}
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

export default DeployServices;
