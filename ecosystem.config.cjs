const path = require('path');

// PM2 evaluates this file before the bridge loads src/config.ts. Load the
// deployment .env here as well so proxy settings are part of the process
// contract, including runtime switches initiated from a minimal SSH shell.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env'), override: false });
} catch {
  // Packaged installs may inject all settings through the supervisor instead.
}

const noProxyEntries = [
  ...(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((item) => item.trim()).filter(Boolean),
  'localhost',
  '127.0.0.1',
  'open.feishu.cn',
  '*.feishu.cn',
  'lark.larksuite.com',
  '*.larksuite.com',
  'modelscope.com',
  'aliyuncs.com',
  'tencentyun.com',
  'wisemodel.cn',
];
const mergedNoProxy = [...new Set(noProxyEntries)].join(',');
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || httpProxy;

const memoryWriteRoots = [
  '/users',
  '/shared',
  '/metabot',
  '/savio',
];

module.exports = {
  apps: [
    {
      name: 'metabot',
      script: 'src/index.ts',
      // Use `node --import tsx` instead of the tsx wrapper script.
      // The wrapper in node_modules/.bin/tsx is a POSIX shell script with no
      // .cmd shim, so PM2's child_process.spawn can't exec it on Windows
      // (EINVAL). `node --import tsx` is tsx 4.x's documented cross-platform
      // entrypoint and works identically on Linux/macOS/Windows.
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,

      // Watch disabled — use `metabot restart` to apply code changes manually
      watch: false,

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Logs
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Environment
      env: {
        NODE_ENV: 'production',
        METABOT_HOME: __dirname,
        CLAUDE_MAX_TURNS: '',  // unlimited turns (override any inherited shell env)
        ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
        ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
        no_proxy: mergedNoProxy,
        NO_PROXY: mergedNoProxy,
      },
    },
    {
      name: 'metabot-core',
      script: 'packages/server/src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      error_file: path.join(__dirname, 'logs', 'metabot-core-error.log'),
      out_file: path.join(__dirname, 'logs', 'metabot-core-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        METABOT_CORE_HOST: '127.0.0.1',
        METABOT_CORE_PORT: '9200',
        METABOT_CORE_MEMORY_WRITE_ROOTS: memoryWriteRoots.join(','),
      },
    },
  ],
};
