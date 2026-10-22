import React, { useEffect, useState } from 'react';
import {
  Table, Button, Space, message, Modal, Form, Input, Select, InputNumber, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined,
} from '@ant-design/icons';
import { dbApi } from '../api/dbConnections';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const DB_TYPES = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'pg', label: 'PostgreSQL' },
  { value: 'opengauss', label: 'OpenGauss' },
];

const DEFAULT_PORTS = { mysql: 3306, pg: 5432, opengauss: 5432 };

function DbConnections() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState({});
  const [form] = Form.useForm();

  // 检查当前用户是否有权限编辑/删除连接
  const canEditConnection = (conn) => {
    if (!conn) return false;
    if (currentUser.role === 'admin') return true;
    return conn.created_by === currentUser.id && conn.scope === 'private';
  };

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await dbApi.getList();
      setConnections(res.data.data || []);
    } catch {
      message.error('获取数据库连接列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, []);

  const openModal = (record = null) => {
    setEditing(record);
    if (record) {
      form.setFieldsValue({ ...record, password: '' });
    } else {
      form.resetFields();
      form.setFieldsValue({ db_type: 'mysql', port: 3306 });
    }
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        const updateData = { ...values };
        if (!updateData.password) delete updateData.password;
        await dbApi.update(editing.id, updateData);
        message.success('连接已更新');
      } else {
        await dbApi.create(values);
        message.success('连接已创建');
      }
      setModalVisible(false);
      fetchList();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.message || '操作失败');
    }
  };

  const handleDelete = async (id) => {
    try {
      await dbApi.delete(id);
      message.success('连接已删除');
      fetchList();
    } catch {
      message.error('删除失败');
    }
  };

  const handleTest = async (id) => {
    setTesting(prev => ({ ...prev, [id]: true }));
    try {
      const res = await dbApi.test(id);
      if (res.data.data?.ok) {
        message.success(`连接成功，延迟 ${res.data.data.latency_ms}ms`);
      } else {
        message.error(`连接失败: ${res.data.data?.error || '未知错误'}`);
      }
      fetchList();
    } catch (err) {
      message.error(err.response?.data?.message || '测试连接失败');
    } finally {
      setTesting(prev => ({ ...prev, [id]: false }));
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 150 },
    {
      title: '类型', dataIndex: 'db_type', key: 'db_type', width: 120,
      render: (type) => {
        const labels = { mysql: 'MySQL', pg: 'PostgreSQL', opengauss: 'OpenGauss' };
        return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{labels[type]}</span>;
      },
    },
    { title: '主机', dataIndex: 'host', key: 'host', width: 160 },
    { title: '端口', dataIndex: 'port', key: 'port', width: 80 },
    { title: '数据库', dataIndex: 'database', key: 'database', width: 140 },
    { title: '用户名', dataIndex: 'username', key: 'username', width: 120 },
    {
      title: '可见性', dataIndex: 'scope', key: 'scope', width: 80,
      render: (scope) => scope === 'public'
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#111', display: 'inline-block' }} />公开</span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c7c7c7', display: 'inline-block' }} />私有</span>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (status) => {
        if (status === 'online') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34c759', display: 'inline-block' }} />已连接</span>;
        if (status === 'offline') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff3b30', display: 'inline-block' }} />异常</span>;
        return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c7c7c7', display: 'inline-block' }} />未检测</span>;
      },
    },
    {
      title: '上次检测', dataIndex: 'last_check', key: 'last_check', width: 170,
      render: (v) => v || '-',
    },
    {
      title: '操作', key: 'actions', width: 220, fixed: 'right',
      render: (_, record) => {
        const canEdit = canEditConnection(record);
        return (
          <Space>
            <Button type="link" size="small" icon={<ApiOutlined />} loading={testing[record.id]} onClick={() => handleTest(record.id)}>测试</Button>
            <Tooltip title={!canEdit ? '无权操作此连接' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)} disabled={!canEdit}>编辑</Button>
            </Tooltip>
            <Tooltip title={!canEdit ? '无权操作此连接' : ''}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} disabled={!canEdit}>删除</Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>数据库连接</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新建连接</Button>
      </div>

      <Table
        dataSource={connections}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="middle"
        scroll={{ x: 1200 }}
        pagination={false}
      />

      <Modal
        title={editing ? '编辑连接' : '新建连接'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="连接名称" rules={[{ required: true, message: '请输入连接名称' }]}>
            <Input placeholder="如：生产环境 MySQL" />
          </Form.Item>
          <Form.Item name="db_type" label="数据库类型" rules={[{ required: true }]}>
            <Select options={DB_TYPES} onChange={(val) => form.setFieldsValue({ port: DEFAULT_PORTS[val] })} />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="host" label="主机地址" rules={[{ required: true, message: '请输入主机地址' }]} style={{ flex: 1 }}>
              <Input placeholder="192.168.1.100" />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true, message: '请输入端口' }]}>
              <InputNumber min={1} max={65535} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="database" label="数据库名" rules={[{ required: true, message: '请输入数据库名' }]}>
            <Input placeholder="my_database" />
          </Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: !editing, message: '请输入密码' }]}>
            <Input.Password placeholder={editing ? '留空则不修改' : '输入密码'} />
          </Form.Item>
          <Form.Item name="scope" label="可见性" initialValue="private">
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

export default DbConnections;
