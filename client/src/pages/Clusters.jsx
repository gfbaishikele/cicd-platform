import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Table, Button, Space, Modal, Form, Input, InputNumber, Select, message, Typography, Popconfirm, Card, Row, Col, Statistic, List, Badge, Drawer, Tooltip, Divider } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, ApiOutlined, FolderOutlined, FolderOpenOutlined, AppstoreOutlined, DockerOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined, FileTextOutlined, SearchOutlined, CloseOutlined } from '@ant-design/icons';
import { clusterApi } from '../api/clusters';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const { Text } = Typography;

function Clusters() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [nodes, setNodes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null); // null = all nodes
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [checking, setChecking] = useState(null);
  const [statusModal, setStatusModal] = useState(null);
  const [nodeStatus, setNodeStatus] = useState(null);
  const [form] = Form.useForm();

  // 分组弹窗
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupForm] = Form.useForm();

  // 检查当前用户是否有权限编辑/删除节点
  const canEditNode = (node) => {
    if (!node) return false;
    if (currentUser.role === 'admin') return true;
    return node.created_by === currentUser.id && node.scope === 'private';
  };

  // 加载基础数据
  const fetchGroups = async () => {
    try {
      const res = await clusterApi.getGroups();
      setGroups(res.data.data);
    } catch {
      // 静默
    }
  };

  const fetchNodes = async () => {
    setLoading(true);
    try {
      const params = {};
      if (keyword) params.keyword = keyword;
      const res = await clusterApi.getNodes(params);
      setNodes(res.data.data);
    } catch {
      message.error('获取节点列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
    fetchNodes();
  }, []);

  useEffect(() => {
    fetchNodes();
  }, [keyword]);

  // 根据选中分组过滤节点
  const filteredNodes = selectedGroup === null
    ? nodes
    : nodes.filter(n => n.group_id === selectedGroup);

  // 未分组的节点
  const ungroupedNodes = nodes.filter(n => !n.group_id);

  // ========== 节点操作 ==========

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      port: 22, auth_type: 'password',
      docker_host: 'unix:///var/run/docker.sock',
      group_id: selectedGroup || null,
    });
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      auth_type: record.auth_type,
      auth_secret: '',
      docker_host: record.docker_host,
      group_id: record.group_id || null,
      scope: record.scope || 'private',
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        const data = { ...values };
        if (!data.auth_secret) delete data.auth_secret;
        await clusterApi.updateNode(editing.id, data);
        message.success('节点已更新');
      } else {
        await clusterApi.createNode(values);
        message.success('节点已添加');
      }
      setModalVisible(false);
      fetchNodes();
      fetchGroups();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await clusterApi.deleteNode(id);
      message.success('节点已删除');
      fetchNodes();
      fetchGroups();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handleHealthCheck = async (id) => {
    setChecking(id);
    try {
      const res = await clusterApi.healthCheck(id);
      const data = res.data.data;
      if (data.ssh_ok && data.docker_ok) {
        message.success(`节点正常 | Docker ${data.docker_version} | 延迟 ${data.latency_ms}ms`);
      } else if (data.ssh_ok) {
        message.warning(`SSH 正常但 Docker 异常: ${data.error}`);
      } else {
        message.error(`连接失败: ${data.error}`);
      }
      fetchNodes();
    } catch {
      message.error('健康检查失败');
    } finally {
      setChecking(null);
    }
  };

  const handleViewStatus = async (node) => {
    setStatusModal(node);
    try {
      const res = await clusterApi.getNodeStatus(node.id);
      setNodeStatus(res.data.data);
    } catch {
      setNodeStatus({ online: false, error: '获取状态失败' });
    }
  };

  // ========== 分组操作 ==========

  const handleAddGroup = () => {
    setEditingGroup(null);
    groupForm.resetFields();
    setGroupModalVisible(true);
  };

  const handleEditGroup = (group) => {
    setEditingGroup(group);
    groupForm.setFieldsValue({ name: group.name, description: group.description });
    setGroupModalVisible(true);
  };

  const handleSaveGroup = async () => {
    try {
      const values = await groupForm.validateFields();
      if (editingGroup) {
        await clusterApi.updateGroup(editingGroup.id, values);
        message.success('分组已更新');
      } else {
        await clusterApi.createGroup(values);
        message.success('分组已创建');
      }
      setGroupModalVisible(false);
      fetchGroups();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDeleteGroup = async (id) => {
    try {
      await clusterApi.deleteGroup(id);
      message.success('分组已删除');
      if (selectedGroup === id) setSelectedGroup(null);
      fetchGroups();
      fetchNodes();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  // ========== 容器管理 ==========
  const [containerDrawer, setContainerDrawer] = useState(null); // { node } | null
  const [containers, setContainers] = useState([]);
  const [containersLoading, setContainersLoading] = useState(false);
  const [containerFilter, setContainerFilter] = useState('');
  const [actionLoading, setActionLoading] = useState({}); // { containerName: true }

  // 日志查看
  const [logDrawer, setLogDrawer] = useState(null); // { node, containerName } | null
  const [containerLogs, setContainerLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logSearchKeyword, setLogSearchKeyword] = useState('');
  const [logContextLines, setLogContextLines] = useState(3); // 搜索上下文前后行数
  const [autoScroll, setAutoScroll] = useState(true);
  const logPollingRef = useRef(null);
  const logContentRef = useRef(null);

  const openContainers = async (node) => {
    setContainerDrawer({ node });
    setContainerFilter('');
    setContainersLoading(true);
    try {
      const res = await clusterApi.getContainers(node.id);
      setContainers(res.data.data);
    } catch (err) {
      message.error(err.response?.data?.message || '获取容器列表失败');
      setContainers([]);
    } finally {
      setContainersLoading(false);
    }
  };

  const closeContainers = () => {
    setContainerDrawer(null);
    setContainers([]);
  };

  const refreshContainers = async () => {
    if (!containerDrawer) return;
    setContainersLoading(true);
    try {
      const res = await clusterApi.getContainers(containerDrawer.node.id);
      setContainers(res.data.data);
    } catch (err) {
      message.error(err.response?.data?.message || '刷新容器列表失败');
    } finally {
      setContainersLoading(false);
    }
  };

  const handleContainerAction = async (nodeId, containerName, action) => {
    const actionLabels = { restart: '重启', stop: '停止', start: '启动', rm: '删除' };
    setActionLoading(prev => ({ ...prev, [containerName]: true }));
    try {
      await clusterApi.containerAction(nodeId, containerName, action);
      message.success(`容器 ${containerName} 已${actionLabels[action] || action}`);
      // 刷新容器列表
      const res = await clusterApi.getContainers(nodeId);
      setContainers(res.data.data);
    } catch (err) {
      message.error(err.response?.data?.message || '操作失败');
    } finally {
      setActionLoading(prev => ({ ...prev, [containerName]: false }));
    }
  };

  const openContainerLogs = (node, containerName) => {
    setLogDrawer({ node, containerName });
    setContainerLogs('');
    setLogSearchKeyword('');
    setAutoScroll(true);
    setLogsLoading(true);

    // 立即拉取一次日志
    fetchLogs(node.id, containerName).finally(() => {
      setLogsLoading(false);
      // 开始轮询
      logPollingRef.current = setInterval(() => {
        fetchLogs(node.id, containerName);
      }, 3000);
    });
  };

  const fetchLogs = async (nodeId, containerName) => {
    try {
      const res = await clusterApi.getContainerLogs(nodeId, containerName, 200);
      setContainerLogs(res.data.data.logs || '');
    } catch {
      // 静默
    }
  };

  const closeContainerLogs = useCallback(() => {
    if (logPollingRef.current) {
      clearInterval(logPollingRef.current);
      logPollingRef.current = null;
    }
    setLogDrawer(null);
    setContainerLogs('');
    setLogSearchKeyword('');
  }, []);

  // 日志自动滚动
  useEffect(() => {
    if (autoScroll && logContentRef.current) {
      logContentRef.current.scrollTop = logContentRef.current.scrollHeight;
    }
  }, [containerLogs, autoScroll]);

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (logPollingRef.current) clearInterval(logPollingRef.current);
    };
  }, []);

  // 过滤后的容器列表
  const filteredContainers = containerFilter
    ? containers.filter(c =>
        c.name.toLowerCase().includes(containerFilter.toLowerCase()) ||
        c.image.toLowerCase().includes(containerFilter.toLowerCase()) ||
        c.status.toLowerCase().includes(containerFilter.toLowerCase())
      )
    : containers;

  // 过滤后的日志行（用于搜索高亮 + 上下文）
  const logLines = containerLogs.split('\n');
  const filteredLogLines = (() => {
    if (!logSearchKeyword) return logLines.map((line, idx) => ({ line, idx, type: 'normal' }));
    const keyword = logSearchKeyword.toLowerCase();
    // 先找出所有匹配行索引
    const matchIndices = new Set();
    logLines.forEach((line, idx) => {
      if (line.toLowerCase().includes(keyword)) matchIndices.add(idx);
    });
    // 再扩展上下文范围
    const contextSet = new Set();
    matchIndices.forEach(idx => {
      for (let i = Math.max(0, idx - logContextLines); i <= Math.min(logLines.length - 1, idx + logContextLines); i++) {
        contextSet.add(i);
      }
    });
    return logLines.map((line, idx) => ({
      line,
      idx,
      type: matchIndices.has(idx) ? 'match' : contextSet.has(idx) ? 'context' : 'hidden',
    }));
  })();

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '名称', dataIndex: 'name', width: 130, ellipsis: true },
    { title: '主机', dataIndex: 'host', width: 140, ellipsis: true },
    { title: '端口', dataIndex: 'port', width: 70 },
    { title: '用户', dataIndex: 'username', width: 80, ellipsis: true },
    ...(selectedGroup === null ? [{
      title: '分组', dataIndex: 'group_name', width: 100, ellipsis: true,
      render: (t) => t || <Text type="secondary">未分组</Text>,
    }] : []),
    {
      title: '可见性', dataIndex: 'scope', width: 70,
      render: (scope) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: scope === 'public' ? '#111' : '#c7c7c7', display: 'inline-block' }} />
          {scope === 'public' ? '公开' : '私有'}
        </span>
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 80,
      render: (s) => {
        const map = { online: { color: '#34c759', label: '在线' }, offline: { color: '#c7c7c7', label: '离线' }, error: { color: '#ff3b30', label: '异常' } };
        const cfg = map[s] || { color: '#c7c7c7', label: s };
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
            {cfg.label}
          </span>
        );
      },
    },
    {
      title: '最近检查', dataIndex: 'last_check', width: 160,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
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
      title: '操作', width: 310, fixed: 'right',
      render: (_, record) => {
        const canEdit = canEditNode(record);
        return (
          <Space>
            <Button type="link" size="small" icon={<ApiOutlined />} loading={checking === record.id} onClick={() => handleHealthCheck(record.id)}>检查</Button>
            <Button type="link" size="small" onClick={() => handleViewStatus(record)}>状态</Button>
            <Button type="link" size="small" icon={<DockerOutlined />} onClick={() => openContainers(record)}>容器</Button>
            <Tooltip title={!canEdit ? '无权操作此节点' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={!canEdit}>编辑</Button>
            </Tooltip>
            <Tooltip title={!canEdit ? '无权操作此节点' : ''}>
              <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)} disabled={!canEdit}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>删除</Button>
              </Popconfirm>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {/* 左侧分组面板 */}
      <div style={{ width: 220, flexShrink: 0 }}>
        <Card size="small" title={<span><FolderOutlined /> 节点分组</span>} extra={
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={handleAddGroup} />
        }>
          <div
            style={{
              padding: '8px 12px', cursor: 'pointer', borderRadius: 6,
              background: selectedGroup === null ? '#f5f5f5' : 'transparent',
              fontWeight: selectedGroup === null ? 600 : 400,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 4,
            }}
            onClick={() => setSelectedGroup(null)}
          >
            <span><AppstoreOutlined /> 全部节点</span>
            <Badge count={nodes.length} size="small" style={{ backgroundColor: '#111' }} />
          </div>

          {groups.map(g => (
            <div
              key={g.id}
              style={{
                padding: '8px 12px', cursor: 'pointer', borderRadius: 6,
                background: selectedGroup === g.id ? '#f5f5f5' : 'transparent',
                fontWeight: selectedGroup === g.id ? 600 : 400,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 4,
              }}
              onClick={() => setSelectedGroup(g.id)}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <FolderOpenOutlined /> {g.name}
              </span>
              <Space size={4} onClick={(e) => e.stopPropagation()}>
                <Badge count={g.node_count || 0} size="small" style={{ backgroundColor: '#111' }} />
                <Button type="text" size="small" icon={<EditOutlined />} style={{ padding: 0, width: 20 }} onClick={() => handleEditGroup(g)} />
                <Popconfirm title="删除分组后节点将变为未分组，确认？" onConfirm={() => handleDeleteGroup(g.id)}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} style={{ padding: 0, width: 20 }} />
                </Popconfirm>
              </Space>
            </div>
          ))}

          {ungroupedNodes.length > 0 && (
            <div
              style={{
                padding: '8px 12px', cursor: 'pointer', borderRadius: 6,
                background: selectedGroup === 'ungrouped' ? '#f5f5f5' : 'transparent',
                fontWeight: selectedGroup === 'ungrouped' ? 600 : 400,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginTop: 8, borderTop: '1px dashed #d9d9d9', paddingTop: 12,
              }}
              onClick={() => setSelectedGroup('ungrouped')}
            >
              <span><Text type="secondary">未分组</Text></span>
              <Badge count={ungroupedNodes.length} size="small" />
            </div>
          )}
        </Card>
      </div>

      {/* 右侧节点列表 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>
            {selectedGroup === null ? '全部节点' :
             selectedGroup === 'ungrouped' ? '未分组节点' :
             groups.find(g => g.id === selectedGroup)?.name || '节点列表'}
          </div>
          <Space>
            <Input placeholder="搜索主机名/IP" prefix={<SearchOutlined />} value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ width: 200 }} allowClear />
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加节点</Button>
          </Space>
        </div>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={selectedGroup === 'ungrouped' ? ungroupedNodes : filteredNodes}
          loading={loading}
          scroll={{ x: 1200 }}
          size="middle"
        />
      </div>

      {/* 添加/编辑节点弹窗 */}
      <Modal title={editing ? '编辑节点' : '添加节点'} open={modalVisible} onOk={handleSave} onCancel={() => setModalVisible(false)} width={500} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="节点名称" rules={[{ required: true }]}>
            <Input placeholder="如：生产节点 1" />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="host" label="主机地址" rules={[{ required: true }]} style={{ width: 250 }}>
              <Input placeholder="192.168.1.100" />
            </Form.Item>
            <Form.Item name="port" label="SSH 端口">
              <InputNumber min={1} max={65535} style={{ width: 100 }} />
            </Form.Item>
          </Space>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input placeholder="root" />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="auth_type" label="认证方式" style={{ width: 150 }}>
              <Select>
                <Select.Option value="password">密码</Select.Option>
                <Select.Option value="key">密钥</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="auth_secret" label="密码/密钥路径" rules={[{ required: !editing }]} style={{ flex: 1 }}>
              <Input.Password placeholder={editing ? '留空不修改' : '密码或密钥路径'} />
            </Form.Item>
          </Space>
          <Form.Item name="docker_host" label="Docker Host">
            <Input placeholder="unix:///var/run/docker.sock" />
          </Form.Item>
          <Form.Item name="group_id" label="所属分组">
            <Select allowClear placeholder="不选择则为未分组">
              {groups.map(g => <Select.Option key={g.id} value={g.id}>{g.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="scope" label="可见性" initialValue="private">
            <Select>
              <Select.Option value="private">私有</Select.Option>
              <Select.Option value="public">公开</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 分组弹窗 */}
      <Modal title={editingGroup ? '编辑分组' : '新建分组'} open={groupModalVisible} onOk={handleSaveGroup} onCancel={() => setGroupModalVisible(false)} destroyOnClose>
        <Form form={groupForm} layout="vertical">
          <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
            <Input placeholder="如：生产环境、测试环境" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 节点状态弹窗 */}
      <Modal title={`节点状态 - ${statusModal?.name || ''}`} open={!!statusModal} onCancel={() => { setStatusModal(null); setNodeStatus(null); }} footer={null} width={500}>
        {nodeStatus ? (
          nodeStatus.online ? (
            <Row gutter={[16, 16]}>
              <Col span={12}><Card size="small"><Statistic title="Docker 版本" value={nodeStatus.docker_version || 'N/A'} /></Card></Col>
              <Col span={12}><Card size="small"><Statistic title="运行容器" value={nodeStatus.containers_running || 0} suffix="个" /></Card></Col>
              <Col span={12}>
                <Card size="small">
                  <Statistic title="CPU 使用率" value={nodeStatus.cpu_usage || 0} suffix="%" />
                  <Text type="secondary" style={{ fontSize: 12 }}>{nodeStatus.cpu_cores ? `${nodeStatus.cpu_cores} 核` : '\u00A0'}</Text>
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small">
                  <Statistic title="内存" value={nodeStatus.memory_total ? `${((nodeStatus.memory_used / nodeStatus.memory_total) * 100).toFixed(1)}` : 0} suffix="%" />
                  <Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(nodeStatus.memory_used)} / {formatBytes(nodeStatus.memory_total)}</Text>
                </Card>
              </Col>
              <Col span={24}>
                <Card size="small">
                  <Statistic title="磁盘" value={nodeStatus.disk_total ? `${((nodeStatus.disk_used / nodeStatus.disk_total) * 100).toFixed(1)}` : 0} suffix="%" />
                  <Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(nodeStatus.disk_used)} / {formatBytes(nodeStatus.disk_total)}</Text>
                </Card>
              </Col>
            </Row>
          ) : (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Text type="danger">节点离线: {nodeStatus.error}</Text>
            </div>
          )
        ) : (
          <div style={{ textAlign: 'center', padding: 24 }}>加载中...</div>
        )}
      </Modal>

      {/* 容器列表 Drawer */}
      <Drawer
        title={
          <Space>
            <DockerOutlined />
            <span>{containerDrawer?.node?.name} - 容器列表</span>
            <span style={{ fontSize: 12, fontWeight: 300, color: '#999', marginLeft: 8 }}>{filteredContainers.length} 个容器</span>
          </Space>
        }
        open={!!containerDrawer}
        onClose={closeContainers}
        width={800}
        extra={
          <Button icon={<ReloadOutlined />} onClick={refreshContainers} loading={containersLoading}>刷新</Button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索容器名、镜像、状态..."
            value={containerFilter}
            onChange={e => setContainerFilter(e.target.value)}
            allowClear
            style={{ width: 300 }}
          />
        </div>

        <Table
          rowKey="id"
          size="small"
          loading={containersLoading}
          dataSource={filteredContainers}
          pagination={{ pageSize: 15, size: 'small' }}
          columns={[
            {
              title: '容器名', dataIndex: 'name', width: 180, ellipsis: true,
              render: (name) => <Text strong style={{ fontSize: 12 }}>{name}</Text>,
            },
            {
              title: '镜像', dataIndex: 'image', width: 180, ellipsis: true,
              render: (img) => <Text style={{ fontSize: 12 }}>{img}</Text>,
            },
            {
              title: '状态', dataIndex: 'state', width: 80,
              render: (state) => {
                const isRunning = state === 'running';
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 300, color: '#666' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: isRunning ? '#34c759' : '#c7c7c7', display: 'inline-block' }} />
                    {isRunning ? '运行中' : state || '已停止'}
                  </span>
                );
              },
            },
            {
              title: '运行时间', dataIndex: 'status', width: 160, ellipsis: true,
              render: (s) => <Text style={{ fontSize: 11 }}>{s || '-'}</Text>,
            },
            {
              title: '端口', dataIndex: 'ports', width: 140, ellipsis: true,
              render: (p) => <Text style={{ fontSize: 11 }}>{p || '-'}</Text>,
            },
            {
              title: '操作', width: 220, fixed: 'right',
              render: (_, record) => {
                const isRunning = record.state === 'running';
                const loading = actionLoading[record.name];
                return (
                  <Space size={4}>
                    <Tooltip title="重启">
                      <Button type="link" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => handleContainerAction(containerDrawer.node.id, record.name, 'restart')} />
                    </Tooltip>
                    {isRunning ? (
                      <Tooltip title="停止">
                        <Button type="link" size="small" icon={<PauseCircleOutlined />} loading={loading} onClick={() => handleContainerAction(containerDrawer.node.id, record.name, 'stop')} />
                      </Tooltip>
                    ) : (
                      <Tooltip title="启动">
                        <Button type="link" size="small" icon={<PlayCircleOutlined />} loading={loading} onClick={() => handleContainerAction(containerDrawer.node.id, record.name, 'start')} />
                      </Tooltip>
                    )}
                    <Tooltip title="查看日志">
                      <Button type="link" size="small" icon={<FileTextOutlined />} onClick={() => openContainerLogs(containerDrawer.node, record.name)} />
                    </Tooltip>
                    <Popconfirm title={`确认删除容器 ${record.name}？`} onConfirm={() => handleContainerAction(containerDrawer.node.id, record.name, 'rm')}>
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                );
              },
            },
          ]}
        />
      </Drawer>

      {/* 容器日志查看 Drawer */}
      <Drawer
        title={
          <Space>
            <FileTextOutlined />
            <span>日志 - {logDrawer?.containerName}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666', marginLeft: 8 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: autoScroll ? '#34c759' : '#c7c7c7', display: 'inline-block' }} />
              {autoScroll ? '实时' : '已暂停'}
            </span>
          </Space>
        }
        open={!!logDrawer}
        onClose={closeContainerLogs}
        width={750}
        extra={
          <Space>
            <Button
              size="small"
              type={autoScroll ? 'primary' : 'default'}
              onClick={() => setAutoScroll(!autoScroll)}
            >
              {autoScroll ? '暂停滚动' : '自动滚动'}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => {
              if (logPollingRef.current) clearInterval(logPollingRef.current);
              fetchLogs(logDrawer.node.id, logDrawer.containerName).then(() => {
                logPollingRef.current = setInterval(() => {
                  fetchLogs(logDrawer.node.id, logDrawer.containerName);
                }, 3000);
              });
            }} loading={logsLoading}>刷新</Button>
          </Space>
        }
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' } }}
      >
        {/* 搜索栏 - 固定顶部 */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索日志关键词..."
            value={logSearchKeyword}
            onChange={e => setLogSearchKeyword(e.target.value)}
            allowClear
            style={{ width: 260 }}
            size="small"
          />
          {logSearchKeyword && (
            <>
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                匹配 {filteredLogLines.filter(l => l.type === 'match').length} 行
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>|</Text>
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>上下文</Text>
              <Select
                size="small"
                value={logContextLines}
                onChange={setLogContextLines}
                style={{ width: 70 }}
                options={[
                  { label: '0 行', value: 0 },
                  { label: '3 行', value: 3 },
                  { label: '5 行', value: 5 },
                  { label: '10 行', value: 10 },
                  { label: '20 行', value: 20 },
                  { label: '50 行', value: 50 },
                ]}
              />
            </>
          )}
        </div>

        {/* 日志内容 - 独立滚动 */}
        <div
          ref={logContentRef}
          onClick={() => setAutoScroll(false)}
          style={{
            background: '#1e1e1e',
            color: '#d4d4d4',
            padding: 12,
            fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
            fontSize: 12,
            lineHeight: 1.6,
            flex: 1,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            minHeight: 0,
          }}
        >
          {logsLoading && !containerLogs ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>加载中...</div>
          ) : filteredLogLines.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>暂无日志</div>
          ) : (
            filteredLogLines.map(({ line, idx, type }) => {
              if (type === 'hidden') return null;
              const isMatch = type === 'match';
              const isContext = type === 'context';
              return (
                <div
                  key={idx}
                  style={{
                    background: isMatch ? 'rgba(255, 235, 59, 0.15)' : isContext ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                    borderLeft: isMatch ? '3px solid #ffeb3b' : isContext ? '3px solid rgba(255,255,255,0.08)' : '3px solid transparent',
                    paddingLeft: 4,
                    opacity: isContext ? 0.6 : 1,
                  }}
                >
                  {isMatch ? highlightText(line, logSearchKeyword) : (line || '\u00A0')}
                </div>
              );
            })
          )}
        </div>
      </Drawer>
    </div>
  );
}

// 日志关键词高亮
function highlightText(text, keyword) {
  if (!keyword) return text;
  const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? <span key={i} style={{ background: '#ffeb3b', color: '#000', borderRadius: 2, padding: '0 2px' }}>{part}</span> : part
  );
}

export default Clusters;
