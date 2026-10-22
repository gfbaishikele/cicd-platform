import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Button, Space, Input, Empty, Modal, Form, Select, message, Popconfirm } from 'antd';
import { PlusOutlined, SearchOutlined, BuildOutlined, DeleteOutlined, EditOutlined, RocketOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { projectApi, gitlabApi, businessProjectsApi } from '../api/projects';
import { registriesApi } from '../api/registries';
import dayjs from 'dayjs';

const buildTypeLabels = { java: 'Java', nodejs: 'Node.js', custom: '自定义' };

function Projects() {
  const [projects, setProjects] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [filterName, setFilterName] = useState('');
  const [filterBusinessProject, setFilterBusinessProject] = useState(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [connections, setConnections] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [registries, setRegistries] = useState([]);
  const [businessProjects, setBusinessProjects] = useState([]);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const navigate = useNavigate();

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const params = { keyword, page: 1, pageSize: 50 };
      if (filterBusinessProject) params.business_project_id = filterBusinessProject;
      if (filterName) params.name = filterName;
      const res = await projectApi.getList(params);
      setProjects(res.data.data.list);
      setTotal(res.data.data.total);
    } catch {
      message.error('获取项目列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, [keyword, filterBusinessProject, filterName]);

  useEffect(() => {
    businessProjectsApi.getList().then(res => setBusinessProjects(res.data.data)).catch(() => {});
  }, []);

  const openCreate = async () => {
    form.resetFields();
    try {
      const [connRes, tempRes, regRes, bpRes] = await Promise.all([
        gitlabApi.getConnections(),
        import('../api/index').then(api => api.default.get('/templates')),
        registriesApi.getList(),
        businessProjectsApi.getList(),
      ]);
      setConnections(connRes.data.data);
      setTemplates(tempRes.data.data);
      setRegistries(regRes.data.data);
      setBusinessProjects(bpRes.data.data);
    } catch {
      // ignore
    }
    setCreateVisible(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await projectApi.create(values);
      message.success('模块创建成功');
      setCreateVisible(false);
      fetchProjects();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await projectApi.delete(id);
      message.success('项目已删除');
      fetchProjects();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const openEdit = async (project) => {
    setEditingProject(project);
    try {
      const [connRes, regRes, bpRes] = await Promise.all([
        gitlabApi.getConnections(),
        registriesApi.getList(),
        businessProjectsApi.getList(),
      ]);
      setConnections(connRes.data.data);
      setRegistries(regRes.data.data);
      setBusinessProjects(bpRes.data.data);
      editForm.setFieldsValue({
        name: project.name,
        description: project.description,
        gitlab_connection_id: project.gitlab_connection,
        repo_path: project.repo_path,
        default_branch: project.default_branch,
        build_type: project.build_type,
        registry_id: project.registry_id || undefined,
        business_project_id: project.business_project_id || undefined,
      });
    } catch {
      // ignore
    }
    setEditVisible(true);
  };

  const handleEdit = async () => {
    try {
      const values = await editForm.validateFields();
      await projectApi.update(editingProject.id, values);
      message.success('模块更新成功');
      setEditVisible(false);
      fetchProjects();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>模块管理</div>
        <Space>
          <Select
            placeholder="按项目管理筛选"
            allowClear
            style={{ width: 180 }}
            value={filterBusinessProject}
            onChange={setFilterBusinessProject}
          >
            {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
          </Select>
          <Input placeholder="按应用名称筛选" prefix={<SearchOutlined />} value={filterName} onChange={(e) => setFilterName(e.target.value)} style={{ width: 200 }} allowClear />
          <Input placeholder="搜索模块" prefix={<SearchOutlined />} value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ width: 200 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建模块</Button>
        </Space>
      </div>

      {projects.length === 0 && !loading ? (
        <Empty description="暂无模块" style={{ marginTop: 80 }}>
          <Button type="primary" onClick={openCreate}>创建第一个模块</Button>
        </Empty>
      ) : (
        <Row gutter={[16, 16]} style={{ display: 'flex', flexWrap: 'wrap' }}>
          {projects.map((project) => (
            <Col xs={24} sm={12} lg={8} xl={6} key={project.id}>
              <Card
                hoverable
                onClick={() => navigate(`/projects/${project.id}`)}
                style={{
                  flex: 1,
                  boxShadow: 'none',
                  border: '1px solid #f0f0f0',
                  borderRadius: 12,
                }}
              >
                <div style={{ minHeight: 100, display: 'flex', flexDirection: 'column' }}>
                  {/* 标题区域：项目名 + Tag 分两行显示 */}
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 400, color: '#111', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.name}>
                      {project.name}
                    </span>
                    <div style={{ marginTop: 6 }}>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666', marginRight: 6 }}>{buildTypeLabels[project.build_type]}</span>
                      {project.business_project_name && (
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{project.business_project_name}</span>
                      )}
                    </div>
                  </div>
                  <Card.Meta
                    description={
                      <div style={{ fontSize: 13, fontWeight: 300, color: '#999', lineHeight: 1.6, marginBottom: 0, minHeight: 44, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {project.description || '暂无描述'}
                      </div>
                    }
                  />
                  <div style={{ marginTop: 'auto' }}>
                    <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 300, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%', display: 'inline-block' }} title={project.repo_path}>
                        <BuildOutlined /> {project.repo_path || '-'}
                      </span>
                      {project.last_build && (() => {
                        const map = { success: { color: '#34c759', label: '成功' }, failed: { color: '#ff3b30', label: '失败' }, building: { color: '#ff9500', label: '构建中' }, pending: { color: '#c7c7c7', label: '等待' }, cancelled: { color: '#c7c7c7', label: '已取消' } };
                        const cfg = map[project.last_build.status] || { color: '#c7c7c7', label: project.last_build.status };
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 300, color: '#666' }}>
                            <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
                            {cfg.label}
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
                      {project.members_count || 0} 成员
                    </div>
                  </div>
                </div>
                {/* 自定义操作栏，替代 Card.actions 避免分隔线拥挤 */}
                <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 12, paddingTop: 8 }}>
                  <Space size="middle" style={{ width: '100%', justifyContent: 'center' }}>
                    <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${project.id}`); }}>详情</Button>
                    <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); navigate('/deploy-services'); }}>发布</Button>
                    <Button type="link" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); openEdit(project); }}>编辑</Button>
                    <Popconfirm title="确认删除？" onConfirm={(e) => { e?.stopPropagation(); handleDelete(project.id); }} onCancel={(e) => e?.stopPropagation()}>
                      <Button type="link" size="small" danger onClick={(e) => e.stopPropagation()}>删除</Button>
                    </Popconfirm>
                  </Space>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal title="新建模块" open={createVisible} onOk={handleCreate} onCancel={() => setCreateVisible(false)} width={520} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="模块名称" rules={[{ required: true, message: '请输入模块名称' }]}>
            <Input placeholder="如：核心业务服务" />
          </Form.Item>
          <Form.Item name="business_project_id" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
            <Select placeholder="选择所属项目" showSearch optionFilterProp="children">
              {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="description" label="模块描述">
            <Input.TextArea rows={2} placeholder="模块描述（可选）" />
          </Form.Item>
          <Form.Item name="gitlab_connection_id" label="GitLab 连接">
            <Select placeholder="选择 GitLab 连接" allowClear showSearch optionFilterProp="children">
              {connections.map(c => <Select.Option key={c.id} value={c.id}>{c.name} ({c.url})</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="repo_path" label="仓库路径" rules={[{ required: true, message: '请输入仓库路径' }]}>
            <Input placeholder="如：group/project-name" />
          </Form.Item>
          <Form.Item name="default_branch" label="默认分支" initialValue="main">
            <Input placeholder="main" />
          </Form.Item>
          <Form.Item name="build_type" label="构建类型" rules={[{ required: true, message: '请选择构建类型' }]}>
            <Select placeholder="选择构建类型">
              <Select.Option value="java">Java</Select.Option>
              <Select.Option value="nodejs">Node.js</Select.Option>
              <Select.Option value="custom">自定义</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="registry_id" label="目标镜像仓库">
            <Select placeholder="选择推送的远程仓库（可选）" allowClear showSearch optionFilterProp="children">
              {registries.map(r => <Select.Option key={r.id} value={r.id}>{r.name} ({r.url})</Select.Option>)}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="编辑模块" open={editVisible} onOk={handleEdit} onCancel={() => setEditVisible(false)} width={520} destroyOnClose>
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="模块名称" rules={[{ required: true, message: '请输入模块名称' }]}>
            <Input placeholder="如：核心业务服务" />
          </Form.Item>
          <Form.Item name="business_project_id" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
            <Select placeholder="选择所属项目" showSearch optionFilterProp="children">
              {businessProjects.map(bp => <Select.Option key={bp.id} value={bp.id}>{bp.name}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="description" label="模块描述">
            <Input.TextArea rows={2} placeholder="模块描述（可选）" />
          </Form.Item>
          <Form.Item name="gitlab_connection_id" label="GitLab 连接">
            <Select placeholder="选择 GitLab 连接" allowClear showSearch optionFilterProp="children">
              {connections.map(c => <Select.Option key={c.id} value={c.id}>{c.name} ({c.url})</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="repo_path" label="仓库路径" rules={[{ required: true, message: '请输入仓库路径' }]}>
            <Input placeholder="如：group/project-name" />
          </Form.Item>
          <Form.Item name="default_branch" label="默认分支">
            <Input placeholder="main" />
          </Form.Item>
          <Form.Item name="build_type" label="构建类型" rules={[{ required: true, message: '请选择构建类型' }]}>
            <Select placeholder="选择构建类型">
              <Select.Option value="java">Java</Select.Option>
              <Select.Option value="nodejs">Node.js</Select.Option>
              <Select.Option value="custom">自定义</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="registry_id" label="目标镜像仓库">
            <Select placeholder="选择推送的远程仓库（可选）" allowClear showSearch optionFilterProp="children">
              {registries.map(r => <Select.Option key={r.id} value={r.id}>{r.name} ({r.url})</Select.Option>)}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Projects;
