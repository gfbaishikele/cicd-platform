const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');

/**
 * 远程 Docker Registry 管理服务
 * 实现 Docker Registry HTTP API V2
 * 支持 htpasswd (Basic) 和 token (Bearer) 认证的挑战-响应流程
 */
class RegistryService {
  /**
   * 创建 axios 实例（不带认证）
   */
  static createClient(registry) {
    return axios.create({
      baseURL: registry.url.replace(/\/$/, ''),
      timeout: 30000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: registry.verify_ssl !== 0,
      }),
    });
  }

  /**
   * 处理认证挑战，获取认证头
   * Docker Registry V2 认证流程：
   * 1. 请求 /v2/ → 收到 401 + Www-Authenticate 头
   * 2. 解析 Www-Authenticate，根据方案（Basic/Bearer）构造 Authorization 头
   * 3. 带 Authorization 头再次请求 /v2/ 验证
   */
  static async getAuthHeaders(registry) {
    if (!registry.username || !registry.password) {
      logger.info('[Registry] 未配置用户名或密码，跳过认证');
      return null;
    }

    const baseURL = registry.url.replace(/\/$/, '');
    logger.info(`[Registry] 开始认证流程: url=${baseURL}, user=${registry.username}`);

    const client = this.createClient(registry);

    // 第一步：发起无认证请求，获取 401 挑战
    let wwwAuth;
    try {
      logger.info('[Registry] 第一步: 请求 /v2/ (无认证)');
      await client.get('/v2/');
      logger.info('[Registry] /v2/ 直接返回 200，无需认证');
      return null;
    } catch (err) {
      logger.info(`[Registry] /v2/ 返回状态码: ${err.response?.status}`);
      if (err.response?.status !== 401) {
        throw new Error(`Registry 连接失败 (HTTP ${err.response?.status || 'unknown'}): ${err.message}`);
      }
      wwwAuth = err.response.headers['www-authenticate'];
      logger.info(`[Registry] Www-Authenticate: ${wwwAuth}`);
      if (!wwwAuth) {
        throw new Error('Registry 返回 401 但未提供 Www-Authenticate 头');
      }
    }

    // 第二步：解析挑战并构造认证头
    let headers = {};
    const scheme = wwwAuth.split(' ')[0].toLowerCase();
    logger.info(`[Registry] 认证方案: ${scheme}`);

    if (scheme === 'basic') {
      const encoded = Buffer.from(`${registry.username}:${registry.password}`).toString('base64');
      headers = { Authorization: `Basic ${encoded}` };
      logger.info('[Registry] 已构造 Basic 认证头');
    } else if (scheme === 'bearer') {
      const params = {};
      const regex = /(\w+)="?([^",]+)"?/g;
      let match;
      while ((match = regex.exec(wwwAuth)) !== null) {
        params[match[1].toLowerCase()] = match[2];
      }
      logger.info(`[Registry] Bearer 参数: ${JSON.stringify(params)}`);

      if (!params.realm) {
        throw new Error('Bearer 挑战缺少 realm 参数');
      }

      const tokenUrl = new URL(params.realm);
      if (params.service) tokenUrl.searchParams.set('service', params.service);
      if (params.scope) tokenUrl.searchParams.set('scope', params.scope);
      logger.info(`[Registry] 请求 token: ${tokenUrl.toString()}`);

      let tokenResponse;
      try {
        tokenResponse = await axios.get(tokenUrl.toString(), {
          auth: { username: registry.username, password: registry.password },
          timeout: 15000,
          httpsAgent: new https.Agent({
            rejectUnauthorized: registry.verify_ssl !== 0,
          }),
        });
      } catch (tokenErr) {
        logger.error(`[Registry] Token 请求失败: ${tokenErr.response?.status} ${tokenErr.message}`);
        throw new Error('认证失败，请检查用户名和密码');
      }

      const token = tokenResponse.data?.token || tokenResponse.data?.access_token;
      if (!token) {
        throw new Error('Token 响应中未找到 token 字段');
      }
      headers = { Authorization: `Bearer ${token}` };
    } else {
      throw new Error(`不支持的认证方案: ${scheme}`);
    }

    // 第三步：用认证头验证 /v2/
    logger.info('[Registry] 第三步: 带认证头验证 /v2/');
    try {
      await client.get('/v2/', { headers });
      logger.info('[Registry] 认证成功');
      return headers;
    } catch (err) {
      logger.error(`[Registry] 认证验证失败: status=${err.response?.status}, data=${JSON.stringify(err.response?.data)}`);
      if (err.response?.status === 401) {
        throw new Error('认证失败，用户名或密码不正确');
      }
      throw err;
    }
  }

  /**
   * 创建已认证的客户端
   * 先完成挑战-响应认证，再返回带拦截器的 axios 实例
   */
  static async createAuthenticatedClient(registry) {
    const authHeaders = await this.getAuthHeaders(registry);
    const client = this.createClient(registry);

    if (authHeaders) {
      client.interceptors.request.use((config) => {
        Object.assign(config.headers, authHeaders);
        return config;
      });
    }

    return client;
  }

  /**
   * 测试 Registry 连接
   */
  static async testConnection(registry) {
    try {
      const client = await this.createAuthenticatedClient(registry);
      const response = await client.get('/v2/');

      return {
        success: true,
        version: response.headers['docker-distribution-api-version'] || 'unknown',
      };
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : '';
      logger.error(`[Registry] testConnection failed: ${err.message} ${detail}`);
      return {
        success: false,
        error: err.message || '连接失败',
      };
    }
  }

  /**
   * 获取镜像列表
   */
  static async listImages(registry) {
    try {
      const client = await this.createAuthenticatedClient(registry);
      const response = await client.get('/v2/_catalog');

      const repositories = response.data.repositories || [];

      // 获取每个镜像的标签信息
      const images = await Promise.all(
        repositories.map(async (name) => {
          try {
            const tagsResponse = await client.get(`/v2/${name}/tags/list`);
            const tags = tagsResponse.data.tags || [];

            // 获取最新标签的 manifest 信息
            let latestTag = null;
            if (tags.length > 0) {
              const latestTagName = tags[tags.length - 1];
              try {
                const manifestResponse = await client.get(
                  `/v2/${name}/manifests/${latestTagName}`,
                  {
                    headers: {
                      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
                    },
                  }
                );
                const layers = manifestResponse.data?.layers || [];
                const totalSize = layers.reduce((sum, layer) => sum + (layer.size || 0), 0);
                latestTag = {
                  tag: latestTagName,
                  digest: manifestResponse.headers['docker-content-digest'],
                  size: totalSize,
                };
              } catch {
                latestTag = { tag: latestTagName };
              }
            }

            return {
              name,
              tags_count: tags.length,
              latest_tag: latestTag,
            };
          } catch {
            return { name, tags_count: 0, latest_tag: null };
          }
        })
      );

      return images;
    } catch (err) {
      logger.error(`List images failed: ${err.message}`);
      throw new Error(`获取镜像列表失败: ${err.message}`);
    }
  }

  /**
   * 获取镜像标签列表
   */
  static async listTags(registry, imageName) {
    try {
      const client = await this.createAuthenticatedClient(registry);
      const response = await client.get(`/v2/${imageName}/tags/list`);

      const tags = response.data.tags || [];

      // 获取每个标签的详细信息
      const tagDetails = await Promise.all(
        tags.map(async (tag) => {
          try {
            const manifestResponse = await client.get(
              `/v2/${imageName}/manifests/${tag}`,
              {
                headers: {
                  Accept: 'application/vnd.docker.distribution.manifest.v2+json',
                },
              }
            );

            const layers = manifestResponse.data?.layers || [];
            const totalSize = layers.reduce((sum, layer) => sum + (layer.size || 0), 0);

            return {
              tag,
              digest: manifestResponse.headers['docker-content-digest'],
              size: totalSize,
              mediaType: manifestResponse.data?.mediaType,
            };
          } catch {
            return { tag };
          }
        })
      );

      return tagDetails;
    } catch (err) {
      logger.error(`List tags failed: ${err.message}`);
      throw new Error(`获取标签列表失败: ${err.message}`);
    }
  }

  /**
   * 删除镜像标签
   */
  static async deleteTag(registry, imageName, tag) {
    try {
      const client = await this.createAuthenticatedClient(registry);

      // 先获取 manifest digest
      const manifestResponse = await client.get(
        `/v2/${imageName}/manifests/${tag}`,
        {
          headers: {
            Accept: 'application/vnd.docker.distribution.manifest.v2+json',
          },
        }
      );

      const digest = manifestResponse.headers['docker-content-digest'];

      if (!digest) {
        throw new Error('无法获取镜像 digest');
      }

      // 删除 manifest
      await client.delete(`/v2/${imageName}/manifests/${digest}`);

      return { success: true };
    } catch (err) {
      logger.error(`Delete tag failed: ${err.message}`);
      throw new Error(`删除标签失败: ${err.message}`);
    }
  }

  /**
   * 推送镜像到远程 Registry
   * 注意：实际推送需要通过 docker CLI 或 docker API
   * 这里只是标记镜像已推送
   */
  static async pushImage(registry, imageName, tag) {
    try {
      const client = await this.createAuthenticatedClient(registry);
      await client.get(`/v2/${imageName}/manifests/${tag}`);

      return { success: true, message: '镜像已存在于远程 Registry' };
    } catch (err) {
      if (err.response?.status === 404) {
        return {
          success: false,
          message: '镜像不存在于远程 Registry，需要通过 docker push 命令推送',
        };
      }
      throw err;
    }
  }
}

module.exports = RegistryService;
