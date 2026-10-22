const db = require('../db/init');
const ClusterService = require('./cluster.service');
const logger = require('../utils/logger');

// 存储正在运行的部署进程
const runningDeploys = new Map();

/**
 * 多节点部署引擎
 * 支持从远程 Registry 拉取镜像，支持 recreate / rolling 两种部署策略
 */
class DeployService {
  /**
   * 写入部署日志
   */
  static appendLog(deploymentId, line) {
    const current = db.prepare('SELECT log FROM deployments WHERE id = ?').get(deploymentId);
    const newLog = (current?.log || '') + line;
    db.prepare('UPDATE deployments SET log = ? WHERE id = ?').run(newLog, deploymentId);

    // Socket.IO 推送
    try {
      const io = require('../index').io;
      if (io) {
        io.to(`deploy:${deploymentId}`).emit('deploy-log', {
          deploymentId,
          line,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // ignore if io not available
    }
  }

  /**
   * 发送状态事件
   */
  static emitStatus(deploymentId, status, duration) {
    try {
      const io = require('../index').io;
      if (io) io.to(`deploy:${deploymentId}`).emit('deploy-status', { deploymentId, status, duration });
    } catch {}
  }

  /**
   * 获取项目的远程仓库配置
   */
  static getRegistryForProject(projectId) {
    const project = db.prepare('SELECT registry_id FROM projects WHERE id = ?').get(projectId);
    if (!project?.registry_id) return null;
    const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(project.registry_id);
    if (registry?.password) {
      const { decrypt } = require('../utils/encrypt');
      registry.password = decrypt(registry.password);
    }
    return registry;
  }

  /**
   * 构建 docker run 命令
   */
  static buildDockerRunCmd(deployment, containerName) {
    const ports = JSON.parse(deployment.ports || '[]');
    const envVars = JSON.parse(deployment.env_vars || '{}');
    const volumes = JSON.parse(deployment.volumes || '[]');

    // 防御性处理：containerName 为空时生成默认名，避免 --name 吃掉后面的参数
    if (!containerName || !containerName.trim()) {
      containerName = `appdocker-${deployment.project_id}-${Date.now()}`;
    }

    let cmd = `docker run -d --name ${containerName} --restart=unless-stopped`;

    // 打标签，用于精确识别和清理旧容器
    if (deployment.deploy_service_id) {
      cmd += ` --label appdocker.service_id=${deployment.deploy_service_id}`;
    }
    cmd += ` --label appdocker.project_id=${deployment.project_id}`;

    for (const p of ports) {
      cmd += ` -p ${p.host}:${p.container}`;
    }

    // 默认时区，用户可通过环境变量覆盖
    cmd += ` -e TZ='Asia/Shanghai'`;

    for (const [key, value] of Object.entries(envVars)) {
      // 使用单引号包裹值，防止 shell 特殊字符破坏命令解析
      const safeValue = String(value).replace(/'/g, "'\\''");
      cmd += ` -e ${key}='${safeValue}'`;
    }

    for (const v of volumes) {
      cmd += ` -v ${v.host}:${v.container}`;
    }

    cmd += ` ${deployment.image_tag}`;
    return cmd;
  }

  /**
   * 创建部署（支持多节点）
   */
  static async createDeployment({
    project_id, build_id, node_ids, image_tag,
    container_name, ports, env_vars, volumes, strategy = 'recreate',
    deployed_by, deploy_service_id,
  }) {
    const deployments = [];

    for (const node_id of node_ids) {
      const result = db.prepare(`
        INSERT INTO deployments (project_id, build_id, node_id, image_tag, container_name,
          ports, env_vars, volumes, status, deployed_by, deploy_service_id, strategy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        project_id, build_id, node_id, image_tag, container_name,
        JSON.stringify(ports || []),
        JSON.stringify(env_vars || {}),
        JSON.stringify(volumes || []),
        deployed_by,
        deploy_service_id || null,
        strategy
      );

      deployments.push(db.prepare('SELECT * FROM deployments WHERE id = ?').get(result.lastInsertRowid));
    }

    // 异步执行部署
    for (const deployment of deployments) {
      this.executeDeployment(deployment.id, strategy).catch(err => {
        logger.error(`Deployment ${deployment.id} failed: ${err.message}`);
      });
    }

    return deployments;
  }

  /**
   * 在目标节点上拉取镜像
   */
  static async pullImage(node, registry, imageTag, emitLog) {
    // 如果有 Registry 配置，先 docker login
    if (registry && registry.username && registry.password) {
      // 提取 registry 域名（从 image tag 或 registry url）
      let registryUrl = registry.url.replace(/\/$/, '').replace(/^https?:\/\//, '');
      emitLog(`登录远程仓库: ${registryUrl}\n`);

      const loginCmd = `docker login ${registryUrl} -u '${registry.username}' -p '${registry.password.replace(/'/g, "'\\''")}'`;
      const loginResult = await ClusterService.sshExec(node, loginCmd);

      if (loginResult.code !== 0) {
        throw new Error(`docker login 失败: ${loginResult.stderr}`);
      }
      emitLog(`仓库登录成功\n`);
    }

    // docker pull
    emitLog(`拉取镜像: ${imageTag}\n`);
    const pullResult = await ClusterService.sshExec(node, `docker pull ${imageTag}`);

    if (pullResult.code !== 0) {
      throw new Error(`docker pull 失败: ${pullResult.stderr}`);
    }
    emitLog(`镜像拉取完成\n`);

    // pull 输出通常很长，只记录最后几行
    const pullLines = pullResult.stdout.split('\n');
    const lastLines = pullLines.slice(-3).join('\n');
    emitLog(`${lastLines}\n\n`);
  }

  /**
   * 健康检查：检查容器是否 running
   */
  static async healthCheck(node, containerName) {
    const result = await ClusterService.sshExec(node,
      `docker inspect --format '{{.State.Status}} {{.State.Running}}' ${containerName}`
    );
    return result.stdout.includes('running');
  }

  /**
   * 按名称清理旧容器：精确匹配容器名，存在则 stop + rm
   */
  static async removeContainerByName(node, containerName, emitLog) {
    const checkResult = await ClusterService.sshExec(node,
      `docker ps -a --filter "name=^${containerName}$" --format '{{.Names}}'`
    );
    if (checkResult.stdout.trim() === containerName) {
      emitLog(`清理同名旧容器: ${containerName}\n`);
      await ClusterService.sshExec(node,
        `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`
      );
      return true;
    }
    return false;
  }

  /**
   * 执行部署
   */
  static async executeDeployment(deploymentId, strategy = 'recreate') {
    const startTime = Date.now();
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId);
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(deployment.node_id);

    if (!deployment || !node) {
      throw new Error('Deployment or node not found');
    }

    // 获取 Registry 配置
    const registry = this.getRegistryForProject(deployment.project_id);

    // 更新状态
    db.prepare("UPDATE deployments SET status = 'deploying', started_at = (datetime('now', 'localtime')) WHERE id = ?").run(deploymentId);
    runningDeploys.set(deploymentId, { cancelling: false });

    const emitLog = (line) => this.appendLog(deploymentId, line);
    const isCancelled = () => runningDeploys.get(deploymentId)?.cancelling || false;

    try {
      emitLog(`[DEPLOY START] Node: ${node.name} (${node.host})\n`);
      emitLog(`Image: ${deployment.image_tag}\n`);
      emitLog(`Container: ${deployment.container_name}\n`);
      emitLog(`Strategy: ${strategy}\n`);
      if (registry) {
        emitLog(`Registry: ${registry.name} (${registry.url})\n`);
      }
      emitLog('\n');

      // ===== Step 1: 拉取镜像 =====
      const totalSteps = strategy === 'rolling' ? 5 : 4;
      emitLog(`[STEP 1/${totalSteps}] 拉取镜像...\n`);

      if (registry) {
        await this.pullImage(node, registry, deployment.image_tag, emitLog);
      } else {
        emitLog(`未配置远程仓库，尝试直接拉取: ${deployment.image_tag}\n`);
        const pullResult = await ClusterService.sshExec(node, `docker pull ${deployment.image_tag}`);
        if (pullResult.code !== 0) {
          emitLog(`[WARN] 镜像拉取失败，将使用本地已有镜像: ${pullResult.stderr}\n`);
        } else {
          emitLog(`镜像拉取完成\n\n`);
        }
      }

      if (isCancelled()) throw new Error('部署已取消');

      if (strategy === 'rolling') {
        // ===== 滚动更新策略 =====
        // Step 2: 启动新容器（临时名称）
        const tempName = `${deployment.container_name}-new-${Date.now()}`;
        emitLog(`\n[STEP 2/${totalSteps}] 启动新容器 (${tempName})...\n`);
        const runCmd = this.buildDockerRunCmd(deployment, tempName);
        const runResult = await ClusterService.sshExec(node, runCmd);
        if (runResult.code !== 0) {
          throw new Error(`启动新容器失败: ${runResult.stderr}`);
        }
        emitLog(`新容器已启动: ${runResult.stdout.substring(0, 12)}...\n\n`);

        if (isCancelled()) {
          emitLog(`[CANCEL] 部署已取消，清理新容器...\n`);
          await ClusterService.sshExec(node, `docker stop ${tempName} 2>/dev/null; docker rm ${tempName} 2>/dev/null`);
          throw new Error('部署已取消');
        }

        // Step 3: 健康检查新容器
        emitLog(`[STEP 3/${totalSteps}] 健康检查新容器...\n`);
        const newContainerOk = await this.healthCheck(node, tempName);
        if (!newContainerOk) {
          emitLog(`新容器未正常运行，回滚清理...\n`);
          await ClusterService.sshExec(node, `docker stop ${tempName} 2>/dev/null; docker rm ${tempName} 2>/dev/null`);
          throw new Error('新容器启动后健康检查失败');
        }
        emitLog(`新容器运行正常\n\n`);

        // Step 4: 切换（停旧容器 → 重命名新容器）
        emitLog(`[STEP 4/${totalSteps}] 切换: 清理旧容器并重命名...\n`);
        await this.removeContainerByName(node, deployment.container_name, emitLog);

        const renameResult = await ClusterService.sshExec(node,
          `docker rename ${tempName} ${deployment.container_name}`
        );
        if (renameResult.code !== 0) {
          throw new Error(`容器重命名失败: ${renameResult.stderr}`);
        }
        emitLog(`容器切换完成\n\n`);

        // Step 5: 最终健康检查
        emitLog(`[STEP 5/${totalSteps}] 最终健康检查...\n`);
      } else {
        // ===== 重建策略 (recreate) =====
        // Step 2: 按名称清理旧容器
        emitLog(`\n[STEP 2/${totalSteps}] 清理旧容器...\n`);
        await this.removeContainerByName(node, deployment.container_name, emitLog);

        if (isCancelled()) throw new Error('部署已取消');

        // Step 3: 启动新容器
        emitLog(`[STEP 3/${totalSteps}] 启动新容器...\n`);
        const runCmd = this.buildDockerRunCmd(deployment, deployment.container_name);
        const runResult = await ClusterService.sshExec(node, runCmd);
        if (runResult.code !== 0) {
          throw new Error(`docker run 失败: ${runResult.stderr}`);
        }
        emitLog(`容器已启动: ${runResult.stdout.substring(0, 12)}...\n\n`);

        // Step 4: 健康检查
        emitLog(`[STEP 4/${totalSteps}] 健康检查...\n`);
      }

      // 最终健康检查
      const isRunning = await this.healthCheck(node, deployment.container_name);
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (isRunning) {
        // 清理旧镜像（可选，保留最近 3 个版本）
        emitLog(`\n清理悬空镜像...\n`);
        await ClusterService.sshExec(node, 'docker image prune -f 2>/dev/null || true');

        db.prepare(`
          UPDATE deployments SET status = 'success', duration = ?, finished_at = (datetime('now', 'localtime')) WHERE id = ?
        `).run(duration, deploymentId);
        emitLog(`\n[DEPLOY SUCCESS] Duration: ${duration}s\n`);
        this.emitStatus(deploymentId, 'success', duration);
        logger.info(`Deployment ${deploymentId} succeeded on node ${node.name}`);
      } else {
        throw new Error('容器未处于 running 状态');
      }

    } catch (err) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      const isCancel = err.message === '部署已取消';
      const finalStatus = isCancel ? 'cancelled' : 'failed';

      db.prepare(`
        UPDATE deployments SET status = ?, duration = ?, finished_at = (datetime('now', 'localtime')) WHERE id = ?
      `).run(finalStatus, duration, deploymentId);

      // 部署失败/取消时也清理悬空镜像
      try {
        await ClusterService.sshExec(node, 'docker image prune -f 2>/dev/null || true');
      } catch { /* 忽略 */ }

      if (isCancel) {
        emitLog(`\n[DEPLOY CANCELLED] Duration: ${duration}s\n`);
      } else {
        emitLog(`\n[DEPLOY FAILED] ${err.message}\n`);
      }

      this.emitStatus(deploymentId, finalStatus, duration);
      logger.error(`Deployment ${deploymentId} ${finalStatus}: ${err.message}`);
    } finally {
      runningDeploys.delete(deploymentId);
    }
  }

  /**
   * 取消部署
   */
  static cancelDeployment(deploymentId) {
    const deploy = runningDeploys.get(deploymentId);
    if (!deploy) {
      return false;
    }
    deploy.cancelling = true;
    logger.info(`Deployment ${deploymentId} cancel requested`);
    return true;
  }

  /**
   * 回滚部署
   */
  static async rollback(deploymentId, targetBuildId) {
    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId);
    if (!deployment) throw new Error('部署不存在');

    // 查找上一个成功的部署（或指定的目标版本）
    let targetDeploy;
    if (targetBuildId) {
      targetDeploy = db.prepare(`
        SELECT * FROM deployments
        WHERE project_id = ? AND node_id = ? AND build_id = ? AND status = 'success'
        ORDER BY id DESC LIMIT 1
      `).get(deployment.project_id, deployment.node_id, targetBuildId);
    } else {
      targetDeploy = db.prepare(`
        SELECT * FROM deployments
        WHERE project_id = ? AND node_id = ? AND status = 'success' AND id < ?
        ORDER BY id DESC LIMIT 1
      `).get(deployment.project_id, deployment.node_id, deploymentId);
    }

    if (!targetDeploy) {
      throw new Error('找不到可回滚的版本');
    }

    // 创建新的部署记录
    const result = db.prepare(`
      INSERT INTO deployments (project_id, build_id, node_id, image_tag, container_name,
        ports, env_vars, volumes, status, deployed_by, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'recreate')
    `).run(
      targetDeploy.project_id, targetDeploy.build_id, targetDeploy.node_id,
      targetDeploy.image_tag, targetDeploy.container_name,
      targetDeploy.ports, targetDeploy.env_vars, targetDeploy.volumes,
      deployment.deployed_by
    );

    const newDeployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(result.lastInsertRowid);

    // 标记原部署为 rolled_back
    db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE id = ?").run(deploymentId);

    // 执行回滚部署
    this.executeDeployment(newDeployment.id, 'recreate').catch(err => {
      logger.error(`Rollback deployment ${newDeployment.id} failed: ${err.message}`);
    });

    return newDeployment;
  }

  /**
   * 获取部署列表
   */
  static getList({ page = 1, pageSize = 20, project_id, node_id, status, deploy_service_id, business_project_id, allowedProjectIds, allowedBusinessProjectIds } = {}) {
    const offset = (page - 1) * pageSize;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (project_id) { whereClause += ' AND d.project_id = ?'; params.push(project_id); }
    if (node_id) { whereClause += ' AND d.node_id = ?'; params.push(node_id); }
    if (status) { whereClause += ' AND d.status = ?'; params.push(status); }
    if (deploy_service_id) { whereClause += ' AND d.deploy_service_id = ?'; params.push(deploy_service_id); }
    if (business_project_id) { whereClause += ' AND p.business_project_id = ?'; params.push(business_project_id); }
    if (allowedProjectIds !== null && allowedProjectIds !== undefined) {
      if (allowedProjectIds.length === 0) {
        return { list: [], total: 0, page, pageSize };
      }
      whereClause += ` AND d.project_id IN (${allowedProjectIds.map(() => '?').join(',')})`;
      params.push(...allowedProjectIds);
    }
    if (allowedBusinessProjectIds !== null && allowedBusinessProjectIds !== undefined) {
      if (allowedBusinessProjectIds.length === 0) {
        return { list: [], total: 0, page, pageSize };
      }
      whereClause += ` AND d.project_id IN (SELECT id FROM projects WHERE business_project_id IN (${allowedBusinessProjectIds.map(() => '?').join(',')}))`;
      params.push(...allowedBusinessProjectIds);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM deployments d LEFT JOIN projects p ON d.project_id = p.id ${whereClause}`).get(...params).count;

    const list = db.prepare(`
      SELECT d.*, p.name as project_name, bp.name as business_project_name, cn.name as node_name, u.name as deployed_by_name,
             ds.name as deploy_service_name
      FROM deployments d
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN business_projects bp ON p.business_project_id = bp.id
      LEFT JOIN cluster_nodes cn ON d.node_id = cn.id
      LEFT JOIN users u ON d.deployed_by = u.id
      LEFT JOIN deploy_services ds ON d.deploy_service_id = ds.id
      ${whereClause}
      ORDER BY d.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    return { list, total, page, pageSize };
  }

  /**
   * 获取部署详情
   */
  static getById(id) {
    return db.prepare(`
      SELECT d.*, p.name as project_name, cn.name as node_name, cn.host as node_host,
        u.name as deployed_by_name
      FROM deployments d
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN cluster_nodes cn ON d.node_id = cn.id
      LEFT JOIN users u ON d.deployed_by = u.id
      WHERE d.id = ?
    `).get(id);
  }
}

module.exports = DeployService;
