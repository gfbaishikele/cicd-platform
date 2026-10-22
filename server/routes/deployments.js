const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { requireRole, checkProjectAccess, getProjectIdFromDeployment } = require('../middleware/rbac');
const { createDeploymentRules, validate } = require('../middleware/validator');
const DeployService = require('../services/deploy.service');
const logger = require('../utils/logger');

router.use(authMiddleware);

/**
 * POST /api/deployments
 * 创建部署（支持多节点 / 按分组）
 */
router.post('/', createDeploymentRules, validate, async (req, res) => {
  try {
    const { project_id, build_id, node_ids: raw_node_ids, group_ids, image_tag, container_name, ports, env_vars, volumes, strategy, deploy_service_id } = req.body;

    // 校验项目
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 校验构建记录
    const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(build_id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建记录不存在' });
    }
    if (build.status !== 'success') {
      return res.status(400).json({ code: 40008, message: '只能部署构建成功的版本' });
    }

    // 解析目标节点：合并直接选择的节点 + 分组下的节点
    let node_ids = Array.isArray(raw_node_ids) ? [...raw_node_ids] : [];

    if (Array.isArray(group_ids) && group_ids.length > 0) {
      const placeholders = group_ids.map(() => '?').join(',');
      const groupNodes = db.prepare(`SELECT id FROM cluster_nodes WHERE group_id IN (${placeholders})`).all(...group_ids);
      for (const gn of groupNodes) {
        if (!node_ids.includes(gn.id)) {
          node_ids.push(gn.id);
        }
      }
    }

    if (node_ids.length === 0) {
      return res.status(400).json({ code: 40001, message: '至少选择一个节点或分组' });
    }

    // 校验节点
    for (const nid of node_ids) {
      const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nid);
      if (!node) {
        return res.status(404).json({ code: 40004, message: `节点 ${nid} 不存在` });
      }
    }

    const deployments = await DeployService.createDeployment({
      project_id,
      build_id,
      node_ids,
      image_tag,
      container_name: container_name || (project.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : ''),
      ports,
      env_vars,
      volumes,
      strategy: strategy || 'recreate',
      deployed_by: req.user.id,
      deploy_service_id: deploy_service_id || null,
    });

    logger.info(`Deployment created: ${deployments.length} tasks by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: deployments,
      message: `已创建 ${deployments.length} 个部署任务`,
    });
  } catch (err) {
    logger.error(`Create deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `创建部署失败: ${err.message}` });
  }
});

/**
 * GET /api/deployments
 * 部署列表（分页 + 筛选）
 */
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const { project_id, node_id, status, deploy_service_id, business_project_id } = req.query;

    // 非 admin 只能看到自己是成员的 business_project 下的部署
    const allowedBpIds = req.user.role !== 'admin'
      ? db.prepare('SELECT business_project_id FROM business_project_members WHERE user_id = ?').all(req.user.id).map(r => r.business_project_id)
      : null;

    const result = DeployService.getList({
      page,
      pageSize,
      project_id: project_id ? parseInt(project_id, 10) : undefined,
      node_id: node_id ? parseInt(node_id, 10) : undefined,
      status,
      deploy_service_id: deploy_service_id ? parseInt(deploy_service_id, 10) : undefined,
      business_project_id: business_project_id ? parseInt(business_project_id, 10) : undefined,
      allowedProjectIds: null, // 不使用 project_id 过滤
      allowedBusinessProjectIds: allowedBpIds,
    });

    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Get deployments failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取部署列表失败' });
  }
});

/**
 * GET /api/deployments/:id
 * 部署详情
 */
router.get('/:id', (req, res) => {
  try {
    const deployment = DeployService.getById(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    // 权限检查：需要是项目成员
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id);
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    res.json({ code: 0, data: deployment });
  } catch (err) {
    logger.error(`Get deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取部署详情失败' });
  }
});

/**
 * POST /api/deployments/:id/rollback
 * 回滚部署
 */
router.post('/:id/rollback', (req, res) => {
  try {
    const deployment = DeployService.getById(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const { target_build_id } = req.body;
    const newDeployment = DeployService.rollback(req.params.id, target_build_id);

    logger.info(`Deployment ${req.params.id} rollback initiated by ${req.user.username}, new: #${newDeployment.id}`);

    res.json({ code: 0, data: newDeployment, message: '回滚已启动' });
  } catch (err) {
    logger.error(`Rollback deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `回滚失败: ${err.message}` });
  }
});

/**
 * POST /api/deployments/:id/cancel
 * 取消部署
 */
router.post('/:id/cancel', (req, res) => {
  try {
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    if (deployment.status !== 'deploying' && deployment.status !== 'pending') {
      return res.status(400).json({ code: 40008, message: '只能取消正在执行中的部署' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const cancelled = DeployService.cancelDeployment(parseInt(req.params.id));

    if (cancelled) {
      logger.info(`Deployment ${req.params.id} cancel requested by ${req.user.username}`);
      res.json({ code: 0, message: '取消请求已发送' });
    } else {
      // 部署可能还没开始执行，直接标记为 cancelled
      db.prepare("UPDATE deployments SET status = 'cancelled', finished_at = (datetime('now', 'localtime')) WHERE id = ?").run(req.params.id);
      logger.info(`Deployment ${req.params.id} cancelled by ${req.user.username}`);
      res.json({ code: 0, message: '部署已取消' });
    }
  } catch (err) {
    logger.error(`Cancel deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `取消失败: ${err.message}` });
  }
});

/**
 * POST /api/deployments/:id/retry
 * 重试部署
 */
router.post('/:id/retry', async (req, res) => {
  try {
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 解析原部署参数
    const node_ids = JSON.parse(deployment.node_ids || '[]');
    const ports = JSON.parse(deployment.ports || '[]');
    const env_vars = JSON.parse(deployment.env_vars || '{}');
    const volumes = JSON.parse(deployment.volumes || '[]');

    // 校验节点
    for (const nid of node_ids) {
      const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nid);
      if (!node) {
        return res.status(404).json({ code: 40004, message: `节点 ${nid} 不存在` });
      }
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(deployment.project_id);

    const deployments = await DeployService.createDeployment({
      project_id: deployment.project_id,
      build_id: deployment.build_id,
      node_ids,
      image_tag: deployment.image_tag,
      container_name: deployment.container_name,
      ports,
      env_vars,
      volumes,
      strategy: deployment.strategy || 'recreate',
      deployed_by: req.user.id,
      deploy_service_id: deployment.deploy_service_id || null,
    });

    logger.info(`Deployment ${req.params.id} retried by ${req.user.username}, new: #${deployments[0]?.id}`);

    res.status(201).json({
      code: 0,
      data: deployments,
      message: `已重试 ${deployments.length} 个部署任务`,
    });
  } catch (err) {
    logger.error(`Retry deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `重试部署失败: ${err.message}` });
  }
});

/**
 * GET /api/deployments/:id/log
 * 获取部署日志
 */
router.get('/:id/log', (req, res) => {
  try {
    const deployment = db.prepare('SELECT id, project_id, log FROM deployments WHERE id = ?').get(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    // 权限检查：需要是项目成员
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id);
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    res.json({ code: 0, data: { log: deployment.log || '' } });
  } catch (err) {
    logger.error(`Get deployment log failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取日志失败' });
  }
});

/**
 * DELETE /api/deployments/all
 * 一键清除所有部署记录（跳过正在部署中的）
 */
router.delete('/all', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      const bpIds = db.prepare('SELECT business_project_id FROM business_project_members WHERE user_id = ?').all(req.user.id).map(r => r.business_project_id);
      if (bpIds.length === 0) {
        return res.json({ code: 0, message: '没有可清除的部署记录', deleted: 0 });
      }
      const placeholders = bpIds.map(() => '?').join(',');
      const deleted = db.prepare(
        `DELETE FROM deployments WHERE status != 'deploying' AND project_id IN (SELECT id FROM projects WHERE business_project_id IN (${placeholders}))`
      ).run(...bpIds);
      logger.info(`All deployments cleared by ${req.user.username}, deleted: ${deleted.changes}`);
      res.json({ code: 0, message: '部署记录已清除', deleted: deleted.changes });
    } else {
      const deleted = db.prepare("DELETE FROM deployments WHERE status != 'deploying'").run();
      logger.info(`All deployments cleared by admin ${req.user.username}, deleted: ${deleted.changes}`);
      res.json({ code: 0, message: '部署记录已清除', deleted: deleted.changes });
    }
  } catch (err) {
    logger.error(`Clear all deployments failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '清除部署记录失败' });
  }
});

/**
 * DELETE /api/deployments/:id
 * 删除部署记录
 */
router.delete('/:id', (req, res) => {
  try {
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(req.params.id);
    if (!deployment) {
      return res.status(404).json({ code: 40004, message: '部署记录不存在' });
    }

    // 权限检查：需要 developer 或 owner 角色
    const access = checkProjectAccess(req.user.id, req.user.role, deployment.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    if (deployment.status === 'deploying') {
      return res.status(400).json({ code: 40008, message: '部署正在执行中，无法删除' });
    }

    db.prepare('DELETE FROM deployments WHERE id = ?').run(req.params.id);
    logger.info(`Deployment ${req.params.id} deleted by ${req.user.username}`);
    res.json({ code: 0, message: '部署记录已删除' });
  } catch (err) {
    logger.error(`Delete deployment failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除部署失败' });
  }
});

module.exports = router;
