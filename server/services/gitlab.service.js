const axios = require('axios');
const { decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger');

/**
 * GitLab API 服务
 */
class GitLabService {
  /**
   * 创建 GitLab API 客户端
   * @param {string} url - GitLab 地址
   * @param {string} encryptedToken - 加密后的 Token
   * @param {string} apiVersion - API 版本，默认 v4
   */
  static createClient(url, encryptedToken, apiVersion = 'v4') {
    const token = decrypt(encryptedToken);
    const baseURL = `${url.replace(/\/+$/, '')}/api/${apiVersion}`;

    return axios.create({
      baseURL,
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * 测试 GitLab 连接
   */
  static async testConnection(url, encryptedToken, apiVersion = 'v4') {
    try {
      const client = this.createClient(url, encryptedToken, apiVersion);
      const [versionRes, userRes] = await Promise.all([
        client.get('/version'),
        client.get('/user'),
      ]);

      return {
        connected: true,
        version: versionRes.data.version,
        user: userRes.data.username,
      };
    } catch (err) {
      logger.warn(`GitLab connection test failed: ${err.message}`);
      return {
        connected: false,
        error: err.response?.data?.message || err.message,
      };
    }
  }

  /**
   * 获取 GitLab 项目列表
   */
  static async getProjects(url, encryptedToken, { search, page = 1, perPage = 20, apiVersion = 'v4' } = {}) {
    const client = this.createClient(url, encryptedToken, apiVersion);
    const params = {
      membership: true,
      order_by: 'updated_at',
      sort: 'desc',
      page,
      per_page: perPage,
    };
    if (search) params.search = search;

    const res = await client.get('/projects', { params });
    return res.data.map(p => ({
      id: p.id,
      name: p.name,
      path_with_namespace: p.path_with_namespace,
      default_branch: p.default_branch,
      web_url: p.web_url,
      description: p.description,
    }));
  }

  /**
   * 获取项目分支列表
   */
  static async getBranches(url, encryptedToken, projectId, { apiVersion = 'v4' } = {}) {
    const client = this.createClient(url, encryptedToken, apiVersion);
    const res = await client.get(`/projects/${encodeURIComponent(projectId)}/repository/branches`, {
      params: { per_page: 100 },
    });
    return res.data.map(b => ({
      name: b.name,
      protected: b.protected,
      commit: {
        sha: b.commit.id,
        message: b.commit.message,
        author: b.commit.author_name,
        created_at: b.commit.committed_date,
      },
    }));
  }

  /**
   * 获取单个项目信息
   */
  static async getProject(url, encryptedToken, projectId, { apiVersion = 'v4' } = {}) {
    const client = this.createClient(url, encryptedToken, apiVersion);
    const res = await client.get(`/projects/${encodeURIComponent(projectId)}`);
    const p = res.data;
    return {
      id: p.id,
      name: p.name,
      path_with_namespace: p.path_with_namespace,
      default_branch: p.default_branch,
      web_url: p.web_url,
      description: p.description,
      ssh_url: p.ssh_url_to_repo,
      http_url: p.http_url_to_repo,
    };
  }

  /**
   * 获取最新提交信息
   */
  static async getLatestCommit(url, encryptedToken, projectId, branch, { apiVersion = 'v4' } = {}) {
    const client = this.createClient(url, encryptedToken, apiVersion);
    const res = await client.get(`/projects/${encodeURIComponent(projectId)}/repository/commits`, {
      params: { ref_name: branch, per_page: 1 },
    });
    if (res.data.length === 0) return null;
    const c = res.data[0];
    return {
      sha: c.id,
      message: c.message,
      author: c.author_name,
      created_at: c.committed_date,
    };
  }
}

module.exports = GitLabService;
