import React, { useEffect, useState } from 'react';
import {
  Table, Button, Space, Tag, message, Typography, Popconfirm, Modal, Form, Input, Select,
  Drawer, Descriptions, Card, Row, Col, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined, CloudServerOutlined,
  EyeOutlined, SyncOutlined, SearchOutlined,
} from '@ant-design/icons';
import { registriesApi } from '../api/registries';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const { Text } = Typography;

function Registries() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [registries, setRegistries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingRegistry, setEditingRegistry] = useState(null);
  const [form] = Form.useForm();

  // 镜像详情
  const [images, setImages] = useState([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [selectedRegistry, setSelectedRegistry] = useState(null);
  const [drawerVisible, setDrawerVisible] = useState(false);

  // 标签详情
  const [tags, setTags] = useState([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [tagsDrawerVisible, setTagsDrawerVisible] = useState(false);

  // 检查当前用户是否有权限编辑/删除 registry
  const canEditRegistry = (registry) => {
    if (!registry) return false;
    if (currentUser.role === 'admin') return true;
    return registry.created_by === currentUser.id && registry.scope === 'private';
  };

  const fetchRegistries = async () => {
    setLoading(true);
    try {
      const params = {};
      if (keyword) params.keyword = keyword;
      const res = await registriesApi.getList(params);
      setRegistries(res.data.data);
    } catch {
      message.error('获取 Registry 列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRegistries();
  }, []);

  useEffect(() => {
    fetchRegistries();
  }, [keyword]);

  const openModal = (registry = null) => {
    setEditingRegistry(registry);
    if (registry) {
      form.setFieldsValue({
        ...registry,
        password: '', // 密码不从 API 回填
      });
    } else {
      form.resetFields();
    }
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingRegistry) {
        await registriesApi.update(editingRegistry.id, values);
        message.success('Registry 已更新');
      } else {
        await registriesApi.create(values);
        message.success('Registry 已创建');
      }
      setModalVisible(false);
      fetchRegistries();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.message || '操作失败');
    }
  };

  const handleDelete = async (id) => {
    try {
      await registriesApi.delete(id);
      message.success('Registry 已删除');
      fetchRegistries();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handleTest = async (id) => {
    try {
      const res = await registriesApi.test(id);
      if (res.data.data.success) {
        message.success(`连接成功！Registry 版本: ${res.data.data.version}`);
      } else {
        message.error(`连接失败: ${res.data.data.error}`);
      }
    } catch (err) {
      message.error(err.response?.data?.message || '测试连接失败');
    }
  };

  const handleViewImages = async (registry) => {
    setSelectedRegistry(registry);
    setDrawerVisible(true);
    setImagesLoading(true);
    try {
      const res = await registriesApi.getImages(registry.id);
      setImages(res.data.data);
    } catch (err) {
      message.error(err.response?.data?.message || '获取镜像列表失败');
      setImages([]);
    } finally {
      setImagesLoading(false);
    }
  };

  const handleViewTags = async (image) => {
    setSelectedImage(image);
    setTagsDrawerVisible(true);
    setTagsLoading(true);
    try {
      const res = await registriesApi.getTags(selectedRegistry.id, image.name);
      setTags(res.data.data);
    } catch (err) {
      message.error(err.response?.data?.message || '获取标签列表失败');
      setTags([]);
    } finally {
      setTagsLoading(false);
    }
  };

  const handleDeleteTag = async (image, tag) => {
    try {
      await registriesApi.deleteTag(selectedRegistry.id, image, tag);
      message.success('标签已删除');
      handleViewTags({ name: image });
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '名称', dataIndex: 'name', width: 150, ellipsis: true },
    { title: 'URL', dataIndex: 'url', width: 250, ellipsis: true },
    {
      title: '类型', dataIndex: 'type', width: 80,
      render: (t) => <span style={{ fontSize: 12, fontWeight: 300, color: '#666' }}>{t}</span>,
    },
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
      title: 'SSL 验证', dataIndex: 'verify_ssl', width: 80,
      render: (v) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: v ? '#34c759' : '#c7c7c7', display: 'inline-block' }} />
          {v ? '是' : '否'}
        </span>
      ),
    },
    {
      title: '创建人', dataIndex: 'created_by_name', width: 100, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '创建时间', dataIndex: 'created_at', width: 160,
      render: (t) => dayjs(t).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作', width: 280, fixed: 'right',
      render: (_, record) => {
        const canEdit = canEditRegistry(record);
        return (
          <Space>
            <Button type="link" size="small" icon={<ApiOutlined />} onClick={() => handleTest(record.id)}>测试</Button>
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewImages(record)}>镜像</Button>
            <Tooltip title={!canEdit ? '无权操作此资源' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)} disabled={!canEdit}>编辑</Button>
            </Tooltip>
            <Tooltip title={!canEdit ? '无权操作此资源' : ''}>
              <Popconfirm title="确认删除此 Registry？" onConfirm={() => handleDelete(record.id)} disabled={!canEdit}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>删除</Button>
              </Popconfirm>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const imageColumns = [
    { title: '镜像名称', dataIndex: 'name', width: 300, ellipsis: true },
    {
      title: '标签数', dataIndex: 'tags_count', width: 80, align: 'center',
      render: (c) => <span style={{ fontSize: 12, fontWeight: 300, color: '#666' }}>{c}</span>,
    },
    {
      title: '最新标签', width: 200,
      render: (_, record) => record.latest_tag ? (
        <Space>
          <span style={{ fontSize: 12, fontWeight: 400, color: '#111' }}>{record.latest_tag.tag}</span>
          {record.latest_tag.size && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {(record.latest_tag.size / 1024 / 1024).toFixed(1)} MB
            </Text>
          )}
        </Space>
      ) : '-',
    },
    {
      title: '操作', width: 100,
      render: (_, record) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewTags(record)}>标签</Button>
      ),
    },
  ];

  const tagColumns = [
    { title: '标签', dataIndex: 'tag', width: 150, render: (t) => <span style={{ fontSize: 12, fontWeight: 400, color: '#111' }}>{t}</span> },
    {
      title: '大小', dataIndex: 'size', width: 100,
      render: (s) => s ? `${(s / 1024 / 1024).toFixed(1)} MB` : '-',
    },
    {
      title: 'Digest', dataIndex: 'digest', width: 200, ellipsis: true,
      render: (d) => d ? d.substring(0, 30) + '...' : '-',
    },
    {
      title: '操作', width: 100,
      render: (_, record) => {
        const canEdit = canEditRegistry(selectedRegistry);
        return (
          <Tooltip title={!canEdit ? '无权操作此资源' : ''}>
            <Popconfirm
              title="确认删除此标签？"
              description="此操作将直接删除远程仓库中的镜像，无法恢复！"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDeleteTag(selectedImage.name, record.tag)}
              disabled={!canEdit}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>删除</Button>
            </Popconfirm>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>远程 Registry 管理</div>
        <Space>
          <Input placeholder="搜索仓库名称/地址" prefix={<SearchOutlined />} value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ width: 220 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新增 Registry</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={registries}
        loading={loading}
        scroll={{ x: 1000 }}
        size="middle"
      />

      {/* 新增/编辑弹窗 */}
      <Modal
        title={editingRegistry ? '编辑 Registry' : '新增 Registry'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={500}
      >
        <Form form={form} layout="vertical" initialValues={{ type: 'docker', verify_ssl: 1 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：Harbor 生产环境" />
          </Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true, message: '请输入 URL' }]}>
            <Input placeholder="例如：https://registry.example.com" />
          </Form.Item>
          <Form.Item name="username" label="用户名">
            <Input placeholder={editingRegistry ? '不修改请留空' : '认证用户名'} />
          </Form.Item>
          <Form.Item name="password" label="密码">
            <Input.Password placeholder={editingRegistry ? '不修改请留空，将保留原密码' : '认证密码'} />
          </Form.Item>
          <Form.Item name="type" label="类型">
            <Select>
              <Select.Option value="docker">Docker Registry</Select.Option>
              <Select.Option value="harbor">Harbor</Select.Option>
              <Select.Option value="aliyun">阿里云</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="verify_ssl" label="SSL 验证">
            <Select>
              <Select.Option value={1}>验证</Select.Option>
              <Select.Option value={0}>不验证</Select.Option>
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

      {/* 镜像列表抽屉 */}
      <Drawer
        title={
          <Space>
            <CloudServerOutlined />
            <span>{selectedRegistry?.name} - 镜像列表</span>
            <Button
              type="link"
              size="small"
              icon={<SyncOutlined />}
              onClick={() => handleViewImages(selectedRegistry)}
            >
              刷新
            </Button>
          </Space>
        }
        open={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        width={800}
      >
        <Table
          rowKey="name"
          columns={imageColumns}
          dataSource={images}
          loading={imagesLoading}
          pagination={false}
          size="small"
        />
      </Drawer>

      {/* 标签列表抽屉 */}
      <Drawer
        title={`${selectedImage?.name} - 标签列表`}
        open={tagsDrawerVisible}
        onClose={() => setTagsDrawerVisible(false)}
        width={700}
      >
        <Table
          rowKey="tag"
          columns={tagColumns}
          dataSource={tags}
          loading={tagsLoading}
          pagination={false}
          size="small"
        />
      </Drawer>
    </div>
  );
}

export default Registries;
