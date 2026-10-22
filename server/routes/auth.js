const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { hashPassword, comparePassword } = require('../utils/hash');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authMiddleware } = require('../middleware/auth');
const { registerRules, loginRules, validate } = require('../middleware/validator');
const logger = require('../utils/logger');

/**
 * POST /api/auth/register
 * 用户注册（首个用户自动成为 admin）
 */
router.post('/register', registerRules, validate, async (req, res) => {
  try {
    const { username, password, email, name } = req.body;

    // 检查用户名是否已存在
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({
        code: 40001,
        message: '用户名已存在',
      });
    }

    // 判断是否为第一个用户（自动成为 admin）
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const role = userCount.count === 0 ? 'admin' : 'user';

    // 哈希密码
    const hashedPassword = await hashPassword(password);

    // 插入用户
    const result = db.prepare(
      'INSERT INTO users (username, password, email, name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hashedPassword, email || null, name || username, role);

    const user = db.prepare(
      'SELECT id, username, name, email, role, status, created_at FROM users WHERE id = ?'
    ).get(result.lastInsertRowid);

    logger.info(`User registered: ${username} (name: ${name}) (role: ${role})`);

    res.status(201).json({
      code: 0,
      data: user,
    });
  } catch (err) {
    logger.error(`Register failed: ${err.message}`);
    res.status(500).json({
      code: 50001,
      message: '注册失败',
    });
  }
});

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', loginRules, validate, async (req, res) => {
  try {
    const { username, password } = req.body;

    // 查找用户
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(400).json({
        code: 40002,
        message: '用户名或密码错误',
      });
    }

    // 检查状态
    if (user.status !== 'active') {
      return res.status(403).json({
        code: 40301,
        message: '账号已被禁用，请联系管理员',
      });
    }

    // 验证密码
    const valid = await comparePassword(password, user.password);
    if (!valid) {
      return res.status(400).json({
        code: 40002,
        message: '用户名或密码错误',
      });
    }

    // 生成 Token
    const payload = { id: user.id, username: user.username, name: user.name, role: user.role };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // 设置 Refresh Token Cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 天
    });

    logger.info(`User logged in: ${username}`);

    res.json({
      code: 0,
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
        },
        accessToken,
      },
    });
  } catch (err) {
    logger.error(`Login failed: ${err.message}`);
    res.status(500).json({
      code: 50001,
      message: '登录失败',
    });
  }
});

/**
 * POST /api/auth/refresh
 * 刷新 Access Token
 */
router.post('/refresh', (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({
        code: 40103,
        message: '未提供 Refresh Token',
      });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const payload = { id: decoded.id, username: decoded.username, name: decoded.name, role: decoded.role };
    const accessToken = generateAccessToken(payload);

    res.json({
      code: 0,
      data: { accessToken },
    });
  } catch (err) {
    logger.warn(`Token refresh failed: ${err.message}`);
    res.status(401).json({
      code: 40101,
      message: 'Refresh Token 已过期，请重新登录',
    });
  }
});

/**
 * POST /api/auth/logout
 * 退出登录
 */
router.post('/logout', authMiddleware, (req, res) => {
  res.clearCookie('refreshToken');
  logger.info(`User logged out: ${req.user.username}`);
  res.json({
    code: 0,
    message: '已退出登录',
  });
});

/**
 * GET /api/auth/me
 * 获取当前用户信息
 */
router.get('/me', authMiddleware, (req, res) => {
  res.json({
    code: 0,
    data: req.user,
  });
});

module.exports = router;
