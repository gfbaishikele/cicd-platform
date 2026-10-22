# ====================
# 阶段 1: 构建前端
# ====================
FROM node:18-alpine AS client-builder

WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci --registry=https://registry.npmmirror.com && npm cache clean --force
COPY client/ .
RUN npm run build

# ====================
# 阶段 2: 安装后端生产依赖
# ====================
FROM node:18-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force

# ====================
# 阶段 3: 运行时（最小化）
# ====================
FROM node:18-alpine

# 合并安装 + 创建目录为单层，减少镜像层数
RUN apk add --no-cache \
      docker-cli \
      openssh-client \
      git \
      tzdata \
    && mkdir -p /app/data/builds /app/data/build-logs /app/data/logs

WORKDIR /app

# 从 deps 阶段复制生产依赖（不含构建缓存）
COPY --from=deps /app/node_modules ./node_modules

# 复制后端代码
COPY server/ ./server/

# 复制前端构建产物
COPY --from=client-builder /app/client/dist ./public

# 环境变量（PORT 默认 8080，docker-compose 可通过 APP_PORT 覆盖）
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/cicd.db \
    BUILD_WORKSPACE=/app/data/builds \
    BUILD_LOG_DIR=/app/data/build-logs

# 健康检查（独立脚本，避免 shell 引号和变量展开问题）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node server/healthcheck.js

VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
