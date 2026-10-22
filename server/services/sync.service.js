const DbService = require('./db.service');
const logger = require('../utils/logger');

/**
 * 跨库同步服务
 * 支持 MySQL ↔ PostgreSQL ↔ OpenGauss 的表结构转换和数据同步
 */

// MySQL → PG/OpenGauss 类型映射
const MYSQL_TO_PG = {
  'tinyint': 'SMALLINT',
  'tinyint unsigned': 'SMALLINT',
  'smallint': 'SMALLINT',
  'smallint unsigned': 'INTEGER',
  'mediumint': 'INTEGER',
  'mediumint unsigned': 'INTEGER',
  'int': 'INTEGER',
  'integer': 'INTEGER',
  'int unsigned': 'BIGINT',
  'bigint': 'BIGINT',
  'bigint unsigned': 'NUMERIC(20)',
  'float': 'REAL',
  'double': 'DOUBLE PRECISION',
  'decimal': 'NUMERIC',
  'bit': 'BOOLEAN',
  'bool': 'BOOLEAN',
  'boolean': 'BOOLEAN',
  'date': 'DATE',
  'time': 'TIME',
  'datetime': 'TIMESTAMP',
  'timestamp': 'TIMESTAMP',
  'year': 'INTEGER',
  'char': 'VARCHAR',
  'varchar': 'VARCHAR',
  'tinytext': 'VARCHAR(255)',
  'text': 'TEXT',
  'mediumtext': 'TEXT',
  'longtext': 'TEXT',
  'tinyblob': 'BYTEA',
  'blob': 'BYTEA',
  'mediumblob': 'BYTEA',
  'longblob': 'BYTEA',
  'binary': 'BYTEA',
  'varbinary': 'BYTEA',
  'json': 'JSONB',
  'enum': 'VARCHAR(255)',
  'set': 'VARCHAR(255)',
};

// PG/OpenGauss → MySQL 类型映射
const PG_TO_MYSQL = {
  'smallint': 'SMALLINT',
  'integer': 'INT',
  'int': 'INT',
  'int4': 'INT',
  'bigint': 'BIGINT',
  'int8': 'BIGINT',
  'real': 'FLOAT',
  'float4': 'FLOAT',
  'double precision': 'DOUBLE',
  'float8': 'DOUBLE',
  'numeric': 'DECIMAL',
  'decimal': 'DECIMAL',
  'boolean': 'TINYINT(1)',
  'bool': 'TINYINT(1)',
  'date': 'DATE',
  'time': 'TIME',
  'timestamp': 'DATETIME',
  'timestamptz': 'DATETIME',
  'text': 'LONGTEXT',
  'varchar': 'VARCHAR',
  'character varying': 'VARCHAR',
  'char': 'CHAR',
  'character': 'CHAR',
  'bytea': 'LONGBLOB',
  'json': 'JSON',
  'jsonb': 'JSON',
  'uuid': 'VARCHAR(36)',
  'serial': 'INT AUTO_INCREMENT',
  'bigserial': 'BIGINT AUTO_INCREMENT',
};

class SyncService {
  /**
   * 转换 MySQL 字段类型为 PG 类型
   */
  static mysqlToPgType(mysqlType) {
    if (!mysqlType) return 'TEXT';
    const lower = mysqlType.toLowerCase().trim();

    // 处理带长度的类型：varchar(255) → VARCHAR(255)
    const lenMatch = lower.match(/^(.+?)\((\d+(?:,\s*\d+)?)\)$/);
    if (lenMatch) {
      const baseType = lenMatch[1];
      const len = lenMatch[2];
      const mapped = MYSQL_TO_PG[baseType];
      if (mapped) {
        // TEXT/BYTEA 不需要长度
        if (['TEXT', 'BYTEA'].includes(mapped)) return mapped;
        // PG 整数类型不接受长度参数（MySQL 的 tinyint(1) → SMALLINT，不是 SMALLINT(1)）
        if (['SMALLINT', 'INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION'].includes(mapped)) return mapped;
        // float/double 带精度和小数位（如 float(10,2)）→ NUMERIC(10,2)
        if (len.includes(',') && ['REAL', 'DOUBLE PRECISION'].includes(mapped)) {
          return `NUMERIC(${len})`;
        }
        // char → VARCHAR（PG 的 CHAR 是定长填充，MySQL 的 char 通常存变长数据）
        if (mapped === 'CHAR') return `VARCHAR(${len})`;
        return `${mapped}(${len})`;
      }
    }

    // 处理 unsigned
    const unsignedMatch = lower.match(/^(.+?)\s+unsigned$/);
    if (unsignedMatch) {
      const mapped = MYSQL_TO_PG[unsignedMatch[1] + ' unsigned'];
      if (mapped) return mapped;
      return MYSQL_TO_PG[unsignedMatch[1]] || 'TEXT';
    }

    // 处理 enum
    if (lower.startsWith('enum')) return 'VARCHAR(255)';
    if (lower.startsWith('set')) return 'VARCHAR(255)';

    return MYSQL_TO_PG[lower] || 'TEXT';
  }

  /**
   * 转换 PG 字段类型为 MySQL 类型
   */
  static pgToMysqlType(pgType) {
    if (!pgType) return 'LONGTEXT';
    const lower = pgType.toLowerCase().trim();

    // 处理带长度的类型
    const lenMatch = lower.match(/^(.+?)\((\d+(?:,\s*\d+)?)\)$/);
    if (lenMatch) {
      const baseType = lenMatch[1];
      const len = lenMatch[2];
      const mapped = PG_TO_MYSQL[baseType];
      if (mapped) {
        if (mapped.includes('AUTO_INCREMENT')) return mapped;
        return `${mapped}(${len})`;
      }
    }

    // 处理 serial 类型
    if (lower === 'serial' || lower === 'bigserial') return PG_TO_MYSQL[lower];

    return PG_TO_MYSQL[lower] || 'TEXT';
  }

  /**
   * 转换字段类型（根据源和目标类型自动判断）
   */
  static convertColumnType(sourceDbType, columnType) {
    if (sourceDbType === 'mysql') {
      return this.mysqlToPgType(columnType);
    } else {
      return this.pgToMysqlType(columnType);
    }
  }

  /**
   * 生成目标库的 CREATE TABLE 语句（含外键、CHECK 约束、注释、字符集、自增）
   */
  static generateCreateTableSQL(sourceColumns, targetTableName, sourceDbType, targetDbType,
    foreignKeys = [], checkConstraints = [], tableComment = '', sourceCharset = null) {
    const quote = targetDbType === 'mysql' ? '`' : '"';
    const textTypes = ['VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT'];

    const lines = sourceColumns.map(col => {
      let convertedType = this.convertColumnType(sourceDbType, col.column_type);

      // 检测自增列
      const isAutoIncrement =
        (sourceDbType === 'mysql' && col.extra && col.extra.toLowerCase().includes('auto_increment')) ||
        (sourceDbType !== 'mysql' && /^serial/i.test(col.column_type));

      // MySQL → PG/OpenGauss: AUTO_INCREMENT 转为 SERIAL/BIGSERIAL
      if (isAutoIncrement && targetDbType !== 'mysql') {
        convertedType = convertedType.replace(/^BIGINT(\(.*?\))?/i, 'BIGSERIAL');
        if (!/^BIGSERIAL/i.test(convertedType)) {
          convertedType = convertedType.replace(/^(INTEGER|INT|SMALLINT)(\(.*?\))?/i, 'SERIAL');
        }
      }

      // PG/OpenGauss → MySQL: SERIAL 转为 AUTO_INCREMENT
      if (isAutoIncrement && targetDbType === 'mysql') {
        convertedType = convertedType.replace(/^(INTEGER|INT|SMALLINT|BIGINT)(\(.*?\))?/i, (match) => match + ' AUTO_INCREMENT');
      }

      let sql = `  ${quote}${col.column_name}${quote} ${convertedType}`;

      // NOT NULL（SERIAL 类型隐含 NOT NULL）
      if (col.is_nullable === 'NO' && !isAutoIncrement) {
        sql += ' NOT NULL';
      }

      // DEFAULT（自增列不需要 DEFAULT）
      if (!isAutoIncrement && col.column_default && !col.column_default.includes('nextval') && !convertedType.includes('AUTO_INCREMENT')) {
        let defaultVal = col.column_default;
        if (targetDbType !== 'mysql') {
          // PG 目标端：处理默认值格式
          // 去掉 MySQL 函数默认的括号包裹：(current_timestamp()) → current_timestamp()
          const stripped = defaultVal.replace(/^\((.+)\)$/, '$1');
          const upper = stripped.toUpperCase();
          if (upper === 'CURRENT_TIMESTAMP' || upper === 'CURRENT_TIMESTAMP()' || upper === 'NOW()') {
            defaultVal = 'NOW()';
          } else if (upper === 'NULL') {
            defaultVal = 'NULL';
          } else if (/^[-+]?\d+(\.\d+)?$/.test(stripped)) {
            // 纯数字直接使用
            defaultVal = stripped;
          } else if (stripped.startsWith("'") || stripped.startsWith('"')) {
            // 已加引号的字符串
            defaultVal = stripped;
          } else if (/^[A-Z_]+\(\)$/i.test(stripped)) {
            // 其他无参函数（如 UUID()、VERSION() 等）直接保留
            defaultVal = stripped;
          } else {
            // 其他非数字值（字符串、日期等），加引号
            defaultVal = `'${stripped.replace(/'/g, "''")}'`;
          }
        }
        sql += ` DEFAULT ${defaultVal}`;
      }

      // CHARACTER SET / COLLATE（MySQL 目标端，文本列，源端有字符集信息时）
      if (targetDbType === 'mysql' && sourceCharset?.charset && sourceCharset?.collation) {
        const baseType = convertedType.replace(/\(.*\)/, '').trim().toUpperCase();
        if (textTypes.includes(baseType)) {
          sql += ` CHARACTER SET ${sourceCharset.charset} COLLATE ${sourceCharset.collation}`;
        }
      }

      // PRIMARY KEY
      if (col.column_key === 'PRI') {
        if (targetDbType === 'mysql' && convertedType.includes('AUTO_INCREMENT')) {
          sql += ' PRIMARY KEY';
        } else {
          sql += ' PRIMARY KEY';
        }
      }

      // MySQL: 列注释内联
      if (targetDbType === 'mysql' && col.column_comment) {
        const escaped = col.column_comment.replace(/'/g, "\\'");
        sql += ` COMMENT '${escaped}'`;
      }

      return sql;
    });

    // 外键约束（按约束名分组，支持复合外键）
    if (foreignKeys.length > 0) {
      const fkGrouped = {};
      for (const fk of foreignKeys) {
        if (!fkGrouped[fk.constraint_name]) {
          fkGrouped[fk.constraint_name] = {
            name: fk.constraint_name,
            columns: [],
            refTable: fk.ref_table,
            refColumns: [],
            deleteRule: fk.delete_rule || 'NO ACTION',
            updateRule: fk.update_rule || 'NO ACTION',
          };
        }
        fkGrouped[fk.constraint_name].columns.push(fk.column_name);
        if (!fkGrouped[fk.constraint_name].refColumns.includes(fk.ref_column)) {
          fkGrouped[fk.constraint_name].refColumns.push(fk.ref_column);
        }
      }
      for (const fk of Object.values(fkGrouped)) {
        const cols = fk.columns.map(c => `${quote}${c}${quote}`).join(', ');
        const refCols = fk.refColumns.map(c => `${quote}${c}${quote}`).join(', ');
        const deleteRule = fk.deleteRule.toUpperCase();
        const updateRule = fk.updateRule.toUpperCase();
        lines.push(`  CONSTRAINT ${quote}${fk.name}${quote} FOREIGN KEY (${cols}) REFERENCES ${quote}${fk.refTable}${quote} (${refCols}) ON DELETE ${deleteRule} ON UPDATE ${updateRule}`);
      }
    }

    // CHECK 约束
    if (checkConstraints.length > 0) {
      for (const chk of checkConstraints) {
        let clause = chk.check_clause;
        // PG 的 pg_get_constraintdef 返回 "CHECK (expression)"，去掉 CHECK 前缀
        if (targetDbType !== 'mysql') {
          clause = clause.replace(/^CHECK\s*\(/i, '(');
        }
        lines.push(`  CONSTRAINT ${quote}${chk.constraint_name}${quote} CHECK ${clause}`);
      }
    }

    let sql = `CREATE TABLE IF NOT EXISTS ${quote}${targetTableName}${quote} (\n${lines.join(',\n')}\n)`;

    if (targetDbType === 'mysql') {
      // MySQL: 表注释内联
      if (tableComment) {
        const escaped = tableComment.replace(/'/g, "\\'");
        sql += ` COMMENT='${escaped}'`;
      }
      sql += ';';
    } else {
      sql += ';';
      // PG/OpenGauss: COMMENT ON 语句
      if (tableComment) {
        const escaped = tableComment.replace(/'/g, "''");
        sql += `\nCOMMENT ON TABLE ${quote}${targetTableName}${quote} IS '${escaped}';`;
      }
      for (const col of sourceColumns) {
        if (col.column_comment) {
          const escaped = col.column_comment.replace(/'/g, "''");
          sql += `\nCOMMENT ON COLUMN ${quote}${targetTableName}${quote}.${quote}${col.column_name}${quote} IS '${escaped}';`;
        }
      }
    }

    return sql;
  }

  /**
   * 生成索引 CREATE INDEX 语句
   */
  static generateIndexDDLs(indexes, targetTableName, targetDbType) {
    if (!indexes || indexes.length === 0) return [];

    const quote = targetDbType === 'mysql' ? '`' : '"';

    // 按索引名分组（一个索引可能有多列）
    const grouped = {};
    for (const idx of indexes) {
      if (idx.index_name === 'PRIMARY') continue; // 主键已在 CREATE TABLE 中处理
      if (!grouped[idx.index_name]) {
        grouped[idx.index_name] = {
          name: idx.index_name,
          unique: idx.non_unique === 0,
          columns: [],
          type: idx.index_type || 'BTREE',
        };
      }
      grouped[idx.index_name].columns.push(idx.column_name);
    }

    return Object.values(grouped).map(idx => {
      const uniqueStr = idx.unique ? 'UNIQUE ' : '';
      const cols = idx.columns.map(c => `${quote}${c}${quote}`).join(', ');
      // MySQL 支持 USING BTREE/HASH，PG/OpenGauss 支持 USING btree/gin/gist 等
      const usingStr = targetDbType === 'mysql' ? ` USING ${idx.type}` : ` USING ${idx.type.toLowerCase()}`;
      const ifNotExists = targetDbType !== 'mysql' ? 'IF NOT EXISTS ' : '';
      return `CREATE ${uniqueStr}INDEX ${ifNotExists}${quote}${idx.name}${quote} ON ${quote}${targetTableName}${quote}${usingStr} (${cols});`;
    });
  }

  /**
   * 预览同步（返回转换后的 DDL 和数据量）
   */
  static async preview(sourceConnId, sourceTable, targetConnId, targetTable, sourceSchema = 'public', targetSchema = 'public') {
    const sourceConn = DbService.getConnectionConfig(sourceConnId);
    const targetConn = DbService.getConnectionConfig(targetConnId);

    const sourceClient = await DbService.createClient(sourceConn);
    try {
      const columns = await DbService.getTableStructure(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const rowCount = await DbService.getTableRowCount(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const foreignKeys = await DbService.getTableForeignKeys(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const checkConstraints = await DbService.getTableCheckConstraints(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const { tableComment } = await DbService.getTableComment(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const sourceCharset = await DbService.getTableCharset(sourceConnId, sourceTable, sourceSchema, sourceClient);

      let ddl = this.generateCreateTableSQL(columns, targetTable, sourceConn.db_type, targetConn.db_type,
        foreignKeys, checkConstraints, tableComment, sourceCharset);

      const indexes = await DbService.getTableIndexes(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const indexDDLs = this.generateIndexDDLs(indexes, targetTable, targetConn.db_type);
      if (indexDDLs.length > 0) {
        ddl += '\n\n-- 索引\n' + indexDDLs.join('\n');
      }

      return { columns, rowCount, ddl };
    } finally {
      await DbService.closeClient(sourceConn.db_type, sourceClient);
    }
  }

  /**
   * 执行同步：建表 + 数据迁移
   */
  static async execute(sourceConnId, sourceTable, targetConnId, targetTable, sourceSchema = 'public', targetSchema = 'public', onProgress, sourceClient = null, targetClient = null) {
    const sourceConn = DbService.getConnectionConfig(sourceConnId);
    const targetConn = DbService.getConnectionConfig(targetConnId);

    const ownSourceClient = !sourceClient;
    const ownTargetClient = !targetClient;
    if (!sourceClient) sourceClient = await DbService.createClient(sourceConn);
    if (!targetClient) targetClient = await DbService.createClient(targetConn);

    try {
      // Step 1: 获取源表结构、外键、约束、注释、字符集
      const columns = await DbService.getTableStructure(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const columnNames = columns.map(c => c.column_name);
      const foreignKeys = await DbService.getTableForeignKeys(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const checkConstraints = await DbService.getTableCheckConstraints(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const { tableComment } = await DbService.getTableComment(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const sourceCharset = await DbService.getTableCharset(sourceConnId, sourceTable, sourceSchema, sourceClient);

      // Step 2: 在目标库建表（PG/OpenGauss 需要 schema 限定）
      // 先检查目标表是否已存在
      let tableExists = false;
      try {
        if (targetConn.db_type === 'mysql') {
          const [rows] = await targetClient.query(`SHOW TABLES LIKE '${targetTable}'`);
          tableExists = rows && rows.length > 0;
        } else {
          const checkRes = await targetClient.query(
            `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = $1 AND schemaname = $2)`,
            [targetTable, targetSchema]
          );
          tableExists = checkRes.rows[0]?.exists === true;
        }
      } catch { /* 查询失败则按不存在处理 */ }

      let ddl = this.generateCreateTableSQL(columns, targetTable, sourceConn.db_type, targetConn.db_type,
        foreignKeys, checkConstraints, tableComment, sourceCharset);
      if (targetConn.db_type !== 'mysql') {
        const quote = '"';
        const qualifiedName = `${quote}${targetSchema}${quote}.${quote}${targetTable}${quote}`;
        // CREATE TABLE 表名（兼容 IF NOT EXISTS）
        ddl = ddl.replace(
          new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+"${targetTable}"(\\s*\\()`, 'i'),
          `CREATE TABLE IF NOT EXISTS ${qualifiedName}$1`
        );
        // REFERENCES "ref_table" → REFERENCES "schema"."ref_table"
        ddl = ddl.replace(
          /REFERENCES\s+"([^"]+)"/gi,
          `REFERENCES ${quote}${targetSchema}${quote}."$1"`
        );
        // COMMENT ON TABLE "table" → COMMENT ON TABLE "schema"."table"
        ddl = ddl.replace(
          new RegExp(`COMMENT ON TABLE\\s+"${targetTable}"`, 'gi'),
          `COMMENT ON TABLE ${qualifiedName}`
        );
        // COMMENT ON COLUMN "table"."col" → COMMENT ON COLUMN "schema"."table"."col"
        ddl = ddl.replace(
          new RegExp(`COMMENT ON COLUMN\\s+"${targetTable}"\\.`, 'gi'),
          `COMMENT ON COLUMN ${qualifiedName}.`
        );
      }
      await DbService.executeDDL(targetConnId, ddl, targetClient);
      if (onProgress) onProgress({ step: 'create_table', message: tableExists ? '目标表已存在，跳过建表' : '目标表已创建' });

      // Step 2.5: 创建索引
      const indexes = await DbService.getTableIndexes(sourceConnId, sourceTable, sourceSchema, sourceClient);
      const indexDDLs = this.generateIndexDDLs(indexes, targetTable, targetConn.db_type);
      for (let idxDdl of indexDDLs) {
        if (targetConn.db_type !== 'mysql') {
          const qualifiedName = `"${targetSchema}"."${targetTable}"`;
          // 替换 ON "table" 为 ON "schema"."table"
          idxDdl = idxDdl.replace(
            new RegExp(`ON\\s+"${targetTable}"`, 'i'),
            `ON ${qualifiedName}`
          );
        }
        await DbService.executeDDL(targetConnId, idxDdl, targetClient);
      }
      if (indexDDLs.length > 0 && onProgress) {
        onProgress({ step: 'indexes', message: tableExists ? '索引已存在' : `已创建 ${indexDDLs.length} 个索引` });
      }

      // Step 3: 获取总行数
      const totalRows = await DbService.getTableRowCount(sourceConnId, sourceTable, sourceSchema, sourceClient);
      if (totalRows === 0) {
        if (onProgress) onProgress({ step: 'done', message: '无数据需要同步', total: 0, synced: 0 });
        return { total: 0, synced: 0 };
      }

      // Step 4: 分批同步数据
      const batchSize = 1000;
      let synced = 0;

      for (let offset = 0; offset < totalRows; offset += batchSize) {
        const rows = await DbService.readTableData(sourceConnId, sourceTable, offset, batchSize, sourceSchema, sourceClient);
        const inserted = await DbService.batchInsert(targetConnId, targetTable, columnNames, rows, targetSchema, targetClient);
        synced += inserted;

        if (onProgress) {
          onProgress({ step: 'syncing', message: `同步中... ${synced}/${totalRows}`, total: totalRows, synced });
        }
      }

      if (onProgress) onProgress({ step: 'done', message: `同步完成，共 ${synced} 条`, total: totalRows, synced });
      return { total: totalRows, synced };
    } finally {
      if (ownSourceClient) await DbService.closeClient(sourceConn.db_type, sourceClient);
      if (ownTargetClient) await DbService.closeClient(targetConn.db_type, targetClient);
    }
  }
}

module.exports = SyncService;
