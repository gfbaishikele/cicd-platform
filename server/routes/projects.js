const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { createProjectRules, validate } = require('../middleware/validator');
const BuildService = require('../services/build.service');
const DeployService = require('../services/deploy.service');
const logger = require('../utils/logger');

// 将 group_ids 解析为节点 ID 列表（与 node_ids 合并去重）
function resolveNodeIds(raw_node_ids, group_ids) {
  const result = new Set(Array.isArray(raw_node_ids) ? raw_node_ids : []);
  if (Array.isArray(group_ids) && group_ids.length > 0) {
    const placeholders = group_ids.map(() => '?').join(',');
    const groupNodes = db.prepare(`SELECT id FROM cluster_nodes WHERE group_id IN (${placeholders})`).all(...group_ids);
    groupNodes.forEach(n => result.add(n.id));
  }
  return Array.from(result);
}

router.use(authMiddleware);

/**
 * GET /api/projects
 * 项目列表
 */
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const offset = (page - 1) * pageSize;
    const keyword = req.query.keyword || '';
    const status = req.query.status || '';
    const businessProjectId = req.query.business_project_id || '';
    const name = req.query.name || '';
    const repoPath = req.query.repo_path || '';
    const sort = req.query.sort || '';

    // 非 admin 只能看到自己是成员的项目
    const isAdmin = req.user.role === 'admin';

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (keyword) {
      whereClause += ' AND (p.name LIKE ? OR p.description LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    if (name) {
      whereClause += ' AND p.name LIKE ?';
      params.push(`%${name}%`);
    }

    if (repoPath) {
      whereClause += ' AND p.repo_path LIKE ?';
      params.push(`%${repoPath}%`);
    }

    if (status) {
      whereClause += ' AND p.status = ?';
      params.push(status);
    }

    if (businessProjectId) {
      whereClause += ' AND p.business_project_id = ?';
      params.push(businessProjectId);
    }

    if (!isAdmin) {
      whereClause += ' AND p.business_project_id IN (SELECT business_project_id FROM business_project_members WHERE user_id = ?)';
      params.push(req.user.id);
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM projects p ${whereClause}
    `).get(...params).count;

    const orderBy = sort === 'id_desc' ? 'p.id DESC' : 'p.updated_at DESC';

    const list = db.prepare(`
      SELECT p.*, gc.name as gitlab_connection_name,
        bp.name as business_project_name,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as members_count
      FROM projects p
      LEFT JOIN gitlab_connections gc ON p.gitlab_connection = gc.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      LEFT JOIN users u ON p.created_by = u.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    // 获取每个项目的最近构建、最近部署和当前用户角色
    const projectsWithBuilds = list.map(project => {
      const lastBuild = db.prepare(`
        SELECT id, status, branch, created_at FROM builds
        WHERE project_id = ? ORDER BY id DESC LIMIT 1
      `).get(project.id);

      const lastDeploy = db.prepare(`
        SELECT id, status, created_at FROM deployments
        WHERE project_id = ? ORDER BY id DESC LIMIT 1
      `).get(project.id);

      let currentUserRole = null;
      if (req.user.role === 'admin') {
        currentUserRole = 'admin';
      } else {
        const myMember = db.prepare(`
          SELECT bpm.role FROM business_project_members bpm
          WHERE bpm.business_project_id = ? AND bpm.user_id = ?
          LIMIT 1
        `).get(project.business_project_id, req.user.id);
        currentUserRole = myMember ? myMember.role : null;
      }

      return {
        ...project,
        last_build: lastBuild || null,
        last_build_status: lastBuild?.status || null,
        last_build_branch: lastBuild?.branch || null,
        last_deploy: lastDeploy || null,
        last_deploy_status: lastDeploy?.status || null,
        current_user_role: currentUserRole,
      };
    });

    res.json({
      code: 0,
      data: { list: projectsWithBuilds, total, page, pageSize },
    });
  } catch (err) {
    logger.error(`Get projects failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目列表失败' });
  }
});

/**
 * POST /api/projects
 * 创建项目
 */
router.post('/', createProjectRules, validate, (req, res) => {
  try {
    const {
      name, description, gitlab_connection_id, repo_path,
      default_branch = 'main', build_type, dockerfile_template_id,
      build_command, registry_image, registry_id, business_project_id,
      // 部署配置字段（合并自 deploy_services）
      node_ids, ports, env_vars, volumes, strategy = 'recreate',
      container_name, dockerfile_source = 'repository', image_name, image_tag, dockerfile_path = '',
    } = req.body;

    // 验证项目管理（如果提供了）
    if (business_project_id) {
      const bp = db.prepare('SELECT id FROM business_projects WHERE id = ?').get(business_project_id);
      if (!bp) {
        return res.status(400).json({ code: 40004, message: '项目管理不存在' });
      }
    }

    // 验证 GitLab 连接（如果提供了）
    if (gitlab_connection_id) {
      const conn = db.prepare('SELECT id FROM gitlab_connections WHERE id = ?').get(gitlab_connection_id);
      if (!conn) {
        return res.status(400).json({ code: 40004, message: 'GitLab 连接不存在' });
      }
    }

    // 验证 Dockerfile 模板（如果提供了）
    if (dockerfile_template_id) {
      const template = db.prepare('SELECT id FROM dockerfile_templates WHERE id = ?').get(dockerfile_template_id);
      if (!template) {
        return res.status(400).json({ code: 40004, message: 'Dockerfile 模板不存在' });
      }
    }

    // 验证远程仓库（如果提供了）
    if (registry_id) {
      const reg = db.prepare('SELECT id FROM registries WHERE id = ?').get(registry_id);
      if (!reg) {
        return res.status(400).json({ code: 40004, message: '远程仓库不存在' });
      }
    }

    const result = db.prepare(`
      INSERT INTO projects (name, description, gitlab_connection, repo_path, default_branch,
        build_type, dockerfile_template_id, build_command, registry_image, registry_id, business_project_id,
        node_ids, ports, env_vars, volumes, strategy, container_name, dockerfile_source, image_name, image_tag, dockerfile_path,
        created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, description || null, gitlab_connection_id || null, repo_path,
      default_branch, build_type, dockerfile_template_id || null,
      build_command || null, registry_image || null, registry_id || null,
      business_project_id || null,
      node_ids || null, ports || null, env_vars || null, volumes || null,
      strategy, container_name || null, dockerfile_source, image_name || null, image_tag || null, dockerfile_path,
      req.user.id
    );

    // 创建者自动成为项目 owner
    db.prepare(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)'
    ).run(result.lastInsertRowid, req.user.id, 'owner');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);

    logger.info(`Project created: ${name} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: project });
  } catch (err) {
    logger.error(`Create project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建项目失败' });
  }
});

/**
 * GET /api/projects/:id
 * 项目详情
 */
router.get('/:id', (req, res) => {
  try {
    const project = db.prepare(`
      SELECT p.*, gc.name as gitlab_connection_name, gc.url as gitlab_url,
        r.name as registry_name, r.url as registry_url,
        bp.name as business_project_name
      FROM projects p
      LEFT JOIN gitlab_connections gc ON p.gitlab_connection = gc.id
      LEFT JOIN registries r ON p.registry_id = r.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查（非 admin 需要是所属 business_project 的成员）
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ?
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '您不是该项目的成员' });
      }
    }

    // 获取成员列表
    const members = db.prepare(`
      SELECT u.id, u.id as user_id, u.username, u.email, u.avatar, pm.role
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      WHERE pm.project_id = ?
      ORDER BY pm.role DESC, u.username ASC
    `).all(req.params.id);

    // 获取模板信息
    let template = null;
    if (project.dockerfile_template_id) {
      template = db.prepare(
        'SELECT id, name, build_type FROM dockerfile_templates WHERE id = ?'
      ).get(project.dockerfile_template_id);
    }

    // 获取最近构建
    const recentBuilds = db.prepare(`
      SELECT id, branch, status, build_type, image_tag, duration, triggered_by, created_at
      FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 10
    `).all(req.params.id);

    // 获取当前用户的项目角色（通过 business_project 级联）
    let currentUserRole = null;
    if (req.user.role === 'admin') {
      currentUserRole = 'admin';
    } else {
      const myMember = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ?
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      currentUserRole = myMember ? myMember.role : null;
    }

    res.json({
      code: 0,
      data: {
        ...project,
        dockerfile_template: template,
        members,
        recent_builds: recentBuilds,
        current_user_role: currentUserRole,
      },
    });
  } catch (err) {
    logger.error(`Get project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目详情失败' });
  }
});

/**
 * PUT /api/projects/:id
 * 更新项目
 */
router.put('/:id', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查（需要 business_project 的 owner 角色）
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ? AND bpm.role = 'owner'
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '需要项目管理 Owner 权限' });
      }
    }

    const allowed = [
      'name', 'description', 'gitlab_connection', 'repo_path', 'default_branch',
      'build_type', 'dockerfile_template_id', 'build_command', 'registry_image', 'registry_id', 'business_project_id', 'status',
      // 部署配置字段
      'node_ids', 'ports', 'env_vars', 'volumes', 'strategy', 'container_name',
      'dockerfile_source', 'image_name', 'image_tag', 'dockerfile_path',
    ];
    const updates = [];
    const params = [];

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (updates.length > 0) {
      updates.push(`updated_at = (datetime('now', 'localtime'))`);
      params.push(req.params.id);
      db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);

    logger.info(`Project ${req.params.id} updated by ${req.user.username}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新项目失败' });
  }
});

/**
 * DELETE /api/projects/:id
 * 删除项目
 */
router.delete('/:id', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查（需要 business_project 的 owner 角色）
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ? AND bpm.role = 'owner'
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '需要项目管理 Owner 权限' });
      }
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);

    logger.info(`Project ${req.params.id} (${project.name}) deleted by ${req.user.username}`);

    res.json({ code: 0, message: '项目已删除' });
  } catch (err) {
    logger.error(`Delete project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除项目失败' });
  }
});

// ============ 项目成员管理 ============

/**
 * POST /api/projects/:id/members
 * 添加项目成员
 */
router.post('/:id/members', (req, res) => {
  try {
    // 权限检查：需要 business_project 的 owner 角色
    if (req.user.role !== 'admin') {
      const project = db.prepare('SELECT business_project_id FROM projects WHERE id = ?').get(req.params.id);
      if (!project) {
        return res.status(404).json({ code: 40004, message: '项目不存在' });
      }
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ? AND bpm.role = 'owner'
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '需要项目管理 Owner 权限' });
      }
    }

    const { user_id, role = 'viewer' } = req.body;

    if (!['owner', 'developer', 'viewer'].includes(role)) {
      return res.status(400).json({ code: 40003, message: '角色无效' });
    }

    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(user_id);
    if (!user) {
      return res.status(404).json({ code: 40004, message: '用户不存在' });
    }

    const existing = db.prepare(
      'SELECT id FROM project_members WHERE project_id = ? AND user_id = ?'
    ).get(req.params.id, user_id);

    if (existing) {
      return res.status(400).json({ code: 40005, message: '该用户已是项目成员' });
    }

    db.prepare(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)'
    ).run(req.params.id, user_id, role);

    logger.info(`User ${user.username} added to project ${req.params.id} as ${role}`);

    res.status(201).json({
      code: 0,
      data: { user_id, username: user.username, role },
    });
  } catch (err) {
    logger.error(`Add member failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '添加成员失败' });
  }
});

/**
 * PUT /api/projects/:id/members/:userId
 * 更新成员角色
 */
router.put('/:id/members/:userId', (req, res) => {
  try {
    // 权限检查：需要 business_project 的 owner 角色
    if (req.user.role !== 'admin') {
      const project = db.prepare('SELECT business_project_id FROM projects WHERE id = ?').get(req.params.id);
      if (!project) {
        return res.status(404).json({ code: 40004, message: '项目不存在' });
      }
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ? AND bpm.role = 'owner'
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '需要项目管理 Owner 权限' });
      }
    }

    const { role } = req.body;

    if (!['owner', 'developer', 'viewer'].includes(role)) {
      return res.status(400).json({ code: 40003, message: '角色无效' });
    }

    const member = db.prepare(
      'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
    ).get(req.params.id, req.params.userId);

    if (!member) {
      return res.status(404).json({ code: 40004, message: '成员不存在' });
    }

    db.prepare(
      'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?'
    ).run(role, req.params.id, req.params.userId);

    res.json({ code: 0, data: { user_id: parseInt(req.params.userId), role } });
  } catch (err) {
    logger.error(`Update member failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新成员失败' });
  }
});

/**
 * DELETE /api/projects/:id/members/:userId
 * 移除成员
 */
router.delete('/:id/members/:userId', (req, res) => {
  try {
    // 权限检查：需要 business_project 的 owner 角色
    if (req.user.role !== 'admin') {
      const project = db.prepare('SELECT business_project_id FROM projects WHERE id = ?').get(req.params.id);
      if (!project) {
        return res.status(404).json({ code: 40004, message: '项目不存在' });
      }
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ? AND bpm.role = 'owner'
        LIMIT 1
      `).get(project.business_project_id, req.user.id);
      if (!member) {
        return res.status(403).json({ code: 40301, message: '需要项目管理 Owner 权限' });
      }
    }

    const member = db.prepare(
      'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?'
    ).get(req.params.id, req.params.userId);

    if (!member) {
      return res.status(404).json({ code: 40004, message: '成员不存在' });
    }

    // 不能移除最后一个 owner
    if (member.role === 'owner') {
      const ownerCount = db.prepare(
        "SELECT COUNT(*) as count FROM project_members WHERE project_id = ? AND role = 'owner'"
      ).get(req.params.id);
      if (ownerCount.count <= 1) {
        return res.status(400).json({ code: 40006, message: '不能移除最后一个 Owner' });
      }
    }

    db.prepare(
      'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
    ).run(req.params.id, req.params.userId);

    res.json({ code: 0, message: '成员已移除' });
  } catch (err) {
    logger.error(`Remove member failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '移除成员失败' });
  }
});

// ============ 项目资源绑定管理 ============

/**
 * 检查当前用户是否为项目成员（viewer+）
 * 通过 business_project_members 级联检查
 */
function requireProjectMember(req, res, projectId) {
  if (req.user.role === 'admin') return true;
  const project = db.prepare('SELECT business_project_id FROM projects WHERE id = ?').get(projectId);
  if (!project || !project.business_project_id) {
    res.status(404).json({ code: 40004, message: '项目不存在或未关联项目管理' });
    return false;
  }
  const member = db.prepare(
    'SELECT role FROM business_project_members WHERE business_project_id = ? AND user_id = ?'
  ).get(project.business_project_id, req.user.id);
  if (!member) {
    res.status(403).json({ code: 40301, message: '您不是该项目的成员' });
    return false;
  }
  return true;
}

/**
 * 检查当前用户是否为项目 owner（或 admin）
 * 通过 business_project_members 级联检查
 */
function requireProjectOwner(req, res, projectId) {
  if (req.user.role === 'admin') return true;
  const project = db.prepare('SELECT business_project_id FROM projects WHERE id = ?').get(projectId);
  if (!project || !project.business_project_id) {
    res.status(404).json({ code: 40004, message: '项目不存在或未关联项目管理' });
    return false;
  }
  const member = db.prepare(
    "SELECT role FROM business_project_members WHERE business_project_id = ? AND user_id = ? AND role = 'owner'"
  ).get(project.business_project_id, req.user.id);
  if (!member) {
    res.status(403).json({ code: 40301, message: '需要项目 Owner 权限' });
    return false;
  }
  return true;
}

// ---------- Registry 绑定 ----------

/**
 * GET /api/projects/:id/bindings/registries
 * 查看项目绑定的 Registry 列表
 */
router.get('/:id/bindings/registries', (req, res) => {
  try {
    if (!requireProjectMember(req, res, req.params.id)) return;

    const list = db.prepare(`
      SELECT r.id, r.name, r.url, r.type, r.scope, r.created_by, pr.created_at as bound_at
      FROM project_registries pr
      JOIN registries r ON r.id = pr.registry_id
      WHERE pr.project_id = ?
      ORDER BY pr.created_at ASC
    `).all(req.params.id);

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get project registries failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目 Registry 列表失败' });
  }
});

/**
 * POST /api/projects/:id/bindings/registries
 * 绑定 Registry 到项目
 */
router.post('/:id/bindings/registries', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const { registry_id } = req.body;
    if (!registry_id) {
      return res.status(400).json({ code: 40001, message: 'registry_id 不能为空' });
    }

    const registry = db.prepare('SELECT id FROM registries WHERE id = ?').get(registry_id);
    if (!registry) {
      return res.status(404).json({ code: 40004, message: 'Registry 不存在' });
    }

    const existing = db.prepare(
      'SELECT id FROM project_registries WHERE project_id = ? AND registry_id = ?'
    ).get(req.params.id, registry_id);
    if (existing) {
      return res.status(400).json({ code: 40005, message: '该 Registry 已绑定到此项目' });
    }

    db.prepare(
      'INSERT INTO project_registries (project_id, registry_id) VALUES (?, ?)'
    ).run(req.params.id, registry_id);

    logger.info(`Registry ${registry_id} bound to project ${req.params.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, message: 'Registry 已绑定' });
  } catch (err) {
    logger.error(`Bind registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '绑定 Registry 失败' });
  }
});

/**
 * DELETE /api/projects/:id/bindings/registries/:registryId
 * 解绑 Registry
 */
router.delete('/:id/bindings/registries/:registryId', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const binding = db.prepare(
      'SELECT id FROM project_registries WHERE project_id = ? AND registry_id = ?'
    ).get(req.params.id, req.params.registryId);
    if (!binding) {
      return res.status(404).json({ code: 40004, message: '绑定关系不存在' });
    }

    db.prepare(
      'DELETE FROM project_registries WHERE project_id = ? AND registry_id = ?'
    ).run(req.params.id, req.params.registryId);

    logger.info(`Registry ${req.params.registryId} unbound from project ${req.params.id} by ${req.user.username}`);

    res.json({ code: 0, message: 'Registry 已解绑' });
  } catch (err) {
    logger.error(`Unbind registry failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '解绑 Registry 失败' });
  }
});

// ---------- Node 绑定 ----------

/**
 * GET /api/projects/:id/bindings/nodes
 * 查看项目绑定的节点列表
 */
router.get('/:id/bindings/nodes', (req, res) => {
  try {
    if (!requireProjectMember(req, res, req.params.id)) return;

    const list = db.prepare(`
      SELECT cn.id, cn.name, cn.host, cn.port, cn.scope, cn.created_by, pn.created_at as bound_at
      FROM project_nodes pn
      JOIN cluster_nodes cn ON cn.id = pn.node_id
      WHERE pn.project_id = ?
      ORDER BY pn.created_at ASC
    `).all(req.params.id);

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get project nodes failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目节点列表失败' });
  }
});

/**
 * POST /api/projects/:id/bindings/nodes
 * 绑定节点到项目
 */
router.post('/:id/bindings/nodes', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const { node_id } = req.body;
    if (!node_id) {
      return res.status(400).json({ code: 40001, message: 'node_id 不能为空' });
    }

    const node = db.prepare('SELECT id FROM cluster_nodes WHERE id = ?').get(node_id);
    if (!node) {
      return res.status(404).json({ code: 40004, message: '节点不存在' });
    }

    const existing = db.prepare(
      'SELECT id FROM project_nodes WHERE project_id = ? AND node_id = ?'
    ).get(req.params.id, node_id);
    if (existing) {
      return res.status(400).json({ code: 40005, message: '该节点已绑定到此项目' });
    }

    db.prepare(
      'INSERT INTO project_nodes (project_id, node_id) VALUES (?, ?)'
    ).run(req.params.id, node_id);

    logger.info(`Node ${node_id} bound to project ${req.params.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, message: '节点已绑定' });
  } catch (err) {
    logger.error(`Bind node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '绑定节点失败' });
  }
});

/**
 * DELETE /api/projects/:id/bindings/nodes/:nodeId
 * 解绑节点
 */
router.delete('/:id/bindings/nodes/:nodeId', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const binding = db.prepare(
      'SELECT id FROM project_nodes WHERE project_id = ? AND node_id = ?'
    ).get(req.params.id, req.params.nodeId);
    if (!binding) {
      return res.status(404).json({ code: 40004, message: '绑定关系不存在' });
    }

    db.prepare(
      'DELETE FROM project_nodes WHERE project_id = ? AND node_id = ?'
    ).run(req.params.id, req.params.nodeId);

    logger.info(`Node ${req.params.nodeId} unbound from project ${req.params.id} by ${req.user.username}`);

    res.json({ code: 0, message: '节点已解绑' });
  } catch (err) {
    logger.error(`Unbind node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '解绑节点失败' });
  }
});

// ---------- DB Connection 绑定 ----------

/**
 * GET /api/projects/:id/bindings/db-connections
 * 查看项目绑定的数据库连接列表
 */
router.get('/:id/bindings/db-connections', (req, res) => {
  try {
    if (!requireProjectMember(req, res, req.params.id)) return;

    const list = db.prepare(`
      SELECT dc.id, dc.name, dc.db_type, dc.host, dc.port, dc.database, dc.scope, dc.created_by, pdc.created_at as bound_at
      FROM project_db_connections pdc
      JOIN db_connections dc ON dc.id = pdc.db_connection_id
      WHERE pdc.project_id = ?
      ORDER BY pdc.created_at ASC
    `).all(req.params.id);

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get project db connections failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目数据库连接列表失败' });
  }
});

/**
 * POST /api/projects/:id/bindings/db-connections
 * 绑定数据库连接到项目
 */
router.post('/:id/bindings/db-connections', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const { db_connection_id } = req.body;
    if (!db_connection_id) {
      return res.status(400).json({ code: 40001, message: 'db_connection_id 不能为空' });
    }

    const conn = db.prepare('SELECT id FROM db_connections WHERE id = ?').get(db_connection_id);
    if (!conn) {
      return res.status(404).json({ code: 40004, message: '数据库连接不存在' });
    }

    const existing = db.prepare(
      'SELECT id FROM project_db_connections WHERE project_id = ? AND db_connection_id = ?'
    ).get(req.params.id, db_connection_id);
    if (existing) {
      return res.status(400).json({ code: 40005, message: '该连接已绑定到此项目' });
    }

    db.prepare(
      'INSERT INTO project_db_connections (project_id, db_connection_id) VALUES (?, ?)'
    ).run(req.params.id, db_connection_id);

    logger.info(`DB connection ${db_connection_id} bound to project ${req.params.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, message: '数据库连接已绑定' });
  } catch (err) {
    logger.error(`Bind db connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '绑定数据库连接失败' });
  }
});

/**
 * DELETE /api/projects/:id/bindings/db-connections/:connectionId
 * 解绑数据库连接
 */
router.delete('/:id/bindings/db-connections/:connectionId', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const binding = db.prepare(
      'SELECT id FROM project_db_connections WHERE project_id = ? AND db_connection_id = ?'
    ).get(req.params.id, req.params.connectionId);
    if (!binding) {
      return res.status(404).json({ code: 40004, message: '绑定关系不存在' });
    }

    db.prepare(
      'DELETE FROM project_db_connections WHERE project_id = ? AND db_connection_id = ?'
    ).run(req.params.id, req.params.connectionId);

    logger.info(`DB connection ${req.params.connectionId} unbound from project ${req.params.id} by ${req.user.username}`);

    res.json({ code: 0, message: '数据库连接已解绑' });
  } catch (err) {
    logger.error(`Unbind db connection failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '解绑数据库连接失败' });
  }
});

// ---------- Template 绑定 ----------

/**
 * GET /api/projects/:id/bindings/templates
 * 查看项目绑定的模板列表
 */
router.get('/:id/bindings/templates', (req, res) => {
  try {
    if (!requireProjectMember(req, res, req.params.id)) return;

    const list = db.prepare(`
      SELECT dt.id, dt.name, dt.build_type, dt.is_system, dt.scope, dt.created_by, pt.created_at as bound_at
      FROM project_templates pt
      JOIN dockerfile_templates dt ON dt.id = pt.template_id
      WHERE pt.project_id = ?
      ORDER BY pt.created_at ASC
    `).all(req.params.id);

    res.json({ code: 0, data: list });
  } catch (err) {
    logger.error(`Get project templates failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取项目模板列表失败' });
  }
});

/**
 * POST /api/projects/:id/bindings/templates
 * 绑定模板到项目
 */
router.post('/:id/bindings/templates', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const { template_id } = req.body;
    if (!template_id) {
      return res.status(400).json({ code: 40001, message: 'template_id 不能为空' });
    }

    const template = db.prepare('SELECT id FROM dockerfile_templates WHERE id = ?').get(template_id);
    if (!template) {
      return res.status(404).json({ code: 40004, message: '模板不存在' });
    }

    const existing = db.prepare(
      'SELECT id FROM project_templates WHERE project_id = ? AND template_id = ?'
    ).get(req.params.id, template_id);
    if (existing) {
      return res.status(400).json({ code: 40005, message: '该模板已绑定到此项目' });
    }

    db.prepare(
      'INSERT INTO project_templates (project_id, template_id) VALUES (?, ?)'
    ).run(req.params.id, template_id);

    logger.info(`Template ${template_id} bound to project ${req.params.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, message: '模板已绑定' });
  } catch (err) {
    logger.error(`Bind template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '绑定模板失败' });
  }
});

/**
 * DELETE /api/projects/:id/bindings/templates/:templateId
 * 解绑模板
 */
router.delete('/:id/bindings/templates/:templateId', (req, res) => {
  try {
    if (!requireProjectOwner(req, res, req.params.id)) return;

    const binding = db.prepare(
      'SELECT id FROM project_templates WHERE project_id = ? AND template_id = ?'
    ).get(req.params.id, req.params.templateId);
    if (!binding) {
      return res.status(404).json({ code: 40004, message: '绑定关系不存在' });
    }

    db.prepare(
      'DELETE FROM project_templates WHERE project_id = ? AND template_id = ?'
    ).run(req.params.id, req.params.templateId);

    logger.info(`Template ${req.params.templateId} unbound from project ${req.params.id} by ${req.user.username}`);

    res.json({ code: 0, message: '模板已解绑' });
  } catch (err) {
    logger.error(`Unbind template failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '解绑模板失败' });
  }
});

// ============ 构建与部署（合并自 deploy_services） ============

/**
 * POST /api/projects/:id/build
 * 触发构建
 */
router.post('/:id/build', async (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ?
      `).get(project.business_project_id, req.user.id);
      if (!member || !['owner', 'developer'].includes(member.role)) {
        return res.status(403).json({ code: 40301, message: '需要开发者及以上权限' });
      }
    }

    const { branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag, params } = req.body;

    const build = await BuildService.triggerBuild({
      project_id: project.id,
      branch: branch || project.default_branch || 'main',
      params: params || {},
      triggered_by: req.user.id,
      trigger_type: 'manual',
      dockerfile_source: dockerfile_source || project.dockerfile_source || 'repository',
      dockerfile_template_id: dockerfile_template_id || project.dockerfile_template_id || null,
      dockerfile_path: dockerfile_path || project.dockerfile_path || '',
      image_name: image_name || project.image_name || '',
      image_tag: image_tag || project.image_tag || '',
    });

    logger.info(`Build #${build.id} triggered for project #${project.id} by ${req.user.username}`);

    res.status(201).json({ code: 0, data: build });
  } catch (err) {
    logger.error(`Build for project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `触发构建失败: ${err.message}` });
  }
});

/**
 * POST /api/projects/:id/deploy
 * 触发部署
 */
router.post('/:id/deploy', async (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ?
      `).get(project.business_project_id, req.user.id);
      if (!member || !['owner', 'developer'].includes(member.role)) {
        return res.status(403).json({ code: 40301, message: '需要开发者及以上权限' });
      }
    }

    const { build_id, ports: reqPorts, env_vars: reqEnvVars, volumes: reqVolumes, node_ids: reqNodeIds, group_ids: reqGroupIds, container_name: reqContainerName, strategy: reqStrategy } = req.body;

    // 校验构建记录
    const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(build_id);
    if (!build) {
      return res.status(404).json({ code: 40004, message: '构建记录不存在' });
    }
    if (build.status !== 'success') {
      return res.status(400).json({ code: 40008, message: '只能部署构建成功的版本' });
    }

    // 解析配置（优先使用请求中的覆盖值，否则使用项目默认配置）
    let node_ids;
    if (reqNodeIds !== undefined || reqGroupIds !== undefined) {
      node_ids = resolveNodeIds(reqNodeIds, reqGroupIds);
    } else {
      node_ids = JSON.parse(project.node_ids || '[]');
    }
    const ports = reqPorts !== undefined ? reqPorts : JSON.parse(project.ports || '[]');
    const env_vars = reqEnvVars !== undefined ? reqEnvVars : JSON.parse(project.env_vars || '{}');
    const volumes = reqVolumes !== undefined ? reqVolumes : JSON.parse(project.volumes || '[]');
    const strategy = reqStrategy || project.strategy || 'recreate';

    const container_name = reqContainerName || project.container_name || (project.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : `appdocker-${project.id}-app`);

    if (node_ids.length === 0) {
      return res.status(400).json({ code: 40001, message: '未配置部署节点' });
    }

    // 校验节点
    for (const nid of node_ids) {
      const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nid);
      if (!node) {
        return res.status(404).json({ code: 40004, message: `节点 ${nid} 不存在` });
      }
    }

    const deployments = await DeployService.createDeployment({
      project_id: project.id,
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

    logger.info(`Deploy triggered for project #${project.id} with build #${build_id} by ${req.user.username}`);

    res.status(201).json({
      code: 0,
      data: deployments,
      message: `已创建 ${deployments.length} 个部署任务`,
    });
  } catch (err) {
    logger.error(`Deploy for project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `部署失败: ${err.message}` });
  }
});

/**
 * POST /api/projects/:id/build-and-deploy
 * 一键构建并部署
 */
router.post('/:id/build-and-deploy', async (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ code: 40004, message: '项目不存在' });
    }

    // 权限检查
    if (req.user.role !== 'admin') {
      const member = db.prepare(`
        SELECT bpm.role FROM business_project_members bpm
        WHERE bpm.business_project_id = ? AND bpm.user_id = ?
      `).get(project.business_project_id, req.user.id);
      if (!member || !['owner', 'developer'].includes(member.role)) {
        return res.status(403).json({ code: 40301, message: '需要开发者及以上权限' });
      }
    }

    const { branch, dockerfile_source, dockerfile_template_id, dockerfile_path, image_name, image_tag, params, ports, env_vars, volumes } = req.body;

    // 触发构建
    const build = await BuildService.triggerBuild({
      project_id: project.id,
      branch: branch || project.default_branch || 'main',
      params: params || {},
      triggered_by: req.user.id,
      trigger_type: 'manual',
      dockerfile_source: dockerfile_source || project.dockerfile_source || 'repository',
      dockerfile_template_id: dockerfile_template_id || project.dockerfile_template_id || null,
      dockerfile_path: dockerfile_path || project.dockerfile_path || '',
      image_name: image_name || project.image_name || '',
      image_tag: image_tag || project.image_tag || '',
    });

    // 存储部署覆盖参数和 auto_deploy 标记，供 worker 构建完成后自动部署
    const deployOverrides = {};
    if (ports !== undefined) deployOverrides.ports = ports;
    if (env_vars !== undefined) deployOverrides.env_vars = env_vars;
    if (volumes !== undefined) deployOverrides.volumes = volumes;
    db.prepare('UPDATE builds SET auto_deploy = 1, deploy_overrides = ? WHERE id = ?')
      .run(Object.keys(deployOverrides).length > 0 ? JSON.stringify(deployOverrides) : null, build.id);

    logger.info(`Build #${build.id} triggered (build-and-deploy) for project #${project.id}`);

    // 注意：构建是异步的，实际部署会在构建完成后由 worker 触发
    // 这里返回构建信息，前端通过 WebSocket 监听状态
    res.status(201).json({
      code: 0,
      data: { build, auto_deploy: true },
      message: '构建已触发，完成后将自动部署',
    });
  } catch (err) {
    logger.error(`Build-and-deploy for project failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: `一键构建部署失败: ${err.message}` });
  }
});

module.exports = router;
