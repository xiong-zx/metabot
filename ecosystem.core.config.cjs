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

const dataDir = process.env.METABOT_CORE_DATA_DIR
  || path.join(os.homedir(), '.metabot-core', 'data');
const logDir = path.join(os.homedir(), '.metabot-core', 'logs');
const releaseVersion = require('./package.json').version;

module.exports = {
  apps: [
    {
      name: 'metabot-core',
      script: 'packages/server/dist/index.js',
      interpreter: runtimeNode,
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      error_file: path.join(logDir, 'error.log'),
      out_file: path.join(logDir, 'out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        METABOT_CORE_HOST: process.env.METABOT_CORE_HOST || '127.0.0.1',
        METABOT_CORE_PORT: process.env.METABOT_CORE_PORT || '9200',
        METABOT_CORE_DATA_DIR: dataDir,
        METABOT_RELEASE_VERSION: releaseVersion,
        METABOT_CORE_UI_ALLOWED_EMAILS: '',
        METABOT_PUBLIC_DISTRIBUTION: '0',
        LOG_FORMAT: process.env.LOG_FORMAT || 'json',
      },
    },
  ],
};
