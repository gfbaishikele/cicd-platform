import React, { useEffect, useState } from 'react';
import { Tabs, Descriptions, Table, Button, Space, Typography, Spin, message, Modal, Select, Popconfirm, Avatar } from 'antd';
import { ArrowLeftOutlined, UserAddOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { projectApi } from '../api/projects';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const { Text } = Typography;

const roleLabels = { owner: 'Owner', developer: '开发者', viewer: '观察者' };
const buildStatusDotColors = { pending: '#c7c7c7', building: '#ff9500', success: '#34c759', failed: '#ff3b30', cancelled: '#c7c7c7' };
const buildStatusLabels = { pending: '等待', building: '构建中', success: '成功', failed: '失败', cancelled: '已取消' };

function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: currentUser } = useSelector((state) => state.auth);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [memberModalVisible, setMemberModalVisible] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [memberForm, setMemberForm] = useState({ user_id: null, role: 'viewer' });

  const fetchProject = async () => {
    setLoading(true);
    try {
      const res = await projectApi.getById(id);
      console.log('Project detail response:', res.data.data);
      console.log('Current user role:', res.data.data.current_user_role);
      console.log('Current user from Redux:', currentUser);
      setProject(res.data.data);
    } catch {
      message.error('获取项目详情失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProject(); }, [id]);

  const handleAddMember = async () => {
    if (!memberForm.user_id) return message.warning('请选择用户');
    try {
      await projectApi.addMember(id, memberForm);
      message.success('成员已添加');
      setMemberModalVisible(false);
      fetchProject();
    } catch (err) {
      message.error(err.response?.data?.message || '添加失败');
    }
  };

  const handleRemoveMember = async (userId) => {
    try {
      await projectApi.removeMember(id, userId);
      message.success('成员已移除');
      fetchProject();
    } catch (err) {
      message.error(err.response?.data?.message || '移除失败');
    }
  };

  const handleChangeRole = async (userId, role) => {
    try {
      await projectApi.updateMember(id, userId, { role });
      message.success('角色已更新');
      fetchProject();
    } catch (err) {
      message.error(err.response?.data?.message || '更新失败');
    }
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  if (!project) return <div>项目不存在</div>;

  // 当前用户是否有管理权限（admin 或 owner）
  const canManageMembers = project.current_user_role === 'admin' || project.current_user_role === 'owner';

  const buildColumns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '分支', dataIndex: 'branch', width: 120 },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: buildStatusDotColors[s] || '#c7c7c7' }} />
          <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{buildStatusLabels[s] || s}</span>
        </span>
      ),
    },
    { title: '类型', dataIndex: 'build_type', width: 80 },
    { title: '镜像', dataIndex: 'image_tag', width: 200, ellipsis: true },
    {
      title: '耗时', dataIndex: 'duration', width: 80,
      render: (d) => d ? `${d}s` : '-',
    },
    {
      title: '时间', dataIndex: 'created_at', width: 170,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
  ];

  const memberColumns = [
    {
      title: '用户', dataIndex: 'username', width: 150,
      render: (name, record) => (
        <Space>
          <Avatar size="small">{name[0]?.toUpperCase()}</Avatar>
          <span>{name}</span>
        </Space>
      ),
    },
    { title: '邮箱', dataIndex: 'email', width: 200, render: (t) => t || '-' },
    {
      title: '角色', dataIndex: 'role', width: 130,
      render: (role, record) => canManageMembers ? (
        <Select
          value={role}
          size="small"
          style={{ width: 100 }}
          onChange={(val) => handleChangeRole(record.id, val)}
          disabled={record.role === 'owner' && project.members.filter(m => m.role === 'owner').length <= 1}
        >
          <Select.Option value="owner">Owner</Select.Option>
          <Select.Option value="developer">开发者</Select.Option>
          <Select.Option value="viewer">观察者</Select.Option>
        </Select>
      ) : (
        <span style={{ fontSize: 12, fontWeight: 300, color: '#666' }}>{roleLabels[role]}</span>
      ),
    },
    {
      title: '操作', width: 80,
      render: (_, record) => canManageMembers && record.user_id !== currentUser.id && (
        <Popconfirm title="确认移除此成员？" onConfirm={() => handleRemoveMember(record.id)}>
          <Button type="link" size="small" danger>移除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')} style={{ marginBottom: 12 }}>返回</Button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>{project.name}</div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: project.status === 'active' ? '#34c759' : '#c7c7c7' }} />
            <span style={{ fontSize: 12, fontWeight: 400, color: '#666' }}>{project.status}</span>
          </span>
        </div>
      </div>

      <Tabs defaultActiveKey="info" items={[
        {
          key: 'info',
          label: '项目信息',
          children: (
            <Descriptions bordered column={2}>
              <Descriptions.Item label="项目名称">{project.name}</Descriptions.Item>
              <Descriptions.Item label="构建类型">
                <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{project.build_type}</span>
              </Descriptions.Item>
              <Descriptions.Item label="项目描述" span={2}>{project.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="GitLab 连接">
                {project.gitlab_connection_name && project.gitlab_url
                  ? `${project.gitlab_connection_name} (${project.gitlab_url})`
                  : (project.gitlab_connection_name || project.gitlab_url || '-')}
              </Descriptions.Item>
              <Descriptions.Item label="仓库路径">{project.repo_path || '-'}</Descriptions.Item>
              <Descriptions.Item label="默认分支">{project.default_branch || '-'}</Descriptions.Item>
              <Descriptions.Item label="远程仓库">
                {project.registry_name && project.registry_url
                  ? `${project.registry_name} (${project.registry_url})`
                  : (project.registry_name || project.registry_url || '-')}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">{dayjs(project.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{dayjs(project.updated_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
            </Descriptions>
          ),
        },
        {
          key: 'members',
          label: `成员 (${project.members?.length || 0})`,
          children: (
            <div>
              {canManageMembers && (
                <div style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<UserAddOutlined />} onClick={() => {
                    setMemberModalVisible(true);
                    import('../api/auth').then(m => m.userApi.getList({ pageSize: 100 })).then(res => setAllUsers(res.data.data.list));
                  }}>添加成员</Button>
                </div>
              )}
              <Table rowKey="id" columns={memberColumns} dataSource={project.members || []} pagination={false} size="small" />
            </div>
          ),
        },
        {
          key: 'builds',
          label: '构建历史',
          children: (
            <Table rowKey="id" columns={buildColumns} dataSource={project.recent_builds || []} pagination={false} size="small" />
          ),
        },
      ]} />

      <Modal title="添加成员" open={memberModalVisible} onOk={handleAddMember} onCancel={() => setMemberModalVisible(false)} destroyOnClose>
        <div style={{ marginBottom: 16 }}>
          <Text>选择用户：</Text>
          <Select
            showSearch
            style={{ width: '100%', marginTop: 8 }}
            placeholder="搜索用户"
            optionFilterProp="children"
            onChange={(val) => setMemberForm({ ...memberForm, user_id: val })}
          >
            {(allUsers || []).filter(u => !project.members?.some(m => m.id === u.id)).map(u => (
              <Select.Option key={u.id} value={u.id}>{u.username} ({u.email || '无邮箱'})</Select.Option>
            ))}
          </Select>
        </div>
        <div>
          <Text>角色：</Text>
          <Select style={{ width: '100%', marginTop: 8 }} value={memberForm.role} onChange={(val) => setMemberForm({ ...memberForm, role: val })}>
            <Select.Option value="viewer">观察者</Select.Option>
            <Select.Option value="developer">开发者</Select.Option>
            <Select.Option value="owner">Owner</Select.Option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}

export default ProjectDetail;
