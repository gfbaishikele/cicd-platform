import React, { useEffect, useState } from 'react';
import { Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Switch } from 'antd';
import { PlusOutlined, SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { userApi } from '../api/auth';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

function Users() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [passwordUserId, setPasswordUserId] = useState(null);
  const [projectsModalVisible, setProjectsModalVisible] = useState(false);
  const [projectsUserId, setProjectsUserId] = useState(null);
  const [projectsUsername, setProjectsUsername] = useState('');
  const [userProjects, setUserProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [form] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const { user: currentUser } = useSelector((state) => state.auth);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await userApi.getList({ page, pageSize, keyword });
      setUsers(res.data.data.list);
      setTotal(res.data.data.total);
    } catch (err) {
      message.error('获取用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [page, pageSize, keyword]);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingUser(record);
    form.setFieldsValue({
      role: record.role,
      status: record.status,
      email: record.email,
      name: record.name,
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingUser) {
        await userApi.update(editingUser.id, values);
        message.success('用户已更新');
      }
      setModalVisible(false);
      fetchUsers();
    } catch (err) {
      if (err.response?.data?.message) {
        message.error(err.response.data.message);
      }
    }
  };

  const handleDelete = async (id) => {
    try {
      await userApi.delete(id);
      message.success('用户已删除');
      fetchUsers();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handleResetPassword = async () => {
    try {
      const values = await passwordForm.validateFields();
      await userApi.updatePassword(passwordUserId, { newPassword: values.newPassword });
      message.success('密码已重置');
      setPasswordModalVisible(false);
      passwordForm.resetFields();
    } catch (err) {
      if (err.response?.data?.message) {
        message.error(err.response.data.message);
      }
    }
  };

  const handleOpenProjects = async (record) => {
    setProjectsUserId(record.id);
    setProjectsUsername(record.username);
    setProjectsModalVisible(true);
    setProjectsLoading(true);
    try {
      const res = await userApi.getUserProjects(record.id);
      setUserProjects(res.data.data || []);
    } catch (err) {
      message.error('获取用户项目关联失败');
    } finally {
      setProjectsLoading(false);
    }
  };

  const handleProjectToggle = (projectId, checked) => {
    setUserProjects((prev) =>
      prev.map((p) =>
        p.project_id === projectId
          ? { ...p, is_member: checked ? 1 : 0, role: checked ? (p.role || 'viewer') : p.role }
          : p
      )
    );
  };

  const handleProjectRoleChange = (projectId, role) => {
    setUserProjects((prev) =>
      prev.map((p) =>
        p.project_id === projectId ? { ...p, role } : p
      )
    );
  };

  const handleSaveProjects = async () => {
    const projects = userProjects
      .filter((p) => p.is_member)
      .map((p) => ({ project_id: p.project_id, role: p.role || 'viewer' }));

    setProjectsLoading(true);
    try {
      await userApi.updateUserProjects(projectsUserId, { projects });
      message.success('项目关联已更新');
      setProjectsModalVisible(false);
    } catch (err) {
      message.error(err.response?.data?.message || '更新项目关联失败');
    } finally {
      setProjectsLoading(false);
    }
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 60,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      width: 150,
      ellipsis: true,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
      ellipsis: true,
      render: (text) => text || '-',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      width: 200,
      ellipsis: true,
      render: (text) => text || '-',
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 100,
      render: (role) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: role === 'admin' ? '#ff3b30' : '#c7c7c7', display: 'inline-block' }} />
          {role === 'admin' ? '管理员' : '普通用户'}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: status === 'active' ? '#34c759' : '#c7c7c7', display: 'inline-block' }} />
          {status === 'active' ? '正常' : '已禁用'}
        </span>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (text) => text ? dayjs(text).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '操作',
      width: 280,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleOpenProjects(record)}>
            关联项目
          </Button>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setPasswordUserId(record.id);
              setPasswordModalVisible(true);
            }}
          >
            重置密码
          </Button>
          {record.id !== currentUser.id && (
            <Popconfirm
              title="确认删除"
              description={`确定要删除用户 "${record.username}" 吗？`}
              onConfirm={() => handleDelete(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button type="link" size="small" danger>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>用户管理</div>
        <Space>
          <Input
            placeholder="搜索用户名/邮箱"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 200 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={fetchUsers}>
            刷新
          </Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          onChange: (p, ps) => {
            setPage(p);
            if (ps) setPageSize(ps);
          },
        }}
        scroll={{ x: 1000 }}
      />

      {/* 编辑用户弹窗 */}
      <Modal
        title={editingUser ? '编辑用户' : '添加用户'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          {editingUser && (
            <Form.Item label="用户名">
              <Input value={editingUser.username} disabled />
            </Form.Item>
          )}
          <Form.Item name="name" label="名称" rules={[
            { required: true, message: '请输入名称' },
            { min: 1, max: 64, message: '名称长度 1-64 个字符' },
          ]}>
            <Input placeholder="名称（显示名称）" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="邮箱" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="user">普通用户</Select.Option>
              <Select.Option value="admin">管理员</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="active">正常</Select.Option>
              <Select.Option value="disabled">禁用</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        title="重置密码"
        open={passwordModalVisible}
        onOk={handleResetPassword}
        onCancel={() => {
          setPasswordModalVisible(false);
          passwordForm.resetFields();
        }}
        destroyOnClose
      >
        <Form form={passwordForm} layout="vertical">
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 个字符' },
            ]}
          >
            <Input.Password placeholder="新密码" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 关联项目弹窗 */}
      <Modal
        title={`关联项目管理 - ${projectsUsername}`}
        open={projectsModalVisible}
        onOk={handleSaveProjects}
        onCancel={() => setProjectsModalVisible(false)}
        confirmText="保存"
        width={640}
        destroyOnClose
      >
        <Table
          rowKey="project_id"
          columns={[
            {
              title: '项目管理',
              dataIndex: 'project_name',
              ellipsis: true,
            },
            {
              title: '关联',
              dataIndex: 'is_member',
              width: 80,
              render: (val, record) => (
                <Switch
                  size="small"
                  checked={!!val}
                  onChange={(checked) => handleProjectToggle(record.project_id, checked)}
                />
              ),
            },
            {
              title: '角色',
              dataIndex: 'role',
              width: 140,
              render: (val, record) => (
                <Select
                  size="small"
                  value={val || 'viewer'}
                  disabled={!record.is_member}
                  onChange={(role) => handleProjectRoleChange(record.project_id, role)}
                  style={{ width: 110 }}
                >
                  <Select.Option value="owner">owner</Select.Option>
                  <Select.Option value="developer">developer</Select.Option>
                  <Select.Option value="viewer">viewer</Select.Option>
                </Select>
              ),
            },
          ]}
          dataSource={userProjects}
          loading={projectsLoading}
          pagination={false}
          size="small"
        />
      </Modal>
    </div>
  );
}

export default Users;
