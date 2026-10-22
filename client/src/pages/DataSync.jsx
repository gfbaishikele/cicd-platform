import React, { useEffect, useState, useRef } from 'react';
import {
  Card, Select, Button, Space, message, Typography, Input, Alert, Table, Progress,
  Divider, Radio, Checkbox,
} from 'antd';
import { SwapOutlined, ArrowRightOutlined, CheckCircleOutlined, SyncOutlined, StopOutlined, CopyOutlined } from '@ant-design/icons';
import { dbApi } from '../api/dbConnections';

const { Text } = Typography;

function DataSync() {
  const [connections, setConnections] = useState([]);
  const [sourceTables, setSourceTables] = useState([]);
  const [sourceConn, setSourceConn] = useState(null);
  const [sourceSchema, setSourceSchema] = useState('public');
  const [sourceSchemas, setSourceSchemas] = useState([]);
  const [sourceTable, setSourceTable] = useState(null);
  const [selectedTables, setSelectedTables] = useState([]);
  const [targetConn, setTargetConn] = useState(null);
  const [targetSchema, setTargetSchema] = useState('public');
  const [targetSchemas, setTargetSchemas] = useState([]);
  const [targetTable, setTargetTable] = useState('');
  const [syncMode, setSyncMode] = useState('single'); // 'single' | 'batch'
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connLoading, setConnLoading] = useState(false);
  const [sourceTableLoading, setSourceTableLoading] = useState(false);
  const [sourceSchemaLoading, setSourceSchemaLoading] = useState(false);
  const [targetSchemaLoading, setTargetSchemaLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [batchResults, setBatchResults] = useState(null);
  const [streamLogs, setStreamLogs] = useState([]);
  const [streamProgress, setStreamProgress] = useState({ current: 0, total: 0 });
  const logEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [streamLogs]);

  useEffect(() => { fetchConnections(); }, []);

  const fetchConnections = async () => {
    setConnLoading(true);
    try {
      const res = await dbApi.getList();
      setConnections(res.data.data || []);
    } catch { message.error('获取连接列表失败'); }
    finally { setConnLoading(false); }
  };

  const isPgConn = (connId) => {
    const conn = connections.find(c => c.id === connId);
    return conn && ['pg', 'opengauss'].includes(conn.db_type);
  };

  const loadSourceTables = async (connId, schema) => {
    setSourceTableLoading(true);
    try {
      const res = await dbApi.getTables(connId, undefined, isPgConn(connId) ? schema : undefined);
      setSourceTables(res.data.data || []);
    } catch { message.error('获取表列表失败'); }
    finally { setSourceTableLoading(false); }
  };

  const handleSourceConnChange = async (connId) => {
    setSourceConn(connId);
    setSourceTable(null);
    setSelectedTables([]);
    setSourceTables([]);
    setSourceSchemas([]);
    setSourceSchema('public');
    setPreviewData(null);
    setSyncResult(null);
    setBatchResults(null);
    if (!connId) return;
    if (isPgConn(connId)) {
      setSourceSchemaLoading(true);
      try {
        const res = await dbApi.getSchemas(connId);
        const list = res.data.data || [];
        setSourceSchemas(list);
        const def = list.includes('public') ? 'public' : list[0] || 'public';
        setSourceSchema(def);
        await loadSourceTables(connId, def);
      } catch { message.error('获取 schema 列表失败'); }
      finally { setSourceSchemaLoading(false); }
    } else {
      await loadSourceTables(connId);
    }
  };

  const handleSourceSchemaChange = async (schema) => {
    setSourceSchema(schema);
    setSourceTable(null);
    setSelectedTables([]);
    setPreviewData(null);
    setSyncResult(null);
    setBatchResults(null);
    if (sourceConn) await loadSourceTables(sourceConn, schema);
  };

  const handleTargetConnChange = async (connId) => {
    setTargetConn(connId);
    setTargetSchemas([]);
    setTargetSchema('public');
    setPreviewData(null);
    setSyncResult(null);
    setBatchResults(null);
    if (!connId) return;
    if (isPgConn(connId)) {
      setTargetSchemaLoading(true);
      try {
        const res = await dbApi.getSchemas(connId);
        const list = res.data.data || [];
        setTargetSchemas(list);
        const def = list.includes('public') ? 'public' : list[0] || 'public';
        setTargetSchema(def);
      } catch { message.error('获取 schema 列表失败'); }
      finally { setTargetSchemaLoading(false); }
    }
  };

  const handlePreview = async () => {
    if (!sourceConn || !sourceTable || !targetConn || !targetTable) {
      message.warning('请填写完整的同步信息');
      return;
    }
    if (sourceConn === targetConn) {
      message.warning('源连接和目标连接不能相同');
      return;
    }
    setLoading(true);
    try {
      const res = await dbApi.syncPreview({
        source_conn_id: sourceConn,
        source_table: sourceTable,
        target_conn_id: targetConn,
        target_table: targetTable,
        source_schema: isPgConn(sourceConn) ? sourceSchema : undefined,
        target_schema: isPgConn(targetConn) ? targetSchema : undefined,
      });
      setPreviewData(res.data.data);
    } catch (err) {
      message.error('预览失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await dbApi.syncExecute({
        source_conn_id: sourceConn,
        source_table: sourceTable,
        target_conn_id: targetConn,
        target_table: targetTable,
        source_schema: isPgConn(sourceConn) ? sourceSchema : undefined,
        target_schema: isPgConn(targetConn) ? targetSchema : undefined,
      });
      setSyncResult(res.data.data);
      message.success(`同步完成，共迁移 ${res.data.data.synced} 条数据`);
    } catch (err) {
      message.error('同步失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setSyncing(false);
    }
  };

  const handleBatchSync = async () => {
    if (!sourceConn || !targetConn || selectedTables.length === 0) {
      message.warning('请选择源连接、目标连接和要同步的表');
      return;
    }
    if (sourceConn === targetConn) {
      message.warning('源连接和目标连接不能相同');
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSyncing(true);
    setBatchResults(null);
    setStreamLogs([]);
    setStreamProgress({ current: 0, total: selectedTables.length });

    try {
      const response = await dbApi.syncBatchStream({
        source_conn_id: sourceConn,
        source_tables: selectedTables,
        target_conn_id: targetConn,
        source_schema: isPgConn(sourceConn) ? sourceSchema : undefined,
        target_schema: isPgConn(targetConn) ? targetSchema : undefined,
      }, controller.signal);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            switch (data.type) {
              case 'table_start':
                setStreamLogs(prev => [...prev, {
                  type: 'info', table: data.table,
                  message: `[${data.index}/${data.total}] 开始同步 ${data.table}`,
                }]);
                break;
              case 'progress':
                setStreamLogs(prev => [...prev, {
                  type: 'info', table: data.table,
                  message: `  ${data.message}`,
                }]);
                break;
              case 'table_complete':
                setStreamProgress({ current: data.index, total: data.total });
                setStreamLogs(prev => [...prev, {
                  type: 'success', table: data.table,
                  message: `  ✓ 完成，同步 ${data.synced}/${data.rowTotal} 条`,
                }]);
                break;
              case 'table_error':
                setStreamProgress({ current: data.index, total: data.total });
                setStreamLogs(prev => [...prev, {
                  type: 'error', table: data.table,
                  message: `  ✗ 失败: ${data.error}`,
                }]);
                break;
              case 'all_done':
                setBatchResults(data.results);
                if (data.failCount > 0) {
                  message.warning(`${data.successCount} 张表成功，${data.failCount} 张表失败`);
                } else {
                  message.success(`全部 ${data.successCount} 张表同步成功`);
                }
                break;
              default: break;
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        message.info('批量同步已中止');
        setStreamLogs(prev => [...prev, {
          type: 'error', table: '',
          message: '── 用户中止同步 ──',
        }]);
      } else {
        message.error('批量同步失败: ' + (err.message));
      }
    } finally {
      abortControllerRef.current = null;
      setSyncing(false);
    }
  };

  const handleCancelSync = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleCopyLogs = () => {
    const text = streamLogs.map(l => l.message).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      message.success('日志已复制到剪贴板');
    }).catch(() => {
      message.error('复制失败');
    });
  };

  const getDbTypeLabel = (type) => {
    const map = { mysql: 'MySQL', pg: 'PostgreSQL', opengauss: 'OpenGauss' };
    return map[type] || type;
  };

  const sourceConnInfo = connections.find(c => c.id === sourceConn);
  const targetConnInfo = connections.find(c => c.id === targetConn);

  const columnTableColumns = [
    { title: '字段名', dataIndex: 'column_name', key: 'column_name', width: 160 },
    { title: '源类型', dataIndex: 'column_type', key: 'column_type', width: 160, render: (t) => <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{t}</span> },
    { title: '可空', dataIndex: 'is_nullable', key: 'is_nullable', width: 70,
      render: (v) => v === 'NO' ? <span style={{ fontSize: 11, color: '#ff3b30' }}>NO</span> : <span style={{ fontSize: 11, color: '#999' }}>YES</span> },
    { title: '键', dataIndex: 'column_key', key: 'column_key', width: 70,
      render: (v) => v === 'PRI' ? <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: '#f5f5f5', color: '#111' }}>PK</span> : '-' },
  ];

  const batchResultColumns = [
    { title: '表名', dataIndex: 'table', key: 'table', width: 200 },
    { title: '状态', key: 'status', width: 100,
      render: (_, r) => r.success
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34c759', display: 'inline-block' }} />成功</span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff3b30', display: 'inline-block' }} />失败</span>,
    },
    { title: '数据量', key: 'total', width: 100,
      render: (_, r) => r.success ? `${r.synced}/${r.total}` : '-',
    },
    { title: '错误信息', dataIndex: 'error', key: 'error',
      render: (e) => e ? <Text type="danger">{e}</Text> : '-',
    },
  ];

  const handleModeChange = (mode) => {
    setSyncMode(mode);
    setPreviewData(null);
    setSyncResult(null);
    setBatchResults(null);
    setStreamLogs([]);
    setStreamProgress({ current: 0, total: 0 });
    setSourceTable(null);
    setSelectedTables([]);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111' }}>跨库同步</div>
        <Radio.Group value={syncMode} onChange={(e) => handleModeChange(e.target.value)}>
          <Radio.Button value="single">单表同步</Radio.Button>
          <Radio.Button value="batch">批量同步</Radio.Button>
        </Radio.Group>
      </div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        在不同类型数据库之间转换表结构并同步数据（支持 MySQL / PostgreSQL / OpenGauss）
      </Text>

      {/* 源端配置 */}
      <Card title="源端配置" size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" align="end">
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>数据库连接</div>
            <Select
              style={{ width: 280 }}
              placeholder="选择源连接"
              loading={connLoading}
              value={sourceConn}
              onChange={handleSourceConnChange}
              allowClear
              showSearch
              optionFilterProp="label"
              options={connections.map(c => ({
                value: c.id,
                label: `${c.name} (${getDbTypeLabel(c.db_type)})`,
              }))}
            />
          </div>
          {isPgConn(sourceConn) && (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>Schema</div>
              <Select
                style={{ width: 160 }}
                placeholder="选择 schema"
                loading={sourceSchemaLoading}
                value={sourceSchema}
                onChange={handleSourceSchemaChange}
                showSearch
                optionFilterProp="label"
                options={sourceSchemas.map(s => ({ value: s, label: s }))}
              />
            </div>
          )}
          {syncMode === 'single' ? (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>源表</div>
              <Select
                style={{ width: 220 }}
                placeholder="选择表"
                loading={sourceTableLoading}
                value={sourceTable}
                onChange={(val) => { setSourceTable(val); setTargetTable(val || ''); setPreviewData(null); setSyncResult(null); }}
                allowClear
                showSearch
                optionFilterProp="label"
                disabled={!sourceConn}
                options={sourceTables.map(t => ({ value: t, label: t }))}
              />
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>
                源表（已选 {selectedTables.length}/{sourceTables.length}）
                <Button type="link" size="small" onClick={() => setSelectedTables([...sourceTables])}>全选</Button>
                <Button type="link" size="small" onClick={() => setSelectedTables([])}>清空</Button>
              </div>
              <Select
                mode="multiple"
                style={{ width: 400 }}
                placeholder="选择要同步的表"
                loading={sourceTableLoading}
                value={selectedTables}
                onChange={setSelectedTables}
                allowClear
                showSearch
                optionFilterProp="label"
                disabled={!sourceConn}
                options={sourceTables.map(t => ({ value: t, label: t }))}
                maxTagCount={5}
              />
            </div>
          )}
        </Space>
        {sourceConnInfo && (
          <div style={{ marginTop: 12 }}>
            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{getDbTypeLabel(sourceConnInfo.db_type)}</span>
            <Text type="secondary">{sourceConnInfo.host}:{sourceConnInfo.port}/{sourceConnInfo.database}</Text>
          </div>
        )}
      </Card>

      {/* 箭头 */}
      <div style={{ textAlign: 'center', margin: '8px 0' }}>
        <ArrowRightOutlined style={{ fontSize: 24, color: '#111' }} />
      </div>

      {/* 目标端配置 */}
      <Card title="目标端配置" size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" align="end">
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>数据库连接</div>
            <Select
              style={{ width: 280 }}
              placeholder="选择目标连接"
              loading={connLoading}
              value={targetConn}
              onChange={handleTargetConnChange}
              allowClear
              showSearch
              optionFilterProp="label"
              options={connections.filter(c => c.id !== sourceConn).map(c => ({
                value: c.id,
                label: `${c.name} (${getDbTypeLabel(c.db_type)})`,
              }))}
            />
          </div>
          {isPgConn(targetConn) && (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>Schema</div>
              <Select
                style={{ width: 160 }}
                placeholder="选择 schema"
                loading={targetSchemaLoading}
                value={targetSchema}
                onChange={(val) => { setTargetSchema(val); setPreviewData(null); setSyncResult(null); setBatchResults(null); }}
                showSearch
                optionFilterProp="label"
                options={targetSchemas.map(s => ({ value: s, label: s }))}
              />
            </div>
          )}
          {syncMode === 'single' && (
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>目标表名</div>
              <Input
                style={{ width: 220 }}
                placeholder="输入目标表名"
                value={targetTable}
                onChange={(e) => { setTargetTable(e.target.value); setPreviewData(null); setSyncResult(null); }}
              />
            </div>
          )}
          {syncMode === 'single' ? (
            <Button icon={<SwapOutlined />} onClick={handlePreview} loading={loading}
              disabled={!sourceConn || !sourceTable || !targetConn || !targetTable}>
              预览转换
            </Button>
          ) : syncing ? (
            <Button danger icon={<StopOutlined />} onClick={handleCancelSync}>
              中止同步
            </Button>
          ) : (
            <Button type="primary" icon={<SyncOutlined />} onClick={handleBatchSync}
              disabled={!sourceConn || !targetConn || selectedTables.length === 0}>
              开始批量同步（{selectedTables.length} 张表）
            </Button>
          )}
        </Space>
        {targetConnInfo && (
          <div style={{ marginTop: 12 }}>
            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666' }}>{getDbTypeLabel(targetConnInfo.db_type)}</span>
            <Text type="secondary">{targetConnInfo.host}:{targetConnInfo.port}/{targetConnInfo.database}</Text>
            {syncMode === 'batch' && <Text type="secondary" style={{ marginLeft: 8 }}>目标表名与源表名相同</Text>}
          </div>
        )}
      </Card>

      {/* 批量模式：进度条和日志 */}
      {syncMode === 'batch' && streamLogs.length > 0 && (
        <Card title="同步进度" size="small" style={{ marginBottom: 16 }}
          extra={<Button size="small" icon={<CopyOutlined />} onClick={handleCopyLogs}>复制日志</Button>}
        >
          <Progress
            percent={streamProgress.total > 0 ? Math.round((streamProgress.current / streamProgress.total) * 100) : 0}
            format={() => `${streamProgress.current} / ${streamProgress.total}`}
            status={syncing ? 'active' : 'success'}
            style={{ marginBottom: 16 }}
          />
          <div style={{
            background: '#1e1e1e', borderRadius: 6, padding: 12, maxHeight: 300,
            overflow: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: '22px',
          }}>
            {streamLogs.map((log, i) => (
              <div key={i} style={{
                color: log.type === 'error' ? '#ff4d4f' : log.type === 'success' ? '#52c41a' : '#d4d4d4',
              }}>
                {log.message}
              </div>
            ))}
            {syncing && <div style={{ color: '#666' }}>▌</div>}
            <div ref={logEndRef} />
          </div>
        </Card>
      )}

      {/* 单表模式：预览结果 */}
      {syncMode === 'single' && previewData && (
        <Card title="转换预览" size="small" style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <Space>
              <Text>数据量：</Text>
              <Text strong>{previewData.rowCount} 条</Text>
            </Space>
          </div>

          <Divider orientation="left" style={{ margin: '12px 0' }}>字段映射</Divider>
          <Table
            dataSource={previewData.columns}
            columns={columnTableColumns}
            rowKey="column_name"
            pagination={false}
            size="small"
            style={{ marginBottom: 16 }}
          />

          <Divider orientation="left" style={{ margin: '12px 0' }}>目标建表语句</Divider>
          <pre style={{
            background: '#f5f5f5', padding: 12, borderRadius: 6, fontSize: 13,
            maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {previewData.ddl}
          </pre>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button type="primary" icon={<SyncOutlined />} onClick={handleSync} loading={syncing} size="large">
              开始同步
            </Button>
          </div>
        </Card>
      )}

      {/* 单表模式：同步结果 */}
      {syncMode === 'single' && syncResult && (
        <Alert
          style={{ marginTop: 16 }}
          type={syncResult.synced >= 0 ? 'success' : 'error'}
          showIcon
          icon={<CheckCircleOutlined />}
          message={`同步完成：共 ${syncResult.total} 条数据，成功迁移 ${syncResult.synced} 条`}
        />
      )}

      {/* 批量模式：同步结果 */}
      {syncMode === 'batch' && batchResults && (
        <Card title={`批量同步结果（共 ${batchResults.length} 张表）`} size="small" style={{ marginTop: 16 }}>
          <Table
            dataSource={batchResults}
            columns={batchResultColumns}
            rowKey="table"
            pagination={false}
            size="small"
          />
        </Card>
      )}
    </div>
  );
}

export default DataSync;
