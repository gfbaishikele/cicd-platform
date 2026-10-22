/**
 * Docker HEALTHCHECK 脚本
 * 使用 Node.js 内置 http 模块，无需安装 wget/curl
 * 退出码 0 = healthy，退出码 1 = unhealthy
 */
const http = require('http');

const port = process.env.PORT || 8080;
const url = `http://localhost:${port}/api/health`;

const req = http.get(url, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});

req.on('error', () => {
  process.exit(1);
});

req.setTimeout(3000, () => {
  req.destroy();
  process.exit(1);
});
