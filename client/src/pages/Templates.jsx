import React, { useEffect, useState, useCallback } from 'react';
import { Table, Button, Space, Modal, Form, Input, Select, Tag, message, Typography, Popconfirm, Drawer, Descriptions, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined, CopyOutlined } from '@ant-design/icons';
import { templateApi } from '../api/builds';
import { useSelector } from 'react-redux';
import dayjs from 'dayjs';

const { Text } = Typography;
const { TextArea } = Input;

const buildTypeColors = { java: 'orange', nodejs: 'green', custom: 'blue' };

function Templates() {
  const { user: currentUser } = useSelector((state) => state.auth);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [viewTemplate, setViewTemplate] = useState(null);
  const [form] = Form.useForm();

  // 检查当前用户是否有权限编辑/删除模板
  const canEditTemplate = (template) => {
    if (!template) return false;
    if (currentUser.role === 'admin') return true;
    if (template.is_system) return false;
    return template.created_by === currentUser.id;
  };

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await templateApi.getList();
      setTemplates(res.data.data);
    } catch {
      message.error('获取模板列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); }, []);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ build_type: 'custom', content: 'FROM {{base_image}}\nWORKDIR /app\nCOPY . .\nEXPOSE {{port}}' });
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      description: record.description,
      build_type: record.build_type,
      content: record.content,
      scope: record.scope || 'private',
      variables: record.variables?.map(v => `${v.name}=${v.default || ''}`).join('\n') || '',
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // 解析变量
      const variables = (values.variables || '').split('\n')
        .filter(line => line.includes('='))
        .map(line => {
          const [name, ...rest] = line.split('=');
          return { name: name.trim(), default: rest.join('=').trim(), description: '' };
        });

      const data = {
        name: values.name,
        description: values.description,
        build_type: values.build_type,
        content: values.content,
        scope: values.scope || 'private',
        variables,
      };

      if (editing) {
        await templateApi.update(editing.id, data);
        message.success('模板已更新');
      } else {
        await templateApi.create(data);
        message.success('模板已创建');
      }
      setModalVisible(false);
      fetchTemplates();
    } catch (err) {
      if (err.response?.data?.message) message.error(err.response.data.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      await templateApi.delete(id);
      message.success('模板已删除');
      fetchTemplates();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handlePreview = async (record) => {
    try {
      const defaultVars = {};
      (record.variables || []).forEach(v => { defaultVars[v.name] = v.default || ''; });
      const res = await templateApi.preview(record.id, defaultVars);
      setPreviewContent(res.data.data.rendered);
      setPreviewVisible(true);
    } catch {
      message.error('预览失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '名称', dataIndex: 'name', width: 180, ellipsis: true },
    {
      title: '类型', dataIndex: 'build_type', width: 80,
      render: (t) => <Tag color={buildTypeColors[t]}>{t}</Tag>,
    },
    {
      title: '变量', dataIndex: 'variables', width: 200,
      render: (vars) => vars?.length ? vars.map(v => <Tag key={v.name} style={{ marginBottom: 2 }}>{`{{${v.name}}}`}</Tag>) : '-',
    },
    {
      title: '可见性', dataIndex: 'scope', width: 80,
      render: (scope) => {
        const map = { public: { dot: '#111', label: '公开' }, project: { dot: '#34c759', label: '项目可见' }, private: { dot: '#c7c7c7', label: '私有' } };
        const cfg = map[scope] || { dot: '#c7c7c7', label: scope };
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot, display: 'inline-block' }} />
            {cfg.label}
          </span>
        );
      },
    },
    {
      title: '系统', dataIndex: 'is_system', width: 60,
      render: (v) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: v ? '#ff3b30' : '#c7c7c7', display: 'inline-block' }} />
          {v ? '内置' : '自定义'}
        </span>
      ),
    },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '创建人', dataIndex: 'created_by_name', width: 90, ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '创建时间', dataIndex: 'created_at', width: 150,
      render: (t) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作', width: 200, fixed: 'right',
      render: (_, record) => {
        const canEdit = canEditTemplate(record);
        return (
          <Space>
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setViewTemplate(record)}>查看</Button>
            <Tooltip title={!canEdit ? '无权操作此模板' : ''}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={!canEdit}>编辑</Button>
            </Tooltip>
            {!record.is_system && (
              <Tooltip title={!canEdit ? '无权操作此模板' : ''}>
                <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)} disabled={!canEdit}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={!canEdit}>删除</Button>
                </Popconfirm>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>Dockerfile 模板</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新建模板</Button>
      </div>

      <Table rowKey="id" columns={columns} dataSource={templates} loading={loading} scroll={{ x: 1000 }} size="middle" />

      {/* 编辑/创建弹窗 */}
      <Modal
        title={editing ? '编辑模板' : '新建模板'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={800}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input placeholder="如：Spring Boot 标准模板" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="模板描述" />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="build_type" label="构建类型" rules={[{ required: true }]} style={{ width: 150 }}>
              <Select>
                <Select.Option value="java">Java</Select.Option>
                <Select.Option value="nodejs">Node.js</Select.Option>
                <Select.Option value="custom">自定义</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="scope" label="可见性" initialValue="private" style={{ width: 150 }}>
              <Select>
                <Select.Option value="private">私有</Select.Option>
                <Select.Option value="public">公开</Select.Option>
                <Select.Option value="project">项目可见</Select.Option>
              </Select>
            </Form.Item>
          </Space>
          <Form.Item
            name="content"
            label={
              <span>
                Dockerfile 内容
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  使用 {'{{变量名}}'} 定义变量
                </Text>
              </span>
            }
            rules={[{ required: true, message: '请输入 Dockerfile 内容' }]}
          >
            <TextArea
              rows={15}
              placeholder="FROM {{base_image}}&#10;WORKDIR /app&#10;..."
              style={{ fontFamily: 'monospace', fontSize: 13 }}
            />
          </Form.Item>
          <Form.Item
            name="variables"
            label="变量定义（每行一个，格式：变量名=默认值）"
          >
            <TextArea rows={4} placeholder="port=8080&#10;base_image=alpine:latest" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 查看模板详情 */}
      <Drawer
        title={viewTemplate?.name}
        open={!!viewTemplate}
        onClose={() => setViewTemplate(null)}
        width={600}
        extra={
          <Button icon={<CopyOutlined />} size="small" onClick={() => {
            navigator.clipboard.writeText(viewTemplate?.content || '');
            message.success('已复制到剪贴板');
          }}>
            复制
          </Button>
        }
      >
        {viewTemplate && (
          <>
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型"><Tag color={buildTypeColors[viewTemplate.build_type]}>{viewTemplate.build_type}</Tag></Descriptions.Item>
              <Descriptions.Item label="系统内置">{viewTemplate.is_system ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{viewTemplate.description || '-'}</Descriptions.Item>
            </Descriptions>
            {viewTemplate.variables?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>变量：</Text>
                <div style={{ marginTop: 8 }}>
                  {viewTemplate.variables.map(v => (
                    <Tag key={v.name} style={{ marginBottom: 4 }}>{`{{${v.name}}}`} = {v.default || '(无默认值)'}</Tag>
                  ))}
                </div>
              </div>
            )}
            <Text strong>Dockerfile：</Text>
            <pre style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              fontFamily: 'monospace',
              overflow: 'auto',
              maxHeight: 400,
              marginTop: 8,
            }}>
              {viewTemplate.content}
            </pre>
          </>
        )}
      </Drawer>

      {/* 预览弹窗 */}
      <Modal
        title="渲染预览"
        open={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        footer={null}
        width={700}
      >
        <pre style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: 16,
          borderRadius: 8,
          fontSize: 13,
          fontFamily: 'monospace',
          overflow: 'auto',
          maxHeight: 500,
        }}>
          {previewContent}
        </pre>
      </Modal>
    </div>
  );
}

export default Templates;
