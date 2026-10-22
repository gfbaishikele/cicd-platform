const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { encrypt, decrypt } = require('../utils/encrypt');
const { authMiddleware } = require('../middleware/auth');
const { gitlabConnectionRules, validate } = require('../middleware/validator');
const GitLabService = require('../services/gitlab.service');
const logger = require('../utils/logger');

// 所有 GitLab 接口需要登录
router.use(authMiddleware);

// ============ GitLab 连接管理（用户级资源） ============

/**
 * GET /api/gitlab/connections
 * 获取 GitLab 连接列表
 * admin: 所有连接; 普通用户: 仅自己创建的
 */
router.get('/connections', (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    let query = `
      SELECT gc.*, u.name as created_by_name
      FROM gitlab_connections gc
      LEFT JOIN users u ON gc.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      query += ' AND (scope = \'public\' OR created_by = ?)';
      params.push(req.user.id);
    }

    if (keyword) {
      query += ' AND (name LIKE ? OR url LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    query += ' ORDER BY id ASC';

    const connections = db.prepare(query).all(...params);

    res.json({ code: 0, data: connections });
  } catch (err) {
    logger.error(`Get GitLab connections failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取 GitLab 连接列表失败' });
  }
});

/**
 * POST /api/gitlab/connections
 * 添加 GitLab 连接（所有用户均可创建自己的连接）
 */
router.post('/connections', gitlabConnectionRules, validate, async (req, res) => {
  try {
    const { name, url, token, api_version = 'v4', scope = 'private' } = req.body;

    // 先测试连接
    const encryptedToken = encrypt(token);
    const testResult = await GitLabService.testConnection(url, encryptedToken, api_version);

    if (!testResult.connected) {
      return res.status(400).json({
        code: 40007,
        message: `GitLab 连接失败: ${testResult.error}`,
      });
    }

    // 保存连接
    const result = db.prepare(
      'INSERT INTO gitlab_connections (name, url, token, api_version, scope, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, url, encryptedToken, api_version, scope, req.user.id);

    const connection = db.prepare(
      'SELECT id, name, url, api_version, scope, created_by, created_at FROM gitlab_connections WHERE id = ?'
    ).get(result.lastInsertRowid);

    logger.info(`GitLab connection created: ${name} by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: {
        ...connection,
        test: testResult,
      },
    });
  } catch (err) {
    logger.error(`Create GitLab connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '添加 GitLab 连接失败' });
  }
});

/**
 * 检查用户是否有权操作指定 GitLab 连接
 * @param {Object} req
 * @param {Object} res
 * @param {Object} conn - 连接记录
 * @param {Object} [opts] - 选项
 * @param {boolean} [opts.readOnly=false] - 是否为只读操作（test），只读时 public 连接也允许
 */
function checkGitlabOwnership(req, res, conn, opts = {}) {
  if (!conn) {
    res.status(404).json({ code: 40004, message: '连接不存在' });
    return false;
  }
  // admin 始终有权限
  if (req.user.role === 'admin') return true;
  // 创建者有权限
  if (conn.created_by === req.user.id) return true;
  // 只读操作 + public scope → 允许
  if (opts.readOnly && conn.scope === 'public') return true;
  res.status(403).json({ code: 40301, message: '无权操作此连接' });
  return false;
}

/**
 * GET /api/gitlab/connections/:id/test
 * 测试 GitLab 连接
 */
router.get('/connections/:id/test', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(req.params.id);
    if (!checkGitlabOwnership(req, res, conn, { readOnly: true })) return;

    const result = await GitLabService.testConnection(conn.url, conn.token, conn.api_version);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Test GitLab connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '测试连接失败' });
  }
});

/**
 * PUT /api/gitlab/connections/:id
 * 更新 GitLab 连接
 */
router.put('/connections/:id', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(req.params.id);
    if (!checkGitlabOwnership(req, res, conn)) return;

    const { name, url, token, api_version, scope } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (url !== undefined) { updates.push('url = ?'); params.push(url); }
    if (api_version !== undefined) { updates.push('api_version = ?'); params.push(api_version); }
    if (scope !== undefined) { updates.push('scope = ?'); params.push(scope); }
    if (token !== undefined) {
      updates.push('token = ?');
      params.push(encrypt(token));
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE gitlab_connections SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare(
      'SELECT id, name, url, api_version, scope, created_by, created_at FROM gitlab_connections WHERE id = ?'
    ).get(req.params.id);

    logger.info(`GitLab connection ${req.params.id} updated by ${req.user.username}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update GitLab connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新连接失败' });
  }
});

/**
 * DELETE /api/gitlab/connections/:id
 * 删除 GitLab 连接
 */
router.delete('/connections/:id', (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(req.params.id);
    if (!checkGitlabOwnership(req, res, conn)) return;

    // 检查是否有项目使用此连接
    const projectCount = db.prepare(
      'SELECT COUNT(*) as count FROM projects WHERE gitlab_connection = ?'
    ).get(req.params.id);

    if (projectCount.count > 0) {
      return res.status(400).json({
        code: 40006,
        message: `该连接下有 ${projectCount.count} 个项目，请先删除或迁移项目`,
      });
    }

    db.prepare('DELETE FROM gitlab_connections WHERE id = ?').run(req.params.id);

    logger.info(`GitLab connection ${req.params.id} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '连接已删除' });
  } catch (err) {
    logger.error(`Delete GitLab connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除连接失败' });
  }
});

// ============ GitLab 仓库/分支查询 ============

/**
 * GET /api/gitlab/connections/:id/projects
 * 获取 GitLab 项目列表
 */
router.get('/connections/:id/projects', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(req.params.id);
    if (!conn) {
      return res.status(404).json({ code: 40004, message: '连接不存在' });
    }
    // 普通用户只能浏览自己连接的仓库，或 public 仓库
    if (req.user.role !== 'admin' && conn.created_by !== req.user.id && conn.scope !== 'public') {
      return res.status(403).json({ code: 40301, message: '无权操作此连接' });
    }

    const { search, page, per_page } = req.query;
    const projects = await GitLabService.getProjects(conn.url, conn.token, {
      search,
      page: parseInt(page, 10) || 1,
      perPage: parseInt(per_page, 10) || 20,
      apiVersion: conn.api_version,
    });

    res.json({ code: 0, data: projects });
  } catch (err) {
    logger.error(`Get GitLab projects failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取 GitLab 项目列表失败' });
  }
});

/**
 * GET /api/gitlab/connections/:id/projects/:projectId/branches
 * 获取分支列表
 */
router.get('/connections/:id/projects/:projectId/branches', async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(req.params.id);
    if (!conn) {
      return res.status(404).json({ code: 40004, message: '连接不存在' });
    }
    if (req.user.role !== 'admin' && conn.created_by !== req.user.id && conn.scope !== 'public') {
      return res.status(403).json({ code: 40301, message: '无权操作此连接' });
    }

    const branches = await GitLabService.getBranches(
      conn.url, conn.token, req.params.projectId, { apiVersion: conn.api_version }
    );

    res.json({ code: 0, data: branches });
  } catch (err) {
    logger.error(`Get GitLab branches failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取分支列表失败' });
  }
});

module.exports = router;
