const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');

const fileEnv = fs.existsSync(path.join(__dirname, '.env'))
  ? dotenv.parse(fs.readFileSync(path.join(__dirname, '.env')))
  : {};
const configured = (name, fallback) => process.env[name] || fileEnv[name] || fallback;
const runtimeNode = configured('METABOT_NODE_INTERPRETER', process.execPath);
if (!path.isAbsolute(runtimeNode) || !fs.existsSync(runtimeNode)) {
  throw new Error('METABOT_NODE_INTERPRETER must be an existing absolute path');
}
const runtimeNodeVersion = execFileSync(runtimeNode, ['--version'], {
  encoding: 'utf8',
  timeout: 5_000,
}).trim();
const versionMatch = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(runtimeNodeVersion);
if (!versionMatch) throw new Error(`Could not parse Node.js version: ${runtimeNodeVersion}`);
const [, nodeMajor, nodeMinor, nodePatch] = versionMatch.map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  throw new Error(`MetaBot requires Node.js >=22.19.0; configured interpreter reports ${nodeMajor}.${nodeMinor}.${nodePatch}`);
}
const stateRoot = configured('METABOT_STATE_DIR', path.join(os.homedir(), '.metabot'));
const keysDir = configured('METABOT_KEYS_DIR', path.join(stateRoot, 'keys'));
const workerEndpoint = configured(
  'METABOT_WORKER_DAEMON_URL',
  configured('METABOT_WORKER_LISTEN', 'http://127.0.0.1:9311/mcp'),
);
const callbackUrl = configured(
  'METABOT_TERMINAL_CALLBACK_URL',
  `http://127.0.0.1:${configured('API_PORT', '9100')}/api/worker-events`,
);
const ordinaryProxyNames = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
];
const proxyEnv = Object.fromEntries(
  ordinaryProxyNames
    .map((name) => [name, process.env[name] || fileEnv[name]])
    .filter(([, value]) => typeof value === 'string' && value.length > 0),
);
const workerAllowlist = [...new Set([
  ...ordinaryProxyNames,
  ...configured('METABOT_WORKER_ENV_ALLOWLIST', '').split(',').map((value) => value.trim()).filter(Boolean),
])].join(',');
const common = {
  cwd: __dirname,
  interpreter: runtimeNode,
  watch: false,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 3000,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'metabot',
      script: 'src/index.ts',
      // `node --import tsx` is portable across POSIX and Windows PM2 hosts.
      interpreter_args: '--import tsx',
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      env: {
        NODE_ENV: 'production',
        METABOT_HOME: __dirname,
        CLAUDE_MAX_TURNS: '',
        ...proxyEnv,
      },
    },
    {
      ...common,
      name: 'metabot-worker-runnerd',
      script: 'packages/worker-runner-mcp/dist/daemon-cli.js',
      error_file: path.join(__dirname, 'logs', 'worker-runner-error.log'),
      out_file: path.join(__dirname, 'logs', 'worker-runner-out.log'),
      env: {
        NODE_ENV: 'production',
        METABOT_HOME: __dirname,
        METABOT_WORKER_DATA_DIR: configured('METABOT_WORKER_DATA_DIR', path.join(stateRoot, 'worker-runner')),
        METABOT_WORKER_LISTEN: workerEndpoint,
        METABOT_WORKER_CAPABILITY_PUBLIC_KEY_FILE: configured(
          'METABOT_WORKER_CAPABILITY_PUBLIC_KEY_FILE',
          path.join(keysDir, 'worker-capability.pub'),
        ),
        METABOT_WORKER_CALLBACK_URL: configured('METABOT_WORKER_CALLBACK_URL', callbackUrl),
        METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE: configured(
          'METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE',
          path.join(keysDir, 'worker-callback.key'),
        ),
        METABOT_WORKER_ENV_ALLOWLIST: workerAllowlist,
        ...proxyEnv,
      },
    },
  ],
};
