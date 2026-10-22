const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const AIService = require('../services/ai.service');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt } = require('../utils/encrypt');

// 所有 AI 接口需要登录
router.use(authMiddleware);

/**
 * POST /api/ai/chat
 * AI 对话（支持多轮）
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, session_id, images } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ code: 40001, message: '消息不能为空' });
    }

    const sessionId = session_id || uuidv4();
    const result = await AIService.chat(sessionId, req.user.id, message.trim(), req, images);

    res.json({
      code: 0,
      data: result,
    });
  } catch (err) {
    logger.error(`AI chat failed: ${err.message}`);
    res.status(500).json({
      code: 50001,
      message: err.message || 'AI 对话失败',
    });
  }
});

/**
 * POST /api/ai/chat/stream
 * AI 对话（流式输出，支持实时显示思考过程）
 */
router.post('/chat/stream', async (req, res) => {
  try {
    const { message, session_id, images } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ code: 40001, message: '消息不能为空' });
    }

    const sessionId = session_id || uuidv4();
    
    // 设置 SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx 不缓冲
    
    // 调用流式 chat
    await AIService.chatStream(sessionId, req.user.id, message.trim(), req, res, images);
  } catch (err) {
    logger.error(`AI chat stream failed: ${err.message}`);
    // 发送错误事件
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/ai/conversations
 * 获取会话历史
 */
router.get('/conversations', (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.status(400).json({ code: 40001, message: '缺少 session_id' });
    }

    const messages = db.prepare(`
      SELECT id, role, content, tool_calls, created_at
      FROM ai_conversations
      WHERE session_id = ? AND user_id = ?
      ORDER BY id ASC
    `).all(sessionId, req.user.id);

    res.json({ code: 0, data: messages });
  } catch (err) {
    logger.error(`Get conversations failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取对话历史失败' });
  }
});

/**
 * GET /api/ai/config
 * 获取 AI 配置列表（支持分页和搜索）
 */
router.get('/config', (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword } = req.query;
    const offset = (page - 1) * pageSize;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (keyword) {
      whereClause += ' AND (name LIKE ? OR model LIKE ? OR provider LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM ai_config ${whereClause}`).get(...params).count;
    const list = db.prepare(`SELECT * FROM ai_config ${whereClause} ORDER BY is_default DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, Number(pageSize), Number(offset));

    // 处理 api_key：始终脱敏显示（包括 admin）
    list.forEach(config => {
      if (config.api_key) {
        try {
          const decrypted = decrypt(config.api_key);
          config.api_key = decrypted.substring(0, 8) + '****';
        } catch {
          // 如果是旧数据未加密，直接脱敏
          config.api_key = config.api_key.substring(0, 8) + '****';
        }
      }
    });

    res.json({
      code: 0,
      data: {
        list,
        total,
        page: Number(page),
        pageSize: Number(pageSize),
      },
    });
  } catch (err) {
    logger.error(`Get AI config list failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '获取 AI 配置列表失败' });
  }
});

/**
 * POST /api/ai/config
 * 新增 AI 配置（仅 admin）
 */
router.post('/config', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 40301, message: '仅管理员可管理 AI 配置' });
    }

    const {
      name, provider, base_url, api_key, model, max_tokens, timeout,
      context_window, support_image, thinking_mode, enabled,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ code: 40001, message: '配置名称不能为空' });
    }

    // 如果启用，先停用其他配置
    if (enabled) {
      db.prepare('UPDATE ai_config SET enabled = 0 WHERE enabled = 1').run();
    }

    // 加密 api_key
    const encryptedApiKey = api_key ? encrypt(api_key) : null;

    const result = db.prepare(`
      INSERT INTO ai_config (name, provider, base_url, api_key, model, max_tokens, timeout,
        context_window, support_image, thinking_mode, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      provider || 'openai',
      base_url || null,
      encryptedApiKey,
      model || null,
      max_tokens || 4096,
      timeout || 60,
      context_window || null,
      support_image ? 1 : 0,
      thinking_mode ? 1 : 0,
      enabled ? 1 : 0,
    );

    const newConfig = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(result.lastInsertRowid);
    logger.info(`AI config created by admin ${req.user.username}: ${name}`);

    res.json({ code: 0, data: newConfig });
  } catch (err) {
    logger.error(`Create AI config failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '新增 AI 配置失败' });
  }
});

/**
 * PUT /api/ai/config/:id
 * 更新 AI 配置（仅 admin）
 */
router.put('/config/:id', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 40301, message: '仅管理员可修改 AI 配置' });
    }

    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ code: 40401, message: '配置不存在' });
    }

    const {
      name, provider, base_url, api_key, model, max_tokens, timeout,
      context_window, support_image, thinking_mode, enabled,
    } = req.body;

    // 如果启用，先停用其他配置
    if (enabled && !existing.enabled) {
      db.prepare('UPDATE ai_config SET enabled = 0 WHERE enabled = 1 AND id != ?').run(id);
    }

    // 加密 api_key（如果有新值）
    const encryptedApiKey = api_key ? encrypt(api_key) : null;

    db.prepare(`
      UPDATE ai_config SET
        name = COALESCE(?, name),
        provider = COALESCE(?, provider),
        base_url = COALESCE(?, base_url),
        api_key = COALESCE(?, api_key),
        model = COALESCE(?, model),
        max_tokens = COALESCE(?, max_tokens),
        timeout = COALESCE(?, timeout),
        context_window = COALESCE(?, context_window),
        support_image = COALESCE(?, support_image),
        thinking_mode = COALESCE(?, thinking_mode),
        enabled = COALESCE(?, enabled),
        updated_at = (datetime('now', 'localtime'))
      WHERE id = ?
    `).run(
      name || null,
      provider || null,
      base_url || null,
      encryptedApiKey,
      model || null,
      max_tokens || null,
      timeout || null,
      context_window !== undefined ? context_window : null,
      support_image !== undefined ? support_image : null,
      thinking_mode !== undefined ? thinking_mode : null,
      enabled !== undefined ? enabled : null,
      id,
    );

    const updated = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(id);
    logger.info(`AI config updated by admin ${req.user.username}: id=${id}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Update AI config failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '更新 AI 配置失败' });
  }
});

/**
 * DELETE /api/ai/config/:id
 * 删除 AI 配置（仅 admin）
 */
router.delete('/config/:id', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 40301, message: '仅管理员可删除 AI 配置' });
    }

    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ code: 40401, message: '配置不存在' });
    }

    db.prepare('DELETE FROM ai_config WHERE id = ?').run(id);
    logger.info(`AI config deleted by admin ${req.user.username}: id=${id}, name=${existing.name}`);

    res.json({ code: 0, data: { success: true } });
  } catch (err) {
    logger.error(`Delete AI config failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '删除 AI 配置失败' });
  }
});

/**
 * PATCH /api/ai/config/:id/toggle
 * 启用/停用 AI 配置（仅 admin）
 * 启用时自动停用其他配置（只能有一个启用）
 */
router.patch('/config/:id/toggle', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 40301, message: '仅管理员可切换 AI 配置状态' });
    }

    const { id } = req.params;
    const { enabled } = req.body;

    if (enabled === undefined) {
      return res.status(400).json({ code: 40001, message: '缺少 enabled 参数' });
    }

    const existing = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ code: 40401, message: '配置不存在' });
    }

    // 启用时，先停用其他配置
    if (enabled) {
      db.prepare('UPDATE ai_config SET enabled = 0 WHERE enabled = 1 AND id != ?').run(id);
    }

    db.prepare('UPDATE ai_config SET enabled = ?, updated_at = (datetime(\'now\', \'localtime\')) WHERE id = ?')
      .run(enabled ? 1 : 0, id);

    const updated = db.prepare('SELECT * FROM ai_config WHERE id = ?').get(id);
    logger.info(`AI config toggled by admin ${req.user.username}: id=${id}, enabled=${enabled}`);

    res.json({ code: 0, data: updated });
  } catch (err) {
    logger.error(`Toggle AI config failed: ${err.message}`);
    res.status(500).json({ code: 50001, message: '切换配置状态失败' });
  }
});

/**
 * POST /api/ai/test
 * 测试 AI 连接（发送一条简单消息验证配置是否正确，不受启用状态限制）
 * 接收完整的配置参数，允许测试未保存的配置
 */
router.post('/test', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ code: 40301, message: '仅管理员可测试 AI 连接' });
    }

    // 从请求体获取配置（允许测试未保存的配置）
    const { provider, base_url, api_key, model, id } = req.body;

    if (!base_url || !model) {
      return res.status(400).json({ code: 40001, message: '请填写完整的配置信息（地址、模型）' });
    }

    // 处理 API Key：如果是脱敏值或为空，从数据库获取真实值
    let actualApiKey = api_key;
    if (id && (!api_key || api_key.includes('****'))) {
      // 编辑模式且未填写新 Key，从数据库获取加密的 Key
      const config = db.prepare('SELECT api_key FROM ai_config WHERE id = ?').get(id);
      if (config && config.api_key) {
        try {
          actualApiKey = decrypt(config.api_key);
        } catch (err) {
          logger.error('Failed to decrypt API key for test:', err);
          return res.status(400).json({ code: 40002, message: '无法解密 API Key，请重新输入' });
        }
      }
    }

    // 自定义模式不需要 api_key，其他模式需要
    if (!actualApiKey && provider !== 'custom') {
      return res.status(400).json({ code: 40001, message: '请填写 API Key' });
    }

    // 使用请求体的配置创建临时 provider
    const config = {
      provider: provider || 'openai',
      base_url,
      api_key: actualApiKey,
      model,
    };

    const { OpenAIProvider, AnthropicProvider, CustomProvider } = require('../services/llm.provider');
    let providerInstance;

    switch (config.provider) {
      case 'openai':
        providerInstance = new OpenAIProvider(config);
        break;
      case 'anthropic':
        providerInstance = new AnthropicProvider(config);
        break;
      case 'custom':
      case 'deepseek':
      case 'qwen':
      case 'ollama':
        // DeepSeek/Qwen/Ollama 都使用 OpenAI 兼容接口，统一用 CustomProvider
        providerInstance = new CustomProvider(config);
        break;
      default:
        return res.status(400).json({ code: 40001, message: `不支持的接入模式: ${config.provider}` });
    }

    const result = await providerInstance.chat([{ role: 'user', content: '你好，请回复"连接成功"' }]);

    res.json({
      code: 0,
      data: { success: true, reply: result.content, model: config.model },
    });
  } catch (err) {
    logger.error(`AI test failed: ${err.message}`);
    res.status(500).json({
      code: 50001,
      message: `AI 连接测试失败: ${err.message}`,
    });
  }
});

module.exports = router;
