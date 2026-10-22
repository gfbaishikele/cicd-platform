/**
 * 角色权限中间件工厂
 * @param  {...string} roles - 允许的角色列表
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        code: 40103,
        message: '未登录',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        code: 40301,
        message: '权限不足，需要以下角色之一: ' + roles.join(', '),
      });
    }

    next();
  };
}

/**
 * 从请求中提取项目 ID
 * 支持多种路由参数格式
 */
function extractProjectId(req) {
  return req.params.projectId || req.params.id || req.body.project_id || req.query.project_id;
}

/**
 * 查询用户在指定项目所属 business_project 中的角色
 * 权限级联：用户关联 business_project → 自动拥有其下所有 project 的权限
 * @param {number} userId
 * @param {number} projectId
 * @returns {string|null} 角色名 (owner/developer/viewer) 或 null（非成员）
 */
function getProjectRole(userId, projectId) {
  const db = require('../db/init');
  const member = db.prepare(`
    SELECT bpm.role FROM business_project_members bpm
    JOIN projects p ON p.business_project_id = bpm.business_project_id
    WHERE p.id = ? AND bpm.user_id = ?
    LIMIT 1
  `).get(projectId, userId);
  return member ? member.role : null;
}

/**
 * 项目级权限检查中间件 — 只读（viewer 及以上）
 * 任何项目成员都可以访问，admin 自动放行
 */
function requireProjectAccess() {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next();

    const projectId = extractProjectId(req);
    if (!projectId) {
      return res.status(400).json({ code: 40003, message: '缺少项目 ID' });
    }

    const projectRole = getProjectRole(req.user.id, projectId);
    if (!projectRole) {
      return res.status(403).json({ code: 40301, message: '您不是该项目的成员' });
    }

    req.projectRole = projectRole;
    next();
  };
}

/**
 * 项目级权限检查中间件 — 可写（developer 及以上）
 * owner / developer 可执行 CRUD 操作，viewer 拒绝
 */
function requireProjectWrite() {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      req.projectRole = 'admin';
      return next();
    }

    const projectId = extractProjectId(req);
    if (!projectId) {
      return res.status(400).json({ code: 40003, message: '缺少项目 ID' });
    }

    const projectRole = getProjectRole(req.user.id, projectId);
    if (!projectRole) {
      return res.status(403).json({ code: 40301, message: '您不是该项目的成员' });
    }

    if (!['owner', 'developer'].includes(projectRole)) {
      return res.status(403).json({ code: 40301, message: '项目权限不足，需要 developer 及以上角色' });
    }

    req.projectRole = projectRole;
    next();
  };
}

/**
 * 项目级权限检查中间件 — 管理（owner 及以上）
 * 项目设置、成员管理、资源绑定等管理操作
 */
function requireProjectManage() {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      req.projectRole = 'admin';
      return next();
    }

    const projectId = extractProjectId(req);
    if (!projectId) {
      return res.status(400).json({ code: 40003, message: '缺少项目 ID' });
    }

    const projectRole = getProjectRole(req.user.id, projectId);
    if (!projectRole) {
      return res.status(403).json({ code: 40301, message: '您不是该项目的成员' });
    }

    if (projectRole !== 'owner') {
      return res.status(403).json({ code: 40301, message: '项目权限不足，需要 owner 角色' });
    }

    req.projectRole = projectRole;
    next();
  };
}

/**
 * 项目级权限检查辅助函数（非中间件版本）
 * 用于 builds/deployments 等路由（:id 不是项目 ID，无法直接用中间件）
 * @param {number} userId - 用户 ID
 * @param {string} userRole - 用户全局角色
 * @param {number} projectId - 项目 ID
 * @param {string} minRole - 最低要求角色: 'viewer' | 'developer' | 'owner'
 * @returns {{ ok: boolean, member: boolean, projectRole?: string, message?: string }}
 */
function checkProjectAccess(userId, userRole, projectId, minRole = 'viewer') {
  if (userRole === 'admin') return { ok: true, member: true, projectRole: 'admin' };

  const projectRole = getProjectRole(userId, projectId);
  if (!projectRole) {
    return { ok: false, member: false, message: '您不是该项目的成员' };
  }

  const roleHierarchy = { viewer: 0, developer: 1, owner: 2 };
  if (roleHierarchy[projectRole] < roleHierarchy[minRole]) {
    return { ok: false, member: true, projectRole, message: '项目权限不足' };
  }

  return { ok: true, member: true, projectRole };
}

/**
 * 构建资源可见性 SQL 过滤条件
 * 用于 registries / cluster_nodes / db_connections / dockerfile_templates 等列表查询
 *
 * 规则：
 * - admin: 看到所有资源
 * - 普通用户: 看到 scope='public' 的 + 自己创建的 scope='private' 的
 *
 * @param {number} userId - 当前用户 ID
 * @param {string} userRole - 当前用户全局角色
 * @param {string} tableAlias - 表别名（如 'r' 表示 registries r）
 * @returns {string} SQL WHERE 子句片段（不含 WHERE 关键字）
 */
function buildResourceVisibilityFilter(userId, userRole, tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : '';

  if (userRole === 'admin') {
    return '1=1';
  }

  return `(${prefix}scope = 'public' OR ${prefix}created_by = ${userId})`;
}

/**
 * 从构建 ID 获取项目 ID
 */
function getProjectIdFromBuild(buildId) {
  const db = require('../db/init');
  const build = db.prepare('SELECT project_id FROM builds WHERE id = ?').get(buildId);
  return build ? build.project_id : null;
}

/**
 * 从部署 ID 获取项目 ID
 */
function getProjectIdFromDeployment(deploymentId) {
  const db = require('../db/init');
  const deployment = db.prepare('SELECT project_id FROM deployments WHERE id = ?').get(deploymentId);
  return deployment ? deployment.project_id : null;
}

/**
 * 获取用户可见的 business_project ID 列表
 * admin 返回 null（表示不过滤），普通用户返回其所加入的 business_project ID 数组
 * @param {number} userId
 * @param {string} userRole
 * @returns {number[]|null}
 */
function getUserProjectIds(userId, userRole) {
  if (userRole === 'admin') return null;
  const db = require('../db/init');
  const rows = db.prepare(
    'SELECT business_project_id FROM business_project_members WHERE user_id = ?'
  ).all(userId);
  return rows.map(r => r.business_project_id);
}

module.exports = {
  requireRole,
  requireProjectAccess,
  requireProjectWrite,
  requireProjectManage,
  checkProjectAccess,
  buildResourceVisibilityFilter,
  getProjectRole,
  getUserProjectIds,
  getProjectIdFromBuild,
  getProjectIdFromDeployment,
};
