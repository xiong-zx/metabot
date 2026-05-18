import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import type { PeerConfig } from '../config.js';
import type { BotInfo } from './bot-registry.js';

export interface PeerBotInfo extends BotInfo {
  peerUrl: string;
  peerName: string;
}

export interface PeerSkillInfo {
  name: string;
  description: string;
  version: number;
  author: string;
  tags: string[];
  peerUrl: string;
  peerName: string;
}

export interface PeerStatus {
  name: string;
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  botCount: number;
  error?: string;
}

interface PeerState {
  config: PeerConfig;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  bots: PeerBotInfo[];
  skills: PeerSkillInfo[];
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const TASK_FORWARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60_000;
const REGISTER_RETRY_INITIAL_MS = 1_000;
const REGISTER_RETRY_MAX_MS = 30_000;
const AGENT_BUS_FAIL_LOG_THRESHOLD = 3;

function loadMetabotCoreToken(): string | undefined {
  if (process.env.METABOT_CORE_TOKEN) return process.env.METABOT_CORE_TOKEN;
  const candidate = path.join(os.homedir(), '.metabot-core', 'token');
  try {
    const raw = fs.readFileSync(candidate, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    /* missing/unreadable — caller warns */
  }
  return undefined;
}

export class PeerManager {
  private peers: Map<string, PeerState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private logger: Logger;

  // Registry mode (set when METABOT_CORE_AGENT_BUS_URL is configured).
  private agentBusUrl?: string;
  private agentBusToken?: string;
  private selfUrl?: string;
  private selfTalkSecret?: string;
  private agentBusFailureCount = 0;

  constructor(configs: PeerConfig[], logger: Logger) {
    this.logger = logger.child({ module: 'peers' });

    for (const config of configs) {
      const normalizedUrl = config.url.replace(/\/+$/, '');
      this.peers.set(config.name, {
        config: { ...config, url: normalizedUrl },
        healthy: false,
        lastChecked: 0,
        lastHealthy: 0,
        bots: [],
        skills: [],
      });
    }

    const rawBus = process.env.METABOT_CORE_AGENT_BUS_URL?.trim();
    if (rawBus) {
      this.agentBusUrl = rawBus.replace(/\/+$/, '');
      this.agentBusToken = loadMetabotCoreToken();
      this.selfUrl = process.env.METABOT_AGENT_SELF_URL?.trim();
      this.selfTalkSecret = process.env.METABOT_AGENT_TALK_SECRET?.trim();

      if (configs.length > 0) {
        this.logger.warn(
          { staticPeers: configs.map((c) => c.name) },
          'METABOT_CORE_AGENT_BUS_URL is set — static peer configs will be shadowed by registry entries with matching URL+talkSecret',
        );
      }
      if (!this.agentBusToken) {
        this.logger.warn(
          { agentBusUrl: this.agentBusUrl },
          'Registry mode enabled but no METABOT_CORE_TOKEN / ~/.metabot-core/token found — agent-bus calls will fail with 401',
        );
      }
      if (!this.selfUrl || !this.selfTalkSecret) {
        this.logger.warn(
          'Registry mode enabled but METABOT_AGENT_SELF_URL or METABOT_AGENT_TALK_SECRET is unset — self-register will be skipped',
        );
      } else {
        this.selfRegisterWithRetry().catch((err) => {
          this.logger.error({ err }, 'Self-register loop terminated unexpectedly');
        });
        this.heartbeatTimer = setInterval(() => {
          this.sendHeartbeat().catch((err) => {
            this.logger.warn({ err: err?.message }, 'Heartbeat failed');
          });
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref();
      }
    }

    const interval = process.env.METABOT_PEER_POLL_INTERVAL_MS
      ? parseInt(process.env.METABOT_PEER_POLL_INTERVAL_MS, 10)
      : DEFAULT_POLL_INTERVAL_MS;

    const hasWorkToPoll = this.peers.size > 0 || this.agentBusUrl !== undefined;
    if (hasWorkToPoll) {
      this.pollTimer = setInterval(() => {
        this.runPollTick().catch((err) => {
          this.logger.error({ err }, 'Peer refresh cycle failed');
        });
      }, interval);
      this.pollTimer.unref();
    }
  }

  /**
   * One poll tick: if registry mode is on, fetch /api/agents to rebuild the
   * peers map (preserving cached bots/skills/healthy for entries whose
   * url+talkSecret are unchanged); then run refreshAll() against whatever
   * peers we ended up with.
   */
  private async runPollTick(): Promise<void> {
    if (this.agentBusUrl) {
      try {
        await this.rebuildPeersFromAgentBus();
        this.agentBusFailureCount = 0;
      } catch (err: any) {
        this.agentBusFailureCount++;
        if (this.agentBusFailureCount === 1) {
          this.logger.warn(
            { agentBusUrl: this.agentBusUrl, err: err?.message },
            'agent bus unreachable, falling back to static configs',
          );
        } else if (this.agentBusFailureCount >= AGENT_BUS_FAIL_LOG_THRESHOLD) {
          this.logger.error(
            { agentBusUrl: this.agentBusUrl, failures: this.agentBusFailureCount, err: err?.message },
            'agent bus repeatedly unreachable — peer discovery degraded',
          );
        }
      }
    }
    await this.refreshAll();
  }

  /**
   * Self-register on boot with exponential backoff (1s, 2s, 4s, … capped at
   * 30s). Single best-effort loop kicked off from the constructor — failures
   * never crash the bridge.
   */
  private async selfRegisterWithRetry(): Promise<void> {
    let delayMs = REGISTER_RETRY_INITIAL_MS;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await this.postSelfRegister();
        this.logger.info(
          { agentBusUrl: this.agentBusUrl, selfUrl: this.selfUrl, attempt },
          'registered with agent bus',
        );
        return;
      } catch (err: any) {
        this.logger.warn(
          { agentBusUrl: this.agentBusUrl, attempt, err: err?.message, nextDelayMs: delayMs },
          'self-register failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, REGISTER_RETRY_MAX_MS);
      }
    }
  }

  private async postSelfRegister(): Promise<void> {
    if (!this.agentBusUrl || !this.selfUrl || !this.selfTalkSecret) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const resp = await proxyFetch(`${this.agentBusUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: this.selfUrl,
        talkSecret: this.selfTalkSecret,
        visible: true,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.agentBusUrl) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const resp = await proxyFetch(`${this.agentBusUrl}/api/agents/heartbeat`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
  }

  private async rebuildPeersFromAgentBus(): Promise<void> {
    if (!this.agentBusUrl) return;
    const headers: Record<string, string> = {};
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const resp = await proxyFetch(`${this.agentBusUrl}/api/agents`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      agents: Array<{ botName: string; url: string; talkSecret: string }>;
    };

    const next = new Map<string, PeerState>();
    for (const entry of data.agents || []) {
      if (!entry.botName || !entry.url) continue;
      // Skip our own row — we don't talk to ourselves over the peer RPC.
      if (this.selfUrl && entry.url.replace(/\/+$/, '') === this.selfUrl.replace(/\/+$/, '')) {
        continue;
      }
      const normalizedUrl = entry.url.replace(/\/+$/, '');
      const newConfig: PeerConfig = {
        name: entry.botName,
        url: normalizedUrl,
        ...(entry.talkSecret ? { secret: entry.talkSecret } : {}),
      };
      const prev = this.peers.get(entry.botName);
      const unchanged =
        prev &&
        prev.config.url === normalizedUrl &&
        prev.config.secret === entry.talkSecret;
      next.set(entry.botName, unchanged
        ? prev
        : {
            config: newConfig,
            healthy: false,
            lastChecked: 0,
            lastHealthy: 0,
            bots: [],
            skills: [],
          });
    }
    this.peers = next;
  }

  async refreshAll(): Promise<void> {
    const tasks = Array.from(this.peers.values()).map((state) =>
      this.refreshPeer(state),
    );
    await Promise.allSettled(tasks);
  }

  private async refreshPeer(state: PeerState): Promise<void> {
    const { config } = state;
    const headers: Record<string, string> = {
      'X-MetaBot-Origin': 'peer',
    };
    if (config.secret) {
      headers['Authorization'] = `Bearer ${config.secret}`;
    }

    try {
      // Fetch bots and skills in parallel
      const [botsResp, skillsResp] = await Promise.all([
        proxyFetch(`${config.url}/api/bots`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
        proxyFetch(`${config.url}/api/skills`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch(() => null), // Skills endpoint may not exist on older peers
      ]);

      if (!botsResp.ok) {
        throw new Error(`HTTP ${botsResp.status}: ${botsResp.statusText}`);
      }

      const botsData = (await botsResp.json()) as {
        bots: Array<{
          name: string;
          description?: string;
          platform: string;
          engine?: BotInfo['engine'];
          model?: string;
          workingDirectory: string;
          peerUrl?: string;
        }>;
      };

      // Filter out transitive bots (bots that already have a peerUrl — they came from another peer)
      const directBots: PeerBotInfo[] = (botsData.bots || [])
        .filter((b) => !b.peerUrl)
        .map((b) => ({
          name: b.name,
          ...(b.description ? { description: b.description } : {}),
          platform: b.platform,
          engine: b.engine ?? 'claude',
          ...(b.model ? { model: b.model } : {}),
          workingDirectory: b.workingDirectory,
          peerUrl: config.url,
          peerName: config.name,
        }));

      // Parse peer skills
      let peerSkills: PeerSkillInfo[] = [];
      if (skillsResp?.ok) {
        const skillsData = (await skillsResp.json()) as {
          skills: Array<{
            name: string;
            description: string;
            version: number;
            author: string;
            tags: string[];
            peerUrl?: string;
          }>;
        };
        // Filter out transitive skills
        peerSkills = (skillsData.skills || [])
          .filter((s) => !s.peerUrl)
          .map((s) => ({
            name: s.name,
            description: s.description || '',
            version: s.version || 1,
            author: s.author || '',
            tags: s.tags || [],
            peerUrl: config.url,
            peerName: config.name,
          }));
      }

      state.bots = directBots;
      state.skills = peerSkills;
      state.healthy = true;
      state.lastChecked = Date.now();
      state.lastHealthy = Date.now();
      state.error = undefined;

      this.logger.debug(
        { peerName: config.name, peerUrl: config.url, botCount: directBots.length, skillCount: peerSkills.length },
        'Peer refreshed',
      );
    } catch (err: any) {
      state.healthy = false;
      state.lastChecked = Date.now();
      state.error = err.message || 'Unknown error';
      state.bots = [];
      state.skills = [];

      this.logger.warn(
        { peerName: config.name, peerUrl: config.url, err: err.message },
        'Peer unreachable',
      );
    }
  }

  /** Return all cached bots from healthy peers. */
  getPeerBots(): PeerBotInfo[] {
    const allBots: PeerBotInfo[] = [];
    for (const state of this.peers.values()) {
      if (state.healthy) {
        allBots.push(...state.bots);
      }
    }
    return allBots;
  }

  /** Find a bot by name across all healthy peers (first match wins). */
  findBotPeer(botName: string): { peer: PeerConfig; bot: PeerBotInfo } | undefined {
    for (const state of this.peers.values()) {
      if (!state.healthy) continue;
      const bot = state.bots.find((b) => b.name === botName);
      if (bot) {
        return { peer: state.config, bot };
      }
    }
    return undefined;
  }

  /** Find a bot on a specific peer by peer name (for qualified name syntax: peerName/botName). */
  findBotOnPeer(peerName: string, botName: string): { peer: PeerConfig; bot: PeerBotInfo } | undefined {
    const state = this.peers.get(peerName);
    if (!state || !state.healthy) return undefined;
    const bot = state.bots.find((b) => b.name === botName);
    if (bot) {
      return { peer: state.config, bot };
    }
    return undefined;
  }

  /** Forward a task request to a peer. Adds X-MetaBot-Origin header to prevent loops. */
  async forwardTask(peer: PeerConfig, body: object): Promise<object> {
    const url = `${peer.url}/api/talk`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-MetaBot-Origin': 'peer',
    };
    if (peer.secret) {
      headers['Authorization'] = `Bearer ${peer.secret}`;
    }

    const response = await proxyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TASK_FORWARD_TIMEOUT_MS),
    });

    return (await response.json()) as object;
  }

  /** Return all cached skills from healthy peers. */
  getPeerSkills(): PeerSkillInfo[] {
    const allSkills: PeerSkillInfo[] = [];
    for (const state of this.peers.values()) {
      if (state.healthy) {
        allSkills.push(...state.skills);
      }
    }
    return allSkills;
  }

  /** Fetch a full skill record from a peer by peer name. */
  async fetchPeerSkill(peerName: string, skillName: string): Promise<{ skillMd: string; referencesTar?: Buffer } | null> {
    const state = this.peers.get(peerName);
    if (!state || !state.healthy) return null;

    const { config } = state;
    const headers: Record<string, string> = {
      'X-MetaBot-Origin': 'peer',
    };
    if (config.secret) {
      headers['Authorization'] = `Bearer ${config.secret}`;
    }

    try {
      const response = await proxyFetch(`${config.url}/api/skills/${encodeURIComponent(skillName)}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as any;
      return {
        skillMd: data.skillMd || '',
        referencesTar: data.referencesTar ? Buffer.from(data.referencesTar, 'base64') : undefined,
      };
    } catch {
      return null;
    }
  }

  /** Return health status of all configured peers. */
  getPeerStatuses(): PeerStatus[] {
    return Array.from(this.peers.values()).map((state) => ({
      name: state.config.name,
      url: state.config.url,
      healthy: state.healthy,
      lastChecked: state.lastChecked,
      lastHealthy: state.lastHealthy,
      botCount: state.bots.length,
      ...(state.error ? { error: state.error } : {}),
    }));
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
