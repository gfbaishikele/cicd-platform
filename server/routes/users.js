const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { hashPassword, comparePassword } = require('../utils/hash');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { updateUserRules, updatePasswordRules, validate } = require('../middleware/validator');
const logger = require('../utils/logger');

// 所有用户管理接口需要登录 + admin 权限
router.use(authMiddleware, requireRole('admin'));

/**
 * GET /api/users
 * 用户列表（分页 + 搜索）
 */
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const offset = (page - 1) * pageSize;
    const keyword = req.query.keyword || '';
    const status = req.query.status || '';

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (keyword) {
      whereClause += ' AND (username LIKE ? OR name LIKE ? OR email LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM users ${whereClause}`).get(...params).count;

    const list = db.prepare(`
      SELECT id, username, name, email, role, status, avatar, created_at, updated_at
      FROM users ${whereClause}
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
      code: 0,
      data: {
        list,
        total,
        page,
        pageSize,
      },
    });
  } catch (err) {
    logger.error(`Get users failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取用户列表失败' });
  }
});

/**
 * GET /api/users/:id
 * 用户详情
 */
router.get('/:id', (req, res) => {
  try {
    const user = db.prepare(
      'SELECT id, username, name, email, role, status, avatar, created_at, updated_at FROM users WHERE id = ?'
    ).get(req.params.id);

    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    res.json({ code: 0, data: user });
  } catch (err) {
    logger.error(`Get user failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取用户详情失败' });
  }
});

/**
 * PUT /api/users/:id
 * 更新用户信息（角色、状态）
 */
router.put('/:id', updateUserRules, validate, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { role, status, email, name } = req.body;

    // 不能修改自己
    if (targetId === req.user.id) {
      return res.status(400).json({ code: 40006, message: '不能修改自己的信息' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    // 如果要取消 admin 权限，检查是否是最后一个 admin
    if (role && role !== 'admin' && user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'").get();
      if (adminCount.count <= 1) {
        return res.status(400).json({ code: 40006, message: '不能取消最后一个管理员的权限' });
      }
    }

    // 如果要禁用用户，检查是否是最后一个 admin
    if (status === 'disabled' && user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'").get();
      if (adminCount.count <= 1) {
        return res.status(400).json({ code: 40006, message: '不能禁用最后一个管理员' });
      }
    }

    const updates = [];
    const updateParams = [];

    if (role !== undefined) {
      updates.push('role = ?');
      updateParams.push(role);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      updateParams.push(status);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      updateParams.push(email);
    }
    if (name !== undefined) {
      updates.push('name = ?');
      updateParams.push(name);
    }

    if (updates.length > 0) {
      updates.push(`updated_at = (datetime('now', 'localtime'))`);
      updateParams.push(targetId);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...updateParams);
    }

    const updated = db.prepare(
      'SELECT id, username, name, email, role, status, avatar, created_at, updated_at FROM users WHERE id = ?'
    ).get(targetId);

    logger.info(`User ${targetId} updated by admin ${req.user.username}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update user failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新用户失败' });
  }
});

/**
 * PUT /api/users/:id/password
 * 重置用户密码（admin）或修改自己密码
 */
router.put('/:id/password', updatePasswordRules, validate, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { oldPassword, newPassword } = req.body;

    // 修改他人密码需要 admin 权限（已通过中间件保证）
    // 修改自己密码需要旧密码
    if (targetId === req.user.id && !oldPassword) {
      return res.status(400).json({ code: 40003, message: '修改自己密码需要提供旧密码' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    // 修改自己密码时验证旧密码
    if (targetId === req.user.id) {
      const valid = await comparePassword(oldPassword, user.password);
      if (!valid) {
        return res.status(400).json({ code: 40002, message: '旧密码错误' });
      }
    }

    const hashedPassword = await hashPassword(newPassword);
    db.prepare(`UPDATE users SET password = ?, updated_at = (datetime('now', 'localtime')) WHERE id = ?`)
      .run(hashedPassword, targetId);

    logger.info(`Password updated for user ${targetId} by ${req.user.username}`);

    res.json({ code: 0, message: '密码已更新' });
  } catch (err) {
    logger.error(`Update password failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新密码失败' });
  }
});

/**
 * DELETE /api/users/:id
 * 删除用户
 */
router.delete('/:id', (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    // 不能删除自己
    if (targetId === req.user.id) {
      return res.status(400).json({ code: 40006, message: '不能删除自己' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    // 不能删除最后一个 admin
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
      if (adminCount.count <= 1) {
        return res.status(400).json({ code: 40006, message: '不能删除最后一个管理员' });
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

    logger.info(`User ${targetId} (${user.username}) deleted by ${req.user.username}`);

    res.json({ code: 0, message: '用户已删除' });
  } catch (err) {
    logger.error(`Delete user failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除用户失败' });
  }
});

/**
 * GET /api/users/:id/projects
 * 获取用户的 business_project 关联列表（所有项目管理 + 是否成员 + 角色）
 */
router.get('/:id/projects', (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    const projects = db.prepare(`
      SELECT
        bp.id AS project_id,
        bp.name AS project_name,
        bpm.role,
        CASE WHEN bpm.id IS NOT NULL THEN 1 ELSE 0 END AS is_member
      FROM business_projects bp
      LEFT JOIN business_project_members bpm ON bpm.business_project_id = bp.id AND bpm.user_id = ?
      ORDER BY bp.id ASC
    `).all(targetId);

    res.json({ code: 0, data: projects });
  } catch (err) {
    logger.error(`Get user projects failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取用户项目关联失败' });
  }
});

/**
 * PUT /api/users/:id/projects
 * 批量更新用户的 business_project 关联
 * body: { projects: [{ project_id, role }] }  — project_id 实际为 business_project_id
 */
router.put('/:id/projects', (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { projects } = req.body;

    if (!Array.isArray(projects)) {
      return res.status(400).json({ code: 40001, message: 'projects 必须为数组' });
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    const validRoles = ['owner', 'developer', 'viewer'];

    // 校验每个条目（project_id 实际是 business_project_id）
    for (const item of projects) {
      if (!item.project_id) {
        return res.status(400).json({ code: 40001, message: 'project_id 不能为空' });
      }
      if (!validRoles.includes(item.role)) {
        return res.status(400).json({ code: 40001, message: `角色 ${item.role} 不合法，可选: ${validRoles.join(', ')}` });
      }
      const bp = db.prepare('SELECT id FROM business_projects WHERE id = ?').get(item.project_id);
      if (!bp) {
        return res.status(400).json({ code: 40004, message: `项目管理 ${item.project_id} 不存在` });
      }
    }

    // 获取当前成员记录
    const currentMembers = db.prepare(
      'SELECT business_project_id, role FROM business_project_members WHERE user_id = ?'
    ).all(targetId);
    const currentMap = new Map(currentMembers.map(m => [m.business_project_id, m.role]));

    // 构建目标映射
    const targetMap = new Map(projects.map(p => [p.project_id, p.role]));

    // 计算差异
    const toInsert = [];
    const toUpdate = [];
    const toDelete = [];

    for (const [bpId, role] of targetMap) {
      if (!currentMap.has(bpId)) {
        toInsert.push({ business_project_id: bpId, role });
      } else if (currentMap.get(bpId) !== role) {
        toUpdate.push({ business_project_id: bpId, role });
      }
    }

    for (const [bpId] of currentMap) {
      if (!targetMap.has(bpId)) {
        // 检查是否是该项目最后一个 owner
        const existingRole = currentMap.get(bpId);
        if (existingRole === 'owner') {
          const ownerCount = db.prepare(
            "SELECT COUNT(*) as count FROM business_project_members WHERE business_project_id = ? AND role = 'owner'"
          ).get(bpId);
          if (ownerCount.count <= 1) {
            return res.status(400).json({
              code: 40006,
              message: `不能移除项目管理 ${bpId} 的最后一个 owner`
            });
          }
        }
        toDelete.push(bpId);
      }
    }

    // 执行变更（手动事务）
    try {
      db.exec("BEGIN");
      for (const item of toInsert) {
        db.prepare(
          'INSERT INTO business_project_members (business_project_id, user_id, role) VALUES (?, ?, ?)'
        ).run(item.business_project_id, targetId, item.role);
      }
      for (const item of toUpdate) {
        db.prepare(
          'UPDATE business_project_members SET role = ? WHERE business_project_id = ? AND user_id = ?'
        ).run(item.role, item.business_project_id, targetId);
      }
      for (const bpId of toDelete) {
        db.prepare(
          'DELETE FROM business_project_members WHERE business_project_id = ? AND user_id = ?'
        ).run(bpId, targetId);
      }
      db.exec("COMMIT");
    } catch (txErr) {
      db.exec("ROLLBACK");
      throw txErr;
    }

    logger.info(
      `User ${targetId} business_projects updated by admin ${req.user.username}: ` +
      `+${toInsert.length} ~${toUpdate.length} -${toDelete.length}`
    );

    // 返回更新后的列表
    const updated = db.prepare(`
      SELECT
        bp.id AS project_id,
        bp.name AS project_name,
        bpm.role,
        CASE WHEN bpm.id IS NOT NULL THEN 1 ELSE 0 END AS is_member
      FROM business_projects bp
      LEFT JOIN business_project_members bpm ON bpm.business_project_id = bp.id AND bpm.user_id = ?
      ORDER BY bp.id ASC
    `).all(targetId);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update user projects failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新用户项目关联失败' });
  }
});

module.exports = router;
