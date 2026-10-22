import React, { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Switch, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { aiApi } from '../api/ai';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';

const PROVIDER_CONFIG = {
  openai: {
    label: 'OpenAI（含兼容接口）',
    defaultEndpoint: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  anthropic: {
    label: 'Anthropic（Claude）',
    defaultEndpoint: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514', 'claude-3-5-sonnet-20241022'],
  },
  deepseek: {
    label: 'DeepSeek',
    defaultEndpoint: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  qwen: {
    label: '通义千问',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  ollama: {
    label: 'Ollama（本地）',
    defaultEndpoint: 'http://localhost:11434/v1',
    models: ['llama3', 'llama3.1', 'mistral', 'qwen2'],
  },
  custom: {
    label: '自定义',
    defaultEndpoint: '',
    models: [],
  },
};

function AISettings() {
  const [form] = Form.useForm();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState('openai');
  const { user } = useSelector((state) => state.auth);
  const navigate = useNavigate();

  // 非 admin 跳转
  useEffect(() => {
    if (user?.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  // 加载列表
  const loadList = async () => {
    setLoading(true);
    try {
      const res = await aiApi.getConfig({ page: 1, pageSize: 100 });
      setList(res.data.data.list || []);
    } catch (err) {
      message.error('加载配置列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  const handleAdd = () => {
    setEditingId(null);
    setProvider('openai');
    form.resetFields();
    form.setFieldsValue({
      provider: 'openai',
      base_url: PROVIDER_CONFIG.openai.defaultEndpoint,
      max_tokens: 4096,
      timeout: 60,
      enabled: false,
    });
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingId(record.id);
    setProvider(record.provider || 'openai');
    // 不设置 api_key 值（已脱敏），显示占位符
    const { api_key, ...rest } = record;
    form.setFieldsValue({
      ...rest,
      enabled: record.enabled === 1,
      support_image: record.support_image === 1,
      thinking_mode: record.thinking_mode === 1,
    });
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    try {
      await aiApi.deleteConfig(id);
      message.success('删除成功');
      loadList();
    } catch (err) {
      message.error(err.response?.data?.message || '删除失败');
    }
  };

  const handleToggle = async (id, enabled) => {
    try {
      await aiApi.toggleConfig(id, enabled);
      message.success(enabled ? '已启用' : '已停用');
      loadList();
    } catch (err) {
      message.error(err.response?.data?.message || '操作失败');
    }
  };

  const handleProviderChange = (value) => {
    setProvider(value);
    const config = PROVIDER_CONFIG[value];
    if (config?.defaultEndpoint) {
      form.setFieldsValue({ base_url: config.defaultEndpoint });
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      const data = {
        ...values,
        enabled: values.enabled ? 1 : 0,
        support_image: values.support_image ? 1 : 0,
        thinking_mode: values.thinking_mode ? 1 : 0,
      };

      // 如果 api_key 为空（编辑时未修改），不发送
      if (!data.api_key) {
        delete data.api_key;
      }

      if (editingId) {
        await aiApi.updateConfig(editingId, data);
        message.success('配置已更新');
      } else {
        await aiApi.createConfig(data);
        message.success('配置已添加');
      }

      setModalVisible(false);
      loadList();
    } catch (err) {
      if (err.response?.data?.message) {
        message.error(err.response.data.message);
      } else if (err.errorFields) {
        // 表单验证错误，不显示 message
      } else {
        message.error('保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      const values = await form.validateFields();
      setTesting(true);
      // 编辑模式时传 id，方便后端从数据库取真实 Key
      const testData = editingId ? { ...values, id: editingId } : values;
      const res = await aiApi.test(testData);
      message.success(`连接成功！模型回复：${res.data.data.reply}`);
    } catch (err) {
      message.error(err.response?.data?.message || '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  const isCustom = provider === 'custom';
  const preset = PROVIDER_CONFIG[provider];
  const modelOptions = preset?.models?.map(m => ({ value: m, label: m })) || [];

  const columns = [
    {
      title: '配置名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
    },
    {
      title: '供应商',
      dataIndex: 'provider',
      key: 'provider',
      width: 150,
      render: (val) => PROVIDER_CONFIG[val]?.label || val,
    },
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model',
      width: 200,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (val, record) => (
        <Switch
          checked={val === 1}
          onChange={(checked) => handleToggle(record.id, checked)}
          checkedChildren="启用"
          unCheckedChildren="停用"
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确定要删除这个配置吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>AI 模型配置</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加配置
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={list}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
      />

      <Modal
        title={editingId ? '编辑配置' : '添加配置'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        width={700}
        footer={[
          <Button key="cancel" onClick={() => setModalVisible(false)}>
            取消
          </Button>,
          <Button key="test" icon={<ThunderboltOutlined />} onClick={handleTest} loading={testing}>
            测试连接
          </Button>,
          <Button key="save" type="primary" onClick={handleSave} loading={saving}>
            保存
          </Button>,
        ]}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称' }]}>
            <Input placeholder="如：生产环境-GPT4" />
          </Form.Item>

          <Form.Item name="provider" label="接入模式" rules={[{ required: true, message: '请选择接入模式' }]}>
            <Select
              options={Object.entries(PROVIDER_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label }))}
              onChange={handleProviderChange}
            />
          </Form.Item>

          <Form.Item
            name="base_url"
            label={isCustom ? '请求地址（Endpoint）' : 'API Endpoint'}
            rules={[{ required: true, message: '请输入 API 地址' }]}
          >
            <Input placeholder={preset?.defaultEndpoint || 'https://...'} />
          </Form.Item>

          <Form.Item
            name="api_key"
            label="API Key"
            rules={editingId ? [] : [{ required: true, message: '请输入 API Key' }]}
          >
            <Input.Password placeholder={editingId ? '留空则保持原有 Key' : 'sk-...'} />
          </Form.Item>

          <Form.Item
            name="model"
            label="模型名称"
            rules={[{ required: true, message: '请输入模型名称' }]}
          >
            {!isCustom && modelOptions.length > 0 ? (
              <Select
                options={modelOptions}
                placeholder="选择或输入模型"
                showSearch
                allowClear
              />
            ) : (
              <Input placeholder="如 gpt-4o-mini" />
            )}
          </Form.Item>

          <Form.Item name="enabled" label="立即启用" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>

          {isCustom && (
            <>
              <Form.Item name="context_window" label="上下文窗口大小">
                <Input type="number" placeholder="如 128000" />
              </Form.Item>

              <Form.Item name="support_image" label="支持图片输入" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item name="thinking_mode" label="开启思考模式" valuePropName="checked">
                <Switch />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}

export default AISettings;
