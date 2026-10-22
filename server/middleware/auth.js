const { verifyAccessToken } = require('../utils/jwt');
const db = require('../db/init');
const logger = require('../utils/logger');

/**
 * JWT 认证中间件
 * 从 Authorization header 中提取并验证 token
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      code: 40103,
      message: '未登录，请先登录',
    });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = verifyAccessToken(token);
    // 查询用户是否存在且状态正常
    const user = db.prepare('SELECT id, username, name, role, status FROM users WHERE id = ?').get(decoded.id);

    if (!user) {
      return res.status(401).json({
        code: 40102,
        message: '用户不存在',
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        code: 40301,
        message: '账号已被禁用',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        code: 40101,
        message: 'Token 已过期',
      });
    }
    logger.warn(`Token verification failed: ${err.message}`);
    return res.status(401).json({
      code: 40102,
      message: 'Token 无效',
    });
  }
}

/**
 * Socket.IO 认证中间件
 */
function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('未提供认证 token'));
  }

  try {
    const decoded = verifyAccessToken(token);
    const user = db.prepare('SELECT id, username, name, role, status FROM users WHERE id = ?').get(decoded.id);

    if (!user || user.status !== 'active') {
      return next(new Error('用户不存在或已被禁用'));
    }

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Token 无效或已过期'));
  }
}

module.exports = {
  authMiddleware,
  socketAuthMiddleware,
};
