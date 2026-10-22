const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { encrypt, decrypt } = require('../utils/encrypt');
const DbService = require('../services/db.service');
const logger = require('../utils/logger');

router.use(authMiddleware);

function checkConnectionVisibility(req, res, conn) {
  if (!conn) {
    res.status(404).json({ code: 40004, message: '连接不存在' });
    return false;
  }
  if (req.user.role === 'admin') return true;
  if (conn.scope === 'public' || conn.created_by === req.user.id) return true;
  // 检查是否绑定到用户所属 business_project 下的项目（级联权限）
  const member = db.prepare(`
    SELECT 1 FROM project_db_connections pdc
    JOIN projects p ON p.id = pdc.project_id
    JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
    WHERE pdc.db_connection_id = ? AND bpm.user_id = ?
    LIMIT 1
  `).get(conn.id, req.user.id);
  if (member) return true;
  res.status(404).json({ code: 40004, message: '连接不存在' });
  return false;
}

function checkConnectionOwnership(req, res, conn) {
  if (!conn) {
    res.status(404).json({ code: 40004, message: '连接不存在' });
    return false;
  }
  if (req.user.role === 'admin') return true;
  if (conn.created_by === req.user.id && conn.scope === 'private') return true;
  res.status(403).json({ code: 40301, message: '无权操作此连接' });
  return false;
}

/**
 * GET /api/db-connections
 * 连接列表
 */
router.get('/', (req, res) => {
  try {
    let list;
    if (req.user.role === 'admin') {
      list = db.prepare(`
        SELECT id, name, db_type, host, port, database, username, status, last_check, scope, created_by, created_at
        FROM db_connections ORDER BY id ASC
      `).all();
    } else {
      list = db.prepare(`
        SELECT id, name, db_type, host, port, database, username, status, last_check, scope, created_by, created_at
        FROM db_connections
        WHERE scope = 'public'
           OR created_by = ?
           OR id IN (
             SELECT db_connection_id FROM project_db_connections
             WHERE project_id IN (
               SELECT id FROM projects WHERE business_project_id IN (
                 SELECT business_project_id FROM business_project_members WHERE user_id = ?
               )
             )
           )
        ORDER BY id ASC
      `).all(req.user.id, req.user.id);
    }
    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get db connections failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取数据库连接列表失败' });
  }
});

/**
 * POST /api/db-connections
 * 创建连接
 */
router.post('/', (req, res) => {
  try {
    const { name, db_type, host, port, database, username, password } = req.body;
    if (!name || !db_type || !host || !port || !database || !username || !password) {
      return res.status(400).json({ code: 40001, message: '请填写完整的连接信息' });
    }
    if (!['mysql', 'pg', 'opengauss'].includes(db_type)) {
      return res.status(400).json({ code: 40001, message: '不支持的数据库类型' });
    }

    const scope = req.body.scope || 'private';

    const result = db.prepare(`
      INSERT INTO db_connections (name, db_type, host, port, database, username, password, scope, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, db_type, host, parseInt(port, 10), database, username, encrypt(password), scope, req.user.id);

    logger.info(`DB connection created: ${name} by ${req.user.username}`);
    res.status(201).json({ code: 0, data: { id: result.lastInsertRowid } });
  } catch (err) {
    logger.error(`Create db connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建数据库连接失败' });
  }
});

/**
 * PUT /api/db-connections/:id
 * 更新连接
 */
router.put('/:id', (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionOwnership(req, res, conn)) return;

    const { name, db_type, host, port, database, username, password } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (db_type !== undefined) { updates.push('db_type = ?'); params.push(db_type); }
    if (host !== undefined) { updates.push('host = ?'); params.push(host); }
    if (port !== undefined) { updates.push('port = ?'); params.push(parseInt(port, 10)); }
    if (database !== undefined) { updates.push('database = ?'); params.push(database); }
    if (username !== undefined) { updates.push('username = ?'); params.push(username); }
    if (password !== undefined && password.trim()) { updates.push('password = ?'); params.push(encrypt(password)); }
    if (req.body.scope !== undefined) { updates.push('scope = ?'); params.push(req.body.scope); }

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE db_connections SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    logger.info(`DB connection ${req.params.id} updated by ${req.user.username}`);
    res.json({ code: 0, message: '连接已更新' });
  } catch (err) {
    logger.error(`Update db connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新数据库连接失败' });
  }
});

/**
 * DELETE /api/db-connections/:id
 * 删除连接
 */
router.delete('/:id', (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionOwnership(req, res, conn)) return;

    db.prepare('DELETE FROM db_connections WHERE id = ?').run(req.params.id);
    logger.info(`DB connection ${req.params.id} deleted by ${req.user.username}`);
    res.json({ code: 0, message: '连接已删除' });
  } catch (err) {
    logger.error(`Delete db connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除数据库连接失败' });
  }
});

/**
 * POST /api/db-connections/:id/test
 * 测试连接
 */
router.post('/:id/test', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const result = await DbService.testConnection(req.params.id);
    if (result.ok) {
      res.json({ code: 0, data: result, message: `连接成功，延迟 ${result.latency_ms}ms` });
    } else {
      res.status(400).json({ code: 40008, data: result, message: `连接失败: ${result.error}` });
    }
  } catch (err) {
    logger.error(`Test connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '测试连接失败' });
  }
});

/**
 * GET /api/db-connections/:id/databases
 * 获取数据库列表
 */
router.get('/:id/databases', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const databases = await DbService.getDatabases(req.params.id);
    res.json({ code: 0, data: databases });
  } catch (err) {
    logger.error(`Get databases failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取数据库列表失败: ${err.message}` });
  }
});

/**
 * GET /api/db-connections/:id/schemas
 * 获取 schema 列表（PG/OpenGauss）
 */
router.get('/:id/schemas', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const schemas = await DbService.getSchemas(req.params.id);
    res.json({ code: 0, data: schemas });
  } catch (err) {
    logger.error(`Get schemas failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取 schema 列表失败: ${err.message}` });
  }
});

/**
 * GET /api/db-connections/:id/tables
 * 获取表列表
 */
router.get('/:id/tables', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const { database, schema } = req.query;
    const tables = await DbService.getTables(req.params.id, database, schema);
    res.json({ code: 0, data: tables });
  } catch (err) {
    logger.error(`Get tables failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取表列表失败: ${err.message}` });
  }
});

/**
 * GET /api/db-connections/:id/tables/:tableName/structure
 * 获取表结构
 */
router.get('/:id/tables/:tableName/structure', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const { schema } = req.query;
    const structure = await DbService.getTableStructure(req.params.id, req.params.tableName, schema);
    res.json({ code: 0, data: structure });
  } catch (err) {
    logger.error(`Get table structure failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取表结构失败: ${err.message}` });
  }
});

/**
 * GET /api/db-connections/:id/tables/:tableName/ddl
 * 获取建表语句
 */
router.get('/:id/tables/:tableName/ddl', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const { schema } = req.query;
    const ddl = await DbService.getCreateTableSQL(req.params.id, req.params.tableName, schema);
    res.json({ code: 0, data: { ddl } });
  } catch (err) {
    logger.error(`Get DDL failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取建表语句失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/:id/partition/preview
 * 预览分表
 */
router.post('/:id/partition/preview', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const { source_table, strategy, start_date, end_date, schema } = req.body;
    if (!source_table || !strategy || !start_date || !end_date) {
      return res.status(400).json({ code: 40001, message: '缺少必要参数' });
    }
    const PartitionService = require('../services/partition.service');
    const tables = await PartitionService.preview(req.params.id, source_table, strategy, start_date, end_date, schema);
    res.json({ code: 0, data: tables });
  } catch (err) {
    logger.error(`Partition preview failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `预览分表失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/:id/partition/execute
 * 执行分表创建
 */
router.post('/:id/partition/execute', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(req.params.id);
    if (!checkConnectionVisibility(req, res, conn)) return;

    const { source_table, strategy, start_date, end_date, schema } = req.body;
    if (!source_table || !strategy || !start_date || !end_date) {
      return res.status(400).json({ code: 40001, message: '缺少必要参数' });
    }
    const PartitionService = require('../services/partition.service');
    const results = await PartitionService.execute(req.params.id, source_table, strategy, start_date, end_date, schema);
    res.json({ code: 0, data: results });
  } catch (err) {
    logger.error(`Partition execute failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `执行分表失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/sync/preview
 * 预览跨库同步
 */
router.post('/sync/preview', async (req, res) => {
  try {
    const { source_conn_id, source_table, target_conn_id, target_table, source_schema, target_schema } = req.body;
    if (!source_conn_id || !source_table || !target_conn_id || !target_table) {
      return res.status(400).json({ code: 40001, message: '缺少必要参数' });
    }
    const sourceConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(source_conn_id);
    if (!checkConnectionVisibility(req, res, sourceConn)) return;
    const targetConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(target_conn_id);
    if (!checkConnectionVisibility(req, res, targetConn)) return;

    const SyncService = require('../services/sync.service');
    const result = await SyncService.preview(source_conn_id, source_table, target_conn_id, target_table, source_schema, target_schema);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Sync preview failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `预览同步失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/sync/execute
 * 执行跨库同步
 */
router.post('/sync/execute', async (req, res) => {
  try {
    const { source_conn_id, source_table, target_conn_id, target_table, source_schema, target_schema } = req.body;
    if (!source_conn_id || !source_table || !target_conn_id || !target_table) {
      return res.status(400).json({ code: 40001, message: '缺少必要参数' });
    }
    const sourceConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(source_conn_id);
    if (!checkConnectionVisibility(req, res, sourceConn)) return;
    const targetConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(target_conn_id);
    if (!checkConnectionVisibility(req, res, targetConn)) return;

    const SyncService = require('../services/sync.service');
    const result = await SyncService.execute(source_conn_id, source_table, target_conn_id, target_table, source_schema, target_schema);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Sync execute failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `执行同步失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/sync/batch-execute
 * 批量跨库同步（多表）
 */
router.post('/sync/batch-execute', async (req, res) => {
  try {
    const { source_conn_id, source_tables, target_conn_id, source_schema, target_schema } = req.body;
    if (!source_conn_id || !Array.isArray(source_tables) || source_tables.length === 0 || !target_conn_id) {
      return res.status(400).json({ code: 40001, message: '缺少必要参数' });
    }
    const sourceConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(source_conn_id);
    if (!checkConnectionVisibility(req, res, sourceConn)) return;
    const targetConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(target_conn_id);
    if (!checkConnectionVisibility(req, res, targetConn)) return;

    const SyncService = require('../services/sync.service');
    const results = [];
    for (const tableName of source_tables) {
      try {
        const result = await SyncService.execute(source_conn_id, tableName, target_conn_id, tableName, source_schema, target_schema);
        results.push({ table: tableName, success: true, ...result });
      } catch (err) {
        results.push({ table: tableName, success: false, error: err.message });
        logger.error(`Batch sync table ${tableName} failed: ${err.message}`);
      }
    }
    res.json({ code: 0, data: results });
  } catch (err) {
    logger.error(`Batch sync failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `批量同步失败: ${err.message}` });
  }
});

/**
 * POST /api/db-connections/sync/batch-stream
 * 批量跨库同步（SSE 流式推送进度）
 */
router.post('/sync/batch-stream', async (req, res) => {
  const { source_conn_id, source_tables, target_conn_id, source_schema, target_schema } = req.body;
  if (!source_conn_id || !Array.isArray(source_tables) || source_tables.length === 0 || !target_conn_id) {
    return res.status(400).json({ code: 40001, message: '缺少必要参数' });
  }
  const sourceConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(source_conn_id);
  if (!checkConnectionVisibility(req, res, sourceConn)) return;
  const targetConn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(target_conn_id);
  if (!checkConnectionVisibility(req, res, targetConn)) return;

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  const SyncService = require('../services/sync.service');
  const total = source_tables.length;
  let completed = 0;
  const results = [];
  const logs = [];
  let logSaved = false;

  // 在任何 await 之前注册 close 事件，确保客户端中止时能兜底保存日志
  req.on('close', () => {
    if (!logSaved) {
      try {
        const sourceConn = DbService.getConnectionConfig(source_conn_id);
        const targetConn = DbService.getConnectionConfig(target_conn_id);
        const status = completed === 0 ? 'aborted' : (results.some(r => !r.success) ? 'partial' : 'completed');
        logger.info(`[SYNC] Saving log from close event: status=${status}, completed=${completed}/${total}`);
        db.prepare(`
          INSERT INTO sync_logs (source_conn_name, target_conn_name, source_db_type, target_db_type,
            total_tables, success_count, fail_count, status, logs, results, created_by, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(
          sourceConn.name, targetConn.name, sourceConn.db_type, targetConn.db_type,
          total, results.filter(r => r.success).length, results.filter(r => !r.success).length,
          status, JSON.stringify(logs), JSON.stringify(results), req.user?.id || null
        );
        logSaved = true;
        logger.info(`[SYNC] Log saved from close event successfully`);
      } catch (e) {
        logger.error(`[SYNC] Save sync log from close event failed: ${e.message}`);
      }
    }
  });

  let sourceClient = null;
  let targetClient = null;

  try {
    // 整个批量同步共用一对连接
    const sourceConn = DbService.getConnectionConfig(source_conn_id);
    const targetConn = DbService.getConnectionConfig(target_conn_id);
    sourceClient = await DbService.createClient(sourceConn);
    targetClient = await DbService.createClient(targetConn);

    for (const tableName of source_tables) {
      if (res.writableEnded) break;
      sendEvent({ type: 'table_start', table: tableName, index: completed + 1, total });
      logs.push({ type: 'info', message: `[${completed + 1}/${total}] 开始同步 ${tableName}` });

      try {
        const result = await SyncService.execute(
          source_conn_id, tableName, target_conn_id, tableName,
          source_schema, target_schema,
          (progress) => {
            sendEvent({ type: 'progress', table: tableName, ...progress });
          },
          sourceClient, targetClient
        );
        completed++;
        results.push({ table: tableName, success: true, ...result });
        logs.push({ type: 'success', message: `  ✓ 完成，同步 ${result.synced}/${result.total} 条` });
        sendEvent({ type: 'table_complete', table: tableName, index: completed, total, rowTotal: result.total, synced: result.synced });
      } catch (err) {
        completed++;
        results.push({ table: tableName, success: false, error: err.message });
        logs.push({ type: 'error', message: `  ✗ 失败: ${err.message}` });
        logger.error(`Batch sync table ${tableName} failed: ${err.message}`);
        sendEvent({ type: 'table_error', table: tableName, index: completed, total, error: err.message });
      }
    }
  } catch (err) {
    logger.error(`Batch sync connection error: ${err.message}`);
    sendEvent({ type: 'all_done', total, completed, successCount: results.filter(r => r.success).length, failCount: results.filter(r => !r.success).length + 1, results, error: err.message });
  } finally {
    // 关闭连接
    try {
      const sourceConn = DbService.getConnectionConfig(source_conn_id);
      const targetConn = DbService.getConnectionConfig(target_conn_id);
      if (sourceClient) await DbService.closeClient(sourceConn.db_type, sourceClient);
      if (targetClient) await DbService.closeClient(targetConn.db_type, targetClient);
    } catch (e) { /* ignore */ }

    // 发送结束事件（客户端可能已断开，需保护）
    try {
      if (!res.writableEnded) {
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        sendEvent({ type: 'all_done', total, completed, successCount, failCount, results });
        res.end();
      }
    } catch { /* 客户端已断开，忽略 */ }

    // 保存同步日志到数据库（正常完成时在此保存，客户端中止时由 close 事件保存）
    if (!logSaved) {
      try {
        const sourceConn = DbService.getConnectionConfig(source_conn_id);
        const targetConn = DbService.getConnectionConfig(target_conn_id);
        const status = results.some(r => !r.success) ? 'partial' : 'completed';
        logger.info(`[SYNC] Saving log: status=${status}, tables=${total}, success=${results.filter(r => r.success).length}, fail=${results.filter(r => !r.success).length}`);
        db.prepare(`
          INSERT INTO sync_logs (source_conn_name, target_conn_name, source_db_type, target_db_type,
            total_tables, success_count, fail_count, status, logs, results, created_by, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(
          sourceConn.name, targetConn.name, sourceConn.db_type, targetConn.db_type,
          total, results.filter(r => r.success).length, results.filter(r => !r.success).length,
          status, JSON.stringify(logs), JSON.stringify(results), req.user?.id || null
        );
        logSaved = true;
        logger.info(`[SYNC] Log saved successfully`);
      } catch (e) {
        logger.error(`[SYNC] Save sync log failed: ${e.message}`);
      }
    }
  }
});

/**
 * GET /api/db-connections/sync/logs
 * 同步日志列表
 */
router.get('/sync/logs', (req, res) => {
  try {
    const list = db.prepare(`
      SELECT id, source_conn_name, target_conn_name, source_db_type, target_db_type,
             total_tables, success_count, fail_count, status, created_at, finished_at
      FROM sync_logs ORDER BY id DESC
    `).all();
    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get sync logs failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取同步日志失败' });
  }
});

/**
 * GET /api/db-connections/sync/logs/:id
 * 同步日志详情
 */
router.get('/sync/logs/:id', (req, res) => {
  try {
    const log = db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(req.params.id);
    if (!log) return res.status(404).json({ code: 40401, message: '日志不存在' });
    log.logs = JSON.parse(log.logs || '[]');
    log.results = JSON.parse(log.results || '[]');
    res.json({ code: 0, data: log });
  } catch (err) {
    logger.error(`Get sync log detail failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取日志详情失败' });
  }
});

/**
 * DELETE /api/db-connections/sync/logs/:id
 * 删除同步日志
 */
router.delete('/sync/logs/:id', requireRole('admin'), (req, res) => {
  try {
    db.prepare('DELETE FROM sync_logs WHERE id = ?').run(req.params.id);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    logger.error(`Delete sync log failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除失败' });
  }
});

module.exports = router;
