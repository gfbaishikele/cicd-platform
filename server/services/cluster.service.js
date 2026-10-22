const { Client: SSHClient } = require('ssh2');
const db = require('../db/init');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger');

/**
 * 集群节点管理服务
 */
class ClusterService {
  /**
   * 获取所有节点（含分组名称）
   */
  static getAll() {
    return db.prepare(`
      SELECT cn.id, cn.name, cn.host, cn.port, cn.username, cn.auth_type, cn.docker_host,
             cn.status, cn.labels, cn.last_check, cn.created_at, cn.scope, cn.created_by,
             cn.group_id, cg.name as group_name, u.name as created_by_name
      FROM cluster_nodes cn
      LEFT JOIN cluster_groups cg ON cn.group_id = cg.id
      LEFT JOIN users u ON cn.created_by = u.id
      ORDER BY cn.id ASC
    `).all();
  }

  /**
   * 获取节点详情（含分组名称）
   */
  static getById(id) {
    return db.prepare(`
      SELECT cn.id, cn.name, cn.host, cn.port, cn.username, cn.auth_type, cn.docker_host,
             cn.status, cn.labels, cn.last_check, cn.created_at, cn.scope, cn.created_by,
             cn.group_id, cg.name as group_name
      FROM cluster_nodes cn
      LEFT JOIN cluster_groups cg ON cn.group_id = cg.id
      WHERE cn.id = ?
    `).get(id);
  }

  /**
   * 创建节点
   */
  static create({ name, host, port = 22, username, auth_type = 'password', auth_secret, docker_host, labels, group_id, scope = 'public', created_by = null }) {
    const encryptedSecret = encrypt(auth_secret);
    const labelsJson = typeof labels === 'string' ? labels : JSON.stringify(labels || {});

    const result = db.prepare(`
      INSERT INTO cluster_nodes (name, host, port, username, auth_type, auth_secret, docker_host, labels, group_id, scope, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, host, port, username, auth_type, encryptedSecret, docker_host || 'unix:///var/run/docker.sock', labelsJson, group_id || null, scope, created_by);

    return this.getById(result.lastInsertRowid);
  }

  /**
   * 更新节点
   */
  static update(id, { name, host, port, username, auth_type, auth_secret, docker_host, labels, group_id, scope }) {
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (host !== undefined) { updates.push('host = ?'); params.push(host); }
    if (port !== undefined) { updates.push('port = ?'); params.push(port); }
    if (username !== undefined) { updates.push('username = ?'); params.push(username); }
    if (auth_type !== undefined) { updates.push('auth_type = ?'); params.push(auth_type); }
    if (auth_secret !== undefined) { updates.push('auth_secret = ?'); params.push(encrypt(auth_secret)); }
    if (docker_host !== undefined) { updates.push('docker_host = ?'); params.push(docker_host); }
    if (labels !== undefined) {
      updates.push('labels = ?');
      params.push(typeof labels === 'string' ? labels : JSON.stringify(labels));
    }
    if (group_id !== undefined) {
      updates.push('group_id = ?');
      params.push(group_id || null);
    }
    if (scope !== undefined) { updates.push('scope = ?'); params.push(scope); }

    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE cluster_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    return this.getById(id);
  }

  /**
   * 删除节点
   */
  static delete(id) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(id);
    if (!node) return null;

    // 检查是否有部署记录
    const deployCount = db.prepare('SELECT COUNT(*) as count FROM deployments WHERE node_id = ?').get(id);
    if (deployCount.count > 0) {
      return { error: `该节点有 ${deployCount.count} 条部署记录，请先清理` };
    }

    db.prepare('DELETE FROM cluster_nodes WHERE id = ?').run(id);
    return { success: true };
  }

  /**
   * SSH 执行命令
   */
  static sshExec(node, command) {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timeout'));
      }, 10000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data) => { stdout += data.toString(); });
          stream.stderr.on('data', (data) => { stderr += data.toString(); });

          stream.on('close', (code) => {
            conn.end();
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      try {
        const secret = decrypt(node.auth_secret);
        const connectConfig = {
          host: node.host,
          port: node.port,
          username: node.username,
        };

        if (node.auth_type === 'key') {
          connectConfig.privateKey = secret;
        } else {
          connectConfig.password = secret;
        }

        conn.connect(connectConfig);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * 健康检查
   */
  static async healthCheck(nodeId) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('节点不存在');

    const startTime = Date.now();
    const result = { ssh_ok: false, docker_ok: false, latency_ms: 0 };

    try {
      // 测试 SSH + Docker
      const sshResult = await this.sshExec(node, 'docker info --format "{{.ServerVersion}}"');
      result.latency_ms = Date.now() - startTime;

      if (sshResult.code === 0) {
        result.ssh_ok = true;
        result.docker_ok = true;
        result.docker_version = sshResult.stdout;
        db.prepare("UPDATE cluster_nodes SET status = 'online', last_check = (datetime('now', 'localtime')) WHERE id = ?").run(nodeId);
      } else {
        result.ssh_ok = true;
        result.docker_ok = false;
        result.error = sshResult.stderr;
        db.prepare("UPDATE cluster_nodes SET status = 'error', last_check = (datetime('now', 'localtime')) WHERE id = ?").run(nodeId);
      }
    } catch (err) {
      result.latency_ms = Date.now() - startTime;
      result.error = err.message;
      db.prepare("UPDATE cluster_nodes SET status = 'offline', last_check = (datetime('now', 'localtime')) WHERE id = ?").run(nodeId);
    }

    return result;
  }

  /**
   * 获取节点状态（资源使用）
   */
  static async getNodeStatus(nodeId) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('节点不存在');

    try {
      const result = await this.sshExec(node, `
        echo "DOCKER_VERSION=$(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo 'N/A')"
        echo "CONTAINERS=$(docker ps -q 2>/dev/null | wc -l)"
        echo "CPU=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2}' 2>/dev/null || echo 'N/A')"
        echo "MEM_TOTAL=$(free -b | awk '/Mem:/{print $2}' 2>/dev/null || echo '0')"
        echo "MEM_USED=$(free -b | awk '/Mem:/{print $3}' 2>/dev/null || echo '0')"
        echo "DISK_TOTAL=$(df -b / | awk 'NR==2{print $2}' 2>/dev/null || echo '0')"
        echo "DISK_USED=$(df -b / | awk 'NR==2{print $3}' 2>/dev/null || echo '0')"
      `);

      const parse = (key) => {
        const match = result.stdout.match(new RegExp(`${key}=(.+)`));
        return match ? match[1] : 'N/A';
      };

      return {
        online: true,
        docker_version: parse('DOCKER_VERSION'),
        containers_running: parseInt(parse('CONTAINERS'), 10) || 0,
        cpu_usage: parseFloat(parse('CPU')) || 0,
        memory_total: parseInt(parse('MEM_TOTAL'), 10) || 0,
        memory_used: parseInt(parse('MEM_USED'), 10) || 0,
        disk_total: parseInt(parse('DISK_TOTAL'), 10) || 0,
        disk_used: parseInt(parse('DISK_USED'), 10) || 0,
        checked_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        online: false,
        error: err.message,
        checked_at: new Date().toISOString(),
      };
    }
  }

  // ========== 分组管理 ==========

  /**
   * 获取所有分组（含节点数量）
   */
  static getAllGroups() {
    return db.prepare(`
      SELECT cg.id, cg.name, cg.description, cg.created_at,
             COUNT(cn.id) as node_count
      FROM cluster_groups cg
      LEFT JOIN cluster_nodes cn ON cn.group_id = cg.id
      GROUP BY cg.id
      ORDER BY cg.id ASC
    `).all();
  }

  /**
   * 获取分组详情
   */
  static getGroupById(id) {
    return db.prepare(`
      SELECT id, name, description, created_at
      FROM cluster_groups WHERE id = ?
    `).get(id);
  }

  /**
   * 创建分组
   */
  static createGroup({ name, description }) {
    const result = db.prepare(`
      INSERT INTO cluster_groups (name, description) VALUES (?, ?)
    `).run(name, description || null);
    return this.getGroupById(result.lastInsertRowid);
  }

  /**
   * 更新分组
   */
  static updateGroup(id, { name, description }) {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE cluster_groups SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return this.getGroupById(id);
  }

  /**
   * 删除分组（组内节点变为未分组）
   */
  static deleteGroup(id) {
    const group = db.prepare('SELECT * FROM cluster_groups WHERE id = ?').get(id);
    if (!group) return null;
    // 将组内节点的 group_id 置为 NULL
    db.prepare('UPDATE cluster_nodes SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM cluster_groups WHERE id = ?').run(id);
    return { success: true };
  }

  /**
   * 获取分组下的节点列表
   */
  static getNodesByGroup(groupId) {
    return db.prepare(`
      SELECT cn.id, cn.name, cn.host, cn.port, cn.username, cn.auth_type, cn.docker_host,
             cn.status, cn.labels, cn.last_check, cn.created_at, cn.scope, cn.created_by,
             cn.group_id, cg.name as group_name
      FROM cluster_nodes cn
      LEFT JOIN cluster_groups cg ON cn.group_id = cg.id
      WHERE cn.group_id = ?
      ORDER BY cn.id ASC
    `).all(groupId);
  }

  // ========== 容器管理 ==========

  /**
   * 获取节点上的所有容器列表
   */
  static async getContainers(nodeId) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('节点不存在');

    // 使用 docker ps -a --format 输出 JSON 格式
    const format = '{{json .}}';
    const result = await this.sshExec(node, `docker ps -a --format '${format}'`);

    if (result.code !== 0) {
      throw new Error(result.stderr || '获取容器列表失败');
    }

    const containers = [];
    const lines = result.stdout.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const c = JSON.parse(line);
        // 从 Status 字段推导状态（Status 如 "Up 2 hours" 或 "Exited (0) 3 hours ago"）
        const statusText = c.Status || '';
        let state = 'unknown';
        if (statusText.toLowerCase().startsWith('up')) {
          state = 'running';
        } else if (statusText.toLowerCase().startsWith('exited')) {
          state = 'exited';
        } else if (statusText.toLowerCase().startsWith('created')) {
          state = 'created';
        } else if (statusText.toLowerCase().startsWith('paused')) {
          state = 'paused';
        } else if (statusText.toLowerCase().startsWith('restarting')) {
          state = 'restarting';
        } else if (statusText.toLowerCase().startsWith('dead')) {
          state = 'dead';
        }

        containers.push({
          id: c.ID,
          name: c.Names,
          image: c.Image,
          status: statusText,
          state,
          ports: c.Ports || '',
          created: c.CreatedAt || '',
          labels: c.Labels || '',
        });
      } catch {
        // 跳过解析失败的行
      }
    }

    return containers;
  }

  /**
   * 对容器执行操作（restart/stop/start/rm）
   */
  static async containerAction(nodeId, containerName, action) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('节点不存在');

    const validActions = ['restart', 'stop', 'start', 'rm'];
    if (!validActions.includes(action)) {
      throw new Error(`不支持的操作: ${action}`);
    }

    // rm 操作需要先 stop 再 rm
    if (action === 'rm') {
      await this.sshExec(node, `docker stop ${containerName}`);
      const rmResult = await this.sshExec(node, `docker rm ${containerName}`);
      if (rmResult.code !== 0) {
        throw new Error(rmResult.stderr || '删除容器失败');
      }
      return { success: true, message: '容器已删除' };
    }

    const result = await this.sshExec(node, `docker ${action} ${containerName}`);
    if (result.code !== 0) {
      throw new Error(result.stderr || `容器${action}失败`);
    }

    const actionLabels = { restart: '重启', stop: '停止', start: '启动' };
    return { success: true, message: `容器已${actionLabels[action] || action}` };
  }

  /**
   * 获取容器日志
   */
  static async getContainerLogs(nodeId, containerName, tail = 200) {
    const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error('节点不存在');

    const result = await this.sshExec(node, `docker logs --tail ${tail} ${containerName} 2>&1`);
    // docker logs 输出到 stderr，所以合并 stdout + stderr
    const logs = result.stdout || result.stderr || '';
    return { logs, total_lines: logs ? logs.split('\n').length : 0 };
  }
}

module.exports = ClusterService;
