const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const logger = require('../utils/logger');

function checkBusinessProjectAccess(req, bp) {
  if (req.user.role === 'admin') return true;
  if (bp.created_by === req.user.id) return true;
  // Check if user is a member of this business_project
  const memberCheck = db.prepare(
    'SELECT COUNT(*) as count FROM business_project_members WHERE business_project_id = ? AND user_id = ?'
  ).get(bp.id, req.user.id);
  return memberCheck.count > 0;
}

router.use(authMiddleware);

/**
 * GET /api/business-projects
 * 项目管理列表
 */
router.get('/', (req, res) => {
  try {
    const name = req.query.name || '';
    let whereExtra = '';
    const extraParams = [];

    if (name) {
      whereExtra = ' AND EXISTS (SELECT 1 FROM projects WHERE business_project_id = bp.id AND projects.name LIKE ?)';
      extraParams.push(`%${name}%`);
    }

    let list;
    if (req.user.role === 'admin') {
      list = db.prepare(`
        SELECT bp.*, u.name as created_by_name,
          (SELECT COUNT(*) FROM projects WHERE business_project_id = bp.id) as module_count
        FROM business_projects bp
        LEFT JOIN users u ON bp.created_by = u.id
        WHERE 1=1 ${whereExtra}
        ORDER BY bp.created_at DESC
      `).all(...extraParams);
    } else {
      list = db.prepare(`
        SELECT bp.*, u.name as created_by_name,
          (SELECT COUNT(*) FROM projects WHERE business_project_id = bp.id) as module_count
        FROM business_projects bp
        LEFT JOIN users u ON bp.created_by = u.id
        WHERE (bp.created_by = ?
           OR EXISTS (
             SELECT 1 FROM business_project_members
             WHERE business_project_id = bp.id AND user_id = ?
           )) ${whereExtra}
        ORDER BY bp.created_at DESC
      `).all(req.user.id, req.user.id, ...extraParams);
    }

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get business projects failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目管理列表失败' });
  }
});

/**
 * GET /api/business-projects/:id
 * 项目管理详情
 */
router.get('/:id', (req, res) => {
  try {
    const bp = db.prepare(`
      SELECT bp.*,
        (SELECT COUNT(*) FROM projects WHERE business_project_id = bp.id) as module_count
      FROM business_projects bp
      WHERE bp.id = ?
    `).get(req.params.id);

    if (!bp) {
      return res.status(404).json({ code: 40004, message: '项目管理不存在' });
    }

    if (!checkBusinessProjectAccess(req, bp)) {
      return res.status(403).json({ code: 40301, message: '无权访问此项目' });
    }

    // 获取下属模块
    const modules = db.prepare(`
      SELECT p.*, gc.name as gitlab_connection_name, r.name as registry_name
      FROM projects p
      LEFT JOIN gitlab_connections gc ON p.gitlab_connection = gc.id
      LEFT JOIN registries r ON p.registry_id = r.id
      WHERE p.business_project_id = ?
      ORDER BY p.created_at DESC
    `).all(req.params.id);

    res.json({ code: 0, data: { ...bp, modules } });
  } catch (err) {
    logger.error(`Get business project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目管理详情失败' });
  }
});

/**
 * POST /api/business-projects
 * 创建项目管理
 */
router.post('/', (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ code: 40001, message: '项目管理名称不能为空' });
    }

    const result = db.prepare(`
      INSERT INTO business_projects (name, description, created_by)
      VALUES (?, ?, ?)
    `).run(name, description || '', req.user.id);

    const bp = db.prepare('SELECT * FROM business_projects WHERE id = ?').get(result.lastInsertRowid);

    logger.info(`Business project created: ${name} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: bp });
  } catch (err) {
    logger.error(`Create business project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建项目管理失败' });
  }
});

/**
 * PUT /api/business-projects/:id
 * 更新项目管理
 */
router.put('/:id', (req, res) => {
  try {
    const bp = db.prepare('SELECT * FROM business_projects WHERE id = ?').get(req.params.id);
    if (!bp) {
      return res.status(404).json({ code: 40004, message: '项目管理不存在' });
    }

    // Ownership check: admin or creator only
    if (req.user.role !== 'admin' && bp.created_by !== req.user.id) {
      return res.status(403).json({ code: 40301, message: '无权修改此项目' });
    }

    const { name, description, status } = req.body;
    const allowedFields = {};
    if (name !== undefined) allowedFields.name = name;
    if (description !== undefined) allowedFields.description = description;
    if (status !== undefined) allowedFields.status = status;

    const fields = Object.keys(allowedFields);
    if (fields.length === 0) {
      return res.status(400).json({ code: 40002, message: '没有可更新的字段' });
    }

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => allowedFields[f]);

    db.prepare(`UPDATE business_projects SET ${setClause}, updated_at = (datetime('now', 'localtime')) WHERE id = ?`)
      .run(...values, req.params.id);

    const updated = db.prepare('SELECT * FROM business_projects WHERE id = ?').get(req.params.id);

    logger.info(`Business project ${req.params.id} updated by ${req.user.username}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update business project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新项目管理失败' });
  }
});

/**
 * DELETE /api/business-projects/:id
 * 删除项目管理
 */
router.delete('/:id', (req, res) => {
  try {
    const bp = db.prepare('SELECT * FROM business_projects WHERE id = ?').get(req.params.id);
    if (!bp) {
      return res.status(404).json({ code: 40004, message: '项目管理不存在' });
    }

    // Ownership check: admin or creator only
    if (req.user.role !== 'admin' && bp.created_by !== req.user.id) {
      return res.status(403).json({ code: 40301, message: '无权删除此项目' });
    }

    // 检查是否有下属模块
    const moduleCount = db.prepare('SELECT COUNT(*) as count FROM projects WHERE business_project_id = ?').get(req.params.id).count;
    if (moduleCount > 0) {
      return res.status(400).json({ code: 40003, message: '该项目管理下还有模块，无法删除' });
    }

    db.prepare('DELETE FROM business_projects WHERE id = ?').run(req.params.id);

    logger.info(`Business project ${req.params.id} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '项目管理已删除' });
  } catch (err) {
    logger.error(`Delete business project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除项目管理失败' });
  }
});

module.exports = router;
