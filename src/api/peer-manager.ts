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

/** Minimal shape PeerManager needs to register a local bot. */
export interface LocalBotEntry {
  name: string;
  visible?: boolean;
  /**
   * When defined, the bridge ships this on every bulk-register and pins the
   * agent row's memory_public to it. Undefined means "leave whatever was last
   * set (runtime toggle wins)" — server-side, omitting the field keeps the
   * existing column value on update.
   */
  memoryPublic?: boolean;
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

/**
 * Pick a private IPv4 address that peers on the same intranet can route to.
 *
 * Skips loopback, virtual bridges (docker/k8s/cni), and public addresses. Among
 * non-virtual RFC1918 candidates, prefers 10.x → 172.16-31.x → 192.168.x in
 * that order; ties broken by interface name. Returns undefined if no private
 * address is found (multi-homed public-only hosts, container with hostNetwork
 * disabled, etc.).
 */
const VIRTUAL_IFACE_PATTERNS = [
  /^docker/i,
  /^br-/i,
  /^veth/i,
  /^cni/i,
  /^flannel/i,
  /^cali/i,
  /^kube-/i,
  /^virbr/i,
  /^vmnet/i,
  /^tailscale/i,
  /^wg/i,
  /^utun/i,
];

function rfc1918Rank(addr: string): number {
  // Lower rank = preferred.
  const parts = addr.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 99;
  const [a, b] = parts;
  if (a === 10) return 0;
  if (a === 172 && b >= 16 && b <= 31) return 1;
  if (a === 192 && b === 168) return 2;
  return 99;
}

export function pickPrivateIPv4(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  type Candidate = { ifname: string; address: string; rank: number };
  const candidates: Candidate[] = [];
  for (const [ifname, list] of Object.entries(ifaces)) {
    if (!list) continue;
    if (VIRTUAL_IFACE_PATTERNS.some((re) => re.test(ifname))) continue;
    for (const info of list) {
      if (info.family !== 'IPv4') continue;
      if (info.internal) continue;
      const rank = rfc1918Rank(info.address);
      if (rank === 99) continue;
      candidates.push({ ifname, address: info.address, rank });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank || x.ifname.localeCompare(y.ifname));
  return candidates[0]?.address;
}

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

  // Registry mode (on when METABOT_CORE_AGENT_BUS_URL or METABOT_CORE_URL is set).
  private agentBusUrl?: string;
  private agentBusToken?: string;
  private selfUrl?: string;
  /** Local bots from bots.json — every entry is bulk-registered at boot. */
  private localBots: LocalBotEntry[] = [];
  /** Names that successfully landed in the registry (heartbeat targets). */
  private registeredBotNames: Set<string> = new Set();
  private agentBusFailureCount = 0;

  constructor(configs: PeerConfig[], localBots: LocalBotEntry[], logger: Logger) {
    this.logger = logger.child({ module: 'peers' });
    this.localBots = localBots;

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

    // Precedence: explicit METABOT_CORE_AGENT_BUS_URL > METABOT_CORE_URL.
    // Empty string after .trim() does not count as set.
    const rawBus = process.env.METABOT_CORE_AGENT_BUS_URL?.trim() || undefined;
    const rawCore = process.env.METABOT_CORE_URL?.trim() || undefined;
    const resolvedBus = rawBus ?? rawCore;
    if (resolvedBus) {
      this.agentBusUrl = resolvedBus.replace(/\/+$/, '');
      this.agentBusToken = loadMetabotCoreToken();

      const rawSelf = process.env.METABOT_AGENT_SELF_URL?.trim() || undefined;
      if (rawSelf) {
        this.selfUrl = rawSelf;
      } else {
        const port = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 9100;
        const privateIp = pickPrivateIPv4();
        if (privateIp) {
          this.selfUrl = `http://${privateIp}:${port}`;
          this.logger.info(
            { selfUrl: this.selfUrl, privateIp },
            'METABOT_AGENT_SELF_URL not set — auto-detected from private IPv4 (set METABOT_AGENT_SELF_URL to override)',
          );
        } else {
          this.selfUrl = `http://localhost:${port}`;
          this.logger.warn(
            { selfUrl: this.selfUrl },
            'METABOT_AGENT_SELF_URL not set and no private IPv4 found — falling back to http://localhost:<port>; cross-host /api/talk from peers will not reach this bridge',
          );
        }
      }

      if (configs.length > 0) {
        this.logger.warn(
          { staticPeers: configs.map((c) => c.name) },
          'registry mode enabled (METABOT_CORE_AGENT_BUS_URL or METABOT_CORE_URL set) — static peer configs will be shadowed by registry entries',
        );
      }
      if (!this.agentBusToken) {
        this.logger.warn(
          { agentBusUrl: this.agentBusUrl },
          'Registry mode enabled but no METABOT_CORE_TOKEN / ~/.metabot-core/token found — agent-bus calls will fail with 401',
        );
      }
      if (this.localBots.length === 0) {
        this.logger.warn(
          { agentBusUrl: this.agentBusUrl, selfUrl: this.selfUrl },
          'Registry mode enabled but no local bots configured — bulk register will be skipped',
        );
      } else {
        this.bulkRegisterWithRetry().catch((err) => {
          this.logger.error({ err }, 'Bulk-register loop terminated unexpectedly');
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
   * peers map (preserving cached bots/skills/healthy for entries whose url is
   * unchanged); then run refreshAll() against whatever peers we ended up with.
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
   * Bulk-register all local bots on boot with exponential backoff (1s, 2s, 4s,
   * … capped at 30s). Single best-effort loop kicked off from the constructor —
   * failures never crash the bridge.
   */
  private async bulkRegisterWithRetry(): Promise<void> {
    let delayMs = REGISTER_RETRY_INITIAL_MS;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const result = await this.postBulkRegister();
        this.logger.info(
          {
            agentBusUrl: this.agentBusUrl,
            selfUrl: this.selfUrl,
            attempt,
            registered: result.registered,
            total: this.localBots.length,
          },
          'bulk-registered with agent bus',
        );
        return;
      } catch (err: any) {
        this.logger.warn(
          { agentBusUrl: this.agentBusUrl, attempt, err: err?.message, nextDelayMs: delayMs },
          'bulk-register failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, REGISTER_RETRY_MAX_MS);
      }
    }
  }

  /**
   * POST /api/agents/bulk with every local bot. Visibility flag is passed
   * through so toggling `visible:false` in bots.json hides the row at the next
   * restart. Per-entry name-squat errors are logged but don't fail the batch
   * (server returns them in `results[i].status === 403`).
   */
  private async postBulkRegister(): Promise<{ registered: number }> {
    if (!this.agentBusUrl || !this.selfUrl || this.localBots.length === 0) {
      return { registered: 0 };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const payload = {
      bots: this.localBots.map((b) => ({
        botName: b.name,
        url: this.selfUrl,
        visible: b.visible !== false,
        // Omit memoryPublic from the payload when bots.json doesn't set it,
        // so a CLI-time `metabot memory visibility` toggle isn't clobbered by
        // every restart. Server-side, undefined → keep existing column value.
        ...(b.memoryPublic !== undefined ? { memoryPublic: b.memoryPublic } : {}),
      })),
    };
    const resp = await proxyFetch(`${this.agentBusUrl}/api/agents/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      registered: number;
      results: Array<{ botName: string; status: number; error?: string }>;
    };
    this.registeredBotNames = new Set(
      (data.results || []).filter((r) => r.status === 201 || r.status === 200).map((r) => r.botName),
    );
    for (const r of data.results || []) {
      if (r.status >= 400) {
        this.logger.warn(
          { botName: r.botName, status: r.status, error: r.error },
          'bulk-register entry rejected',
        );
      }
    }
    return { registered: data.registered ?? this.registeredBotNames.size };
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.agentBusUrl) return;
    if (this.registeredBotNames.size === 0) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const resp = await proxyFetch(`${this.agentBusUrl}/api/agents/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ botNames: Array.from(this.registeredBotNames) }),
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
      agents: Array<{ botName: string; url: string; visible?: boolean; lastSeenAt?: string }>;
    };

    const next = new Map<string, PeerState>();
    const selfUrlNorm = this.selfUrl?.replace(/\/+$/, '');
    for (const entry of data.agents || []) {
      if (!entry.botName || !entry.url) continue;
      const normalizedUrl = entry.url.replace(/\/+$/, '');
      // Skip our own rows — we don't talk to ourselves over the peer RPC.
      if (selfUrlNorm && normalizedUrl === selfUrlNorm) continue;

      const newConfig: PeerConfig = { name: entry.botName, url: normalizedUrl };
      const prev = this.peers.get(entry.botName);
      const unchanged = prev && prev.config.url === normalizedUrl;
      next.set(
        entry.botName,
        unchanged
          ? prev
          : {
              config: newConfig,
              healthy: false,
              lastChecked: 0,
              lastHealthy: 0,
              bots: [],
              skills: [],
            },
      );
    }
    this.peers = next;
  }

  /**
   * Pick the outbound Authorization for a cross-bridge call. In registry mode
   * we always use the caller's metabot-core token — the peer verifies it via
   * `GET /api/whoami`. In static-peer-only mode we fall back to the legacy
   * per-peer shared secret.
   */
  private resolveOutboundAuth(peer: PeerConfig): string | undefined {
    if (this.agentBusUrl) return this.agentBusToken;
    return peer.secret;
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
    const auth = this.resolveOutboundAuth(config);
    if (auth) {
      headers['Authorization'] = `Bearer ${auth}`;
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
    const auth = this.resolveOutboundAuth(peer);
    if (auth) {
      headers['Authorization'] = `Bearer ${auth}`;
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
    const auth = this.resolveOutboundAuth(config);
    if (auth) {
      headers['Authorization'] = `Bearer ${auth}`;
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
