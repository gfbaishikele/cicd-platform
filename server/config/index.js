const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    path: path.resolve(__dirname, '../../', process.env.DB_PATH || './data/cicd.db'),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'default-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '2h',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || '0'.repeat(64),
  },

  build: {
    workspace: path.resolve(__dirname, '../../', process.env.BUILD_WORKSPACE || './data/builds'),
    timeout: parseInt(process.env.BUILD_TIMEOUT, 10) || 600,
    logDir: path.resolve(__dirname, '../../', process.env.BUILD_LOG_DIR || './data/build-logs'),
  },

  docker: {
    host: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
  },

  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
};

module.exports = config;
