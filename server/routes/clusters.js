const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { createNodeRules, validate } = require('../middleware/validator');
const ClusterService = require('../services/cluster.service');
const logger = require('../utils/logger');

function checkNodeVisibility(req, res, node) {
  if (!node) {
    res.status(404).json({ code: 40004, message: '节点不存在' });
    return false;
  }
  if (req.user.role === 'admin') return true;
  if (node.scope === 'public' || node.created_by === req.user.id) return true;
  // 检查是否绑定到用户所属 business_project 下的项目（级联权限）
  const db = require('../db/init');
  const member = db.prepare(`
    SELECT 1 FROM project_nodes pn
    JOIN projects p ON p.id = pn.project_id
    JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
    WHERE pn.node_id = ? AND bpm.user_id = ?
    LIMIT 1
  `).get(node.id, req.user.id);
  if (member) return true;
  res.status(404).json({ code: 40004, message: '节点不存在' });
  return false;
}

function checkNodeOwnership(req, res, node) {
  if (!node) {
    res.status(404).json({ code: 40004, message: '节点不存在' });
    return false;
  }
  if (req.user.role === 'admin') return true;
  if (node.created_by === req.user.id && node.scope === 'private') return true;
  res.status(403).json({ code: 40301, message: '无权操作此节点' });
  return false;
}

router.use(authMiddleware);

/**
 * GET /api/clusters/nodes
 * 节点列表
 */
router.get('/nodes', (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    let nodes = ClusterService.getAll();
    if (keyword) {
      nodes = nodes.filter(n => (n.name || '').includes(keyword) || (n.host || '').includes(keyword));
    }
    if (req.user.role === 'admin') {
      res.json({ code: 0, data: nodes });
    } else {
      const db = require('../db/init');
      // 获取用户所属 business_project 下项目绑定的节点 ID（级联权限）
      const projectNodeIds = db.prepare(`
        SELECT DISTINCT pn.node_id FROM project_nodes pn
        JOIN projects p ON p.id = pn.project_id
        JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
        WHERE bpm.user_id = ?
      `).all(req.user.id).map(r => r.node_id);

      const filtered = nodes.filter(n =>
        n.scope === 'public' ||
        n.created_by === req.user.id ||
        projectNodeIds.includes(n.id)
      );
      res.json({ code: 0, data: filtered });
    }
  } catch (err) {
    logger.error(`Get cluster nodes failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取节点列表失败' });
  }
});

/**
 * POST /api/clusters/nodes
 * 添加节点
 */
router.post('/nodes', createNodeRules, validate, (req, res) => {
  try {
    const scope = req.body.scope || 'private';
    const created_by = req.user.id;

    const node = ClusterService.create({ ...req.body, scope, created_by });
    logger.info(`Cluster node created: ${node.name} by ${req.user.username} (scope=${scope})`);
    res.status(201).json({ code: 0, data: node });
  } catch (err) {
    logger.error(`Create cluster node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '添加节点失败' });
  }
});

/**
 * GET /api/clusters/nodes/:id
 * 节点详情
 */
router.get('/nodes/:id', (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;
    res.json({ code: 0, data: node });
  } catch (err) {
    logger.error(`Get cluster node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取节点详情失败' });
  }
});

/**
 * PUT /api/clusters/nodes/:id
 * 更新节点
 */
router.put('/nodes/:id', (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeOwnership(req, res, node)) return;

    const updated = ClusterService.update(req.params.id, req.body);
    logger.info(`Cluster node ${req.params.id} updated by ${req.user.username}`);
    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update cluster node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新节点失败' });
  }
});

/**
 * DELETE /api/clusters/nodes/:id
 * 删除节点
 */
router.delete('/nodes/:id', (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeOwnership(req, res, node)) return;

    const result = ClusterService.delete(req.params.id);
    if (!result) {
      return res.status(404).json({ code: 40004, message: '节点不存在' });
    }
    if (result.error) {
      return res.status(400).json({ code: 40006, message: result.error });
    }
    logger.info(`Cluster node ${req.params.id} deleted by ${req.user.username}`);
    res.json({ code: 0, message: '节点已删除' });
  } catch (err) {
    logger.error(`Delete cluster node failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除节点失败' });
  }
});

/**
 * POST /api/clusters/nodes/:id/check
 * 健康检查
 */
router.post('/nodes/:id/check', async (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;

    const result = await ClusterService.healthCheck(req.params.id);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Health check failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '健康检查失败' });
  }
});

/**
 * GET /api/clusters/nodes/:id/status
 * 节点状态（资源使用）
 */
router.get('/nodes/:id/status', async (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;

    const status = await ClusterService.getNodeStatus(req.params.id);
    res.json({ code: 0, data: status });
  } catch (err) {
    logger.error(`Get node status failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取节点状态失败' });
  }
});

// ========== 容器管理 ==========

/**
 * GET /api/clusters/nodes/:id/containers
 * 获取节点上的容器列表
 */
router.get('/nodes/:id/containers', async (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;

    const containers = await ClusterService.getContainers(req.params.id);
    res.json({ code: 0, data: containers });
  } catch (err) {
    logger.error(`Get containers failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: err.message || '获取容器列表失败' });
  }
});

/**
 * POST /api/clusters/nodes/:id/containers/:containerName/:action
 * 对容器执行操作（restart/stop/start/rm）
 */
router.post('/nodes/:id/containers/:containerName/:action', async (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;

    const { id, containerName, action } = req.params;
    const result = await ClusterService.containerAction(id, containerName, action);
    logger.info(`Container ${action} on node ${id}: ${containerName} by ${req.user.username}`);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Container action failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: err.message || '操作失败' });
  }
});

/**
 * GET /api/clusters/nodes/:id/containers/:containerName/logs
 * 获取容器日志
 */
router.get('/nodes/:id/containers/:containerName/logs', async (req, res) => {
  try {
    const node = ClusterService.getById(req.params.id);
    if (!checkNodeVisibility(req, res, node)) return;

    const tail = parseInt(req.query.tail, 10) || 200;
    const result = await ClusterService.getContainerLogs(req.params.id, req.params.containerName, tail);
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error(`Get container logs failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: err.message || '获取日志失败' });
  }
});

// ========== 分组管理 ==========

/**
 * GET /api/clusters/groups
 * 分组列表（含节点数量，按权限过滤）
 */
router.get('/groups', (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const groups = ClusterService.getAllGroups();
      res.json({ code: 0, data: groups });
    } else {
      // 非 admin：分组计数只统计用户可见的节点
      const db = require('../db/init');
      const groups = db.prepare(`
        SELECT cg.id, cg.name, cg.description, cg.created_at,
               COUNT(cn.id) as node_count
        FROM cluster_groups cg
        LEFT JOIN cluster_nodes cn ON cn.group_id = cg.id
          AND (cn.scope = 'public'
               OR cn.created_by = ?
               OR cn.id IN (
                 SELECT pn.node_id FROM project_nodes pn
                 JOIN projects p ON p.id = pn.project_id
                 JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
                 WHERE bpm.user_id = ?
               )
          )
        GROUP BY cg.id
        ORDER BY cg.id ASC
      `).all(req.user.id, req.user.id);
      res.json({ code: 0, data: groups });
    }
  } catch (err) {
    logger.error(`Get cluster groups failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取分组列表失败' });
  }
});

/**
 * POST /api/clusters/groups
 * 创建分组
 */
router.post('/groups', requireRole('admin'), (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ code: 40001, message: '分组名称不能为空' });
    }
    const group = ClusterService.createGroup({ name: name.trim(), description });
    logger.info(`Cluster group created: ${group.name} by ${req.user.username}`);
    res.status(201).json({ code: 0, data: group });
  } catch (err) {
    logger.error(`Create cluster group failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '创建分组失败' });
  }
});

/**
 * PUT /api/clusters/groups/:id
 * 更新分组
 */
router.put('/groups/:id', requireRole('admin'), (req, res) => {
  try {
    const group = ClusterService.getGroupById(req.params.id);
    if (!group) {
      return res.status(404).json({ code: 40004, message: '分组不存在' });
    }
    const updated = ClusterService.updateGroup(req.params.id, req.body);
    logger.info(`Cluster group ${req.params.id} updated by ${req.user.username}`);
    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update cluster group failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新分组失败' });
  }
});

/**
 * DELETE /api/clusters/groups/:id
 * 删除分组（组内节点变为未分组）
 */
router.delete('/groups/:id', requireRole('admin'), (req, res) => {
  try {
    const result = ClusterService.deleteGroup(req.params.id);
    if (!result) {
      return res.status(404).json({ code: 40004, message: '分组不存在' });
    }
    logger.info(`Cluster group ${req.params.id} deleted by ${req.user.username}`);
    res.json({ code: 0, message: '分组已删除' });
  } catch (err) {
    logger.error(`Delete cluster group failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除分组失败' });
  }
});

/**
 * GET /api/clusters/groups/:id/nodes
 * 获取分组下的节点列表
 */
router.get('/groups/:id/nodes', (req, res) => {
  try {
    const group = ClusterService.getGroupById(req.params.id);
    if (!group) {
      return res.status(404).json({ code: 40004, message: '分组不存在' });
    }
    const nodes = ClusterService.getNodesByGroup(req.params.id);
    if (req.user.role === 'admin') {
      res.json({ code: 0, data: nodes });
    } else {
      const db = require('../db/init');
      const projectNodeIds = db.prepare(`
        SELECT DISTINCT pn.node_id FROM project_nodes pn
        JOIN projects p ON p.id = pn.project_id
        JOIN business_project_members bpm ON bpm.business_project_id = p.business_project_id
        WHERE bpm.user_id = ?
      `).all(req.user.id).map(r => r.node_id);

      const filtered = nodes.filter(n =>
        n.scope === 'public' ||
        n.created_by === req.user.id ||
        projectNodeIds.includes(n.id)
      );
      res.json({ code: 0, data: filtered });
    }
  } catch (err) {
    logger.error(`Get group nodes failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取分组节点失败' });
  }
});

module.exports = router;
