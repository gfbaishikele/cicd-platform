const db = require('../db/init');
const logger = require('../utils/logger');

/**
 * Dockerfile 模板服务
 */
class TemplateService {
  /**
   * 渲染模板变量
   * 将 {{variable}} 替换为实际值
   * @param {string} content - 模板内容
   * @param {Object} variables - 变量键值对
   * @returns {string} 渲染后的内容
   */
  static render(content, variables = {}) {
    return content.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] !== undefined ? variables[key] : match;
    });
  }

  /**
   * 提取模板中的变量名列表
   * @param {string} content - 模板内容
   * @returns {string[]} 变量名列表
   */
  static extractVariables(content) {
    const matches = content.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => m.replace(/\{\{|\}\}/g, '')))];
  }

  /**
   * 验证模板变量是否都有对应值
   * @param {string} content - 模板内容
   * @param {Object} variables - 变量键值对
   * @returns {{ valid: boolean, missing: string[] }}
   */
  static validateVariables(content, variables = {}) {
    const required = this.extractVariables(content);
    const missing = required.filter(key => variables[key] === undefined || variables[key] === '');
    return { valid: missing.length === 0, missing };
  }

  /**
   * 获取模板列表
   */
  static getAll(buildType) {
    const base = `
      SELECT t.*, u.name as created_by_name
      FROM dockerfile_templates t
      LEFT JOIN users u ON t.created_by = u.id
    `;
    if (buildType) {
      return db.prepare(base + ' WHERE t.build_type = ? ORDER BY t.is_system DESC, t.id ASC').all(buildType);
    }
    return db.prepare(base + ' ORDER BY t.is_system DESC, t.id ASC').all();
  }

  /**
   * 获取模板详情
   */
  static getById(id) {
    return db.prepare('SELECT * FROM dockerfile_templates WHERE id = ?').get(id);
  }

  /**
   * 创建模板
   */
  static create({ name, description, build_type, content, variables, created_by, scope = 'private', is_system = 0 }) {
    const variablesJson = typeof variables === 'string' ? variables : JSON.stringify(variables || []);
    const result = db.prepare(`
      INSERT INTO dockerfile_templates (name, description, build_type, content, variables, created_by, scope, is_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description || null, build_type, content, variablesJson, created_by, scope, is_system);

    return db.prepare('SELECT * FROM dockerfile_templates WHERE id = ?').get(result.lastInsertRowid);
  }

  /**
   * 更新模板
   */
  static update(id, { name, description, content, variables, scope }) {
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (content !== undefined) { updates.push('content = ?'); params.push(content); }
    if (variables !== undefined) {
      updates.push('variables = ?');
      params.push(typeof variables === 'string' ? variables : JSON.stringify(variables));
    }
    if (scope !== undefined) { updates.push('scope = ?'); params.push(scope); }

    if (updates.length > 0) {
      updates.push(`updated_at = (datetime('now', 'localtime'))`);
      params.push(id);
      db.prepare(`UPDATE dockerfile_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    return db.prepare('SELECT * FROM dockerfile_templates WHERE id = ?').get(id);
  }

  /**
   * 删除模板（仅非系统模板）
   */
  static delete(id) {
    const template = db.prepare('SELECT * FROM dockerfile_templates WHERE id = ?').get(id);
    if (!template) return null;
    if (template.is_system) return { error: '系统内置模板不可删除' };

    // 检查是否有项目使用此模板
    const projectCount = db.prepare(
      'SELECT COUNT(*) as count FROM projects WHERE dockerfile_template_id = ?'
    ).get(id);
    if (projectCount.count > 0) {
      return { error: `有 ${projectCount.count} 个项目使用此模板，请先更换模板` };
    }

    db.prepare('DELETE FROM dockerfile_templates WHERE id = ?').run(id);
    return { success: true };
  }
}

module.exports = TemplateService;
