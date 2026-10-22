import React, { useEffect, useState } from 'react';
import {
  Card, Select, Button, Space, message, Table, Typography, DatePicker, Radio, Alert, Drawer,
} from 'antd';
import { ThunderboltOutlined, EyeOutlined } from '@ant-design/icons';
import { dbApi } from '../api/dbConnections';
import dayjs from 'dayjs';

const { Text } = Typography;
const { RangePicker } = DatePicker;

function TablePartition() {
  const [connections, setConnections] = useState([]);
  const [tables, setTables] = useState([]);
  const [selectedConn, setSelectedConn] = useState(null);
  const [selectedSchema, setSelectedSchema] = useState('public');
  const [schemas, setSchemas] = useState([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState(null);
  const [strategy, setStrategy] = useState('monthly');
  const [dateRange, setDateRange] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [connLoading, setConnLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [ddlDrawer, setDdlDrawer] = useState({ visible: false, tableName: '', ddl: '' });

  const connInfo = connections.find(c => c.id === selectedConn);
  const isPgType = connInfo && ['pg', 'opengauss'].includes(connInfo.db_type);

  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    setConnLoading(true);
    try {
      const res = await dbApi.getList();
      setConnections(res.data.data || []);
    } catch {
      message.error('获取连接列表失败');
    } finally {
      setConnLoading(false);
    }
  };

  const loadTables = async (connId, schema) => {
    setTableLoading(true);
    try {
      const res = await dbApi.getTables(connId, undefined, schema);
      setTables(res.data.data || []);
    } catch (err) {
      message.error('获取表列表失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setTableLoading(false);
    }
  };

  const handleConnChange = async (connId) => {
    setSelectedConn(connId);
    setSelectedTable(null);
    setTables([]);
    setSchemas([]);
    setSelectedSchema('public');
    setPreviewData(null);
    if (!connId) return;

    const conn = connections.find(c => c.id === connId);
    if (conn && ['pg', 'opengauss'].includes(conn.db_type)) {
      setSchemaLoading(true);
      try {
        const res = await dbApi.getSchemas(connId);
        const schemaList = res.data.data || [];
        setSchemas(schemaList);
        const defaultSchema = schemaList.includes('public') ? 'public' : schemaList[0] || 'public';
        setSelectedSchema(defaultSchema);
        await loadTables(connId, defaultSchema);
      } catch (err) {
        message.error('获取 schema 列表失败');
      } finally {
        setSchemaLoading(false);
      }
    } else {
      await loadTables(connId);
    }
  };

  const handleSchemaChange = async (schema) => {
    setSelectedSchema(schema);
    setSelectedTable(null);
    setPreviewData(null);
    if (selectedConn) {
      await loadTables(selectedConn, schema);
    }
  };

  const handlePreview = async () => {
    if (!selectedConn || !selectedTable || !dateRange) {
      message.warning('请选择连接、表和日期范围');
      return;
    }
    setLoading(true);
    try {
      const res = await dbApi.partitionPreview(selectedConn, {
        source_table: selectedTable,
        strategy,
        start_date: dateRange[0].format('YYYY-MM-DD'),
        end_date: dateRange[1].format('YYYY-MM-DD'),
        schema: isPgType ? selectedSchema : undefined,
      });
      setPreviewData(res.data.data || []);
    } catch (err) {
      message.error('预览失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!previewData || previewData.length === 0) {
      message.warning('请先预览分表');
      return;
    }
    setExecuting(true);
    try {
      const res = await dbApi.partitionExecute(selectedConn, {
        source_table: selectedTable,
        strategy,
        start_date: dateRange[0].format('YYYY-MM-DD'),
        end_date: dateRange[1].format('YYYY-MM-DD'),
        schema: isPgType ? selectedSchema : undefined,
      });
      const results = res.data.data || [];
      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      if (failCount > 0) {
        message.warning(`完成：${successCount} 个成功，${failCount} 个失败`);
      } else {
        message.success(`全部分表创建成功，共 ${successCount} 个`);
      }
    } catch (err) {
      message.error('执行失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setExecuting(false);
    }
  };

  const previewColumns = [
    { title: '序号', key: 'index', width: 60, render: (_, __, i) => i + 1 },
    { title: '分表名称', dataIndex: 'tableName', key: 'tableName', width: 250,
      render: (name) => <Text strong>{name}</Text>,
    },
    {
      title: '状态', key: 'status', width: 100,
      render: (_, record) => record._executed
        ? (record._success
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34c759', display: 'inline-block' }} />已创建</span>
          : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff3b30', display: 'inline-block' }} />失败</span>)
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c7c7c7', display: 'inline-block' }} />待创建</span>,
    },
    {
      title: 'DDL', dataIndex: 'ddl', key: 'ddl', width: 300,
      render: (ddl, record) => (
        <Space>
          <Text code style={{ fontSize: 12 }}>{ddl?.substring(0, 60)}...</Text>
          <Button type="link" size="small" onClick={() => setDdlDrawer({ visible: true, tableName: record.tableName, ddl })}>详情</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>创建分表</div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        基于现有表结构，按月或按年批量创建分表
      </Text>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap size="middle" align="end">
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>数据库连接</div>
            <Select
              style={{ width: 220 }}
              placeholder="选择连接"
              loading={connLoading}
              value={selectedConn}
              onChange={handleConnChange}
              allowClear
              showSearch
              optionFilterProp="label"
              options={connections.map(c => ({ value: c.id, label: `${c.name} (${c.host}:${c.port}/${c.database})` }))}
            />
          </div>
          {isPgType && (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>Schema</div>
              <Select
                style={{ width: 160 }}
                placeholder="选择 schema"
                loading={schemaLoading}
                value={selectedSchema}
                onChange={handleSchemaChange}
                showSearch
                optionFilterProp="label"
                options={schemas.map(s => ({ value: s, label: s }))}
              />
            </div>
          )}
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>源表</div>
            <Select
              style={{ width: 200 }}
              placeholder="选择表"
              loading={tableLoading}
              value={selectedTable}
              onChange={(val) => { setSelectedTable(val); setPreviewData(null); }}
              allowClear
              showSearch
              optionFilterProp="label"
              disabled={!selectedConn}
              options={tables.map(t => ({ value: t, label: t }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>分表策略</div>
            <Radio.Group value={strategy} onChange={(e) => { setStrategy(e.target.value); setPreviewData(null); }}>
              <Radio.Button value="monthly">按月</Radio.Button>
              <Radio.Button value="yearly">按年</Radio.Button>
            </Radio.Group>
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>日期范围</div>
            <RangePicker
              value={dateRange}
              onChange={setDateRange}
              picker={strategy === 'monthly' ? 'month' : 'year'}
            />
          </div>
          <Button icon={<EyeOutlined />} onClick={handlePreview} loading={loading} disabled={!selectedConn || !selectedTable || !dateRange}>
            预览
          </Button>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleExecute} loading={executing} disabled={!previewData}>
            执行创建
          </Button>
        </Space>
      </Card>

      {connInfo && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`当前连接：${connInfo.name}（${connInfo.db_type.toUpperCase()} - ${connInfo.host}:${connInfo.port}/${connInfo.database}）`}
        />
      )}

      {previewData && (
        <Card title={`分表预览（共 ${previewData.length} 个表）`} size="small">
          <Table
            dataSource={previewData}
            columns={previewColumns}
            rowKey="tableName"
            pagination={false}
            size="small"
          />
        </Card>
      )}

      <Drawer
        title={`DDL 详情 — ${ddlDrawer.tableName}`}
        open={ddlDrawer.visible}
        onClose={() => setDdlDrawer({ visible: false, tableName: '', ddl: '' })}
        width={640}
      >
        <pre style={{
          background: '#f5f5f5', padding: 16, borderRadius: 6, fontSize: 13,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
          maxHeight: 'calc(100vh - 160px)', overflow: 'auto',
        }}>
          {ddlDrawer.ddl}
        </pre>
      </Drawer>
    </div>
  );
}

export default TablePartition;
