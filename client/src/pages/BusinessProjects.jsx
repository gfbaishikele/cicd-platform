import React, { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, message, Popconfirm, Descriptions } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, AppstoreOutlined, SearchOutlined } from '@ant-design/icons';
import { businessProjectsApi } from '../api/projects';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';

function BusinessProjects() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const navigate = useNavigate();

  const fetchList = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterName) params.name = filterName;
      const res = await businessProjectsApi.getList(params);
      setList(res.data.data);
    } catch {
      message.error('获取项目管理列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, [filterName]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await businessProjectsApi.create(values);
      message.success('项目管理创建成功');
      setCreateVisible(false);
      fetchList();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleEdit = async () => {
    try {
      const values = await editForm.validateFields();
      await businessProjectsApi.update(editing.id, values);
      message.success('项目管理更新成功');
      setEditVisible(false);
      fetchList();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await businessProjectsApi.delete(id);
      message.success('项目管理已删除');
      fetchList();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const openDetail = async (id) => {
    try {
      const res = await businessProjectsApi.getById(id);
      setDetail(res.data.data);
      setDetailVisible(true);
    } catch {
      message.error('获取详情失败');
    }
  };

  const openEdit = (record) => {
    setEditing(record);
    editForm.setFieldsValue({
      name: record.name,
      description: record.description,
      status: record.status,
    });
    setEditVisible(true);
  };

  const columns = [
    {
      title: '项目管理名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      ellipsis: true,
      render: (text, record) => (
        <a onClick={() => openDetail(record.id)}>{text}</a>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s) => {
        const map = { active: { color: '#34c759', label: '进行中' }, archived: { color: '#c7c7c7', label: '已归档' } };
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
      title: '模块数',
      dataIndex: 'module_count',
      key: 'module_count',
      width: 80,
      align: 'center',
    },
    {
      title: '创建人',
      dataIndex: 'created_by_name',
      key: 'created_by_name',
      width: 100,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => openDetail(record.id)}>详情</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除该项目管理？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>项目管理</div>
        <Space>
          <Input placeholder="按应用名称筛选" prefix={<SearchOutlined />} value={filterName} onChange={(e) => setFilterName(e.target.value)} style={{ width: 200 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateVisible(true); }}>
            新建项目管理
          </Button>
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={list}
        rowKey="id"
        loading={loading}
        pagination={false}
      />

      {/* 新建弹窗 */}
      <Modal title="新建项目管理" open={createVisible} onOk={handleCreate} onCancel={() => setCreateVisible(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：电商平台、OA 系统" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="项目管理描述（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑弹窗 */}
      <Modal title="编辑项目管理" open={editVisible} onOk={handleEdit} onCancel={() => setEditVisible(false)} destroyOnClose>
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：电商平台、OA 系统" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="项目管理描述（可选）" />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="active">
            <Select>
              <Select.Option value="active">进行中</Select.Option>
              <Select.Option value="archived">已归档</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情弹窗 */}
      <Modal
        title={detail?.name || '项目管理详情'}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={null}
        width={640}
      >
        {detail && (
          <>
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {(() => {
                  const map = { active: { color: '#34c759', label: '进行中' }, archived: { color: '#c7c7c7', label: '已归档' } };
                  const cfg = map[detail.status] || { color: '#c7c7c7', label: detail.status };
                  return (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
                      {cfg.label}
                    </span>
                  );
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{detail.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{detail.created_at ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="模块数">{detail.module_count || 0}</Descriptions.Item>
            </Descriptions>

            {detail.modules && detail.modules.length > 0 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 400, color: '#111', marginBottom: 8 }}>关联模块</div>
                <Table
                  size="small"
                  dataSource={detail.modules}
                  rowKey="id"
                  pagination={false}
                  columns={[
                    { title: '模块名称', dataIndex: 'name', key: 'name', render: (text, r) => <a onClick={() => navigate(`/projects/${r.id}`)}>{text}</a> },
                    { title: '类型', dataIndex: 'build_type', key: 'build_type', width: 80 },
                    { title: '仓库路径', dataIndex: 'repo_path', key: 'repo_path', ellipsis: true },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

export default BusinessProjects;
