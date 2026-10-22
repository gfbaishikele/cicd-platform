const db = require('../db/init');
const { encrypt, decrypt } = require('../utils/encrypt');
const logger = require('../utils/logger');

/**
 * 统一数据库连接服务
 * 支持 MySQL、PostgreSQL、OpenGauss
 */
class DbService {
  /**
   * 获取连接配置（解密密码）
   */
  static getConnectionConfig(connId) {
    const conn = db.prepare('SELECT * FROM db_connections WHERE id = ?').get(connId);
    if (!conn) throw new Error('数据库连接不存在');
    return {
      ...conn,
      password: decrypt(conn.password),
    };
  }

  /**
   * 创建数据库客户端连接
   */
  static createClient(conn) {
    const config = {
      host: conn.host,
      port: conn.port,
      user: conn.username,
      password: conn.password,
      database: conn.database,
    };

    if (conn.db_type === 'mysql') {
      const mysql = require('mysql2/promise');
      return mysql.createConnection(config);
    } else {
      // pg 或 opengauss（OpenGauss 兼容 PG 协议）
      const { Client } = require('pg');
      const client = new Client(config);
      return client.connect().then(() => client);
    }
  }

  /**
   * 测试连接
   */
  static async testConnection(connId) {
    const conn = this.getConnectionConfig(connId);
    const client = await this.createClient(conn);
    try {
      const startTime = Date.now();
      if (conn.db_type === 'mysql') {
        await client.execute('SELECT 1');
      } else {
        await client.query('SELECT 1');
      }
      const latency = Date.now() - startTime;
      db.prepare("UPDATE db_connections SET status = 'online', last_check = (datetime('now', 'localtime')) WHERE id = ?").run(connId);
      return { ok: true, latency_ms: latency };
    } catch (err) {
      db.prepare("UPDATE db_connections SET status = 'offline', last_check = (datetime('now', 'localtime')) WHERE id = ?").run(connId);
      return { ok: false, error: err.message };
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 关闭客户端连接
   */
  static async closeClient(dbType, client) {
    try {
      if (dbType === 'mysql') {
        await client.end();
      } else {
        await client.end();
      }
    } catch { /* 忽略关闭错误 */ }
  }

  /**
   * 获取数据库列表（MySQL 用 SHOW DATABASES，PG 用 pg_database）
   */
  static async getDatabases(connId) {
    const conn = this.getConnectionConfig(connId);
    const client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute('SHOW DATABASES');
        return rows.map(r => Object.values(r)[0]);
      } else {
        const res = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
        return res.rows.map(r => r.datname);
      }
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取 schema 列表（仅 PG/OpenGauss）
   */
  static async getSchemas(connId) {
    const conn = this.getConnectionConfig(connId);
    const client = await this.createClient(conn);
    try {
      const res = await client.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
        ORDER BY schema_name
      `);
      return res.rows.map(r => r.schema_name);
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表列表
   */
  static async getTables(connId, database, schema = 'public') {
    const conn = this.getConnectionConfig(connId);
    if (database && database !== conn.database) {
      conn.database = database;
    }
    const client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute('SHOW TABLES');
        return rows.map(r => Object.values(r)[0]);
      } else {
        const res = await client.query(`
          SELECT tablename FROM pg_tables
          WHERE schemaname = $1
          ORDER BY tablename
        `, [schema]);
        return res.rows.map(r => r.tablename);
      }
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表结构（字段信息）
   */
  static async getTableStructure(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`
          SELECT COLUMN_NAME as column_name, COLUMN_TYPE as column_type,
                 IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default,
                 COLUMN_KEY as column_key, EXTRA as extra, COLUMN_COMMENT as column_comment
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [conn.database, tableName]);
        return rows;
      } else {
        const res = await client.query(`
          SELECT c.column_name,
                 c.udt_name || COALESCE(
                   CASE WHEN c.character_maximum_length IS NOT NULL
                        THEN '(' || c.character_maximum_length || ')'
                        ELSE '' END,
                   CASE WHEN c.numeric_precision IS NOT NULL AND c.udt_name NOT IN ('timestamptz','timestamp','date','time')
                        THEN '(' || c.numeric_precision || COALESCE(',' || c.numeric_scale, '') || ')'
                        ELSE '' END
                 ) as column_type,
                 c.is_nullable,
                 c.column_default,
                 CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END as column_key,
                 '' as extra,
                 COALESCE(col_description(tc.oid, a.attnum), '') as column_comment
          FROM information_schema.columns c
          LEFT JOIN pg_class tc ON tc.relname = c.table_name
            AND tc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema)
          LEFT JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attname = c.column_name
          LEFT JOIN (
            SELECT ku.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = $2
          ) pk ON c.column_name = pk.column_name
          WHERE c.table_name = $1 AND c.table_schema = $2
          ORDER BY c.ordinal_position
        `, [tableName, schema]);
        return res.rows;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表的索引信息
   */
  static async getTableIndexes(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`
          SELECT INDEX_NAME as index_name, COLUMN_NAME as column_name,
                 NON_UNIQUE as non_unique, INDEX_TYPE as index_type,
                 SEQ_IN_INDEX as seq_in_index
          FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY INDEX_NAME, SEQ_IN_INDEX
        `, [conn.database, tableName]);
        return rows;
      } else {
        const res = await client.query(`
          SELECT
            i.relname as index_name,
            a.attname as column_name,
            ix.indisunique as non_unique,
            am.amname as index_type,
            array_position(ix.indkey, a.attnum) as seq_in_index
          FROM pg_class t
          JOIN pg_index ix ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_am am ON i.relam = am.oid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = $1 AND n.nspname = $2
          ORDER BY i.relname, array_position(ix.indkey, a.attnum)
        `, [tableName, schema]);
        return res.rows.map(r => ({
          ...r,
          non_unique: r.non_unique ? 0 : 1,
        }));
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表的外键信息
   */
  static async getTableForeignKeys(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`
          SELECT kcu.CONSTRAINT_NAME as constraint_name,
                 kcu.COLUMN_NAME as column_name,
                 kcu.REFERENCED_TABLE_NAME as ref_table,
                 kcu.REFERENCED_COLUMN_NAME as ref_column,
                 kcu.ORDINAL_POSITION as position,
                 rc.DELETE_RULE as delete_rule,
                 rc.UPDATE_RULE as update_rule
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
          WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
        `, [conn.database, tableName]);
        return rows;
      } else {
        const res = await client.query(`
          SELECT
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name AS ref_table,
            ccu.column_name AS ref_column,
            kcu.ordinal_position AS position,
            LOWER(rc.delete_rule) AS delete_rule,
            LOWER(rc.update_rule) AS update_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = $1 AND tc.table_schema = $2
          ORDER BY tc.constraint_name, kcu.ordinal_position
        `, [tableName, schema]);
        return res.rows;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表的 CHECK 约束
   */
  static async getTableCheckConstraints(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        // MySQL 8.0.16+ 支持 CHECK 约束
        try {
          const [rows] = await client.execute(`
            SELECT cc.CONSTRAINT_NAME as constraint_name,
                   cc.CHECK_CLAUSE as check_clause
            FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
            JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
              ON cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
            WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
              AND tc.CONSTRAINT_TYPE = 'CHECK'
            ORDER BY cc.CONSTRAINT_NAME
          `, [conn.database, tableName]);
          return rows;
        } catch {
          return []; // MySQL < 8.0.16 不支持 CHECK 约束
        }
      } else {
        const res = await client.query(`
          SELECT
            con.conname AS constraint_name,
            pg_get_constraintdef(con.oid) AS check_clause
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE con.contype = 'c'
            AND rel.relname = $1 AND nsp.nspname = $2
          ORDER BY con.conname
        `, [tableName, schema]);
        return res.rows;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表注释和列注释
   */
  static async getTableComment(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`
          SELECT TABLE_COMMENT as table_comment
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        `, [conn.database, tableName]);
        return { tableComment: rows[0]?.table_comment || '', columnComments: [] };
        // 列注释已在 getTableStructure 中返回
      } else {
        const res = await client.query(`
          SELECT obj_description(c.oid) as table_comment
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = $2
        `, [tableName, schema]);
        return { tableComment: res.rows[0]?.table_comment || '', columnComments: [] };
        // 列注释已在 getTableStructure 中返回
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表的字符集和排序规则
   */
  static async getTableCharset(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`
          SELECT TABLE_COLLATION as collation
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        `, [conn.database, tableName]);
        const collation = rows[0]?.collation || '';
        const charset = collation.split('_')[0] || '';
        return { charset, collation };
      } else {
        // PG/OpenGauss: 编码在数据库级别
        const res = await client.query(`SHOW server_encoding`);
        const pgEncoding = (res.rows[0]?.server_encoding || '').toUpperCase();
        // 映射 PG 编码到 MySQL charset + collation
        const encodingMap = {
          'UTF8': { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' },
          'LATIN1': { charset: 'latin1', collation: 'latin1_swedish_ci' },
          'WIN1252': { charset: 'latin1', collation: 'latin1_swedish_ci' },
          'GBK': { charset: 'gbk', collation: 'gbk_chinese_ci' },
          'GBP': { charset: 'gb18030', collation: 'gb18030_chinese_ci' },
          'EUC_JP': { charset: 'ujis', collation: 'ujis_japanese_ci' },
          'EUC_KR': { charset: 'euckr', collation: 'euckr_korean_ci' },
          'EUC_CN': { charset: 'gb2312', collation: 'gb2312_chinese_ci' },
        };
        const mapped = encodingMap[pgEncoding] || { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' };
        return mapped;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表的 CREATE TABLE 语句
   */
  static async getCreateTableSQL(connId, tableName, schema = 'public') {
    const conn = this.getConnectionConfig(connId);
    const client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`SHOW CREATE TABLE \`${tableName}\``);
        return rows[0]?.['Create Table'] || '';
      } else {
        const columns = await this.getTableStructure(connId, tableName, schema);
        return this.buildPgCreateTable(tableName, columns, conn.db_type);
      }
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 构建 PG/OpenGauss 的 CREATE TABLE 语句
   */
  static buildPgCreateTable(tableName, columns, dbType) {
    const lines = columns.map(col => {
      let sql = `  "${col.column_name}" ${col.column_type}`;
      if (col.column_default && col.column_default.includes('nextval')) {
        // SERIAL 类型已有默认值，不需要额外处理
      } else if (col.column_default) {
        sql += ` DEFAULT ${col.column_default}`;
      }
      if (col.is_nullable === 'NO') {
        sql += ' NOT NULL';
      }
      if (col.column_key === 'PRI') {
        sql += ' PRIMARY KEY';
      }
      return sql;
    });

    let sql = `CREATE TABLE "${tableName}" (\n${lines.join(',\n')}\n);`;

    // 添加注释
    const comments = columns
      .filter(c => c.column_comment)
      .map(c => `COMMENT ON COLUMN "${tableName}"."${c.column_name}" IS '${c.column_comment.replace(/'/g, "''")}';`)
      .join('\n');

    if (comments) sql += '\n' + comments;
    return sql;
  }

  /**
   * 执行查询（返回结果）
   */
  static async executeQuery(connId, sql, params = []) {
    const conn = this.getConnectionConfig(connId);
    const client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(sql, params);
        return rows;
      } else {
        const res = await client.query(sql, params);
        return res.rows;
      }
    } finally {
      await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 分批读取表数据（用于数据同步）
   */
  static async readTableData(connId, tableName, offset, limit, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`, [limit, offset]);
        return rows;
      } else {
        const qualifiedName = `"${schema}"."${tableName}"`;
        const res = await client.query(`SELECT * FROM ${qualifiedName} LIMIT $1 OFFSET $2`, [limit, offset]);
        return res.rows;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 获取表总行数
   */
  static async getTableRowCount(connId, tableName, schema = 'public', client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const [rows] = await client.execute(`SELECT COUNT(*) as total FROM \`${tableName}\``);
        return rows[0].total;
      } else {
        const qualifiedName = `"${schema}"."${tableName}"`;
        const res = await client.query(`SELECT COUNT(*) as total FROM ${qualifiedName}`);
        return parseInt(res.rows[0].total, 10);
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 批量插入数据
   */
  static async batchInsert(connId, tableName, columns, rows, schema = 'public', client = null) {
    if (rows.length === 0) return 0;
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        const colList = columns.map(c => `\`${c}\``).join(', ');
        const placeholders = rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
        const values = rows.flatMap(row => columns.map(c => row[c] === undefined ? null : row[c]));
        const sql = `INSERT INTO \`${tableName}\` (${colList}) VALUES ${placeholders}`;
        const [result] = await client.execute(sql, values);
        return result.affectedRows || rows.length;
      } else {
        const colList = columns.map(c => `"${c}"`).join(', ');
        const qualifiedName = `"${schema}"."${tableName}"`;
        let inserted = 0;
        const batchSize = 100;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const values = batch.flatMap(row => columns.map(c => row[c] === undefined ? null : row[c]));
          const valueSets = batch.map((_, idx) => {
            const base = i + idx;
            return `(${columns.map((_, ci) => `$${base * columns.length + ci + 1}`).join(', ')})`;
          }).join(', ');
          const sql = `INSERT INTO ${qualifiedName} (${colList}) VALUES ${valueSets}`;
          try {
            const res = await client.query(sql, values);
            inserted += res.rowCount || batch.length;
          } catch (batchErr) {
            // 批量插入失败，降级为逐行插入，跳过问题行
            for (const row of batch) {
              const rowValues = columns.map(c => row[c] === undefined ? null : row[c]);
              const placeholders = columns.map((_, ci) => `$${ci + 1}`).join(', ');
              const rowSql = `INSERT INTO ${qualifiedName} (${colList}) VALUES (${placeholders})`;
              try {
                const res = await client.query(rowSql, rowValues);
                inserted += res.rowCount || 1;
              } catch { /* 跳过脏数据行 */ }
            }
          }
        }
        return inserted;
      }
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }

  /**
   * 执行 DDL 语句
   */
  static async executeDDL(connId, sql, client = null) {
    const conn = this.getConnectionConfig(connId);
    const ownClient = !client;
    if (!client) client = await this.createClient(conn);
    try {
      if (conn.db_type === 'mysql') {
        await client.execute(sql);
      } else {
        // PG/OpenGauss: client.query 不支持单条执行多条语句，需按分号拆分逐条执行
        // 智能拆分：跳过单引号字符串内的分号
        const statements = [];
        let current = '';
        let inString = false;
        for (let i = 0; i < sql.length; i++) {
          const ch = sql[i];
          if (ch === "'" && !inString) {
            inString = true;
            current += ch;
          } else if (ch === "'" && inString) {
            // 处理转义的单引号 ''
            if (sql[i + 1] === "'") {
              current += "''";
              i++;
            } else {
              inString = false;
              current += ch;
            }
          } else if (ch === ';' && !inString) {
            const stmt = current.trim();
            if (stmt) statements.push(stmt);
            current = '';
          } else {
            current += ch;
          }
        }
        const last = current.trim();
        if (last) statements.push(last);
        for (const stmt of statements) {
          await client.query(stmt);
        }
      }
      return true;
    } finally {
      if (ownClient) await this.closeClient(conn.db_type, client);
    }
  }
}

module.exports = DbService;
