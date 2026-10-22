const db = require('../db/init');
const { LLMProvider } = require('./llm.provider');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `你是 appdocker CI/CD 平台的 AI 运维助手。你可以帮用户：
1. 查询：构建记录、部署记录、容器状态、节点信息、项目列表等
2. 操作：触发构建、触发部署、一键构建部署、新建应用、新建项目管理分组

请用简洁的中文回答。如果需要查询数据，使用提供的工具获取信息后再回答。
执行操作前，先确认关键参数（如项目ID、分支、节点等），必要时先查询再操作。
不要编造数据，如果工具返回为空，如实告知用户。`;

/**
 * Tool 注册表
 * 每个 tool 包含：name, description, parameters(JSON Schema), execute(req, args)
 */
const TOOLS = [
  {
    name: 'query_builds',
    description: '查询构建记录列表，可按项目ID、状态、分支筛选',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID（可选）' },
        status: { type: 'string', enum: ['pending', 'building', 'success', 'failed', 'cancelled'], description: '构建状态（可选）' },
        branch: { type: 'string', description: '分支名（可选）' },
        limit: { type: 'integer', description: '返回条数，默认5', default: 5 },
      },
    },
    async execute(req, args) {
      const limit = args.limit || 5;
      let where = 'WHERE 1=1';
      const params = [];

      if (args.project_id) {
        where += ' AND b.project_id = ?';
        params.push(args.project_id);
      }
      if (args.status) {
        where += ' AND b.status = ?';
        params.push(args.status);
      }
      if (args.branch) {
        where += ' AND b.branch = ?';
        params.push(args.branch);
      }

      const list = db.prepare(`
        SELECT b.id, b.project_id, p.name as project_name, bp.name as business_project_name,
               b.branch, b.status, b.created_at
        FROM builds b
        LEFT JOIN projects p ON b.project_id = p.id
        LEFT JOIN business_projects bp ON p.business_project_id = bp.id
        ${where}
        ORDER BY b.id DESC
        LIMIT ?
      `).all(...params, limit);

      return list.map(b => ({
        id: b.id,
        project: b.business_project_name || b.project_name || `项目${b.project_id}`,
        branch: b.branch,
        status: b.status,
        time: b.created_at,
      }));
    },
  },
  {
    name: 'query_build_logs',
    description: '获取指定构建的日志内容',
    parameters: {
      type: 'object',
      properties: {
        build_id: { type: 'integer', description: '构建ID' },
      },
      required: ['build_id'],
    },
    async execute(req, args) {
      const logPath = db.prepare('SELECT log_path FROM builds WHERE id = ?').get(args.build_id)?.log_path;
      if (!logPath) return { error: '未找到构建日志' };

      const fs = require('fs');
      const path = require('path');
      const fullPath = path.resolve(__dirname, '..', logPath);

      if (!fs.existsSync(fullPath)) return { error: '日志文件不存在' };

      const content = fs.readFileSync(fullPath, 'utf-8');
      // 只返回最后 200 行
      const lines = content.split('\n');
      const tail = lines.slice(-200).join('\n');
      return { build_id: args.build_id, total_lines: lines.length, last_200_lines: tail };
    },
  },
  {
    name: 'query_deployments',
    description: '查询部署记录列表，可按项目ID、状态筛选',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID（可选）' },
        status: { type: 'string', enum: ['pending', 'deploying', 'success', 'failed', 'rolled_back'], description: '部署状态（可选）' },
        limit: { type: 'integer', description: '返回条数，默认5', default: 5 },
      },
    },
    async execute(req, args) {
      const limit = args.limit || 5;
      let where = 'WHERE 1=1';
      const params = [];

      if (args.project_id) {
        where += ' AND d.project_id = ?';
        params.push(args.project_id);
      }
      if (args.status) {
        where += ' AND d.status = ?';
        params.push(args.status);
      }

      const list = db.prepare(`
        SELECT d.id, d.project_id, p.name as project_name, bp.name as business_project_name,
               d.status, d.image_tag, d.node_id, cn.name as node_name, d.created_at
        FROM deployments d
        LEFT JOIN projects p ON d.project_id = p.id
        LEFT JOIN business_projects bp ON p.business_project_id = bp.id
        LEFT JOIN cluster_nodes cn ON d.node_id = cn.id
        ${where}
        ORDER BY d.id DESC
        LIMIT ?
      `).all(...params, limit);

      return list.map(d => ({
        id: d.id,
        project: d.business_project_name || d.project_name || `项目${d.project_id}`,
        status: d.status,
        image_tag: d.image_tag,
        node: d.node_name || `节点${d.node_id}`,
        time: d.created_at,
      }));
    },
  },
  {
    name: 'query_nodes',
    description: '查询集群节点列表及状态',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(req) {
      const nodes = db.prepare(`
        SELECT cn.id, cn.name, cn.host, cn.status, cn.labels, cn.last_check,
               cg.name as group_name
        FROM cluster_nodes cn
        LEFT JOIN cluster_groups cg ON cn.group_id = cg.id
        ORDER BY cn.id ASC
      `).all();

      return nodes.map(n => ({
        id: n.id,
        name: n.name,
        host: n.host,
        status: n.status,
        group: n.group_name || '未分组',
        last_check: n.last_check,
      }));
    },
  },
  {
    name: 'query_containers',
    description: '查询指定节点上的容器列表',
    parameters: {
      type: 'object',
      properties: {
        node_id: { type: 'integer', description: '节点ID' },
      },
      required: ['node_id'],
    },
    async execute(req, args) {
      const node = db.prepare('SELECT * FROM cluster_nodes WHERE id = ?').get(args.node_id);
      if (!node) return { error: '节点不存在' };

      // 通过 SSH 执行 docker ps
      const ClusterService = require('./cluster.service');
      try {
        const containers = await ClusterService.getContainers(args.node_id);
        return containers.map(c => ({
          name: c.name,
          image: c.image,
          status: c.status,
          state: c.state,
          ports: c.ports || '-',
        }));
      } catch (e) {
        return { error: `获取容器列表失败: ${e.message}` };
      }
    },
  },
  {
    name: 'list_business_projects',
    description: '列出所有项目管理分组列表，admin 可见全部，普通用户按权限过滤',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按名称关键词搜索（可选）' },
        limit: { type: 'integer', description: '返回条数，默认20', default: 20 },
      },
    },
    async execute(req, args) {
      const limit = args.limit || 20;
      let where = 'WHERE 1=1';
      const params = [];

      if (args.keyword) {
        where += ' AND bp.name LIKE ?';
        params.push(`%${args.keyword}%`);
      }

      // 权限过滤：admin 看全部，普通用户看自己创建的 + 作为成员绑定的
      if (req.user.role !== 'admin') {
        where += ` AND (
          bp.created_by = ?
          OR bp.id IN (
            SELECT business_project_id FROM business_project_members WHERE user_id = ?
          )
        )`;
        params.push(req.user.id, req.user.id);
      }

      const list = db.prepare(`
        SELECT bp.id, bp.name, bp.description, bp.created_at,
               COUNT(p.id) as project_count
        FROM business_projects bp
        LEFT JOIN projects p ON bp.id = p.business_project_id
        ${where}
        GROUP BY bp.id
        ORDER BY bp.id DESC
        LIMIT ?
      `).all(...params, limit);

      return {
        total: list.length,
        business_projects: list.map(bp => ({
          id: bp.id,
          name: bp.name,
          description: bp.description || '-',
          project_count: bp.project_count,
          created_at: bp.created_at,
        })),
      };
    },
  },
  {
    name: 'list_projects',
    description: '列出所有应用（项目）列表，admin 可见全部，普通用户按权限过滤',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按名称关键词搜索（可选）' },
        limit: { type: 'integer', description: '返回条数，默认20', default: 20 },
      },
    },
    async execute(req, args) {
      const limit = args.limit || 20;
      let where = 'WHERE 1=1';
      const params = [];

      if (args.keyword) {
        where += ' AND p.name LIKE ?';
        params.push(`%${args.keyword}%`);
      }

      // 权限过滤：admin 看全部，普通用户看自己创建的 + 绑定的
      if (req.user.role !== 'admin') {
        where += ` AND (
          p.created_by = ?
          OR p.business_project_id IN (
            SELECT business_project_id FROM business_project_members WHERE user_id = ?
          )
        )`;
        params.push(req.user.id, req.user.id);
      }

      const list = db.prepare(`
        SELECT p.id, p.name, bp.name as business_project_name, p.status, p.created_at
        FROM projects p
        LEFT JOIN business_projects bp ON p.business_project_id = bp.id
        ${where}
        ORDER BY p.id DESC
        LIMIT ?
      `).all(...params, limit);

      return {
        total: list.length,
        projects: list.map(p => ({
          id: p.id,
          name: p.name,
          business_project: p.business_project_name || '-',
          status: p.status,
          created_at: p.created_at,
        })),
      };
    },
  },
  {
    name: 'get_project_info',
    description: '获取应用（项目）的配置信息，包括构建配置、部署配置等',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID' },
        name_keyword: { type: 'string', description: '按名称关键词搜索项目（可选）' },
      },
    },
    async execute(req, args) {
      if (args.project_id) {
        const p = db.prepare(`
          SELECT p.id, p.name, p.repo_path, p.build_type, p.default_branch,
                 bp.name as business_project_name,
                 p.node_ids, p.ports, p.env_vars, p.volumes,
                 p.strategy, p.container_name, p.image_name, p.image_tag,
                 p.dockerfile_path, p.dockerfile_source, p.status
          FROM projects p
          LEFT JOIN business_projects bp ON p.business_project_id = bp.id
          WHERE p.id = ?
        `).get(args.project_id);
        if (!p) return { error: '项目不存在' };
        return p;
      }

      if (args.name_keyword) {
        const list = db.prepare(`
          SELECT p.id, p.name, bp.name as business_project_name, p.status
          FROM projects p
          LEFT JOIN business_projects bp ON p.business_project_id = bp.id
          WHERE p.name LIKE ?
          LIMIT 10
        `).all(`%${args.name_keyword}%`);
        return list;
      }

      return { error: '请提供 project_id 或 name_keyword' };
    },
  },
  {
    name: 'trigger_build',
    description: '触发项目构建。需要提供项目ID和分支名，构建会异步执行。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID' },
        branch: { type: 'string', description: 'Git分支名，如main、develop' },
        dockerfile_source: { type: 'string', enum: ['template', 'repository'], description: 'Dockerfile来源，默认repository' },
        dockerfile_path: { type: 'string', description: '仓库中Dockerfile相对路径，如docker/Dockerfile' },
        image_tag: { type: 'string', description: '自定义镜像标签，不填则自动生成' },
      },
      required: ['project_id', 'branch'],
    },
    async execute(req, args) {
      const BuildService = require('./build.service');
      try {
        const build = await BuildService.triggerBuild({
          project_id: args.project_id,
          branch: args.branch,
          triggered_by: req.user.id,
          trigger_type: 'manual',
          dockerfile_source: args.dockerfile_source || 'repository',
          dockerfile_path: args.dockerfile_path || '',
          image_tag: args.image_tag || '',
        });
        return {
          success: true,
          build_id: build.id,
          project_id: build.project_id,
          branch: build.branch,
          status: build.status,
          message: `构建已触发，构建ID: ${build.id}，分支: ${build.branch}`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
  {
    name: 'trigger_deploy',
    description: '触发项目部署。需要提供项目ID、构建ID和目标节点ID列表。构建状态必须为success。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID' },
        build_id: { type: 'integer', description: '构建ID（必须已成功）' },
        node_ids: { type: 'array', items: { type: 'integer' }, description: '目标节点ID列表' },
        image_tag: { type: 'string', description: '镜像标签，不填则使用构建时的标签' },
        container_name: { type: 'string', description: '容器名称' },
        strategy: { type: 'string', enum: ['recreate', 'rolling'], description: '部署策略，默认recreate' },
      },
      required: ['project_id', 'build_id', 'node_ids'],
    },
    async execute(req, args) {
      const DeployService = require('./deploy.service');
      try {
        const build = db.prepare('SELECT * FROM builds WHERE id = ?').get(args.build_id);
        if (!build) return { success: false, error: '构建不存在' };
        if (build.status !== 'success') return { success: false, error: `构建状态为${build.status}，只有成功的构建才能部署` };

        const deployments = await DeployService.createDeployment({
          project_id: args.project_id,
          build_id: args.build_id,
          node_ids: args.node_ids,
          image_tag: args.image_tag || build.image_tag,
          container_name: args.container_name || null,
          strategy: args.strategy || 'recreate',
          deployed_by: req.user.id,
        });
        return {
          success: true,
          deployment_ids: deployments.map(d => d.id),
          node_count: deployments.length,
          message: `部署已触发，共${deployments.length}个节点`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
  {
    name: 'build_and_deploy',
    description: '一键构建并部署。先触发构建，构建成功后自动部署到指定节点。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: '项目ID' },
        branch: { type: 'string', description: 'Git分支名，默认main' },
        node_ids: { type: 'array', items: { type: 'integer' }, description: '目标节点ID列表' },
        dockerfile_source: { type: 'string', enum: ['template', 'repository'], description: 'Dockerfile来源' },
        dockerfile_path: { type: 'string', description: 'Dockerfile相对路径' },
        image_tag: { type: 'string', description: '自定义镜像标签' },
        strategy: { type: 'string', enum: ['recreate', 'rolling'], description: '部署策略' },
      },
      required: ['project_id', 'node_ids'],
    },
    async execute(req, args) {
      const BuildService = require('./build.service');
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(args.project_id);
        if (!project) return { success: false, error: '项目不存在' };

        const branch = args.branch || project.default_branch || 'main';
        const build = await BuildService.triggerBuild({
          project_id: args.project_id,
          branch,
          triggered_by: req.user.id,
          trigger_type: 'manual',
          dockerfile_source: args.dockerfile_source || project.dockerfile_source || 'repository',
          dockerfile_path: args.dockerfile_path || project.dockerfile_path || '',
          image_tag: args.image_tag || '',
        });

        // 设置自动部署标记
        db.prepare('UPDATE builds SET auto_deploy = 1 WHERE id = ?').run(build.id);

        // 保存节点ID到构建参数，供executeBuild使用
        db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)')
          .run(build.id, 'deploy_node_ids', JSON.stringify(args.node_ids));
        if (args.strategy) {
          db.prepare('INSERT INTO build_params (build_id, key, value) VALUES (?, ?, ?)')
            .run(build.id, 'deploy_strategy', args.strategy);
        }

        return {
          success: true,
          build_id: build.id,
          branch,
          node_ids: args.node_ids,
          message: `一键构建部署已触发，构建ID: ${build.id}，构建成功后将自动部署到${args.node_ids.length}个节点`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
  {
    name: 'create_project',
    description: '新建应用（项目）。需要提供应用名称、仓库路径和构建类型。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '应用名称' },
        repo_path: { type: 'string', description: 'Git仓库路径，如group/project-name' },
        build_type: { type: 'string', enum: ['java', 'vue', 'custom'], description: '构建类型' },
        description: { type: 'string', description: '应用描述' },
        default_branch: { type: 'string', description: '默认分支，默认main' },
        business_project_id: { type: 'integer', description: '所属项目管理分组ID' },
        dockerfile_source: { type: 'string', enum: ['template', 'repository'], description: 'Dockerfile来源' },
        dockerfile_path: { type: 'string', description: 'Dockerfile相对路径' },
        node_ids: { type: 'array', items: { type: 'integer' }, description: '部署目标节点ID列表' },
        ports: { type: 'array', items: { type: 'object' }, description: '端口映射，如[{host:8080,container:80}]' },
        env_vars: { type: 'object', description: '环境变量，如{KEY: "value"}' },
        strategy: { type: 'string', enum: ['recreate', 'rolling'], description: '部署策略' },
        container_name: { type: 'string', description: '容器名称' },
      },
      required: ['name', 'repo_path', 'build_type'],
    },
    async execute(req, args) {
      try {
        // 验证项目管理分组
        if (args.business_project_id) {
          const bp = db.prepare('SELECT id FROM business_projects WHERE id = ?').get(args.business_project_id);
          if (!bp) return { success: false, error: '项目管理分组不存在' };
        }

        const result = db.prepare(`
          INSERT INTO projects (name, description, repo_path, default_branch, build_type,
            business_project_id, dockerfile_source, dockerfile_path, node_ids, ports, env_vars,
            strategy, container_name, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.name,
          args.description || null,
          args.repo_path,
          args.default_branch || 'main',
          args.build_type,
          args.business_project_id || null,
          args.dockerfile_source || 'repository',
          args.dockerfile_path || '',
          args.node_ids ? JSON.stringify(args.node_ids) : null,
          args.ports ? JSON.stringify(args.ports) : null,
          args.env_vars ? JSON.stringify(args.env_vars) : null,
          args.strategy || 'recreate',
          args.container_name || null,
          req.user.id
        );

        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);

        // 自动添加创建者为项目owner
        db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
          .run(project.id, req.user.id, 'owner');

        return {
          success: true,
          project_id: project.id,
          name: project.name,
          message: `应用「${project.name}」创建成功，ID: ${project.id}`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
  {
    name: 'create_business_project',
    description: '新建项目管理分组。用于对应用进行分组管理。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '分组名称' },
        description: { type: 'string', description: '分组描述' },
      },
      required: ['name'],
    },
    async execute(req, args) {
      try {
        const result = db.prepare(`
          INSERT INTO business_projects (name, description, created_by)
          VALUES (?, ?, ?)
        `).run(args.name, args.description || '', req.user.id);

        const bp = db.prepare('SELECT * FROM business_projects WHERE id = ?').get(result.lastInsertRowid);

        return {
          success: true,
          business_project_id: bp.id,
          name: bp.name,
          message: `项目管理分组「${bp.name}」创建成功，ID: ${bp.id}`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
];

/**
 * AI 核心服务
 */
class AIService {
  /**
   * 获取所有 Tool 的 OpenAI function 格式定义（用于发送给 LLM）
   */
  static getToolDefinitions() {
    return TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * 根据名称查找 Tool 并执行
   */
  static async executeTool(req, toolName, args) {
    const tool = TOOLS.find(t => t.name === toolName);
    if (!tool) {
      return { error: `未知工具: ${toolName}` };
    }
    try {
      const result = await tool.execute(req, args);
      logger.info(`[AI] Tool executed: ${toolName}(${JSON.stringify(args)})`);
      return result;
    } catch (e) {
      logger.error(`[AI] Tool ${toolName} failed: ${e.message}`);
      return { error: e.message };
    }
  }

  /**
   * 核心对话方法：LLM → Tool 调用 → 结果回注 → 再生成
   * @param {string} sessionId - 会话ID
   * @param {number} userId - 用户ID
   * @param {string} userMessage - 用户消息
   * @param {Object} req - Express req（供 Tool 使用）
   * @param {Array} images - 图片数组（base64 或 URL）
   * @returns {{ reply: string, actions: Array, sessionId: string }}
   */
  static async chat(sessionId, userId, userMessage, req, images = []) {
    const provider = await LLMProvider.create();

    // 加载历史对话
    const history = db.prepare(`
      SELECT role, content, tool_calls, reasoning FROM ai_conversations
      WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId);

    // 构建用户消息内容（支持文本+图片）
    let userContent;
    if (images && images.length > 0) {
      // 有图片时，content 为数组格式（OpenAI Vision 格式）
      userContent = [
        { type: 'text', text: userMessage },
        ...images.map(img => {
          if (img.startsWith('http://') || img.startsWith('https://')) {
            // URL 格式
            return { type: 'image_url', image_url: { url: img } };
          } else {
            // Base64 格式
            return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } };
          }
        }),
      ];
    } else {
      userContent = userMessage;
    }

    // 组装 messages（包含 reasoning_content 以支持思考模式多轮回传）
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(h => {
        if (h.role === 'tool') {
          const tc = JSON.parse(h.tool_calls || '{}');
          return { role: 'tool', tool_call_id: tc.id, content: h.content };
        }
        if (h.role === 'assistant' && h.tool_calls) {
          const msg = { role: 'assistant', content: h.content || '', tool_calls: JSON.parse(h.tool_calls) };
          // DeepSeek 思考模式要求回传 reasoning_content
          if (h.reasoning) {
            msg.reasoning_content = h.reasoning;
          }
          return msg;
        }
        return { role: h.role, content: h.content };
      }),
      { role: 'user', content: userContent },
    ];

    // 保存用户消息（包含图片信息）
    const userContentStr = typeof userContent === 'string' ? userContent : JSON.stringify(userContent);
    db.prepare(
      'INSERT INTO ai_conversations (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, 'user', userContentStr);

    const toolDefs = AIService.getToolDefinitions();
    const actions = [];
    const MAX_ITERATIONS = 5; // 防止无限循环

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result = await provider.chat(messages, { tools: toolDefs });

      // 保存 AI 回复（包含 reasoning 以支持思考模式多轮回传）
      const toolCallsStr = result.toolCalls ? JSON.stringify(result.toolCalls) : null;
      db.prepare(
        'INSERT INTO ai_conversations (session_id, user_id, role, content, tool_calls, reasoning) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionId, userId, 'assistant', result.content || null, toolCallsStr, result.reasoning || null);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // 没有工具调用，返回最终回复
        return {
          reply: result.content,
          reasoning: result.reasoning || '',
          actions,
          sessionId,
        };
      }

      // 有工具调用，逐个执行
      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls,
      });
      
      // 如果有 reasoning，需要回传给 API（DeepSeek 思考模式要求）
      if (result.reasoning) {
        messages[messages.length - 1].reasoning_content = result.reasoning;
      }

      for (const tc of result.toolCalls) {
        // tc 是原始 API 格式: { id, type: "function", function: { name, arguments: "string" } }
        const toolName = tc.function.name;
        const toolArgs = JSON.parse(tc.function.arguments || '{}');
        const toolResult = await AIService.executeTool(req, toolName, toolArgs);
        const toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);

        actions.push({ tool: toolName, params: toolArgs, result: toolResult });

        // 将 tool 结果注入 messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResultStr,
        });

        // 保存 tool 结果到对话历史
        db.prepare(
          'INSERT INTO ai_conversations (session_id, user_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)'
        ).run(sessionId, userId, 'tool', toolResultStr, JSON.stringify({ id: tc.id }));
      }
    }

    // 超过最大迭代次数，强制返回
    return {
      reply: '抱歉，处理过程过于复杂，请简化您的问题。',
      actions,
      sessionId,
    };
  }

  /**
   * 流式对话（支持实时显示思考过程）
   * @param {string} sessionId - 会话ID
   * @param {number} userId - 用户ID
   * @param {string} userMessage - 用户消息
   * @param {Object} req - Express req
   * @param {Object} res - Express res（用于 SSE）
   * @param {Array} images - 图片数组
   */
  static async chatStream(sessionId, userId, userMessage, req, res, images = []) {
    const provider = await LLMProvider.create();

    // 加载历史对话
    const history = db.prepare(`
      SELECT role, content, tool_calls, reasoning FROM ai_conversations
      WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId);

    // 构建用户消息内容
    let userContent;
    if (images && images.length > 0) {
      userContent = [
        { type: 'text', text: userMessage },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: img.startsWith('http') ? img : `data:image/jpeg;base64,${img}` },
        })),
      ];
    } else {
      userContent = userMessage;
    }

    // 组装 messages
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(h => {
        if (h.role === 'tool') {
          const tc = JSON.parse(h.tool_calls || '{}');
          return { role: 'tool', tool_call_id: tc.id, content: h.content };
        }
        if (h.role === 'assistant' && h.tool_calls) {
          const msg = { role: 'assistant', content: h.content || '', tool_calls: JSON.parse(h.tool_calls) };
          if (h.reasoning) msg.reasoning_content = h.reasoning;
          return msg;
        }
        return { role: h.role, content: h.content };
      }),
      { role: 'user', content: userContent },
    ];

    // 保存用户消息
    const userContentStr = typeof userContent === 'string' ? userContent : JSON.stringify(userContent);
    db.prepare('INSERT INTO ai_conversations (session_id, user_id, role, content) VALUES (?, ?, ?, ?)')
      .run(sessionId, userId, 'user', userContentStr);

    const toolDefs = AIService.getToolDefinitions();
    const actions = [];
    const MAX_ITERATIONS = 5;

    try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let fullContent = '';
      let fullReasoning = '';
      let toolCalls = null;

      // 流式调用 LLM
      const result = await provider.chatStream(messages, { tools: toolDefs }, (chunk) => {
        // 实时发送 chunk 给前端
        if (chunk.reasoning) {
          res.write(`data: ${JSON.stringify({ type: 'reasoning', content: chunk.reasoning })}\n\n`);
        }
        if (chunk.content) {
          res.write(`data: ${JSON.stringify({ type: 'content', content: chunk.content })}\n\n`);
        }
        if (chunk.tool_calls) {
          res.write(`data: ${JSON.stringify({ type: 'tool_calls', data: chunk.tool_calls })}\n\n`);
        }
      });

      fullContent = result.content;
      fullReasoning = result.reasoning;
      toolCalls = result.toolCalls;

      logger.info(`[AI Stream] Iteration ${i}: content=${fullContent?.length || 0}chars, reasoning=${fullReasoning?.length || 0}chars, toolCalls=${toolCalls?.length || 0}`);

      // 如果 content 为空但有 reasoning，使用 reasoning 的最后一行作为 content
      if (!fullContent && fullReasoning) {
        const lines = fullReasoning.split('\n').filter(l => l.trim());
        fullContent = lines.length > 0 ? lines[lines.length - 1] : '';
      }

      // 保存 AI 回复
      const toolCallsStr = toolCalls ? JSON.stringify(toolCalls) : null;
      db.prepare('INSERT INTO ai_conversations (session_id, user_id, role, content, tool_calls, reasoning) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, userId, 'assistant', fullContent || null, toolCallsStr, fullReasoning || null);

      if (!toolCalls || toolCalls.length === 0) {
        // 没有工具调用，发送完成信号
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      // 有工具调用，执行并继续
      logger.info(`[AI Stream] Tool calls received: ${JSON.stringify(toolCalls, null, 2)}`);
      messages.push({
        role: 'assistant',
        content: fullContent || '...',  // 确保 content 不为空
        tool_calls: toolCalls,
      });
      if (fullReasoning) {
        messages[messages.length - 1].reasoning_content = fullReasoning;
      }
      logger.info(`[AI Stream] Assistant message added: content="${messages[messages.length - 1].content}", reasoning_length=${messages[messages.length - 1].reasoning_content?.length || 0}, tool_calls_count=${toolCalls.length}`);

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        let toolArgs, toolResult, toolResultStr;
        try {
          toolArgs = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
          logger.error(`[AI Stream] Failed to parse tool arguments: ${tc.function.arguments}`);
          toolArgs = {};
        }
        try {
          toolResult = await AIService.executeTool(req, toolName, toolArgs);
          toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
        } catch (e) {
          logger.error(`[AI Stream] Tool execution failed: ${toolName} - ${e.message}`);
          toolResult = { error: e.message };
          toolResultStr = JSON.stringify(toolResult);
        }

        actions.push({ tool: toolName, params: toolArgs, result: toolResult });
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: toolName, result: toolResult })}\n\n`);

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultStr });
        db.prepare('INSERT INTO ai_conversations (session_id, user_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)')
          .run(sessionId, userId, 'tool', toolResultStr, JSON.stringify({ id: tc.id }));
      }

      logger.info(`[AI Stream] After tool execution, messages count: ${messages.length}, next iteration will call LLM`);
      // 详细记录每条消息的结构
      messages.forEach((msg, idx) => {
        const summary = {
          role: msg.role,
          has_content: !!msg.content,
          content_length: msg.content?.length || 0,
          has_reasoning: !!msg.reasoning_content,
          reasoning_length: msg.reasoning_content?.length || 0,
          has_tool_calls: !!msg.tool_calls,
          tool_calls_count: msg.tool_calls?.length || 0,
          tool_call_id: msg.tool_call_id || null,
        };
        logger.info(`[AI Stream] Message ${idx}: ${JSON.stringify(summary)}`);
      });
    }
    } catch (err) {
      // 流式调用或工具执行出错，关闭 SSE 并返回错误
      logger.error(`[AI Stream] Error during chat: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'AI 处理出错' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // 超过最大迭代
    res.write(`data: ${JSON.stringify({ type: 'content', content: '\n\n抱歉，处理过程过于复杂，请简化您的问题。' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
}

module.exports = AIService;
