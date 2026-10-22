const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { checkProjectAccess } = require('../middleware/rbac');
const { createBuildRules, validate } = require('../middleware/validator');
const BuildService = require('../services/build.service');
const logger = require('../utils/logger');

router.use(authMiddleware);

/**
 * POST /api/builds
 * 触发构建
 */
router.post('/', createBuildRules, validate, async (req, res) => {
  try {
    const {
      project_id, branch, params = {},
      dockerfile_source = 'template', dockerfile_template_id = null,
      dockerfile_path = '', image_name = '', image_tag = '', deploy_service_id,
    } = req.body;

    // 检查项目是否存在
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 检查是否有正在运行的构建
    const runningBuild = db.prepare(
      "SELECT id FROM builds WHERE project_id = ? AND status = 'building'"
    ).get(project_id);
    if (runningBuild) {
      return res.status(400).json({
        code: 40008,
        message: `项目正在构建中 (Build #${runningBuild.id})，请等待完成`,
      });
    }

    const build = await BuildService.triggerBuild({
      project_id,
      branch,
      params,
      triggered_by: req.user.id,
      dockerfile_source,
      dockerfile_template_id,
      dockerfile_path,
      image_name,
      image_tag,
    });

    // 关联到应用发布
    if (deploy_service_id) {
      db.prepare('UPDATE builds SET deploy_service_id = ? WHERE id = ?').run(deploy_service_id, build.id);
      build.deploy_service_id = deploy_service_id;
    }

    logger.info(`Build triggered: #${build.id} for project ${project.name} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: build });
  } catch (err) {
    logger.error(`Trigger build failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `触发构建失败: ${err.message}` });
  }
});

/**
 * GET /api/builds
 * 构建列表
 */
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const offset = (page - 1) * pageSize;
    const { project_id, status, branch, business_project_id, deploy_service_id } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (project_id) {
      whereClause += ' AND b.project_id = ?';
      params.push(project_id);
    }
    if (status) {
      whereClause += ' AND b.status = ?';
      params.push(status);
    }
    if (branch) {
      whereClause += ' AND b.branch = ?';
      params.push(branch);
    }
    if (business_project_id) {
      whereClause += ' AND b.project_id IN (SELECT id FROM projects WHERE business_project_id = ?)';
      params.push(business_project_id);
    }
    if (deploy_service_id) {
      whereClause += ' AND b.deploy_service_id = ?';
      params.push(deploy_service_id);
    }

    // 非 admin 只能看到自己是成员的 business_project 下的构建
    if (req.user.role !== 'admin') {
      whereClause += ' AND b.project_id IN (SELECT id FROM projects WHERE business_project_id IN (SELECT business_project_id FROM business_project_members WHERE user_id = ?))';
      params.push(req.user.id);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM builds b ${whereClause}`).get(...params).count;

    const list = db.prepare(`
      SELECT b.*, p.name as project_name, bp.name as business_project_name, u.name as triggered_by_name,
             ds.name as deploy_service_name
      FROM builds b
      LEFT JOIN projects p ON b.project_id = p.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      LEFT JOIN users u ON b.triggered_by = u.id
      LEFT JOIN deploy_services ds ON b.deploy_service_id = ds.id
      ${whereClause}
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
      code: 0,
      data: { list, total, page, pageSize },
    });
  } catch (err) {
    logger.error(`Get builds failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取构建列表失败' });
  }
});

/**
 * GET /api/builds/:id
 * 构建详情
 */
router.get('/:id', (req, res) => {
  try {
    const build = db.prepare(`
      SELECT b.*, p.name as project_name, p.repo_path, u.name as triggered_by_name
      FROM builds b
      LEFT JOIN projects p ON b.project_id = p.id
      LEFT JOIN users u ON b.triggered_by = u.id
      WHERE b.id = ?
    `).get(req.params.id);

    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建不存在' });
    }

    // 权限检查：需要是项目成员
    const access = checkProjectAccess(req.user.id, req.user.role, build.project_id);
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 获取构建参数
    const buildParams = db.prepare(
      'SELECT key, value, is_secret FROM build_params WHERE build_id = ?'
    ).all(req.params.id);

    res.json({
      code: 0,
      data: {
        ...build,
        params: buildParams.map(p => ({
          ...p,
          value: p.is_secret ? '******' : p.value,
        })),
      },
    });
  } catch (err) {
    logger.error(`Get build failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取构建详情失败' });
  }
});

/**
 * GET /api/builds/:id/log
 * 获取构建日志
 */
router.get('/:id/log', (req, res) => {
  try {
    // 权限检查：需要是项目成员
    const build = db.prepare('SELECT project_id FROM builds WHERE id = ?').get(req.params.id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建不存在' });
    }
    const access = checkProjectAccess(req.user.id, req.user.role, build.project_id);
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const offset = parseInt(req.query.offset, 10) || 0;
    const logData = BuildService.getLog(req.params.id, offset);
    res.json({ code: 0, data: logData });
  } catch (err) {
    logger.error(`Get build log failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取日志失败' });
  }
});

/**
 * POST /api/builds/:id/cancel
 * 取消构建
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    // 权限检查：需要 developer 或 owner 角色
    const build = db.prepare('SELECT project_id FROM builds WHERE id = ?').get(req.params.id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建不存在' });
    }
    const access = checkProjectAccess(req.user.id, req.user.role, build.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const cancelled = await BuildService.cancelBuild(req.params.id);
    if (cancelled) {
      logger.info(`Build ${req.params.id} cancelled by ${req.user.username}`);
      res.json({ code: 0, message: '构建已取消' });
    } else {
      res.status(400).json({ code: 40008, message: '构建不在运行中' });
    }
  } catch (err) {
    logger.error(`Cancel build failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '取消构建失败' });
  }
});

/**
 * POST /api/builds/:id/retry
 * 重试构建
 */
router.post('/:id/retry', async (req, res) => {
  try {
    const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(req.params.id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, build.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 获取原构建参数
    const params = db.prepare('SELECT key, value FROM build_params WHERE build_id = ?').all(req.params.id);
    const paramsObj = {};
    params.forEach(p => { paramsObj[p.key] = p.value; });

    // 提取构建配置参数（不作为构建变量传入）
    const dockerfile_source = paramsObj.dockerfile_source || 'template';
    const dockerfile_template_id = paramsObj.dockerfile_template_id || null;
    const dockerfile_path = paramsObj.dockerfile_path || '';
    const image_name = paramsObj.image_name || '';
    const image_tag = paramsObj.image_tag || '';
    delete paramsObj.dockerfile_source;
    delete paramsObj.dockerfile_template_id;
    delete paramsObj.dockerfile_path;
    delete paramsObj.image_name;
    delete paramsObj.image_tag;

    const newBuild = await BuildService.triggerBuild({
      project_id: build.project_id,
      branch: build.branch,
      params: paramsObj,
      triggered_by: req.user.id,
      dockerfile_source,
      dockerfile_template_id: dockerfile_template_id ? parseInt(dockerfile_template_id) : null,
      dockerfile_path,
      image_name,
      image_tag,
    });

    logger.info(`Build ${req.params.id} retried as #${newBuild.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: { ...newBuild, retry_of: build.id } });
  } catch (err) {
    logger.error(`Retry build failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '重试构建失败' });
  }
});

/**
 * DELETE /api/builds/all
 * 一键清除所有构建记录（跳过正在构建中的）
 */
router.delete('/all', (req, res) => {
  try {
    // 非 admin 只能清除自己是成员的项目的构建
    if (req.user.role !== 'admin') {
      const bpIds = db.prepare('SELECT business_project_id FROM business_project_members WHERE user_id = ?').all(req.user.id).map(r => r.business_project_id);
      if (bpIds.length === 0) {
        return res.json({ code: 0, message: '没有可清除的构建记录', deleted: 0 });
      }
      const placeholders = bpIds.map(() => '?').join(',');
      const deleted = db.prepare(
        `DELETE FROM builds WHERE status != 'building' AND project_id IN (SELECT id FROM projects WHERE business_project_id IN (${placeholders}))`
      ).run(...bpIds);
      db.prepare(
        `DELETE FROM build_params WHERE build_id NOT IN (SELECT id FROM builds)`
      ).run();
      logger.info(`All builds cleared by ${req.user.username}, deleted: ${deleted.changes}`);
      res.json({ code: 0, message: '构建记录已清除', deleted: deleted.changes });
    } else {
      const deleted = db.prepare("DELETE FROM builds WHERE status != 'building'").run();
      db.prepare('DELETE FROM build_params WHERE build_id NOT IN (SELECT id FROM builds)').run();
      logger.info(`All builds cleared by admin ${req.user.username}, deleted: ${deleted.changes}`);
      res.json({ code: 0, message: '构建记录已清除', deleted: deleted.changes });
    }
  } catch (err) {
    logger.error(`Clear all builds failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '清除构建记录失败' });
  }
});

/**
 * DELETE /api/builds/:id
 * 删除构建记录
 */
router.delete('/:id', (req, res) => {
  try {
    const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(req.params.id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, build.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    if (build.status === 'building') {
      return res.status(400).json({ code: 40008, message: '构建正在运行中，请先取消' });
    }

    db.prepare('DELETE FROM builds WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM build_params WHERE build_id = ?').run(req.params.id);

    logger.info(`Build ${req.params.id} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '构建记录已删除' });
  } catch (err) {
    logger.error(`Delete build failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除构建失败' });
  }
});

module.exports = router;
