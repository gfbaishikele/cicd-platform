import React, { useEffect, useState } from 'react';
import { Table, Button, Space, Modal, Form, Input, Select, message, Tag, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined, ApiOutlined, DeleteOutlined, EditOutlined, SearchOutlined } from '@ant-design/icons';
import { gitlabApi } from '../api/projects';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

function GitLabConnections() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const [form] = Form.useForm();

  // 检查当前用户是否有权限编辑/删除连接
  const canEditConnection = (conn) => {
    if (!conn) return false;
    if (currentUser.role === 'admin') return true;
    return conn.created_by === currentUser.id && conn.scope === 'private';
  };

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const params = {};
      if (keyword) params.keyword = keyword;
      const res = await gitlabApi.getConnections(params);
      setConnections(res.data.data);
    } catch {
      message.error('获取连接列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConnections(); }, []);
  useEffect(() => { fetchConnections(); }, [keyword]);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      url: record.url,
      api_version: record.api_version,
      scope: record.scope || 'private',
      token: '',
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        const data = { ...values };
        if (!data.token) delete data.token;
        await gitlabApi.updateConnection(editing.id, data);
        message.success('连接已更新');
      } else {
        await gitlabApi.createConnection(values);
        message.success('连接已添加');
      }
      setModalVisible(false);
      fetchConnections();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleTest = async (id) => {
    setTesting(id);
    try {
      const res = await gitlabApi.testConnection(id);
      const data = res.data.data;
      if (data.connected) {
        message.success(`连接成功！GitLab ${data.version}，用户: ${data.user}`);
      } else {
        message.error(`连接失败: ${data.error}`);
      }
    } catch {
      message.error('测试连接失败');
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id) => {
    try {
      await gitlabApi.deleteConnection(id);
      message.success('连接已删除');
      fetchConnections();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name', width: 150, ellipsis: true },
    { title: '地址', dataIndex: 'url', width: 250, ellipsis: true },
    { title: 'API 版本', dataIndex: 'api_version', width: 100, render: (v) => <Tag>{v}</Tag> },
    {
      title: '可见性', dataIndex: 'scope', width: 80,
      render: (scope) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: scope === 'public' ? '#111' : '#c7c7c7', display: 'inline-block' }} />
          {scope === 'public' ? '公开' : '私有'}
        </span>
      ),
    },
    {
      title: '创建人', dataIndex: 'created_by_name', width: 100, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '创建时间', dataIndex: 'created_at', width: 180,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作', width: 220, fixed: 'right',
      render: (_, record) => {
        const canEdit = canEditConnection(record);
        return (
          <Space>
            <Button type="link" size="small" icon={<ApiOutlined />} loading={testing === record.id} onClick={() => handleTest(record.id)}>
              测试
            </Button>
            <Tooltip title={!canEdit ? '无权操作此连接' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={!canEdit}>
                编辑
              </Button>
            </Tooltip>
            <Tooltip title={!canEdit ? '无权操作此连接' : ''}>
              <Popconfirm title="确认删除此连接？" onConfirm={() => handleDelete(record.id)} disabled={!canEdit}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>删除</Button>
              </Popconfirm>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>GitLab 连接管理</div>
        <Space>
          <Input placeholder="搜索名称/地址" prefix={<SearchOutlined />} value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ width: 200 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加连接</Button>
        </Space>
      </div>

      <Table rowKey="id" columns={columns} dataSource={connections} loading={loading} pagination={false} scroll={{ x: 900 }} />

      <Modal title={editing ? '编辑连接' : '添加 GitLab 连接'} open={modalVisible} onOk={handleSave} onCancel={() => setModalVisible(false)} destroyOnClose width={500}>
        <Form form={form} layout="vertical" initialValues={{ api_version: 'v4', scope: 'private' }}>
          <Form.Item name="name" label="连接名称" rules={[{ required: true, message: '请输入连接名称' }]}>
            <Input placeholder="如：公司 GitLab" />
          </Form.Item>
          <Form.Item name="url" label="GitLab 地址" rules={[{ required: true, message: '请输入 GitLab 地址' }, { type: 'url', message: '请输入有效的 URL' }]}>
            <Input placeholder="https://gitlab.example.com" />
          </Form.Item>
          <Form.Item name="token" label="Access Token" rules={[{ required: !editing, message: '请输入 Token' }]}>
            <Input.Password placeholder={editing ? '留空则不修改' : 'glpat-xxxxxxxxxxxx'} />
          </Form.Item>
          <Form.Item name="api_version" label="API 版本">
            <Input placeholder="v4" />
          </Form.Item>
          <Form.Item name="scope" label="可见性">
            <Select>
              <Select.Option value="private">私有</Select.Option>
              <Select.Option value="public">公开</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default GitLabConnections;
