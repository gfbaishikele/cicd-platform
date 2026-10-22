const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { checkProjectAccess } = require('../middleware/rbac');
const BuildService = require('../services/build.service');
const DeployService = require('../services/deploy.service');
const logger = require('../utils/logger');

router.use(authMiddleware);

/**
 * 将 group_ids 解析为节点 ID 列表（与 node_ids 合并去重）
 */
function resolveNodeIds(raw_node_ids, group_ids) {
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
  return node_ids;
}

/**
 * GET /api/deploy-services
 * 应用发布列表
 */
router.get('/', (req, res) => {
  try {
    const { project_id } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (project_id) {
      whereClause += ' AND ds.project_id = ?';
      params.push(parseInt(project_id, 10));
    }

    // 非 admin 只能看到自己是成员的 business_project 下的应用发布
    if (req.user.role !== 'admin') {
      whereClause += ' AND p.business_project_id IN (SELECT business_project_id FROM business_project_members WHERE user_id = ?)';
      params.push(req.user.id);
    }

    const list = db.prepare(`
      SELECT ds.*, p.name as project_name, p.repo_path, p.business_project_id,
             bp.name as business_project_name,
             u.name as created_by_name
      FROM deploy_services ds
      LEFT JOIN projects p ON ds.project_id = p.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      LEFT JOIN users u ON ds.created_by = u.id
      ${whereClause}
      ORDER BY ds.id DESC
    `).all(...params);

    // 附带每个服务的最新构建和部署状态
    for (const service of list) {
      const latestBuild = db.prepare(`
        SELECT id, status, image_tag, created_at FROM builds
        WHERE deploy_service_id = ? ORDER BY id DESC LIMIT 1
      `).get(service.id);

      const latestDeploy = db.prepare(`
        SELECT id, status, image_tag, created_at FROM deployments
        WHERE deploy_service_id = ? ORDER BY id DESC LIMIT 1
      `).get(service.id);

      service.latest_build = latestBuild || null;
      service.latest_deploy = latestDeploy || null;
    }

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get deploy services failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取应用发布列表失败' });
  }
});

/**
 * POST /api/deploy-services
 * 创建应用发布
 */
router.post('/', async (req, res) => {
  try {
    const {
      name, project_id, node_ids: raw_node_ids, group_ids, ports, env_vars, volumes,
      strategy, container_name, description, is_default,
      branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag,
    } = req.body;

    if (!project_id) {
      return res.status(400).json({ code: 40001, message: '模块不能为空' });
    }

    // 校验项目
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '模块不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 解析目标节点
    const node_ids = resolveNodeIds(raw_node_ids, group_ids);
    if (node_ids.length === 0) {
      return res.status(400).json({ code: 40001, message: '至少选择一个节点或分组' });
    }

    // 如果设为默认，取消同模块其他默认
    if (is_default) {
      db.prepare('UPDATE deploy_services SET is_default = 0 WHERE project_id = ?').run(project_id);
    }

    const result = db.prepare(`
      INSERT INTO deploy_services (name, project_id, node_ids, ports, env_vars, volumes,
        strategy, container_name, description, is_default, created_by,
        branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name || null, project_id,
      JSON.stringify(node_ids),
      JSON.stringify(ports || []),
      JSON.stringify(env_vars || {}),
      JSON.stringify(volumes || []),
      strategy || 'recreate',
      container_name || (project.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : ''),
      description || null,
      is_default ? 1 : 0,
      req.user.id,
      branch || 'main',
      dockerfile_source || 'repository',
      dockerfile_template_id || null,
      dockerfile_path || '',
      image_name || null,
      image_tag || null,
    );

    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(result.lastInsertRowid);

    logger.info(`Deploy service created: #${service.id} "${service.name}" by ${req.user.username}`);

    res.status(201).json({ code: 0, data: service });
  } catch (err) {
    logger.error(`Create deploy service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `创建应用发布失败: ${err.message}` });
  }
});

/**
 * GET /api/deploy-services/:id
 * 应用发布详情（含时间线）
 */
router.get('/:id', (req, res) => {
  try {
    const service = db.prepare(`
      SELECT ds.*, p.name as project_name, p.repo_path, p.registry_id,
             bp.name as business_project_name,
             u.name as created_by_name
      FROM deploy_services ds
      LEFT JOIN projects p ON ds.project_id = p.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      LEFT JOIN users u ON ds.created_by = u.id
      WHERE ds.id = ?
    `).get(req.params.id);

    if (!service) {
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id);
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 解析 JSON 字段
    service.node_ids = JSON.parse(service.node_ids || '[]');
    service.ports = JSON.parse(service.ports || '[]');
    service.env_vars = JSON.parse(service.env_vars || '{}');
    service.volumes = JSON.parse(service.volumes || '[]');

    // 获取节点名称
    if (service.node_ids.length > 0) {
      service.nodes = db.prepare(
        'SELECT id, name, host FROM cluster_nodes WHERE id IN (' + service.node_ids.join(',') + ')'
      ).all();
    } else {
      service.nodes = [];
    }

    // 获取时间线：构建 + 部署合并，按时间倒序
    const builds = db.prepare(`
      SELECT 'build' as type, id, status, image_tag, branch, duration, created_at, triggered_by
      FROM builds WHERE deploy_service_id = ?
      ORDER BY id DESC
    `).all(service.id);

    const deployments = db.prepare(`
      SELECT 'deploy' as type, id, status, image_tag, node_id, duration, created_at, deployed_by
      FROM deployments WHERE deploy_service_id = ?
      ORDER BY id DESC
    `).all(service.id);

    // 合并并按操作时间倒序
    const timeline = [...builds, ...deployments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 获取关联的用户名
    for (const item of timeline) {
      if (item.type === 'build' && item.triggered_by) {
        const u = db.prepare('SELECT username FROM users WHERE id = ?').get(item.triggered_by);
        item.triggered_by_name = u?.username || '';
      }
      if (item.type === 'deploy' && item.deployed_by) {
        const u = db.prepare('SELECT username FROM users WHERE id = ?').get(item.deployed_by);
        item.deployed_by_name = u?.username || '';
      }
      if (item.type === 'deploy' && item.node_id) {
        const n = db.prepare('SELECT name, host FROM cluster_nodes WHERE id = ?').get(item.node_id);
        item.node_name = n?.name || '';
        item.node_host = n?.host || '';
      }
    }

    service.timeline = timeline;

    res.json({ code: 0, data: service });
  } catch (err) {
    logger.error(`Get deploy service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取应用发布详情失败' });
  }
});

/**
 * PUT /api/deploy-services/:id
 * 更新应用发布
 */
router.put('/:id', async (req, res) => {
  try {
    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const allowed = ['name', 'node_ids', 'ports', 'env_vars', 'volumes', 'strategy', 'container_name', 'description', 'is_default', 'branch', 'dockerfile_source', 'dockerfile_template_id', 'dockerfile_path', 'image_name', 'image_tag'];
    const updates = [];
    const params = [];

    // 如果提供了 group_ids，解析为 node_ids
    if (req.body.group_ids !== undefined || req.body.node_ids !== undefined) {
      const resolvedNodeIds = resolveNodeIds(req.body.node_ids, req.body.group_ids);
      if (resolvedNodeIds.length === 0) {
        return res.status(400).json({ code: 40001, message: '至少选择一个节点或分组' });
      }
      req.body.node_ids = resolvedNodeIds;
    }

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        if (['node_ids', 'ports', 'env_vars', 'volumes'].includes(field)) {
          updates.push(`${field} = ?`);
          params.push(JSON.stringify(req.body[field]));
        } else if (field === 'is_default') {
          updates.push(`${field} = ?`);
          params.push(req.body[field] ? 1 : 0);
        } else {
          updates.push(`${field} = ?`);
          params.push(req.body[field]);
        }
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: 40001, message: '没有需要更新的字段' });
    }

    updates.push("updated_at = (datetime('now', 'localtime'))");
    params.push(req.params.id);

    // 如果设为默认，取消同模块其他默认
    if (req.body.is_default) {
      db.prepare('UPDATE deploy_services SET is_default = 0 WHERE project_id = ? AND id != ?')
        .run(service.project_id, req.params.id);
    }

    db.prepare(`UPDATE deploy_services SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    logger.info(`Deploy service #${req.params.id} updated by ${req.user.username}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update deploy service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `更新应用发布失败: ${err.message}` });
  }
});

/**
 * DELETE /api/deploy-services/:id
 * 删除应用发布
 */
router.delete('/:id', (req, res) => {
  try {
    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 检查是否有正在执行的构建或部署
    const runningBuild = db.prepare(
      "SELECT id FROM builds WHERE deploy_service_id = ? AND status = 'building'"
    ).get(req.params.id);
    if (runningBuild) {
      return res.status(400).json({ code: 40008, message: '有正在执行的构建，请先取消' });
    }

    const runningDeploy = db.prepare(
      "SELECT id FROM deployments WHERE deploy_service_id = ? AND status = 'deploying'"
    ).get(req.params.id);
    if (runningDeploy) {
      return res.status(400).json({ code: 40008, message: '有正在执行的部署，请先取消' });
    }

    // 将关联的构建和部署的 deploy_service_id 置空（保留历史记录）
    db.prepare('UPDATE builds SET deploy_service_id = NULL WHERE deploy_service_id = ?').run(req.params.id);
    db.prepare('UPDATE deployments SET deploy_service_id = NULL WHERE deploy_service_id = ?').run(req.params.id);

    db.prepare('DELETE FROM deploy_services WHERE id = ?').run(req.params.id);
    logger.info(`Deploy service #${req.params.id} deleted by ${req.user.username}`);

    res.json({ code: 0, message: '应用发布已删除' });
  } catch (err) {
    logger.error(`Delete deploy service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除应用发布失败' });
  }
});

/**
 * POST /api/deploy-services/:id/build
 * 为应用发布触发构建
 */
router.post('/:id/build', async (req, res) => {
  try {
    logger.info(`Build trigger request for deploy service #${req.params.id}`);
    logger.info(`Request body: ${JSON.stringify(req.body)}`);

    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    if (!service) {
      logger.error(`Deploy service #${req.params.id} not found`);
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    logger.info(`Found deploy service: ${service.name}, project_id: ${service.project_id}`);

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id, 'developer');
    if (!access.ok) {
      logger.error(`Permission check failed: ${access.message}`);
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const { branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag, params } = req.body;

    logger.info(`Calling BuildService.triggerBuild`);

    const build = await BuildService.triggerBuild({
      project_id: service.project_id,
      branch: branch || service.branch || 'main',
      params: params || {},
      triggered_by: req.user.id,
      trigger_type: 'manual',
      dockerfile_source: dockerfile_source || service.dockerfile_source || 'repository',
      dockerfile_template_id: dockerfile_template_id || service.dockerfile_template_id || null,
      dockerfile_path: dockerfile_path || service.dockerfile_path || '',
      image_name: image_name || service.image_name || '',
      image_tag: image_tag || service.image_tag || '',
    });

    // 关联到应用发布
    db.prepare('UPDATE builds SET deploy_service_id = ? WHERE id = ?').run(req.params.id, build.id);

    logger.info(`Build #${build.id} triggered for deploy service #${req.params.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: build });
  } catch (err) {
    logger.error(`Build for deploy service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `触发构建失败: ${err.message}` });
  }
});

/**
 * POST /api/deploy-services/:id/deploy
 * 使用应用发布配置执行部署
 */
router.post('/:id/deploy', async (req, res) => {
  try {
    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    const { build_id, ports: reqPorts, env_vars: reqEnvVars, volumes: reqVolumes } = req.body;

    // 校验构建记录
    const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(build_id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建记录不存在' });
    }
    if (build.status !== 'success') {
      return res.status(400).json({ code: 40008, message: '只能部署构建成功的版本' });
    }

    // 解析配置：优先使用请求体传入的覆盖值，否则使用服务默认配置
    const node_ids = JSON.parse(service.node_ids || '[]');
    const ports = reqPorts !== undefined ? reqPorts : JSON.parse(service.ports || '[]');
    const env_vars = reqEnvVars !== undefined ? reqEnvVars : JSON.parse(service.env_vars || '{}');
    const volumes = reqVolumes !== undefined ? reqVolumes : JSON.parse(service.volumes || '[]');
    const strategy = service.strategy || 'recreate';

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(service.project_id);
    const container_name = service.container_name || (project?.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : `appdocker-${service.project_id}-app`);

    if (node_ids.length === 0) {
      return res.status(400).json({ code: 40001, message: '应用发布未配置节点' });
    }

    // 校验节点
    for (const nid of node_ids) {
      const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nid);
      if (!node) {
        return res.status(404).json({ code: 40004, message: `节点 ${nid} 不存在` });
      }
    }

    const deployments = await DeployService.createDeployment({
      project_id: service.project_id,
      build_id,
      node_ids,
      image_tag: build.image_tag,
      container_name,
      ports,
      env_vars,
      volumes,
      strategy,
      deployed_by: req.user.id,
    });

    // 关联到应用发布
    for (const dep of deployments) {
      db.prepare('UPDATE deployments SET deploy_service_id = ? WHERE id = ?').run(req.params.id, dep.id);
    }

    logger.info(`Deploy triggered for service #${req.params.id} with build #${build_id} by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: deployments,
      message: `已创建 ${deployments.length} 个部署任务`,
    });
  } catch (err) {
    logger.error(`Deploy for service failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `部署失败: ${err.message}` });
  }
});

/**
 * POST /api/deploy-services/:id/build-and-deploy
 * 一键构建并部署：触发构建，构建成功后自动部署
 */
router.post('/:id/build-and-deploy', async (req, res) => {
  try {
    const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ code: 40004, message: '应用发布不存在' });
    }

    // 权限检查
    const access = checkProjectAccess(req.user.id, req.user.role, service.project_id, 'developer');
    if (!access.ok) {
      return res.status(403).json({ code: 40301, message: access.message });
    }

    // 检查是否有正在运行的构建
    const runningBuild = db.prepare(
      "SELECT id FROM builds WHERE project_id = ? AND status = 'building'"
    ).get(service.project_id);
    if (runningBuild) {
      return res.status(400).json({
        code: 40008,
        message: `项目正在构建中 (Build #${runningBuild.id})，请等待完成`,
      });
    }

    // 合并构建参数：请求体覆盖服务默认值
    const { branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag, ports, env_vars, volumes } = req.body;

    const build = await BuildService.triggerBuild({
      project_id: service.project_id,
      branch: branch || service.branch || 'main',
      params: {},
      triggered_by: req.user.id,
      trigger_type: 'manual',
      dockerfile_source: dockerfile_source || service.dockerfile_source || 'repository',
      dockerfile_template_id: dockerfile_template_id || service.dockerfile_template_id || null,
      dockerfile_path: dockerfile_path || service.dockerfile_path || '',
      image_name: image_name || service.image_name || '',
      image_tag: image_tag || service.image_tag || '',
    });

    // 存储部署覆盖值（端口/环境变量/卷挂载），供自动部署时使用
    const deployOverrides = {};
    if (ports !== undefined) deployOverrides.ports = ports;
    if (env_vars !== undefined) deployOverrides.env_vars = env_vars;
    if (volumes !== undefined) deployOverrides.volumes = volumes;
    const hasOverrides = Object.keys(deployOverrides).length > 0;

    // 设置 deploy_service_id 和 auto_deploy 标记
    db.prepare('UPDATE builds SET deploy_service_id = ?, auto_deploy = 1, deploy_overrides = ? WHERE id = ?')
      .run(req.params.id, hasOverrides ? JSON.stringify(deployOverrides) : null, build.id);

    logger.info(`Build and deploy triggered: service #${req.params.id}, build #${build.id} by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: { build_id: build.id, deploy_service_id: service.id },
      message: '构建并部署已触发',
    });
  } catch (err) {
    logger.error(`Build and deploy failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `触发构建并部署失败: ${err.message}` });
  }
});

module.exports = router;
