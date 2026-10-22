const DbService = require('./db.service');
const logger = require('../utils/logger');

/**
 * 分表服务
 * 基于现有表结构创建分表（按月/按年）
 */
class PartitionService {
  /**
   * 提取基础表名（剥离末尾的日期后缀 _YYYYMM 或 _YYYY）
   * 例如：t_ivr_key_record_202612 → t_ivr_key_record
   *       t_log_202601_202612 → t_log
   */
  static getBaseTableName(tableName) {
    return tableName.replace(/(_\d{4,6})+$/, '');
  }

  /**
   * 生成分表名称
   */
  static generateTableName(sourceTable, period, date) {
    const baseName = this.getBaseTableName(sourceTable);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    if (period === 'monthly') {
      return `${baseName}_${y}${m}`;
    } else {
      return `${baseName}_${y}`;
    }
  }

  /**
   * 计算分表周期列表
   */
  static getPeriods(strategy, startDate, endDate) {
    const periods = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (strategy === 'monthly') {
      const d = new Date(start.getFullYear(), start.getMonth(), 1);
      while (d <= end) {
        periods.push(new Date(d));
        d.setMonth(d.getMonth() + 1);
      }
    } else {
      const d = new Date(start.getFullYear(), 0, 1);
      while (d <= end) {
        periods.push(new Date(d));
        d.setFullYear(d.getFullYear() + 1);
      }
    }
    return periods;
  }

  /**
   * 预览分表（返回表名列表和 DDL）
   */
  static async preview(connId, sourceTable, strategy, startDate, endDate, schema = 'public') {
    const periods = this.getPeriods(strategy, startDate, endDate);
    const conn = DbService.getConnectionConfig(connId);
    const isMysql = conn.db_type === 'mysql';
    const quote = isMysql ? '`' : '"';
    const ddl = await DbService.getCreateTableSQL(connId, sourceTable, schema);

    const tables = periods.map(date => {
      const tableName = this.generateTableName(sourceTable, strategy, date);
      // 匹配 CREATE TABLE 后的表名（支持反引号、双引号、无引号、schema.table 格式）
      let newDdl = ddl.replace(
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[\\S]+?\\.)?["\`]${sourceTable}["\`]`, 'i'),
        isMysql
          ? `CREATE TABLE ${quote}${tableName}${quote}`
          : `CREATE TABLE ${quote}${schema}${quote}.${quote}${tableName}${quote}`
      );
      // 去掉 IF NOT EXISTS（避免重复执行问题）
      newDdl = newDdl.replace(/IF NOT EXISTS\s+/gi, '');
      // PG: 替换 COMMENT ON COLUMN 语句中的表名引用（含 schema 前缀）
      if (!isMysql) {
        newDdl = newDdl.replace(
          new RegExp(`("${sourceTable}"\\.")`, 'g'),
          `${quote}${schema}${quote}.${quote}${tableName}${quote}."`
        );
        // PG/OpenGauss: 重命名索引，末尾追加日期后缀避免跨分表冲突
        // idx_t_record_col → idx_t_record_col_202701
        const baseName = this.getBaseTableName(sourceTable);
        const suffix = tableName.slice(baseName.length); // 如 _202701
        newDdl = newDdl.replace(
          /(?<=INDEX\s+(?:IF\s+EXISTS\s+)?")[^"]+/gi,
          (match) => match + suffix
        );
      }
      return { tableName, ddl: newDdl };
    });

    return tables;
  }

  /**
   * 执行分表创建
   */
  static async execute(connId, sourceTable, strategy, startDate, endDate, schema = 'public') {
    const tables = await this.preview(connId, sourceTable, strategy, startDate, endDate, schema);
    const results = [];

    for (const { tableName, ddl } of tables) {
      try {
        await DbService.executeDDL(connId, ddl);
        results.push({ tableName, success: true });
      } catch (err) {
        results.push({ tableName, success: false, error: err.message });
        logger.error(`Create partition table ${tableName} failed: ${err.message}`);
      }
    }

    return results;
  }
}

module.exports = PartitionService;
