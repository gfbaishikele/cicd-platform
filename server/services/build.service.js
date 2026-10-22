const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const config = require('../config');
const TemplateService = require('./template.service');
const logger = require('../utils/logger');

// 存储正在运行的构建进程和相关信息
const runningBuilds = new Map();

/**
 * 构建引擎
 */
class BuildService {
  /**
   * 确保目录存在
   */
  static ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 写入日志
   */
  static appendLog(buildId, line) {
    const logDir = config.build.logDir;
    this.ensureDir(logDir);
    const logPath = path.join(logDir, `${buildId}.log`);
    fs.appendFileSync(logPath, line);
  }

  /**
   * 读取构建日志
   */
  static getLog(buildId, offset = 0) {
    const logPath = path.join(config.build.logDir, `${buildId}.log`);
    if (!fs.existsSync(logPath)) {
      return { log: '', finished: false, total_length: 0 };
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const build = db.prepare('SELECT status FROM builds WHERE id = ?').get(buildId);
    const finished = build ? !['pending', 'building'].includes(build.status) : true;

    if (offset > 0) {
      return {
        log: content.substring(offset),
        finished,
        total_length: content.length,
      };
    }

    return { log: content, finished, total_length: content.length };
  }

  /**
   * 触发构建
   */
  static async triggerBuild({ project_id, branch, params = {}, triggered_by, trigger_type = 'manual', dockerfile_source = 'template', dockerfile_template_id = null, dockerfile_path = '', image_name = '', image_tag = '' }) {
    // 获取项目信息
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) throw new Error('项目不存在');

    // 获取模板（仅当来源为 template 时）
    let templateContent = '';
    if (dockerfile_source === 'template') {
      // 优先使用构建时指定的模板，否则使用项目配置的模板
      const templateId = dockerfile_template_id || project.dockerfile_template_id;
      if (templateId) {
        const template = TemplateService.getById(templateId);
        if (template) {
          // 合并模板默认变量和构建参数
          const defaultVars = {};
          if (template.variables) {
            const vars = JSON.parse(template.variables);
            vars.forEach(v => { defaultVars[v.name] = v.default || ''; });
          }
          const allVars = { ...defaultVars, ...params };
          templateContent = TemplateService.render(template.content, allVars);
        }
      }
    }

    // 生成镜像标签
    const finalImageTag = image_tag || this.generateDefaultTag(branch);

    // 生成完整镜像名称（名称:标签）
    let defaultName;
    if (project.repo_path) {
      // 从仓库路径提取最后一段作为镜像名
      defaultName = project.repo_path.split('/').pop().toLowerCase().replace(/\s+/g, '-');
    } else {
      defaultName = project.name.toLowerCase().replace(/\s+/g, '-');
    }
    // 过滤非 ASCII 字符（如中文），确保镜像名合法
    defaultName = defaultName.replace(/[^\x00-\x7F]/g, '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    if (!defaultName) {
      defaultName = `app-${project_id}`;
    }
    const fullImageName = image_name
      ? `${image_name}:${finalImageTag}`
      : `${defaultName}:${finalImageTag}`;

    // 创建构建记录
    const result = db.prepare(`
      INSERT INTO builds (project_id, branch, build_type, status, trigger_type, triggered_by)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(project_id, branch, project.build_type, trigger_type, triggered_by);

    const buildId = result.lastInsertRowid;

    // 保存构建参数
    for (const [key, value] of Object.entries(params)) {
      db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, key, value);
    }
    db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, 'dockerfile_source', dockerfile_source);
    db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, 'dockerfile_template_id', dockerfile_template_id || '');
    db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, 'dockerfile_path', dockerfile_path || '');
    db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, 'image_name', image_name);
    db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)').run(buildId, 'image_tag', finalImageTag);

    // 异步执行构建
    this.executeBuild(buildId, project, branch, templateContent, dockerfile_source, dockerfile_path, fullImageName).catch(err => {
      logger.error(`Build ${buildId} failed: ${err.message}`);
    });

    return db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId);
  }

  /**
   * 生成默认镜像标签（yymmddhhmmss 格式）
   */
  static generateDefaultTag(branch) {
    const now = new Date();
    const y = String(now.getFullYear()).slice(2);
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}${m}${d}${h}${min}${s}`;
  }

  /**
   * 执行构建
   */
  static async executeBuild(buildId, project, branch, templateContent, dockerfile_source = 'template', dockerfile_path = '', imageTag = '') {
    const startTime = Date.now();
    const workDir = path.join(config.build.workspace, `${project.id}`, `${buildId}`);
    const logFile = path.join(config.build.logDir, `${buildId}.log`);

    this.ensureDir(path.dirname(workDir));
    this.ensureDir(path.dirname(logFile));

    // 更新状态为 building
    db.prepare("UPDATE builds SET status = 'building', started_at = (datetime('now', 'localtime')) WHERE id = ?").run(buildId);

    // 存储构建信息用于取消时清理
    runningBuilds.set(buildId, { imageTag });

    const io = require('../index').io;
    const emitLog = (line) => {
      this.appendLog(buildId, line);
      if (io) {
        io.to(`build:${buildId}`).emit('build-log', { buildId, line, timestamp: new Date().toISOString() });
      }
    };

    try {
      // 获取 GitLab 连接信息用于 clone
      let repoUrl = '';
      if (project.gitlab_connection) {
        const conn = db.prepare('SELECT * FROM gitlab_connections WHERE id = ?').get(project.gitlab_connection);
        if (conn) {
          const { decrypt } = require('../utils/encrypt');
          const token = decrypt(conn.token);
          const urlObj = new URL(conn.url);
          repoUrl = `${urlObj.protocol}//oauth2:${token}@${urlObj.host}/${project.repo_path}.git`;
        }
      }

      // Step 1: Clone 代码
      emitLog(`[STEP 1/4] Cloning repository...\n`);
      emitLog(`Repository: ${project.repo_path}\n`);
      emitLog(`Branch: ${branch}\n\n`);

      if (repoUrl) {
        await this.execCommand(
          'git', ['clone', '--branch', branch, '--depth', '1', repoUrl, workDir],
          emitLog, buildId
        );
      } else {
        emitLog('[WARN] No GitLab connection, skipping git clone\n');
        this.ensureDir(workDir);
      }

      // Step 2: 处理 Dockerfile
      emitLog(`\n[STEP 2/4] Preparing Dockerfile...\n`);
      
      if (dockerfile_source === 'template') {
        // 使用模板生成 Dockerfile
        if (templateContent) {
          const dockerfilePath = path.join(workDir, 'Dockerfile');
          fs.writeFileSync(dockerfilePath, templateContent);
          emitLog(`Dockerfile generated from template and written to ${dockerfilePath}\n`);
          emitLog(`--- Dockerfile content ---\n${templateContent}\n--- End ---\n\n`);
        } else {
          emitLog(`[ERROR] No Dockerfile template configured for this project\n\n`);
          throw new Error('未配置 Dockerfile 模板');
        }
      } else if (dockerfile_source === 'repository') {
        // 使用代码仓库中的 Dockerfile
        const dockerfileRelPath = dockerfile_path || 'Dockerfile';
        const dockerfilePath = path.join(workDir, dockerfileRelPath);
        if (fs.existsSync(dockerfilePath)) {
          emitLog(`Dockerfile found: ${dockerfileRelPath}\n`);
          const content = fs.readFileSync(dockerfilePath, 'utf-8');
          emitLog(`--- Dockerfile content ---\n${content}\n--- End ---\n\n`);
        } else {
          emitLog(`[ERROR] Dockerfile not found: ${dockerfileRelPath}\n\n`);
          throw new Error(`代码仓库中未找到 Dockerfile: ${dockerfileRelPath}`);
        }
      } else {
        emitLog(`[ERROR] Invalid Dockerfile source: ${dockerfile_source}\n\n`);
        throw new Error('无效的 Dockerfile 来源');
      }

      // Step 3: Docker Build
      emitLog(`[STEP 3/4] Building Docker image...\n`);
      emitLog(`Image tag: ${imageTag}\n\n`);

      const buildArgs = ['build', '-t', imageTag, '--label', `appdocker.build_id=${buildId}`];
      // 当使用仓库 Dockerfile 且指定了路径时，用 -f 指定 Dockerfile 位置
      if (dockerfile_source === 'repository' && dockerfile_path) {
        buildArgs.push('-f', path.join(workDir, dockerfile_path));
      }
      buildArgs.push(workDir);

      await this.execCommand('docker', buildArgs, emitLog, buildId);

      // Step 4: 获取镜像信息
      emitLog(`\n[STEP 4/4] Getting image info...\n`);
      let imageSize = 0;
      try {
        const inspectResult = await this.execCommandCapture('docker', ['image', 'inspect', imageTag, '--format', '{{.Size}}']);
        imageSize = parseInt(inspectResult.trim(), 10) || 0;
        emitLog(`Image size: ${(imageSize / 1024 / 1024).toFixed(2)} MB\n`);
      } catch {
        emitLog(`[WARN] Could not get image size\n`);
      }

      // 构建成功
      const duration = Math.round((Date.now() - startTime) / 1000);
      db.prepare(`
        UPDATE builds SET status = 'success', image_tag = ?, image_size = ?, duration = ?, finished_at = (datetime('now', 'localtime'))
        WHERE id = ?
      `).run(imageTag, imageSize, duration, buildId);

      emitLog(`\n[BUILD SUCCESS] Duration: ${duration}s, Image: ${imageTag}\n`);

      // Step 5: 推送到远程仓库（如果项目配置了 registry_id）
      if (project.registry_id) {
        const registry = db.prepare('SELECT * FROM registries WHERE id = ?').get(project.registry_id);
        if (registry) {
          emitLog(`\n[STEP 5] Pushing to remote registry...\n`);
          try {
            const { decrypt } = require('../utils/encrypt');
            const registryUrl = registry.url.replace(/\/$/, '').replace(/^https?:\/\//, '');
            const remoteImage = `${registryUrl}/${imageTag}`;

            // 登录
            if (registry.username && registry.password) {
              const pwd = decrypt(registry.password);
              emitLog(`Logging in to ${registryUrl}...\n`);
              await this.execCommand('docker', ['login', registryUrl, '-u', registry.username, '-p', pwd], emitLog, buildId);
            }

            // 打标签
            emitLog(`Tagging ${imageTag} as ${remoteImage}...\n`);
            await this.execCommand('docker', ['tag', imageTag, remoteImage], emitLog, buildId);

            // 推送
            emitLog(`Pushing ${remoteImage}...\n`);
            await this.execCommand('docker', ['push', remoteImage], emitLog, buildId);

            // 登出
            if (registry.username && registry.password) {
              await this.execCommand('docker', ['logout', registryUrl], emitLog, buildId);
            }

            emitLog(`\n[PUSH SUCCESS] Image pushed to ${remoteImage}\n`);
            db.prepare('UPDATE builds SET image_tag = ? WHERE id = ?').run(remoteImage, buildId);

            // 推送成功，清理本地构建镜像（本地标签 + 远程标签，registry 同 daemon 共享存储，rmi 只删标签不删层）
            emitLog(`\n[CLEANUP] 清理本地构建镜像...\n`);
            try {
              await this.execCommand('docker', ['rmi', imageTag], emitLog, buildId);
            } catch { /* 镜像可能不存在，忽略 */ }
            try {
              await this.execCommand('docker', ['rmi', remoteImage], emitLog, buildId);
            } catch { /* 镜像可能不存在，忽略 */ }
            try {
              await this.execCommand('docker', ['image', 'prune', '-f'], emitLog, buildId);
            } catch { /* 忽略 */ }
            emitLog(`本地构建镜像已清理，远程仓库镜像保留\n`);
          } catch (pushErr) {
            emitLog(`\n[PUSH FAILED] ${pushErr.message}\n`);
            logger.error(`Build ${buildId} push failed: ${pushErr.message}`);
          }
        }
      }

      if (io) {
        io.to(`build:${buildId}`).emit('build-status', { buildId, status: 'success', duration, imageTag });
      }

      logger.info(`Build ${buildId} succeeded: ${imageTag}`);

      // ===== 自动部署（构建并部署功能） =====
      // 重新从数据库读取 image_tag，因为推送成功后已更新为远程仓库地址
      const buildRecord = db.prepare('SELECT auto_deploy, deploy_service_id, project_id, triggered_by, deploy_overrides, image_tag FROM builds WHERE id = ?').get(buildId);
      if (buildRecord?.auto_deploy) {
        try {
          emitLog(`\n[AUTO DEPLOY] 构建成功，自动触发部署...\n`);
          const DeployService = require('./deploy.service');
          // 使用数据库中的 image_tag（推送后为远程地址），而非内存中的本地标签
          const deployImageTag = buildRecord.image_tag || imageTag;
          // 优先使用构建时存储的 deploy_overrides
          const overrides = buildRecord.deploy_overrides ? JSON.parse(buildRecord.deploy_overrides) : null;

          let node_ids, ports, env_vars, volumes, strategy, container_name, projectId, deployServiceId;

          if (buildRecord.deploy_service_id) {
            // 旧模式：通过 deploy_services 表
            const service = db.prepare('SELECT * FROM deploy_services WHERE id = ?').get(buildRecord.deploy_service_id);
            if (service) {
              node_ids = JSON.parse(service.node_ids || '[]');
              ports = overrides?.ports !== undefined ? overrides.ports : JSON.parse(service.ports || '[]');
              env_vars = overrides?.env_vars !== undefined ? overrides.env_vars : JSON.parse(service.env_vars || '{}');
              volumes = overrides?.volumes !== undefined ? overrides.volumes : JSON.parse(service.volumes || '[]');
              strategy = service.strategy || 'recreate';
              projectId = service.project_id;
              deployServiceId = service.id;
              const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
              container_name = service.container_name || (project?.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : `appdocker-${projectId}-app`);
            }
          } else if (buildRecord.project_id) {
            // 新模式：直接从 projects 表读取配置
            const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(buildRecord.project_id);
            if (project) {
              node_ids = JSON.parse(project.node_ids || '[]');
              ports = overrides?.ports !== undefined ? overrides.ports : JSON.parse(project.ports || '[]');
              env_vars = overrides?.env_vars !== undefined ? overrides.env_vars : JSON.parse(project.env_vars || '{}');
              volumes = overrides?.volumes !== undefined ? overrides.volumes : JSON.parse(project.volumes || '[]');
              strategy = project.strategy || 'recreate';
              projectId = project.id;
              deployServiceId = null;
              container_name = project.container_name || (project.repo_path ? `${project.repo_path.split('/').pop().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '-')}-app` : `appdocker-${projectId}-app`);
            }
          }

          if (projectId && node_ids && node_ids.length > 0) {
            const deployParams = {
              project_id: projectId,
              build_id: buildId,
              node_ids,
              image_tag: deployImageTag,
              container_name,
              ports,
              env_vars,
              volumes,
              strategy,
              deployed_by: buildRecord.triggered_by,
            };
            if (deployServiceId) deployParams.deploy_service_id = deployServiceId;
            const deployments = await DeployService.createDeployment(deployParams);
            emitLog(`[AUTO DEPLOY] 已创建 ${deployments.length} 个部署任务\n`);
          } else {
            emitLog(`[AUTO DEPLOY] 应用未配置节点，跳过自动部署\n`);
          }
        } catch (deployErr) {
          emitLog(`[AUTO DEPLOY] 自动部署失败: ${deployErr.message}\n`);
          logger.error(`Auto deploy after build ${buildId} failed: ${deployErr.message}`);
        }
      }
    } catch (err) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      db.prepare(`
        UPDATE builds SET status = 'failed', duration = ?, finished_at = (datetime('now', 'localtime')) WHERE id = ?
      `).run(duration, buildId);

      emitLog(`\n[BUILD FAILED] ${err.message}\n`);

      // 清理失败构建产生的容器和镜像
      emitLog(`\n[CLEANUP] 清理失败构建的容器和镜像...\n`);
      try {
        // 1. 收集本次构建产生的所有镜像 ID（悬空 + build_id 标签）
        const buildImageIds = new Set();
        try {
          const danglingResult = await this.execCommandCapture('docker', ['images', '-f', 'dangling=true', '-q']);
          danglingResult.trim().split('\n').filter(id => id).forEach(id => buildImageIds.add(id));
        } catch { /* 忽略 */ }
        try {
          const labelResult = await this.execCommandCapture('docker', ['images', '-f', 'label=appdocker.build_id=' + buildId, '-q']);
          labelResult.trim().split('\n').filter(id => id).forEach(id => buildImageIds.add(id));
        } catch { /* 忽略 */ }

        // 2. 只清理引用了本次构建镜像的已退出容器
        if (buildImageIds.size > 0) {
          const containerResult = await this.execCommandCapture('docker', ['ps', '-a', '-f', 'status=exited', '--format', '{{.ID}} {{.Image}}']);
          const toRemove = containerResult.trim().split('\n')
            .filter(line => {
              const parts = line.trim().split(/\s+/);
              return parts.length >= 2 && buildImageIds.has(parts[1]);
            })
            .map(line => line.trim().split(/\s+/)[0]);
          if (toRemove.length > 0) {
            await this.execCommand('docker', ['rm', '-f', ...toRemove], emitLog, buildId);
            emitLog(`已清理 ${toRemove.length} 个构建残留容器\n`);
          }
        }

        // 3. 删除悬空镜像
        if (buildImageIds.size > 0) {
          await this.execCommand('docker', ['rmi', '-f', ...buildImageIds], emitLog, buildId);
          emitLog(`已清理 ${buildImageIds.size} 个构建镜像\n`);
        }
      } catch { /* 忽略 */ }

      if (io) {
        io.to(`build:${buildId}`).emit('build-status', { buildId, status: 'failed', duration });
      }

      logger.error(`Build ${buildId} failed: ${err.message}`);
    } finally {
      runningBuilds.delete(buildId);
    }
  }

  /**
   * 执行命令（流式输出）
   */
  static execCommand(cmd, args, onOutput, buildId) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        env: { ...process.env },
        shell: true,
      });

      if (buildId) {
        const existing = runningBuilds.get(buildId) || {};
        runningBuilds.set(buildId, { ...existing, proc });
      }

      // 超时处理
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
        reject(new Error(`Command timed out after ${config.build.timeout}s`));
      }, config.build.timeout * 1000);

      proc.stdout.on('data', (data) => {
        const line = data.toString();
        if (onOutput) onOutput(line);
      });

      proc.stderr.on('data', (data) => {
        const line = data.toString();
        if (onOutput) onOutput(line);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * 执行命令（捕获输出）
   */
  static execCommandCapture(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { shell: true });
      let output = '';

      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`Exit code ${code}: ${output}`));
      });

      proc.on('error', reject);
    });
  }

  /**
   * 取消构建
   */
  static async cancelBuild(buildId) {
    const info = runningBuilds.get(buildId);
    const proc = info?.proc;

    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    }

    const build = db.prepare("SELECT * FROM builds WHERE id = ? AND status = 'building'").get(buildId);
    if (build) {
      db.prepare("UPDATE builds SET status = 'cancelled', finished_at = (datetime('now', 'localtime')) WHERE id = ?").run(buildId);
      this.appendLog(buildId, `\n[BUILD CANCELLED] by user\n`);

      // 清理取消构建产生的容器和镜像（只清理本次构建相关的，不影响其他容器）
      this.appendLog(buildId, `\n[CLEANUP] 清理构建容器和镜像...\n`);
      try {
        const buildImageIds = new Set();
        try {
          const danglingResult = await this.execCommandCapture('docker', ['images', '-f', 'dangling=true', '-q']);
          danglingResult.trim().split('\n').filter(id => id).forEach(id => buildImageIds.add(id));
        } catch { /* 忽略 */ }
        try {
          const labelResult = await this.execCommandCapture('docker', ['images', '-f', 'label=appdocker.build_id=' + buildId, '-q']);
          labelResult.trim().split('\n').filter(id => id).forEach(id => buildImageIds.add(id));
        } catch { /* 忽略 */ }

        if (buildImageIds.size > 0) {
          const containerResult = await this.execCommandCapture('docker', ['ps', '-a', '-f', 'status=exited', '--format', '{{.ID}} {{.Image}}']);
          const toRemove = containerResult.trim().split('\n')
            .filter(line => {
              const parts = line.trim().split(/\s+/);
              return parts.length >= 2 && buildImageIds.has(parts[1]);
            })
            .map(line => line.trim().split(/\s+/)[0]);
          if (toRemove.length > 0) {
            await this.execCommand('docker', ['rm', '-f', ...toRemove], (line) => this.appendLog(buildId, line), null);
            this.appendLog(buildId, `已清理 ${toRemove.length} 个构建残留容器\n`);
          }
          await this.execCommand('docker', ['rmi', '-f', ...buildImageIds], (line) => this.appendLog(buildId, line), null);
          this.appendLog(buildId, `已清理 ${buildImageIds.size} 个构建镜像\n`);
        }
      } catch { /* 忽略 */ }
    }

    runningBuilds.delete(buildId);
    return !!build;
  }

  /**
   * 检查构建是否正在运行
   */
  static isRunning(buildId) {
    return runningBuilds.has(buildId);
  }
}

module.exports = BuildService;
