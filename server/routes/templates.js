const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { createTemplateRules, validate } = require('../middleware/validator');
const TemplateService = require('../services/template.service');
const logger = require('../utils/logger');

function checkTemplateVisibility(req, template) {
  if (!template) return false;
  if (req.user.role === 'admin') return true;
  if (template.scope === 'public') return true;
  if (template.created_by === req.user.id) return true;
  // scope='project' 时，检查是否绑定到用户所属 business_project 下的项目（级联权限）
  if (template.scope === 'project') {
    const db = require('../db/init');
    const member = db.prepare(`
      SELECT 1 FROM project_templates pt
      JOIN projects p ON p.id = pt.project_id
      JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
      WHERE pt.template_id = ? AND bpm.user_id = ?
      LIMIT 1
    `).get(template.id, req.user.id);
    return !!member;
  }
  return false;
}

function checkTemplateOwnership(req, res, template) {
  if (!template) { res.status(404).json({ code: 40004, message: '模板不存在' }); return false; }
  if (req.user.role === 'admin') return true;
  if (template.is_system) { res.status(403).json({ code: 40301, message: '无权修改系统模板' }); return false; }
  if (template.created_by === req.user.id) return true;
  res.status(403).json({ code: 40301, message: '无权操作此模板' }); return false;
}

router.use(authMiddleware);

/**
 * GET /api/templates
 * 模板列表
 */
router.get('/', (req, res) => {
  try {
    const { build_type } = req.query;
    let templates = TemplateService.getAll(build_type);

    // Scope-based visibility for non-admin users
    if (req.user.role !== 'admin') {
      const db = require('../db/init');
      // 获取用户所属 business_project 下项目绑定的模板 ID（级联权限）
      const projectTemplateIds = db.prepare(`
        SELECT DISTINCT pt.template_id FROM project_templates pt
        JOIN projects p ON p.id = pt.project_id
        JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
        WHERE bpm.user_id = ?
      `).all(req.user.id).map(r => r.template_id);
      
      templates = templates.filter(t =>
        t.scope === 'public' ||
        t.created_by === req.user.id ||
        (t.scope === 'project' && projectTemplateIds.includes(t.id))
      );
    }

    const parsed = templates.map(t => ({
      ...t,
      variables: t.variables ? JSON.parse(t.variables) : [],
    }));

    res.json({ code: 0, data: parsed });
  } catch (err) {
    logger.error(`Get templates failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取模板列表失败' });
  }
});

/**
 * GET /api/templates/system
 * 获取系统内置模板
 */
router.get('/system', (req, res) => {
  try {
    const templates = TemplateService.getAll().filter(t => t.is_system);
    const parsed = templates.map(t => ({
      ...t,
      variables: t.variables ? JSON.parse(t.variables) : [],
    }));
    res.json({ code: 0, data: parsed });
  } catch (err) {
    logger.error(`Get system templates failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取系统模板失败' });
  }
});

/**
 * POST /api/templates
 * 创建模板
 */
router.post('/', createTemplateRules, validate, (req, res) => {
  try {
    const { name, description, build_type, content, variables, is_system, scope } = req.body;

    const templateData = {
      name, description, build_type, content, variables,
      scope: req.body.scope || 'private',
      created_by: req.user.id,
    };

    if (req.user.role === 'admin') {
      if (is_system !== undefined) templateData.is_system = is_system;
    } else {
      templateData.is_system = 0;
    }

    const template = TemplateService.create(templateData);

    logger.info(`Template created: ${name} by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: {
        ...template,
        variables: template.variables ? JSON.parse(template.variables) : [],
      },
    });
  } catch (err) {
    logger.error(`Create template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建模板失败' });
  }
});

/**
 * GET /api/templates/:id
 * 模板详情
 */
router.get('/:id', (req, res) => {
  try {
    const template = TemplateService.getById(req.params.id);
    if (!checkTemplateVisibility(req, template)) {
      return res.status(404).json({ code: 40004, message: '模板不存在' });
    }

    res.json({
      code: 0,
      data: {
        ...template,
        variables: template.variables ? JSON.parse(template.variables) : [],
      },
    });
  } catch (err) {
    logger.error(`Get template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取模板详情失败' });
  }
});

/**
 * PUT /api/templates/:id
 * 更新模板
 */
router.put('/:id', (req, res) => {
  try {
    const template = TemplateService.getById(req.params.id);
    if (!checkTemplateOwnership(req, res, template)) return;

    const updated = TemplateService.update(req.params.id, req.body);

    logger.info(`Template ${req.params.id} updated by ${req.user.username}`);

    res.json({
      code: 0,
      data: {
        ...updated,
        variables: updated.variables ? JSON.parse(updated.variables) : [],
      },
    });
  } catch (err) {
    logger.error(`Update template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新模板失败' });
  }
});

/**
 * DELETE /api/templates/:id
 * 删除模板
 */
router.delete('/:id', (req, res) => {
  try {
    const template = TemplateService.getById(req.params.id);
    if (!checkTemplateOwnership(req, res, template)) return;

    const result = TemplateService.delete(req.params.id);

    if (!result) {
      return res.status(404).json({ code: 40004, message: '模板不存在' });
    }
    if (result.error) {
      return res.status(400).json({ code: 40006, message: result.error });
    }

    logger.info(`Template ${req.params.id} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '模板已删除' });
  } catch (err) {
    logger.error(`Delete template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除模板失败' });
  }
});

/**
 * POST /api/templates/:id/preview
 * 预览渲染结果
 */
router.post('/:id/preview', (req, res) => {
  try {
    const template = TemplateService.getById(req.params.id);
    if (!checkTemplateVisibility(req, template)) {
      return res.status(404).json({ code: 40004, message: '模板不存在' });
    }

    const variables = req.body || {};
    const rendered = TemplateService.render(template.content, variables);

    res.json({ code: 0, data: { rendered } });
  } catch (err) {
    logger.error(`Preview template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '预览失败' });
  }
});

module.exports = router;
