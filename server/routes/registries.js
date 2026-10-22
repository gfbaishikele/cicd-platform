const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const RegistryService = require('../services/registry.service');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger');

router.use(authMiddleware);

function checkRegistryVisibility(req, registry) {
  if (!registry) return false;
  if (req.user.role === 'admin') return true;
  if (registry.scope === 'public' || registry.created_by === req.user.id) return true;
  // 检查是否绑定到用户所属 business_project 下的项目（级联权限）
  const member = db.prepare(`
    SELECT 1 FROM project_registries pr
    JOIN projects p ON p.id = pr.project_id
    JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
    WHERE pr.registry_id = ? AND bpm.user_id = ?
    LIMIT 1
  `).get(registry.id, req.user.id);
  return !!member;
}

function checkRegistryOwnership(req, registry) {
  if (!registry) return false;
  if (req.user.role === 'admin') return true;
  return registry.created_by === req.user.id && registry.scope === 'private';
}

/**
 * GET /api/registries
 * Registry 列表
 */
router.get('/', (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    let query;
    let params;

    if (req.user.role === 'admin') {
      query = `
        SELECT r.*, u.name as created_by_name
        FROM registries r
        LEFT JOIN users u ON r.created_by = u.id
        WHERE 1=1
      `;
      params = [];
    } else {
      query = `
        SELECT r.*, u.name as created_by_name
        FROM registries r
        LEFT JOIN users u ON r.created_by = u.id
        WHERE r.scope = 'public'
           OR r.created_by = ?
           OR r.id IN (
             SELECT registry_id FROM project_registries
             WHERE project_id IN (
               SELECT id FROM projects WHERE business_project_id IN (
                 SELECT business_project_id FROM business_project_members WHERE user_id = ?
               )
             )
           )
      `;
      params = [req.user.id, req.user.id];
    }

    if (keyword) {
      query += ' AND (name LIKE ? OR url LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    query += ' ORDER BY created_at DESC';

    const registries = db.prepare(query).all(...params);

    res.json({ code: 0, data: registries });
  } catch (err) {
    logger.error(`Get registries failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取 Registry 列表失败' });
  }
});

/**
 * POST /api/registries
 * 创建 Registry
 */
router.post('/', (req, res) => {
  try {
    const { name, url, username, password, type = 'docker', verify_ssl = 1 } = req.body;

    if (!name || !url) {
      return res.status(400).json({ code: 40001, message: '名称和 URL 不能为空' });
    }

    const scope = req.body.scope || 'private';

    const result = db.prepare(`
      INSERT INTO registries (name, url, username, password, type, verify_ssl, scope, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, url, username || null, password ? encrypt(password) : null, type, verify_ssl, scope, req.user.id);

    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(result.lastInsertRowid);

    logger.info(`Registry created: ${name} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: registry });
  } catch (err) {
    logger.error(`Create registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建 Registry 失败' });
  }
});

/**
 * GET /api/registries/:id
 * Registry 详情
 */
router.get('/:id', (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry || !checkRegistryVisibility(req, registry)) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }

    // 不返回密码
    const { password, ...safeRegistry } = registry;

    res.json({ code: 0, data: safeRegistry });
  } catch (err) {
    logger.error(`Get registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取 Registry 详情失败' });
  }
});

/**
 * PUT /api/registries/:id
 * 更新 Registry
 */
router.put('/:id', (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }

    if (!checkRegistryOwnership(req, registry)) {
      return res.status(403).json({ code: 40301, message: '无权修改此 Registry' });
    }

    const { name, url, username, password, type, verify_ssl } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (url !== undefined) { updates.push('url = ?'); params.push(url); }
    if (username !== undefined && username !== '') { updates.push('username = ?'); params.push(username); }
    if (password !== undefined && password !== '') { updates.push('password = ?'); params.push(encrypt(password)); }
    if (type !== undefined) { updates.push('type = ?'); params.push(type); }
    if (verify_ssl !== undefined) { updates.push('verify_ssl = ?'); params.push(verify_ssl); }
    if (req.body.scope !== undefined) { updates.push('scope = ?'); params.push(req.body.scope); }

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE registries SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    const { password: pwd, ...safeRegistry } = updated;

    logger.info(`Registry ${req.params.id} updated by ${req.user.username}`);

    res.json({ code: 0, data: safeRegistry });
  } catch (err) {
    logger.error(`Update registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新 Registry 失败' });
  }
});

/**
 * DELETE /api/registries/:id
 * 删除 Registry
 */
router.delete('/:id', (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }

    if (!checkRegistryOwnership(req, registry)) {
      return res.status(403).json({ code: 40301, message: '无权删除此 Registry' });
    }

    // 检查是否有项目使用此 Registry
    const projectCount = db.prepare(
      'SELECT COUNT(*) as count FROM projects WHERE registry_id = ?'
    ).get(req.params.id);

    if (projectCount.count > 0) {
      return res.status(400).json({
        code: 40008,
        message: `有 ${projectCount.count} 个项目正在使用此 Registry，无法删除`,
      });
    }

    db.prepare('DELETE FROM registries WHERE id = ?').run(req.params.id);

    logger.info(`Registry ${req.params.id} (${registry.name}) deleted by ${req.user.username}`);

    res.json({ code: 0, message: 'Registry 已删除' });
  } catch (err) {
    logger.error(`Delete registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除 Registry 失败' });
  }
});

/**
 * POST /api/registries/:id/test
 * 测试 Registry 连接
 */
router.post('/:id/test', async (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry || !checkRegistryVisibility(req, registry)) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }
    if (registry.password) registry.password = decrypt(registry.password);

    const result = await RegistryService.testConnection(registry);

    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Test registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `测试连接失败: ${err.message}` });
  }
});

/**
 * GET /api/registries/:id/images
 * 获取远程 Registry 的镜像列表
 */
router.get('/:id/images', async (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry || !checkRegistryVisibility(req, registry)) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }
    if (registry.password) registry.password = decrypt(registry.password);

    const images = await RegistryService.listImages(registry);

    res.json({ code: 0, data: images });
  } catch (err) {
    logger.error(`Get registry images failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取镜像列表失败: ${err.message}` });
  }
});

/**
 * GET /api/registries/:id/images/:image/tags
 * 获取镜像的标签列表
 */
router.get('/:id/images/:image/tags', async (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry || !checkRegistryVisibility(req, registry)) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }
    if (registry.password) registry.password = decrypt(registry.password);

    const tags = await RegistryService.listTags(registry, req.params.image);

    res.json({ code: 0, data: tags });
  } catch (err) {
    logger.error(`Get image tags failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `获取标签列表失败: ${err.message}` });
  }
});

/**
 * DELETE /api/registries/:id/images/:image/tags/:tag
 * 删除远程镜像标签
 */
router.delete('/:id/images/:image/tags/:tag', async (req, res) => {
  try {
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(req.params.id);
    if (!registry) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }

    if (!checkRegistryOwnership(req, registry)) {
      return res.status(403).json({ code: 40301, message: '无权操作此 Registry' });
    }

    if (registry.password) registry.password = decrypt(registry.password);

    await RegistryService.deleteTag(registry, req.params.image, req.params.tag);

    logger.info(`Registry tag ${req.params.image}:${req.params.tag} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '标签已删除' });
  } catch (err) {
    logger.error(`Delete tag failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `删除标签失败: ${err.message}` });
  }
});

module.exports = router;
