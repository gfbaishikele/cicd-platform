const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { socketAuthMiddleware } = require('./middleware/auth');
const { initPromise } = require('./db/init');

// 创建 Express 应用
const app = express();
const server = http.createServer(app);

// Socket.IO 配置
const io = new Server(server, {
  cors: {
    origin: config.nodeEnv === 'production' ? true : config.clientUrl,
    credentials: true,
  },
});

// ============ 中间件 ============

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    // 允许无 origin 的请求（同源、服务端、curl）
    if (!origin) return callback(null, true);
    // 生产环境：前端和后端同源，允许所有来源
    if (config.nodeEnv === 'production') return callback(null, true);
    // 开发环境：只允许配置的客户端地址
    if (origin === config.clientUrl) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 请求日志
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// 健康检查（不依赖数据库）
app.get('/api/health', (req, res) => {
  res.json({
    code: 0,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

// ============ 启动服务（等待数据库初始化） ============

async function startServer() {
  try {
    await initPromise;
    logger.info('Database initialized');

    // 注册路由（需要数据库就绪）
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/users', require('./routes/users'));
    app.use('/api/gitlab', require('./routes/gitlab'));
    app.use('/api/business-projects', require('./routes/businessProjects'));
    app.use('/api/projects', require('./routes/projects'));
    app.use('/api/templates', require('./routes/templates'));
    app.use('/api/builds', require('./routes/builds'));
    app.use('/api/registries', require('./routes/registries'));
    app.use('/api/clusters', require('./routes/clusters'));
    app.use('/api/deployments', require('./routes/deployments'));
    app.use('/api/deploy-services', require('./routes/deployServices'));
    app.use('/api/db-connections', require('./routes/dbConnections'));
    app.use('/api/ai', require('./routes/ai'));

    // 404 处理（必须在路由之后）
    app.use('/api/*', (req, res) => {
      res.status(404).json({ code: 40004, message: '接口不存在' });
    });

    // 前端静态文件服务（生产环境）
    const publicPath = path.resolve(__dirname, '../public');
    if (require('fs').existsSync(publicPath)) {
      app.use(express.static(publicPath));
      // SPA 路由回退：非 API 请求都返回 index.html
      app.get('*', (req, res) => {
        res.sendFile(path.join(publicPath, 'index.html'));
      });
    }

    // 全局错误处理
    app.use((err, req, res, next) => {
      logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
      res.status(500).json({ code: 50001, message: '服务器内部错误' });
    });

    // Socket.IO 认证与事件
    io.use(socketAuthMiddleware);

    io.on('connection', (socket) => {
      logger.info(`Socket connected: ${socket.user.username} (${socket.id})`);

      socket.on('subscribe-build', (buildId) => {
        socket.join(`build:${buildId}`);
        const fs = require('fs');
        const logPath = path.join(config.build.logDir, `${buildId}.log`);
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf-8');
          socket.emit('build-log-history', { buildId, logs: content });
        }
      });

      socket.on('unsubscribe-build', (buildId) => {
        socket.leave(`build:${buildId}`);
      });

      socket.on('subscribe-deploy', (deploymentId) => {
        socket.join(`deploy:${deploymentId}`);
      });

      socket.on('unsubscribe-deploy', (deploymentId) => {
        socket.leave(`deploy:${deploymentId}`);
      });

      socket.on('disconnect', () => {
        logger.debug(`Socket disconnected: ${socket.user.username} (${socket.id})`);
      });
    });

    app.set('io', io);

    server.listen(config.port, '0.0.0.0', () => {
      logger.info(`CI/CD Platform server running on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`API: http://0.0.0.0:${config.port}/api`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

startServer();

module.exports = { app, server, io };
