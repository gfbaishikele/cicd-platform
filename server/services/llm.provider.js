const axios = require('axios');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/encrypt');

/**
 * LLM 模型适配层
 * 支持 OpenAI / Anthropic / 自定义 三种接入模式
 * 统一输出格式：{ content, toolCalls, usage }
 */
class LLMProvider {
  /**
   * 从 DB 读取 AI 配置并创建对应的 provider 实例
   * @param {boolean} skipEnabledCheck - 是否跳过启用状态检查（测试连接时使用）
   */
  static async create(skipEnabledCheck = false) {
    const db = require('../db/init');

    let config;
    if (skipEnabledCheck) {
      // 测试连接时使用第一条配置（不检查启用状态）
      config = db.prepare('SELECT * FROM ai_config ORDER BY id ASC LIMIT 1').get();
    } else {
      // 正常使用已启用的配置（只能有一个启用）
      config = db.prepare('SELECT * FROM ai_config WHERE enabled = 1 LIMIT 1').get();

      if (!config) {
        throw new Error('没有已启用的 AI 配置，请先在系统设置中启用 AI 模型');
      }
    }

    if (!config) {
      throw new Error('AI 配置不存在，请先配置 AI 模型');
    }

    // 解密 api_key
    if (config.api_key) {
      // 检查是否是加密格式（iv:tag:encrypted）
      const parts = config.api_key.split(':');
      if (parts.length === 3) {
        // 是加密格式，尝试解密
        try {
          config.api_key = decrypt(config.api_key);
        } catch (err) {
          logger.error(`[LLM] Failed to decrypt API key: ${err.message}`);
          throw new Error('API Key 解密失败，请重新配置');
        }
      }
      // 如果不是加密格式（3段冒号分隔），保持原样（旧数据未加密）
    }

    if (!config.api_key && config.provider !== 'custom') {
      throw new Error('AI API Key 未配置');
    }

    if (!config.base_url) {
      throw new Error('AI API Endpoint 未配置');
    }

    if (!config.model) {
      throw new Error('AI 模型名称未配置');
    }

    switch (config.provider) {
      case 'openai':
        return new OpenAIProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'custom':
      case 'deepseek':
      case 'qwen':
      case 'ollama':
        // DeepSeek/Qwen/Ollama 都使用 OpenAI 兼容接口，统一用 CustomProvider
        return new CustomProvider(config);
      default:
        throw new Error(`不支持的 AI 接入模式: ${config.provider}`);
    }
  }

  /**
   * 统一调用接口
   * @param {Array} messages - [{ role: 'system'|'user'|'assistant', content: string }]
   * @param {Object} options - { tools?, maxTokens?, temperature? }
   * @returns {{ content: string, toolCalls: Array|null, usage: Object }}
   */
  async chat(messages, options = {}) {
    throw new Error('子类必须实现 chat() 方法');
  }
}

// ============ OpenAI 模式 ============

class OpenAIProvider extends LLMProvider {
  constructor(config) {
    super();
    this.config = config;
    this.client = axios.create({
      baseURL: config.base_url.replace(/\/+$/, ''),
      timeout: (config.timeout || 60) * 1000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
      },
    });
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens || this.config.max_tokens || 4096,
      temperature: options.temperature ?? 0.7,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    logger.info(`[LLM] OpenAI chat: model=${this.config.model}, messages=${messages.length}`);

    const resp = await this.client.post('/chat/completions', body);
    const choice = resp.data.choices?.[0];

    if (!choice) {
      throw new Error('LLM 返回空响应');
    }

    const message = choice.message || {};
    // 保持原始的 tool_calls 格式，方便后续直接用于消息历史
    const toolCalls = message.tool_calls || null;

    return {
      content: message.content || '',
      toolCalls,
      usage: resp.data.usage || {},
    };
  }
}

// ============ Anthropic 模式 ============

class AnthropicProvider extends LLMProvider {
  constructor(config) {
    super();
    this.config = config;
    this.client = axios.create({
      baseURL: (config.base_url || 'https://api.anthropic.com').replace(/\/+$/, ''),
      timeout: (config.timeout || 60) * 1000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.api_key,
        'anthropic-version': '2023-06-01',
      },
    });
  }

  async chat(messages, options = {}) {
    // Anthropic 不支持 system 角色，需单独提取
    let systemPrompt = '';
    const anthropicMessages = messages.filter(m => {
      if (m.role === 'system') {
        systemPrompt += m.content + '\n';
        return false;
      }
      return true;
    });

    // 转换 tool_calls 角色为 Anthropic 格式
    const convertedMessages = [];
    for (const msg of anthropicMessages) {
      if (msg.role === 'tool') {
        // Anthropic 用 user 角色携带 tool 结果
        convertedMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Anthropic assistant 消息带 tool_use
        const content = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        convertedMessages.push({ role: 'assistant', content });
      } else {
        convertedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body = {
      model: this.config.model,
      messages: convertedMessages,
      max_tokens: options.maxTokens || this.config.max_tokens || 4096,
      system: systemPrompt.trim() || undefined,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    logger.info(`[LLM] Anthropic chat: model=${this.config.model}, messages=${messages.length}`);

    const resp = await this.client.post('/v1/messages', body);
    const data = resp.data;

    // 提取文本内容
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const content = textBlocks.join('\n');

    // 提取 tool_use 并转换为 OpenAI 兼容格式
    const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
    const toolCalls = toolUseBlocks.length > 0
      ? toolUseBlocks.map(tu => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        }))
      : null;

    return {
      content,
      toolCalls,
      usage: data.usage || {},
    };
  }
}

// ============ 自定义模式（OpenAI 兼容格式） ============

class CustomProvider extends LLMProvider {
  constructor(config) {
    super();
    this.config = config;
    this.client = axios.create({
      baseURL: config.base_url.replace(/\/+$/, ''),
      timeout: (config.timeout || 60) * 1000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {}),
      },
    });
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens || this.config.max_tokens || 4096,
      temperature: options.temperature ?? 0.7,
    };

    // 如果启用了思考模式，添加 thinking 参数（DeepSeek API 格式）
    if (this.config.thinking_mode) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = 'high';
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    logger.info(`[LLM] Custom chat: endpoint=${this.config.base_url}, model=${this.config.model}, thinking=${!!this.config.thinking_mode}`);

    try {
      const resp = await this.client.post('/chat/completions', body);
      const choice = resp.data.choices?.[0];

      if (!choice) {
        throw new Error('LLM 返回空响应');
      }

      const message = choice.message || {};
      // 保持原始的 tool_calls 格式，方便后续直接用于消息历史
      const toolCalls = message.tool_calls || null;

      // 捕获推理思考内容（如 DeepSeek 的 reasoning_content）
      const reasoning = message.reasoning_content || '';
      
      // 调试日志：记录是否收到 reasoning
      if (this.config.thinking_mode) {
        logger.info(`[LLM] Response received - reasoning length: ${reasoning.length}, has reasoning: ${!!reasoning}`);
        if (!reasoning) {
          logger.warn(`[LLM] Thinking mode enabled but no reasoning_content returned. Message keys: ${Object.keys(message).join(', ')}`);
        }
      }

      return {
        content: message.content || '',
        reasoning,
        toolCalls,
        usage: resp.data.usage || {},
      };
    } catch (err) {
      // 详细记录 API 错误信息
      if (err.response) {
        logger.error(`[LLM] API error: status=${err.response.status}, data=${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * 流式对话（支持实时显示思考过程）
   * @param {Array} messages - 消息列表
   * @param {Object} options - 选项（tools, onChunk 回调等）
   * @param {Function} onChunk - 每收到一个 chunk 时的回调 (chunk) => void
   */
  async chatStream(messages, options = {}, onChunk) {
    const body = {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens || this.config.max_tokens || 4096,
      temperature: options.temperature ?? 0.7,
      stream: true, // 启用流式输出
    };

    // 如果启用了思考模式，添加 thinking 参数
    if (this.config.thinking_mode) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = 'high';
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    logger.info(`[LLM] Custom chat stream: endpoint=${this.config.base_url}, model=${this.config.model}, thinking=${!!this.config.thinking_mode}, hasApiKey=${!!this.config.api_key}`);

    try {
      const resp = await this.client.post('/chat/completions', body, {
        responseType: 'stream',
      });

      let buffer = '';
      let finalContent = '';
      let finalReasoning = '';
      let finalToolCalls = null;

      // 处理流式数据
      return new Promise((resolve, reject) => {
        resp.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后一个不完整的行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta || {};
                
                // 收集内容
                if (delta.content) {
                  finalContent += delta.content;
                }
                if (delta.reasoning_content) {
                  finalReasoning += delta.reasoning_content;
                }
                if (delta.tool_calls) {
                  if (!finalToolCalls) {
                    finalToolCalls = delta.tool_calls;
                  } else {
                    // 流式 tool_calls 累积
                    for (let i = 0; i < delta.tool_calls.length; i++) {
                      if (!finalToolCalls[i]) {
                        finalToolCalls[i] = delta.tool_calls[i];
                      } else {
                        if (delta.tool_calls[i].id) finalToolCalls[i].id = delta.tool_calls[i].id;
                        if (delta.tool_calls[i].type) finalToolCalls[i].type = delta.tool_calls[i].type;
                        if (delta.tool_calls[i].function?.name) finalToolCalls[i].function.name = delta.tool_calls[i].function.name;
                        // arguments 拼接（增量模式）
                        if (delta.tool_calls[i].function?.arguments) {
                          if (!finalToolCalls[i].function.arguments) {
                            finalToolCalls[i].function.arguments = '';
                          }
                          finalToolCalls[i].function.arguments += delta.tool_calls[i].function.arguments;
                        }
                      }
                    }
                  }
                  // 调试日志：记录每个 chunk 的 tool_calls
                  logger.debug(`[LLM] Stream chunk tool_calls: ${JSON.stringify(delta.tool_calls)}`);
                }

                // 回调给前端
                if (onChunk) {
                  onChunk({
                    type: 'chunk',
                    content: delta.content || '',
                    reasoning: delta.reasoning_content || '',
                    tool_calls: delta.tool_calls || null,
                  });
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        });

        resp.data.on('end', () => {
          // 验证 tool_calls 的 arguments 是否为合法 JSON
          if (finalToolCalls) {
            finalToolCalls.forEach((tc, i) => {
              if (tc.function?.arguments) {
                try {
                  JSON.parse(tc.function.arguments);
                  logger.debug(`[LLM] Tool call ${i} arguments valid: ${tc.function.arguments}`);
                } catch (e) {
                  logger.error(`[LLM] Tool call ${i} arguments invalid: ${tc.function.arguments}`);
                }
              }
            });
          }
          resolve({
            content: finalContent,
            reasoning: finalReasoning,
            toolCalls: finalToolCalls,
          });
        });

        resp.data.on('error', (err) => {
          reject(err);
        });
      });
    } catch (err) {
      if (err.response) {
        // 读取完整的错误响应体
        let errorBody = '';
        if (err.response.data) {
          if (typeof err.response.data === 'string') {
            errorBody = err.response.data;
          } else if (err.response.data.on) {
            // 如果是 stream，读取内容
            errorBody = await new Promise((resolve) => {
              let data = '';
              err.response.data.on('data', chunk => data += chunk);
              err.response.data.on('end', () => resolve(data));
            });
          } else {
            errorBody = JSON.stringify(err.response.data);
          }
        }
        logger.error(`[LLM] Stream API error: status=${err.response.status}, body=${errorBody}`);
        logger.error(`[LLM] Request body keys: ${Object.keys(body || {}).join(', ')}`);
        if (body.messages) {
          logger.error(`[LLM] Messages count: ${body.messages.length}`);
          body.messages.forEach((m, i) => {
            logger.error(`[LLM] Message ${i}: role=${m.role}, has_content=${!!m.content}, has_reasoning=${!!m.reasoning_content}, has_tool_calls=${!!m.tool_calls}`);
          });
        }
      }
      throw err;
    }
  }
}

module.exports = {
  LLMProvider,
  OpenAIProvider,
  AnthropicProvider,
  CustomProvider,
};
