const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// 确保数据库目录存在
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 确保日志目录存在
const logDir = path.resolve(dbDir, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

let rawDb = null;
let saveTimer = null;

/**
 * Statement 包装器，提供类似 better-sqlite3 的 API
 */
class StatementWrapper {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  /**
   * 获取单行结果
   */
  get(...params) {
    const stmt = this.database.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        columns.forEach((col, i) => {
          row[col] = values[i];
        });
        return row;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /**
   * 获取所有行
   */
  all(...params) {
    const stmt = this.database.prepare(this.sql);
    const results = [];
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      while (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        columns.forEach((col, i) => {
          row[col] = values[i];
        });
        results.push(row);
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  /**
   * 执行语句（INSERT/UPDATE/DELETE）
   */
  run(...params) {
    this.database.run(this.sql, params);
    const lastId = this.database.exec("SELECT last_insert_rowid() as id")[0];
    const changes = this.database.getRowsModified();
    const id = lastId ? lastId.values[0][0] : 0;
    scheduleSave();
    return { lastInsertRowid: id, changes };
  }
}

/**
 * 延迟保存数据库到文件（防抖 500ms）
 */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (rawDb) {
      const data = rawDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(config.db.path, buffer);
    }
  }, 500);
}

/**
 * 数据库包装器
 */
class DatabaseWrapper {
  constructor(sqlJsDb) {
    this._db = sqlJsDb;
  }

  prepare(sql) {
    return new StatementWrapper(this._db, sql);
  }

  exec(sql) {
    this._db.run(sql);
    scheduleSave();
  }

  pragma(pragmaStr) {
    try {
      this._db.run(`PRAGMA ${pragmaStr}`);
    } catch (e) {
      // 忽略不支持的 pragma
    }
  }
}

// 数据库初始化 Promise（单例）
let dbInstance = null;
const initPromise = (async () => {
  const SQL = await initSqlJs();

  // 如果数据库文件存在则加载
  if (fs.existsSync(config.db.path)) {
    const fileBuffer = fs.readFileSync(config.db.path);
    rawDb = new SQL.Database(fileBuffer);
  } else {
    rawDb = new SQL.Database();
  }

  // 启用 WAL 和外键
  rawDb.run('PRAGMA journal_mode = WAL');
  rawDb.run('PRAGMA foreign_keys = ON');

  const db = new DatabaseWrapper(rawDb);

  // 建表
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      email       TEXT,
      role        TEXT    NOT NULL DEFAULT 'user',
      avatar      TEXT,
      status      TEXT    NOT NULL DEFAULT 'active',
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at  DATETIME DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS project_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'viewer',
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(project_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS gitlab_connections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      url          TEXT    NOT NULL,
      token        TEXT    NOT NULL,
      api_version  TEXT    DEFAULT 'v4',
      scope        TEXT    DEFAULT 'private',
      created_by   INTEGER,
      created_at   DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS business_projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      status      TEXT    DEFAULT 'active',
      created_by  INTEGER,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      name                   TEXT    NOT NULL,
      description            TEXT,
      business_project_id    INTEGER,
      gitlab_connection      INTEGER,
      repo_path              TEXT    NOT NULL,
      default_branch         TEXT    DEFAULT 'main',
      build_type             TEXT    NOT NULL,
      dockerfile_template_id INTEGER,
      build_command          TEXT,
      registry_image         TEXT,
      registry_id            INTEGER,
      status                 TEXT    DEFAULT 'active',
      created_by             INTEGER,
      created_at             DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at             DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (business_project_id) REFERENCES business_projects(id) ON DELETE SET NULL,
      FOREIGN KEY (gitlab_connection) REFERENCES gitlab_connections(id),
      FOREIGN KEY (registry_id) REFERENCES registries(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS dockerfile_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      build_type  TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      variables   TEXT,
      is_system   INTEGER DEFAULT 0,
      created_by  INTEGER,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS builds (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      branch        TEXT    NOT NULL,
      commit_sha    TEXT,
      commit_msg    TEXT,
      build_type    TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      trigger_type  TEXT    DEFAULT 'manual',
      log_path      TEXT,
      image_tag     TEXT,
      image_size    INTEGER,
      duration      INTEGER,
      started_at    DATETIME,
      finished_at   DATETIME,
      triggered_by  INTEGER,
      created_at    DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (triggered_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS build_params (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id  INTEGER NOT NULL,
      key       TEXT    NOT NULL,
      value     TEXT    NOT NULL,
      is_secret INTEGER DEFAULT 0,
      FOREIGN KEY (build_id) REFERENCES builds(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS registries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      username    TEXT,
      password    TEXT,
      type        TEXT    DEFAULT 'docker',
      verify_ssl  INTEGER DEFAULT 1,
      created_by  INTEGER,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS cluster_nodes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      host        TEXT    NOT NULL,
      port        INTEGER DEFAULT 22,
      username    TEXT    NOT NULL,
      auth_type   TEXT    DEFAULT 'password',
      auth_secret TEXT    NOT NULL,
      docker_host TEXT,
      status      TEXT    DEFAULT 'offline',
      labels      TEXT,
      last_check  DATETIME,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS deployments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL,
      build_id       INTEGER NOT NULL,
      node_id        INTEGER NOT NULL,
      image_tag      TEXT    NOT NULL,
      container_name TEXT,
      ports          TEXT,
      env_vars       TEXT,
      volumes        TEXT,
      status         TEXT    DEFAULT 'pending',
      log            TEXT,
      duration       INTEGER,
      deployed_by    INTEGER,
      started_at     DATETIME,
      finished_at    DATETIME,
      created_at     DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (build_id) REFERENCES builds(id),
      FOREIGN KEY (node_id) REFERENCES cluster_nodes(id),
      FOREIGN KEY (deployed_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS deploy_services (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      project_id     INTEGER NOT NULL,
      node_ids       TEXT,
      ports          TEXT,
      env_vars       TEXT,
      volumes        TEXT,
      strategy       TEXT    DEFAULT 'recreate',
      container_name TEXT,
      description    TEXT,
      is_default     INTEGER DEFAULT 0,
      created_by     INTEGER,
      created_at     DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at     DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS deployment_strategies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      type       TEXT    NOT NULL,
      config     TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS cluster_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS db_connections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      db_type     TEXT    NOT NULL,
      host        TEXT    NOT NULL,
      port        INTEGER NOT NULL,
      database    TEXT    NOT NULL,
      username    TEXT    NOT NULL,
      password    TEXT    NOT NULL,
      status      TEXT    DEFAULT 'unknown',
      last_check  DATETIME,
      created_by  INTEGER,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS sync_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_conn_name TEXT   NOT NULL,
      target_conn_name TEXT   NOT NULL,
      source_db_type   TEXT   NOT NULL,
      target_db_type   TEXT   NOT NULL,
      total_tables     INTEGER DEFAULT 0,
      success_count    INTEGER DEFAULT 0,
      fail_count       INTEGER DEFAULT 0,
      status           TEXT    DEFAULT 'completed',
      logs             TEXT    DEFAULT '[]',
      results          TEXT    DEFAULT '[]',
      created_by       INTEGER,
      created_at       DATETIME DEFAULT (datetime('now', 'localtime')),
      finished_at      DATETIME,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_config (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL DEFAULT '默认配置',
      provider          TEXT    DEFAULT 'openai',
      base_url          TEXT,
      api_key           TEXT,
      model             TEXT,
      max_tokens        INTEGER DEFAULT 4096,
      timeout           INTEGER DEFAULT 60,
      context_window    INTEGER,
      support_image     INTEGER DEFAULT 0,
      thinking_mode     INTEGER DEFAULT 0,
      is_default        INTEGER DEFAULT 0,
      enabled           INTEGER DEFAULT 0,
      created_at        DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at        DATETIME DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      user_id     INTEGER NOT NULL,
      role        TEXT    NOT NULL,
      content     TEXT,
      tool_calls  TEXT,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
  ];

  tables.forEach(sql => db.exec(sql));

  // 迁移：为已有的 projects 表添加 registry_id 列
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all();
    const hasRegistryId = columns.some(c => c.name === 'registry_id');
    if (!hasRegistryId) {
      db.exec('ALTER TABLE projects ADD COLUMN registry_id INTEGER REFERENCES registries(id)');
    }
  } catch (e) {
    // projects 表可能不存在，忽略
  }

  // 迁移：为已有的 projects 表添加 business_project_id 列
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all();
    const hasBusinessProjectId = columns.some(c => c.name === 'business_project_id');
    if (!hasBusinessProjectId) {
      db.exec('ALTER TABLE projects ADD COLUMN business_project_id INTEGER REFERENCES business_projects(id) ON DELETE SET NULL');
    }
  } catch (e) {
    // projects 表可能不存在，忽略
  }

  // 迁移：为已有的 builds 表添加 deploy_service_id 列
  try {
    const columns = db.prepare('PRAGMA table_info(builds)').all();
    const hasDeployServiceId = columns.some(c => c.name === 'deploy_service_id');
    if (!hasDeployServiceId) {
      db.exec('ALTER TABLE builds ADD COLUMN deploy_service_id INTEGER REFERENCES deploy_services(id) ON DELETE SET NULL');
    }
  } catch (e) {
    // builds 表可能不存在，忽略
  }

  // 迁移：为已有的 deployments 表添加 deploy_service_id 列
  try {
    const columns = db.prepare('PRAGMA table_info(deployments)').all();
    const hasDeployServiceId = columns.some(c => c.name === 'deploy_service_id');
    if (!hasDeployServiceId) {
      db.exec('ALTER TABLE deployments ADD COLUMN deploy_service_id INTEGER REFERENCES deploy_services(id) ON DELETE SET NULL');
    }
  } catch (e) {
    // deployments 表可能不存在，忽略
  }

  // 迁移：为已有的 cluster_nodes 表添加 group_id 列
  try {
    const columns = db.prepare('PRAGMA table_info(cluster_nodes)').all();
    const hasGroupId = columns.some(c => c.name === 'group_id');
    if (!hasGroupId) {
      db.exec('ALTER TABLE cluster_nodes ADD COLUMN group_id INTEGER REFERENCES cluster_groups(id) ON DELETE SET NULL');
    }
  } catch (e) {
    // cluster_nodes 表可能不存在，忽略
  }

  // 迁移：为 deploy_services 表添加构建配置字段
  try {
    const columns = db.prepare('PRAGMA table_info(deploy_services)').all();
    const colNames = columns.map(c => c.name);
    if (!colNames.includes('branch')) {
      db.exec("ALTER TABLE deploy_services ADD COLUMN branch TEXT DEFAULT 'main'");
    }
    if (!colNames.includes('dockerfile_source')) {
      db.exec("ALTER TABLE deploy_services ADD COLUMN dockerfile_source TEXT DEFAULT 'repository'");
    }
    if (!colNames.includes('dockerfile_template_id')) {
      db.exec('ALTER TABLE deploy_services ADD COLUMN dockerfile_template_id INTEGER');
    }
    if (!colNames.includes('image_name')) {
      db.exec('ALTER TABLE deploy_services ADD COLUMN image_name TEXT');
    }
    if (!colNames.includes('image_tag')) {
      db.exec('ALTER TABLE deploy_services ADD COLUMN image_tag TEXT');
    }
    if (!colNames.includes('dockerfile_path')) {
      db.exec("ALTER TABLE deploy_services ADD COLUMN dockerfile_path TEXT DEFAULT ''");
    }
    // name 列原来是 NOT NULL，改为可空
    const nameCol = columns.find(c => c.name === 'name');
    if (nameCol && nameCol.notnull === 1) {
      db.exec(`
        CREATE TABLE deploy_services_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT,
          project_id     INTEGER NOT NULL,
          node_ids       TEXT,
          ports          TEXT,
          env_vars       TEXT,
          volumes        TEXT,
          strategy       TEXT    DEFAULT 'recreate',
          container_name TEXT,
          description    TEXT,
          is_default     INTEGER DEFAULT 0,
          created_by     INTEGER,
          branch         TEXT    DEFAULT 'main',
          dockerfile_source TEXT DEFAULT 'repository',
          dockerfile_template_id INTEGER,
          image_name     TEXT,
          image_tag      TEXT,
          created_at     DATETIME DEFAULT (datetime('now', 'localtime')),
          updated_at     DATETIME DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);
      db.exec(`
        INSERT INTO deploy_services_new SELECT * FROM deploy_services
      `);
      db.exec('DROP TABLE deploy_services');
      db.exec('ALTER TABLE deploy_services_new RENAME TO deploy_services');
    }
  } catch (e) {
    // deploy_services 表可能不存在，忽略
  }

  // 迁移：为 builds 表添加 auto_deploy 列（构建并部署功能）
  try {
    const columns = db.prepare('PRAGMA table_info(builds)').all();
    const hasAutoDeploy = columns.some(c => c.name === 'auto_deploy');
    if (!hasAutoDeploy) {
      db.exec('ALTER TABLE builds ADD COLUMN auto_deploy INTEGER DEFAULT 0');
    }
    // 为 builds 表添加 deploy_overrides 列（存储构建并部署时的端口/环境变量/卷挂载覆盖值）
    const hasDeployOverrides = columns.some(c => c.name === 'deploy_overrides');
    if (!hasDeployOverrides) {
      db.exec('ALTER TABLE builds ADD COLUMN deploy_overrides TEXT DEFAULT NULL');
    }
  } catch (e) {
    // builds 表可能不存在，忽略
  }

  // 迁移：为资源表添加 scope 字段（公共/私有权限模型）
  const scopeTables = ['registries', 'cluster_nodes', 'db_connections', 'dockerfile_templates', 'gitlab_connections'];
  for (const tbl of scopeTables) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${tbl})`).all();
      const hasScope = columns.some(c => c.name === 'scope');
      if (!hasScope) {
        db.exec(`ALTER TABLE ${tbl} ADD COLUMN scope TEXT DEFAULT 'private'`);
      }
    } catch (e) {
      // 表可能不存在，忽略
    }
  }

  // 迁移：将已有系统内置模板的 scope 从 private 修正为 public
  try {
    db.exec("UPDATE dockerfile_templates SET scope = 'public' WHERE is_system = 1 AND scope = 'private'");
  } catch (e) {
    // 表可能不存在，忽略
  }

  // 迁移：为 deployments 表添加 strategy 列（记录每次部署使用的策略）
  try {
    const columns = db.prepare('PRAGMA table_info(deployments)').all();
    const hasStrategy = columns.some(c => c.name === 'strategy');
    if (!hasStrategy) {
      db.exec("ALTER TABLE deployments ADD COLUMN strategy TEXT DEFAULT 'recreate'");
    }
  } catch (e) {
    // deployments 表可能不存在，忽略
  }

  // 迁移：为 cluster_nodes 补上 created_by 字段
  try {
    const columns = db.prepare('PRAGMA table_info(cluster_nodes)').all();
    const hasCreatedBy = columns.some(c => c.name === 'created_by');
    if (!hasCreatedBy) {
      db.exec('ALTER TABLE cluster_nodes ADD COLUMN created_by INTEGER REFERENCES users(id)');
    }
  } catch (e) {
    // cluster_nodes 表可能不存在，忽略
  }

  // 迁移：创建项目资源绑定表
  const bindingTables = [
    `CREATE TABLE IF NOT EXISTS project_registries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      registry_id INTEGER NOT NULL,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(project_id, registry_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (registry_id) REFERENCES registries(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS project_nodes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      node_id     INTEGER NOT NULL,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(project_id, node_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES cluster_nodes(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS project_db_connections (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL,
      db_connection_id INTEGER NOT NULL,
      created_at       DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(project_id, db_connection_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (db_connection_id) REFERENCES db_connections(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS project_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL,
      template_id INTEGER NOT NULL,
      created_at  DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(project_id, template_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES dockerfile_templates(id) ON DELETE CASCADE
    )`,
  ];
  bindingTables.forEach(sql => db.exec(sql));

  // 创建 business_project_members 表（用户关联到 business_project 而非 project）
  db.exec(`CREATE TABLE IF NOT EXISTS business_project_members (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    business_project_id INTEGER NOT NULL,
    user_id             INTEGER NOT NULL,
    role                TEXT    NOT NULL DEFAULT 'viewer',
    created_at          DATETIME DEFAULT (datetime('now', 'localtime')),
    UNIQUE(business_project_id, user_id),
    FOREIGN KEY (business_project_id) REFERENCES business_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // 迁移：从 project_members 推导 business_project_members（仅当表为空时）
  try {
    const bpmCount = db.prepare('SELECT COUNT(*) as count FROM business_project_members').get();
    if (bpmCount.count === 0) {
      db.exec(`
        INSERT OR IGNORE INTO business_project_members (business_project_id, user_id, role)
        SELECT p.business_project_id, pm.user_id, pm.role
        FROM project_members pm
        JOIN projects p ON pm.project_id = p.id
        WHERE p.business_project_id IS NOT NULL
      `);
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 迁移：为 projects 表添加部署配置字段（合并 deploy_services 功能）
  const projectDeployColumns = [
    { name: 'node_ids', type: 'TEXT' },
    { name: 'ports', type: 'TEXT' },
    { name: 'env_vars', type: 'TEXT' },
    { name: 'volumes', type: 'TEXT' },
    { name: 'strategy', type: "TEXT DEFAULT 'recreate'" },
    { name: 'container_name', type: 'TEXT' },
    { name: 'dockerfile_source', type: "TEXT DEFAULT 'repository'" },
    { name: 'image_name', type: 'TEXT' },
    { name: 'image_tag', type: 'TEXT' },
    { name: 'dockerfile_path', type: "TEXT DEFAULT ''" },
  ];
  for (const col of projectDeployColumns) {
    try {
      const columns = db.prepare('PRAGMA table_info(projects)').all();
      const hasColumn = columns.some(c => c.name === col.name);
      if (!hasColumn) {
        db.exec(`ALTER TABLE projects ADD COLUMN ${col.name} ${col.type}`);
      }
    } catch (e) {
      // 忽略
    }
  }

  // 迁移：从 deploy_services 合并数据到 projects（仅当 projects 的 node_ids 为空时）
  try {
    const emptyDeploy = db.prepare("SELECT COUNT(*) as count FROM projects WHERE node_ids IS NULL OR node_ids = ''").get();
    if (emptyDeploy.count > 0) {
      // 将每个 project 的第一个（is_default=1 优先）deploy_service 数据合并到 projects
      const deployServices = db.prepare(`
        SELECT ds.*, p.id as pid FROM deploy_services ds
        JOIN projects p ON ds.project_id = p.id
        WHERE p.node_ids IS NULL OR p.node_ids = ''
        ORDER BY ds.is_default DESC, ds.id ASC
      `).all();
      
      const updateStmt = db.prepare(`
        UPDATE projects SET 
          node_ids = ?, ports = ?, env_vars = ?, volumes = ?, 
          strategy = ?, container_name = ?, dockerfile_source = ?,
          image_name = ?, image_tag = ?, dockerfile_path = ?
        WHERE id = ?
      `);
      
      for (const ds of deployServices) {
        // 只取每个 project 的第一个 deploy_service
        const project = db.prepare('SELECT node_ids FROM projects WHERE id = ?').get(ds.pid);
        if (project && (project.node_ids === null || project.node_ids === '')) {
          updateStmt.run(
            ds.node_ids || null,
            ds.ports || null,
            ds.env_vars || null,
            ds.volumes || null,
            ds.strategy || 'recreate',
            ds.container_name || null,
            ds.dockerfile_source || 'repository',
            ds.image_name || null,
            ds.image_tag || null,
            ds.dockerfile_path || '',
            ds.pid
          );
        }
      }
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 迁移：为 users 表添加 name（显示名称）列
  try {
    const hasNameCol = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('users') WHERE name='name'").get();
    if (hasNameCol.c === 0) {
      db.exec("ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''");
      // 回填：把已有用户的 name 设为 username
      db.exec("UPDATE users SET name = username WHERE name = '' OR name IS NULL");
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 迁移：ai_config 表结构简化（去掉 custom_* 字段，增加 context_window/support_image/thinking_mode）
  try {
    const hasContextWindow = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('ai_config') WHERE name='context_window'").get();
    if (hasContextWindow.c === 0) {
      db.exec("ALTER TABLE ai_config ADD COLUMN context_window INTEGER");
      db.exec("ALTER TABLE ai_config ADD COLUMN support_image INTEGER DEFAULT 0");
      db.exec("ALTER TABLE ai_config ADD COLUMN thinking_mode INTEGER DEFAULT 0");
    }
    // 删除旧的 custom 字段（如果存在）
    for (const col of ['custom_method', 'custom_headers', 'request_template', 'response_parser']) {
      const hasCol = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('ai_config') WHERE name='${col}'`).get();
      if (hasCol.c > 0) {
        // SQLite 不支持 DROP COLUMN 旧版本，通过重建表实现
        // 这里简单跳过，不影响使用
      }
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 迁移：ai_config 支持多条记录（添加 name 和 is_default 字段）
  try {
    const hasNameCol = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('ai_config') WHERE name='name'").get();
    if (hasNameCol.c === 0) {
      db.exec("ALTER TABLE ai_config ADD COLUMN name TEXT NOT NULL DEFAULT '默认配置'");
      db.exec("ALTER TABLE ai_config ADD COLUMN is_default INTEGER DEFAULT 0");
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 迁移：ai_conversations 添加 reasoning 字段（支持思考模式多轮回传）
  try {
    const hasReasoningCol = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('ai_conversations') WHERE name='reasoning'").get();
    if (hasReasoningCol.c === 0) {
      db.exec("ALTER TABLE ai_conversations ADD COLUMN reasoning TEXT");
    }
  } catch (e) {
    // 迁移失败不影响启动
  }

  // 插入系统内置 Dockerfile 模板（仅首次）
  const templateCount = db.prepare('SELECT COUNT(*) as count FROM dockerfile_templates WHERE is_system = 1').get();
  if (templateCount.count === 0) {
    const insertSql = 'INSERT INTO dockerfile_templates (name, description, build_type, content, variables, is_system, scope) VALUES (?, ?, ?, ?, ?, 1, \'public\')';

    db.prepare(insertSql).run(
      'Java Maven 标准模板',
      '适用于 Spring Boot 等 Maven 项目，多阶段构建',
      'java',
      `FROM maven:3.9-eclipse-temurin-17 AS builder\nWORKDIR /app\nCOPY pom.xml .\nRUN mvn dependency:go-offline\nCOPY src ./src\nRUN mvn package -DskipTests\n\nFROM eclipse-temurin:17-jre-alpine\nWORKDIR /app\nCOPY --from=builder /app/target/*.jar app.jar\nEXPOSE {{port}}\nENTRYPOINT ["java", "-jar", "app.jar"]`,
      JSON.stringify([{ name: 'port', default: '8080', description: '服务端口' }])
    );

    db.prepare(insertSql).run(
      'Java Gradle 标准模板',
      '适用于 Gradle 构建的 Java 项目',
      'java',
      `FROM gradle:8-jdk17 AS builder\nWORKDIR /app\nCOPY build.gradle settings.gradle ./\nCOPY src ./src\nRUN gradle build -x test\n\nFROM eclipse-temurin:17-jre-alpine\nWORKDIR /app\nCOPY --from=builder /app/build/libs/*.jar app.jar\nEXPOSE {{port}}\nENTRYPOINT ["java", "-jar", "app.jar"]`,
      JSON.stringify([{ name: 'port', default: '8080', description: '服务端口' }])
    );

    db.prepare(insertSql).run(
      'Vue 标准模板',
      '适用于 Vue.js 项目，使用 Nginx 部署',
      'vue',
      `FROM node:18-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM nginx:alpine\nCOPY --from=builder /app/dist /usr/share/nginx/html\nEXPOSE {{port}}\nCMD ["nginx", "-g", "daemon off;"]`,
      JSON.stringify([{ name: 'port', default: '80', description: '服务端口' }])
    );

    db.prepare(insertSql).run(
      '自定义模板',
      '空白模板，可自由编写 Dockerfile',
      'custom',
      `FROM {{base_image}}\nWORKDIR /app\nCOPY . .\n{{custom_commands}}\nEXPOSE {{port}}`,
      JSON.stringify([
        { name: 'base_image', default: 'alpine:latest', description: '基础镜像' },
        { name: 'port', default: '8080', description: '服务端口' },
        { name: 'custom_commands', default: '# 在此添加自定义命令', description: '自定义构建命令' },
      ])
    );
  }

  console.log('[DB] Database initialized successfully');
  return db;
})();

// 在 initPromise 完成后设置 dbInstance
initPromise.then((db) => {
  dbInstance = db;
});

/**
 * 获取数据库实例
 */
function getDb() {
  if (!dbInstance) throw new Error('Database not initialized yet');
  return dbInstance;
}

module.exports = {
  initPromise,
  getDb,
  // 兼容旧代码中的 db.prepare(...) 调用方式
  prepare: (...args) => getDb().prepare(...args),
  exec: (...args) => getDb().exec(...args),
  pragma: (...args) => getDb().pragma(...args),
};
