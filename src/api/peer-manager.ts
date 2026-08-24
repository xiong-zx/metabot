import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import type { PeerConfig } from '../config.js';
import type { BotInfo } from './bot-registry.js';
import {
  PEER_CAPABILITY_TTL_SECONDS,
  createPeerAuthorization,
  createPeerNonce,
  parsePeerAuthorization,
  peerAuthFailure,
  sha256Base64Url,
  verifyPeerAuthorizationSignature,
  type PeerAuthResult,
  type PeerCapabilityClaims,
} from './peer-auth.js';

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
  authMode: 'peer_capability' | 'core_bearer' | 'legacy_secret_rejected' | 'none';
  error?: string;
}

export interface PeerManagerOptions {
  peerIdentity?: string;
  now?: () => number;
  nonce?: () => string;
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
  rulesPackStatus?: BotInfo['rulesPackStatus'];
  /** Live operator host/audience proposed for credential-bound Core TOFU. */
  rulesPackIdentity?: BotInfo['rulesPackIdentity'];
}

export interface RelayInboxMessage {
  id: string;
  targetBot: string;
  chatId: string;
  fromBot: string | null;
  fromOwner: string;
  content: string;
  enqueuedAt: string;
}

export type RelayInboxHandler = (message: RelayInboxMessage) => Promise<void>;

interface PeerState {
  config: PeerConfig;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  bots: PeerBotInfo[];
  skills: PeerSkillInfo[];
  error?: string;
  /** Registry-discovered bot that should be reached through metabot-core inbox relay, not direct P2P. */
  relay?: boolean;
  /**
   * Static peers come from bots.json/env (loaded in the constructor) or are
   * added at runtime via addPeer(). Unlike dynamic peers discovered from the
   * agent bus, they are NEVER dropped by rebuildPeersFromAgentBus() — the 30s
   * poll re-injects them so a manually-added peer survives the next tick.
   */
  static?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const TASK_FORWARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PEER_STATUS_POLL_MS = 250;

/**
 * Parse METABOT_ALLOWED_PEER_CIDRS (comma/space-separated CIDRs). When set, a
 * forward target's resolved literal IPv4 host must additionally fall inside one
 * of these ranges. Empty/unset → no CIDR constraint (the known-peer allowlist
 * is still enforced). Invalid entries are silently dropped.
 */
function parseAllowedPeerCidrs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
const HEARTBEAT_INTERVAL_MS = 60_000;
const RELAY_POLL_WAIT_SECONDS = 60;
const RELAY_POLL_TIMEOUT_MS = 70_000;
const RELAY_POLL_RETRY_MS = 3_000;
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
// Container/host bridge interfaces. These can carry RFC1918 addresses
// (docker0=172.17.0.1, custom bridges br-<hash> anywhere in 172.16-31.x) that
// are NOT the shared intranet, so they are skipped in every selection path.
const CONTAINER_IFACE_PATTERNS = [
  /^docker/i,
  /^br-/i,
  /^veth/i,
  /^cni/i,
  /^flannel/i,
  /^cali/i,
  /^kube-/i,
  /^virbr/i,
  /^vmnet/i,
];

// VPN tunnel interfaces (WireGuard, Tailscale, generic tun, macOS utun). The
// shared intranet may be delivered over one of these (e.g. a corporate VPN
// hands out a 172.31.x address on utun*/wg*), so they are skipped only by the
// generic rank-based fallback — the intranet-CIDR pass below still considers
// them, which is what lets a tunnel-delivered intranet IP win.
const VPN_IFACE_PATTERNS = [/^tailscale/i, /^wg/i, /^utun/i, /^tun/i];

const VIRTUAL_IFACE_PATTERNS = [...CONTAINER_IFACE_PATTERNS, ...VPN_IFACE_PATTERNS];

/**
 * True when `addr` (dotted IPv4) falls inside the `a.b.c.d/bits` CIDR. Invalid
 * inputs return false rather than throwing.
 */
function cidrContains(cidr: string, addr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw ?? '', 10);
  if (!base || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const toInt = (ip: string): number | undefined => {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return undefined;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };
  const baseInt = toInt(base);
  const addrInt = toInt(addr);
  if (baseInt === undefined || addrInt === undefined) return false;
  // /0 means "everything"; a 32-bit shift is UB in JS, so special-case it.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (baseInt & mask) === (addrInt & mask);
}

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
  intranetCidr?: string,
): string | undefined {
  // Pass 1 — intranet CIDR. When the shared intranet segment is known (e.g.
  // 172.31.0.0/16), pick the address inside it from any non-container interface.
  // VPN tunnels are intentionally allowed here so a tunnel-delivered intranet IP
  // wins over a non-routable physical LAN address (192.168.x). Container/host
  // bridges stay skipped so a docker custom bridge inside the CIDR can't squat.
  if (intranetCidr && intranetCidr.trim()) {
    const cidr = intranetCidr.trim();
    const matches: Array<{ ifname: string; address: string }> = [];
    for (const [ifname, list] of Object.entries(ifaces)) {
      if (!list) continue;
      if (CONTAINER_IFACE_PATTERNS.some((re) => re.test(ifname))) continue;
      for (const info of list) {
        if (info.family !== 'IPv4' || info.internal) continue;
        if (cidrContains(cidr, info.address)) matches.push({ ifname, address: info.address });
      }
    }
    matches.sort((x, y) => x.ifname.localeCompare(y.ifname));
    if (matches[0]) return matches[0].address;
  }

  // Pass 2 — generic fallback. Skips all virtual interfaces (containers + VPN)
  // and ranks remaining RFC1918 addresses 10/8 → 172.16/12 → 192.168/16.
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

function normalizedUrlHost(url: string | undefined): string | undefined {
  if (!url || url === 'inbox:') return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export class PeerManager {
  private peers: Map<string, PeerState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private logger: Logger;

  // Registry mode (on when METABOT_CORE_AGENT_BUS_URL or METABOT_CORE_URL is set).
  private agentBusUrl?: string;
  private agentBusToken?: string;
  /** Cached identity for the Bridge-wide Core credential used by every bot. */
  private agentBusIdentityPromise?: Promise<string>;
  private selfUrl?: string;
  /** Local bots from bots.json — every entry is bulk-registered at boot. */
  private localBots: LocalBotEntry[] = [];
  /** Names that successfully landed in the registry (heartbeat targets). */
  private registeredBotNames: Set<string> = new Set();
  private registrationTail: Promise<void> = Promise.resolve();
  private relayHandler?: RelayInboxHandler;
  private relayPollers: Map<string, AbortController> = new Map();
  private agentBusFailureCount = 0;
  private peerIdentity?: string;
  private now: () => number;
  private nonce: () => string;
  private replayNonces = new Map<string, number>();
  /**
   * Optional CIDR allowlist for forward targets (METABOT_ALLOWED_PEER_CIDRS).
   * Empty = no CIDR constraint; the known-peer allowlist is always enforced.
   */
  private allowedPeerCidrs: string[];

  constructor(
    configs: PeerConfig[],
    localBots: LocalBotEntry[],
    logger: Logger,
    options: PeerManagerOptions = {},
  ) {
    this.logger = logger.child({ module: 'peers' });
    this.localBots = localBots;
    this.peerIdentity = options.peerIdentity?.trim() || process.env.METABOT_PEER_ID?.trim() || undefined;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? createPeerNonce;
    this.allowedPeerCidrs = parseAllowedPeerCidrs(process.env.METABOT_ALLOWED_PEER_CIDRS);
    if (this.allowedPeerCidrs.length > 0) {
      this.logger.info(
        { allowedPeerCidrs: this.allowedPeerCidrs },
        'peer forward CIDR allowlist active (METABOT_ALLOWED_PEER_CIDRS)',
      );
    }

    for (const config of configs) {
      const normalizedUrl = config.url.replace(/\/+$/, '');
      this.peers.set(config.name, {
        config: { ...config, url: normalizedUrl },
        healthy: false,
        lastChecked: 0,
        lastHealthy: 0,
        bots: [],
        skills: [],
        static: true,
      });
      if (config.secret) {
        this.logger.warn(
          { peerName: config.name, peerUrl: normalizedUrl, code: 'legacy_peer_secret_rejected' },
          'peer.secret is deprecated and will not be sent; configure scoped peer auth instead',
        );
      }
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
        // Known intranet segment — an address inside this CIDR is preferred even
        // when it lives on a VPN tunnel interface. Defaults to the org intranet
        // (172.31.0.0/16); set METABOT_INTRANET_CIDR='' to disable the override.
        const intranetCidr =
          process.env.METABOT_INTRANET_CIDR !== undefined ? process.env.METABOT_INTRANET_CIDR.trim() : '172.31.0.0/16';
        const privateIp = pickPrivateIPv4(os.networkInterfaces(), intranetCidr);
        if (privateIp) {
          this.selfUrl = `http://${privateIp}:${port}`;
          this.logger.info(
            { selfUrl: this.selfUrl, privateIp, intranetCidr: intranetCidr || undefined },
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
        this.logger.info(
          { staticPeers: configs.map((c) => c.name) },
          'registry mode enabled (METABOT_CORE_AGENT_BUS_URL or METABOT_CORE_URL set) — static peer configs are kept alongside registry-discovered peers (preserved across poll ticks)',
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
          { agentBusUrl: this.agentBusUrl },
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

  setRelayHandler(handler: RelayInboxHandler): void {
    this.relayHandler = handler;
    this.syncRelayPollers();
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
        const result = await this.queueBulkRegister();
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
  private queueBulkRegister(targetBotName?: string): Promise<{ registered: number }> {
    const run = this.registrationTail
      .catch(() => undefined)
      .then(() => this.postBulkRegister(targetBotName));
    this.registrationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async postBulkRegister(targetBotName?: string): Promise<{ registered: number }> {
    if (!this.agentBusUrl || this.localBots.length === 0) {
      return { registered: 0 };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const rulesPackIdentity = this.localRulesPackIdentity();
    const selectedBots = targetBotName
      ? this.localBots.filter((bot) => bot.name === targetBotName)
      : this.localBots;
    const payload = {
      ...(rulesPackIdentity ? { rulesPackIdentity } : {}),
      bots: selectedBots.map((b) => ({
        botName: b.name,
        url: this.selfUrl || 'inbox:',
        visible: b.visible !== false,
        // Omit memoryPublic from the payload when bots.json doesn't set it,
        // so a CLI-time `metabot memory visibility` toggle isn't clobbered by
        // every restart. Server-side, undefined → keep existing column value.
        ...(b.memoryPublic !== undefined ? { memoryPublic: b.memoryPublic } : {}),
        ...(b.rulesPackStatus ? { rulesPackStatus: b.rulesPackStatus } : {}),
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
      results: Array<{
        botName: string;
        status: number;
        error?: string;
        rulesPackIdentity?: BotInfo['rulesPackIdentity'];
      }>;
    };
    const accepted = (data.results || []).filter((r) => r.status === 201 || r.status === 200);
    if (targetBotName) {
      const target = (data.results || []).find((result) => result.botName === targetBotName);
      if (!target || target.status < 200 || target.status >= 300) {
        throw new Error(`RulesPack status publication failed for ${targetBotName}: ${target?.error ?? 'missing result'}`);
      }
      this.registeredBotNames.add(targetBotName);
    } else {
      this.registeredBotNames = new Set(accepted.map((r) => r.botName));
    }
    this.syncRelayPollers();
    for (const r of data.results || []) {
      if (r.status >= 400) {
        this.logger.warn({ botName: r.botName, status: r.status, error: r.error }, 'bulk-register entry rejected');
      }
    }
    if (rulesPackIdentity) {
      for (const local of selectedBots.filter((bot) => bot.rulesPackIdentity)) {
        const result = (data.results || []).find((entry) => entry.botName === local.name);
        if (
          !result ||
          (result.status !== 200 && result.status !== 201) ||
          result.rulesPackIdentity?.hostId !== rulesPackIdentity.hostId ||
          result.rulesPackIdentity?.audience !== rulesPackIdentity.audience
        ) {
          throw new Error(`Core did not attest the configured RulesPack identity for bot ${local.name}`);
        }
      }
    }
    return { registered: data.registered ?? this.registeredBotNames.size };
  }

  private localRulesPackIdentity(): NonNullable<BotInfo['rulesPackIdentity']> | undefined {
    let resolved: NonNullable<BotInfo['rulesPackIdentity']> | undefined;
    for (const bot of this.localBots) {
      const active =
        (bot.rulesPackStatus?.state === 'inherited' || bot.rulesPackStatus?.state === 'overridden') &&
        (bot.rulesPackStatus.mode === 'shadow' || bot.rulesPackStatus.mode === 'enforce');
      if (active && !bot.rulesPackIdentity) {
        throw new Error(`Active RulesPack bot ${bot.name} has no live host/audience identity`);
      }
      if (!bot.rulesPackIdentity) continue;
      if (
        resolved &&
        (resolved.hostId !== bot.rulesPackIdentity.hostId || resolved.audience !== bot.rulesPackIdentity.audience)
      ) {
        throw new Error('One Bridge credential cannot register multiple RulesPack host/audience identities');
      }
      resolved = bot.rulesPackIdentity;
    }
    return resolved;
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
      agents: Array<{
        botName: string;
        url: string;
        visible?: boolean;
        lastSeenAt?: string;
        rulesPackStatus?: BotInfo['rulesPackStatus'];
        rulesPackIdentity?: BotInfo['rulesPackIdentity'];
      }>;
    };

    const next = new Map<string, PeerState>();
    const selfUrlNorm = this.selfUrl?.replace(/\/+$/, '');
    const selfHost = normalizedUrlHost(selfUrlNorm);
    for (const entry of data.agents || []) {
      if (!entry.botName || !entry.url) continue;
      const normalizedUrl = entry.url.replace(/\/+$/, '');
      // Skip our own rows — we don't talk to ourselves over the peer RPC.
      if (selfUrlNorm && normalizedUrl === selfUrlNorm) continue;

      const newConfig: PeerConfig = { name: entry.botName, url: normalizedUrl };
      const prev = this.peers.get(entry.botName);
      const unchanged = prev && prev.config.url === normalizedUrl;
      const entryHost = normalizedUrlHost(normalizedUrl);
      const sameHost = Boolean(selfHost && entryHost && selfHost === entryHost);
      next.set(
        entry.botName,
        unchanged && sameHost
          ? { ...prev, relay: false }
          : unchanged
            ? {
                ...prev,
                bots: [agentBusBot(entry, normalizedUrl, prev.bots[0])],
                relay: true,
                healthy: true,
                lastChecked: Date.now(),
                lastHealthy: Date.now(),
                error: undefined,
              }
            : {
                config: newConfig,
                healthy: !sameHost,
                lastChecked: sameHost ? 0 : Date.now(),
                lastHealthy: sameHost ? 0 : Date.now(),
                bots: sameHost ? [] : [agentBusBot(entry, normalizedUrl)],
                skills: [],
                relay: !sameHost,
              },
      );
    }

    // Re-inject static peers (bots.json/env or runtime-added via addPeer). The
    // agent bus rebuild must never drop them — a static entry wins over a
    // same-named dynamic one so a manually-added peer URL is authoritative.
    for (const [name, state] of this.peers) {
      if (state.static) next.set(name, state);
    }

    this.peers = next;
  }

  /**
   * Add (or update) a static peer at runtime — takes effect immediately, no
   * restart. The peer is marked `static` so the next agent-bus poll tick won't
   * clobber it, and is refreshed right away so it becomes usable within ~1s.
   * Persisting it across restarts is the caller's job (bots.json peers[]).
   */
  addPeer(config: PeerConfig): void {
    const normalizedUrl = config.url.replace(/\/+$/, '');
    const existing = this.peers.get(config.name);
    const state: PeerState = {
      config: { ...config, url: normalizedUrl },
      healthy: existing?.healthy ?? false,
      lastChecked: existing?.lastChecked ?? 0,
      lastHealthy: existing?.lastHealthy ?? 0,
      bots: existing?.bots ?? [],
      skills: existing?.skills ?? [],
      static: true,
    };
    this.peers.set(config.name, state);
    this.logger.info({ peerName: config.name, peerUrl: normalizedUrl }, 'static peer added at runtime');
    // Best-effort immediate refresh so the peer is healthy without waiting for
    // the next poll tick; errors are captured into state by refreshPeer itself.
    void this.refreshPeer(state);
  }

  /** Remove a peer by name. Returns true if a peer was removed. */
  removePeer(name: string): boolean {
    const removed = this.peers.delete(name);
    if (removed) this.logger.info({ peerName: name }, 'peer removed at runtime');
    return removed;
  }

  private findPeerState(peer: PeerConfig): PeerState | undefined {
    const normalized = peer.url.replace(/\/+$/, '');
    const byName = this.peers.get(peer.name);
    if (byName?.config.url === normalized) return byName;
    return Array.from(this.peers.values()).find((state) => state.config.url === normalized);
  }

  private resolveSourceBot(requested: unknown): string {
    if (typeof requested === 'string' && this.localBots.some((bot) => bot.name === requested)) {
      return requested;
    }
    if (!this.peerIdentity) throw new Error('peer_auth_identity_required');
    return `bridge:${this.peerIdentity}`;
  }

  private capabilityAuthorization(
    peer: PeerConfig,
    method: string,
    requestPath: string,
    rawBody: string,
    binding: {
      sourceBot: string;
      targetBot?: string;
      chatId?: string;
      taskId?: string;
    },
  ): string {
    if (!peer.auth) throw new Error('peer_auth_required');
    if (!this.peerIdentity) throw new Error('peer_auth_identity_required');
    let host: string;
    try {
      host = new URL(peer.url).host.toLowerCase();
    } catch {
      throw new Error('peer_auth_target_url_invalid');
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims: PeerCapabilityClaims = {
      v: 1,
      iss: this.peerIdentity,
      aud: peer.name,
      kid: peer.auth.keyId,
      host,
      method: method.toUpperCase(),
      path: requestPath,
      sourceBot: binding.sourceBot,
      ...(binding.targetBot ? { targetBot: binding.targetBot } : {}),
      ...(binding.chatId ? { chatId: binding.chatId } : {}),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      bodySha256: sha256Base64Url(rawBody),
      iat: nowSeconds,
      exp: nowSeconds + PEER_CAPABILITY_TTL_SECONDS,
      nonce: this.nonce(),
    };
    return createPeerAuthorization(claims, peer.auth.secret);
  }

  private authorizationHeaders(
    state: PeerState,
    method: string,
    requestPath: string,
    rawBody: string,
    binding: {
      sourceBot: string;
      targetBot?: string;
      chatId?: string;
      taskId?: string;
    },
  ): Record<string, string> {
    if (state.config.auth) {
      return {
        Authorization: this.capabilityAuthorization(
          state.config,
          method,
          requestPath,
          rawBody,
          binding,
        ),
      };
    }
    // Registry-discovered same-Core peers may use the ordinary Core bearer.
    // Static peers never receive it, and legacy peer.secret is never used.
    if (!state.static && this.agentBusToken) {
      return { Authorization: `Bearer ${this.agentBusToken}` };
    }
    return {};
  }

  private isAllowedCapabilityRoute(method: string, requestPath: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(requestPath, 'http://peer.invalid');
    } catch {
      return false;
    }
    const pathName = parsed.pathname;
    const upperMethod = method.toUpperCase();
    if (upperMethod === 'POST' && (pathName === '/api/talk' || pathName === '/api/tasks')) return true;
    if (upperMethod !== 'GET') return false;
    if (pathName === '/api/bots' || pathName === '/api/skills' || pathName === '/api/peers') return true;
    if (/^\/api\/skills\/[^/]+$/.test(pathName)) return true;
    return /^\/api\/talk\/[^/]+$/.test(pathName);
  }

  /** Verify a short-lived peer capability without exposing its credential. */
  verifyInboundPeerRequest(input: {
    authorization: string | string[] | undefined;
    method: string;
    path: string;
    host: string | string[] | undefined;
    origin: string | string[] | undefined;
    rawBody: string;
  }): PeerAuthResult {
    const parsed = parsePeerAuthorization(input.authorization);
    if ('ok' in parsed) return parsed;
    const { claims } = parsed;
    const state = this.peers.get(claims.iss);
    if (!state?.config.auth) return peerAuthFailure('peer_auth_unknown_issuer');
    const auth = state.config.auth;
    if (auth.revokedKeyIds?.includes(claims.kid)) return peerAuthFailure('peer_auth_revoked');

    const nowMs = this.now();
    const key = auth.keyId === claims.kid
      ? auth
      : (auth.acceptKeys ?? []).find((candidate) => {
          if (candidate.keyId !== claims.kid || !candidate.acceptUntil) return false;
          const cutoff = Date.parse(candidate.acceptUntil);
          return Number.isFinite(cutoff) && cutoff >= nowMs;
        });
    if (!key) return peerAuthFailure('peer_auth_unknown_key');
    if (!verifyPeerAuthorizationSignature(parsed, key.secret)) {
      return peerAuthFailure('peer_auth_bad_signature');
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    if (claims.exp <= nowSeconds || claims.exp <= claims.iat) return peerAuthFailure('peer_auth_expired');
    if (claims.iat > nowSeconds + 5) return peerAuthFailure('peer_auth_not_yet_valid');
    if (claims.exp - claims.iat > PEER_CAPABILITY_TTL_SECONDS + 5) return peerAuthFailure('peer_auth_expired');
    if (!this.peerIdentity || claims.aud !== this.peerIdentity) {
      return peerAuthFailure('peer_auth_audience', 403);
    }
    const host = Array.isArray(input.host) ? undefined : input.host?.trim().toLowerCase();
    if (!host || claims.host.toLowerCase() !== host) return peerAuthFailure('peer_auth_host', 403);
    const origin = Array.isArray(input.origin) ? undefined : input.origin;
    if (origin !== 'peer'
      || !this.isAllowedCapabilityRoute(input.method, input.path)
      || claims.method !== input.method.toUpperCase()
      || claims.path !== input.path) {
      return peerAuthFailure('peer_auth_route', 403);
    }
    if (claims.bodySha256 !== sha256Base64Url(input.rawBody)) {
      return peerAuthFailure('peer_auth_body', 403);
    }

    if (auth.allowedSourceBots?.length && !auth.allowedSourceBots.includes(claims.sourceBot)) {
      return peerAuthFailure('peer_auth_source_scope', 403);
    }
    if (claims.targetBot && auth.allowedTargetBots?.length
      && !auth.allowedTargetBots.includes(claims.targetBot)) {
      return peerAuthFailure('peer_auth_target_scope', 403);
    }

    const route = new URL(input.path, 'http://peer.invalid').pathname;
    if (claims.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(input.rawBody) as Record<string, unknown>;
      } catch {
        return peerAuthFailure('peer_auth_body', 403);
      }
      if (typeof body.botName !== 'string' || !body.botName || body.botName.includes('/')
        || body.botName !== claims.targetBot
        || typeof body.chatId !== 'string' || !body.chatId || body.chatId !== claims.chatId
        || typeof body.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestId)
        || body.requestId !== claims.taskId
        || body.sourceBot !== claims.sourceBot
        || body.async !== true
        || body.callbackBotName !== undefined
        || body.callbackChatId !== undefined
        || !this.localBots.some((bot) => bot.name === body.botName)) {
        return peerAuthFailure('peer_auth_body', 403);
      }
    } else if (/^\/api\/talk\//.test(route)) {
      const taskId = decodeURIComponent(route.slice('/api/talk/'.length));
      if (!taskId || claims.taskId !== taskId) return peerAuthFailure('peer_auth_route', 403);
    } else if (claims.targetBot || claims.chatId || claims.taskId) {
      return peerAuthFailure('peer_auth_route', 403);
    }

    for (const [keyId, expiresAt] of this.replayNonces) {
      if (expiresAt <= nowSeconds) this.replayNonces.delete(keyId);
    }
    const replayKey = `${claims.iss}:${claims.kid}:${claims.nonce}`;
    if (this.replayNonces.has(replayKey)) return peerAuthFailure('peer_auth_replay');
    this.replayNonces.set(replayKey, claims.exp);
    return { ok: true, claims };
  }

  /**
   * Bind an envelope issuer to the credential that will authenticate this
   * exact outbound hop. Scoped peer auth binds it to a configured local Bot;
   * Agent Bus traffic uses the server-derived `/api/whoami` botName.
   */
  private async assertRulesPackTransportIssuer(peer: PeerConfig, body: object): Promise<void> {
    const dispatch = (body as { rulesPackDispatch?: { issuer?: unknown } }).rulesPackDispatch;
    if (!dispatch) return;
    const issuer = typeof dispatch.issuer === 'string' ? dispatch.issuer.trim() : '';
    if (!issuer) {
      this.logger.warn({ peerName: peer.name }, 'RulesPack dispatch has no issuer to bind to outbound transport');
      throw new Error('RulesPack dispatch issuer is required for authenticated transport');
    }
    if (peer.auth) {
      const sourceBot = (body as { sourceBot?: unknown }).sourceBot;
      if (sourceBot !== issuer || !this.localBots.some((bot) => bot.name === issuer)) {
        this.logger.warn(
          { peerName: peer.name, issuer, sourceBot, authMode: 'peer-capability' },
          'RulesPack dispatch issuer does not match the scoped peer source Bot',
        );
        throw new Error('RulesPack dispatch issuer must match a configured local peer source Bot');
      }
      this.logger.info(
        { peerName: peer.name, issuer, authMode: 'peer-capability' },
        'RulesPack issuer bound to scoped peer source Bot',
      );
      return;
    }
    if (peer.secret) throw new Error('legacy_peer_secret_rejected');
    let authenticatedIssuer: string;
    try {
      authenticatedIssuer = await this.resolveAgentBusIdentity();
    } catch (error) {
      this.logger.warn(
        { peerName: peer.name, issuer, error: error instanceof Error ? error.message : String(error) },
        'RulesPack dispatch blocked because Agent Bus transport identity could not be verified',
      );
      throw error;
    }
    if (issuer !== authenticatedIssuer) {
      this.logger.warn(
        { peerName: peer.name, issuer, authenticatedIssuer, authMode: 'core-bearer' },
        'RulesPack dispatch issuer does not match authenticated Agent Bus transport identity',
      );
      throw new Error(
        `RulesPack dispatch issuer "${issuer}" does not match authenticated Agent Bus identity "${authenticatedIssuer}"`,
      );
    }
  }

  private async resolveAgentBusIdentity(): Promise<string> {
    if (!this.agentBusUrl || !this.agentBusToken) {
      throw new Error('RulesPack Agent Bus dispatch requires a configured Core URL and credential');
    }
    if (!this.agentBusIdentityPromise) {
      this.agentBusIdentityPromise = this.fetchAgentBusIdentity().catch((error) => {
        this.agentBusIdentityPromise = undefined;
        throw error;
      });
    }
    return this.agentBusIdentityPromise;
  }

  private async fetchAgentBusIdentity(): Promise<string> {
    const resp = await proxyFetch(`${this.agentBusUrl}/api/whoami`, {
      headers: { Authorization: `Bearer ${this.agentBusToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`Core whoami failed with HTTP ${resp.status}: ${resp.statusText}`);
    }
    const body = (await resp.json().catch(() => ({}))) as { botName?: unknown };
    const botName = typeof body.botName === 'string' ? body.botName.trim() : '';
    if (!botName) throw new Error('Core whoami did not return a botName transport identity');
    return botName;
  }

  async refreshAll(): Promise<void> {
    const tasks = Array.from(this.peers.values()).map((state) => this.refreshPeer(state));
    await Promise.allSettled(tasks);
  }

  /** Publish a live, non-secret RulesPack mode/adoption change to the central Agent Bus. */
  async updateLocalRulesPackStatus(
    name: string,
    rulesPackStatus: NonNullable<BotInfo['rulesPackStatus']>,
  ): Promise<void> {
    const local = this.localBots.find((bot) => bot.name === name);
    if (!local) return;
    const previous = local.rulesPackStatus;
    const next = { ...previous, ...rulesPackStatus };
    local.rulesPackStatus = next;
    if (!this.agentBusUrl) return;
    try {
      await this.queueBulkRegister(name);
    } catch (error) {
      if (local.rulesPackStatus === next) local.rulesPackStatus = previous;
      this.logger.warn({ botName: name, error: error instanceof Error ? error.message : String(error) },
        'failed to publish live RulesPack status to agent bus');
      throw error;
    }
  }

  private async refreshPeer(state: PeerState): Promise<void> {
    const { config } = state;
    if (state.relay || config.url === 'inbox:') {
      state.healthy = true;
      state.lastChecked = Date.now();
      state.lastHealthy = Date.now();
      state.error = undefined;
      if (state.bots.length === 0) {
        state.bots = [
          {
            name: config.name,
            platform: 'agent-bus',
            engine: 'codex',
            workingDirectory: '',
            peerUrl: 'inbox:',
            peerName: config.name,
          },
        ];
      }
      return;
    }
    try {
      const headers: Record<string, string> = {
        'X-MetaBot-Origin': 'peer',
      };
      Object.assign(headers, this.authorizationHeaders(
        state,
        'GET',
        '/api/bots',
        '',
        { sourceBot: this.peerIdentity ? `bridge:${this.peerIdentity}` : 'bridge:registry' },
      ));

      const skillsHeaders: Record<string, string> = { 'X-MetaBot-Origin': 'peer' };
      Object.assign(skillsHeaders, this.authorizationHeaders(
        state,
        'GET',
        '/api/skills',
        '',
        { sourceBot: this.peerIdentity ? `bridge:${this.peerIdentity}` : 'bridge:registry' },
      ));

      // Fetch bots and skills in parallel
      const [botsResp, skillsResp] = await Promise.all([
        proxyFetch(`${config.url}/api/bots`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
        proxyFetch(`${config.url}/api/skills`, {
          headers: skillsHeaders,
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
          rulesPackTools?: string[];
          rulesPackStatus?: BotInfo['rulesPackStatus'];
          rulesPackIdentity?: BotInfo['rulesPackIdentity'];
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
          engine: b.engine ?? 'codex',
          ...(b.model ? { model: b.model } : {}),
          workingDirectory: b.workingDirectory,
          ...(Array.isArray(b.rulesPackTools) && b.rulesPackTools.every((tool) => typeof tool === 'string')
            ? { rulesPackTools: [...new Set(b.rulesPackTools)].sort() }
            : {}),
          ...(b.rulesPackStatus ? { rulesPackStatus: b.rulesPackStatus } : {}),
          ...(b.rulesPackIdentity ? { rulesPackIdentity: b.rulesPackIdentity } : {}),
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

      this.logger.warn({ peerName: config.name, peerUrl: config.url, err: err.message }, 'Peer unreachable');
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

  /**
   * Set of normalized peer URLs currently in our map. These are the only
   * targets forwardTask is allowed to reach — every entry got here either from
   * a static config (bots.json/env/addPeer) or from a refreshPeer-verified
   * agent-bus discovery, so an attacker can't point a forward at an arbitrary
   * internal service (e.g. http://localhost:6379) just by poisoning the bus.
   */
  private knownPeerUrls(): Set<string> {
    const urls = new Set<string>();
    for (const state of this.peers.values()) {
      urls.add(state.config.url.replace(/\/+$/, ''));
    }
    return urls;
  }

  /**
   * Gate a forward target before we open a connection to it. Two layers:
   *  1. The normalized URL MUST be a known peer (present in this.peers). This is
   *     the primary SSRF defense — we never forward to a URL we didn't discover.
   *  2. When METABOT_ALLOWED_PEER_CIDRS is set and the host is a literal IPv4,
   *     it must additionally fall inside one of the configured CIDRs.
   * Returns a reason string when rejected, or undefined when allowed.
   */
  private rejectForwardTarget(peerUrl: string): string | undefined {
    const normalized = peerUrl.replace(/\/+$/, '');
    if (!this.knownPeerUrls().has(normalized)) {
      return 'target is not a known/verified peer';
    }
    if (this.allowedPeerCidrs.length > 0) {
      let host: string;
      try {
        host = new URL(normalized).hostname;
      } catch {
        return 'target URL is unparseable';
      }
      // Only enforce CIDR on literal IPv4 hosts; hostnames are left to the
      // known-peer check above (we don't resolve DNS here).
      const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (isIpv4 && !this.allowedPeerCidrs.some((cidr) => cidrContains(cidr, host))) {
        return 'target IP is outside METABOT_ALLOWED_PEER_CIDRS';
      }
    }
    return undefined;
  }

  /** Forward a task request to a peer. Adds X-MetaBot-Origin header to prevent loops. */
  async forwardTask(peer: PeerConfig, body: object): Promise<object> {
    await this.assertRulesPackTransportIssuer(peer, body);
    if (peer.url === 'inbox:' || this.isRelayPeer(peer)) {
      return this.enqueueRelayTask(peer, body);
    }
    const rejection = this.rejectForwardTarget(peer.url);
    if (rejection) {
      let host = peer.url;
      try {
        host = new URL(peer.url).host;
      } catch {
        /* keep raw url in log */
      }
      this.logger.warn(
        { peerName: peer.name, peerUrl: peer.url, targetHost: host, reason: rejection },
        'refusing to forward task to unverified/disallowed peer target (possible SSRF)',
      );
      throw new Error(`Refusing to forward to peer "${peer.name}": ${rejection}`);
    }

    const state = this.findPeerState(peer);
    if (!state) throw new Error(`Peer "${peer.name}" is not configured`);
    const effectivePeer = state.config;
    const url = `${effectivePeer.url}/api/talk`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-MetaBot-Origin': 'peer',
    };
    const dispatch = (body as { rulesPackDispatch?: { issuer?: string } }).rulesPackDispatch;
    if (dispatch?.issuer) headers['X-MetaBot-RulesPack-Issuer'] = dispatch.issuer;
    if (!effectivePeer.auth) {
      if (effectivePeer.secret) throw new Error('legacy_peer_secret_rejected');
      // Registry-discovered same-Core peers keep their scoped Core bearer.
      // Static peers receive no credential and never fall back to API_SECRET.
      Object.assign(headers, this.authorizationHeaders(
        state,
        'POST',
        '/api/talk',
        JSON.stringify(body),
        { sourceBot: this.peerIdentity ? `bridge:${this.peerIdentity}` : 'bridge:registry' },
      ));
      const response = await proxyFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TASK_FORWARD_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as object;
      if (!response.ok) throw new Error(`peer_auth_required_http_${response.status}`);
      return result;
    }

    const input = body as Record<string, unknown>;
    const requestedId = typeof input.requestId === 'string' ? input.requestId : '';
    const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
    const sourceBot = this.resolveSourceBot(input.sourceBot);
    const targetBot = typeof input.botName === 'string' ? input.botName : '';
    const chatId = typeof input.chatId === 'string' ? input.chatId : '';
    if (!targetBot || targetBot.includes('/') || !chatId) throw new Error('peer task requires botName and chatId');
    const outboundBody: Record<string, unknown> = {
      ...input,
      botName: targetBot,
      chatId,
      sourceBot,
      requestId,
      async: true,
    };
    delete outboundBody.callbackBotName;
    delete outboundBody.callbackChatId;
    const rawBody = JSON.stringify(outboundBody);

    let response: Response | undefined;
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptHeaders = {
        ...headers,
        ...this.authorizationHeaders(state, 'POST', '/api/talk', rawBody, {
          sourceBot,
          targetBot,
          chatId,
          taskId: requestId,
        }),
      };
      try {
        response = await proxyFetch(url, {
          method: 'POST',
          headers: attemptHeaders,
          body: rawBody,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status < 500) break;
      } catch (error) {
        lastNetworkError = error;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!response) {
      throw lastNetworkError instanceof Error ? lastNetworkError : new Error('peer task request failed');
    }
    const accepted = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof accepted.code === 'string' ? accepted.code : `http_${response.status}`;
      throw new Error(`peer task rejected: ${code}`);
    }
    if (response.status !== 202) return accepted;
    this.logger.info(
      { peerName: effectivePeer.name, requestId, sourceBot, targetBot, chatId },
      'peer task accepted',
    );

    const deadline = this.now() + TASK_FORWARD_TIMEOUT_MS;
    const statusPath = `/api/talk/${encodeURIComponent(requestId)}`;
    while (this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PEER_STATUS_POLL_MS));
      const statusHeaders: Record<string, string> = {
        'X-MetaBot-Origin': 'peer',
        ...this.authorizationHeaders(state, 'GET', statusPath, '', {
          sourceBot,
          targetBot,
          chatId,
          taskId: requestId,
        }),
      };
      let statusResponse: Response;
      try {
        statusResponse = await proxyFetch(`${effectivePeer.url}${statusPath}`, {
          headers: statusHeaders,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch {
        continue;
      }
      const statusBody = (await statusResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (statusResponse.status >= 500) continue;
      if (!statusResponse.ok) {
        const code = typeof statusBody.code === 'string' ? statusBody.code : `http_${statusResponse.status}`;
        throw new Error(`peer task status rejected: ${code}`);
      }
      if (statusBody.status === 'completed' || statusBody.status === 'failed') {
        const result = statusBody.result && typeof statusBody.result === 'object'
          ? statusBody.result as object
          : { success: statusBody.status === 'completed' };
        this.logger.info(
          { peerName: effectivePeer.name, requestId, status: statusBody.status, sourceBot, targetBot, chatId },
          'peer task reached terminal status',
        );
        return { requestId, ...result };
      }
    }
    throw new Error(`peer task timed out: ${requestId}`);
  }

  private isRelayPeer(peer: PeerConfig): boolean {
    const normalized = peer.url.replace(/\/+$/, '');
    const byName = this.peers.get(peer.name);
    if (byName && byName.config.url === normalized) return byName.relay === true;
    for (const state of this.peers.values()) {
      if (state.config.url === normalized && state.config.name === peer.name) {
        return state.relay === true;
      }
    }
    return false;
  }

  private async enqueueRelayTask(peer: PeerConfig, body: any): Promise<object> {
    if (!this.agentBusUrl) throw new Error('agent bus URL is not configured');
    const prompt =
      typeof body?.prompt === 'string' ? body.prompt : typeof body?.content === 'string' ? body.content : '';
    if (!prompt) throw new Error('relay task prompt is required');
    const chatId = typeof body?.chatId === 'string' ? body.chatId : '';
    const targetBot = typeof body?.botName === 'string' && body.botName ? body.botName : peer.name;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.agentBusToken) headers['Authorization'] = `Bearer ${this.agentBusToken}`;
    const resp = await proxyFetch(`${this.agentBusUrl}/api/inbox/${encodeURIComponent(targetBot)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chatId,
        content: JSON.stringify({
          type: 'talk',
          botName: targetBot,
          chatId,
          prompt,
          sendCards: body?.sendCards,
          ...(body?.rulesPackDispatch ? { rulesPackDispatch: body.rulesPackDispatch } : {}),
        }),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => ({}))) as object;
    if (!resp.ok) {
      throw new Error(`core inbox enqueue failed with HTTP ${resp.status}`);
    }
    return { accepted: true, relay: 'inbox', ...data };
  }

  private syncRelayPollers(): void {
    if (!this.agentBusUrl || !this.relayHandler || !this.agentBusToken) return;
    for (const botName of this.registeredBotNames) {
      if (this.relayPollers.has(botName)) continue;
      const controller = new AbortController();
      this.relayPollers.set(botName, controller);
      void this.runRelayPollLoop(botName, controller).catch((err) => {
        this.logger.warn({ err: err?.message, botName }, 'relay inbox poll loop stopped');
      });
    }
    for (const [botName, controller] of this.relayPollers) {
      if (!this.registeredBotNames.has(botName)) {
        controller.abort();
        this.relayPollers.delete(botName);
      }
    }
  }

  private async runRelayPollLoop(botName: string, controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const message = await this.pollRelayInbox(botName, controller.signal);
        if (message && this.relayHandler) {
          await this.relayHandler(message);
        }
      } catch (err: any) {
        if (controller.signal.aborted) return;
        this.logger.warn({ err: err?.message, botName }, 'relay inbox poll failed');
        await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_RETRY_MS));
      }
    }
  }

  private async pollRelayInbox(botName: string, signal: AbortSignal): Promise<RelayInboxMessage | undefined> {
    if (!this.agentBusUrl || !this.agentBusToken) return undefined;
    const resp = await proxyFetch(
      `${this.agentBusUrl}/api/inbox/${encodeURIComponent(botName)}/poll?wait=${RELAY_POLL_WAIT_SECONDS}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.agentBusToken}`,
        },
        body: JSON.stringify({ wait: RELAY_POLL_WAIT_SECONDS }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_POLL_TIMEOUT_MS)]),
      },
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = (await resp.json()) as { message?: RelayInboxMessage | null };
    return data.message ?? undefined;
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
  async fetchPeerSkill(
    peerName: string,
    skillName: string,
  ): Promise<{ skillMd: string; referencesTar?: Buffer } | null> {
    const state = this.peers.get(peerName);
    if (!state || !state.healthy) return null;

    const { config } = state;
    const requestPath = `/api/skills/${encodeURIComponent(skillName)}`;

    try {
      const headers: Record<string, string> = {
        'X-MetaBot-Origin': 'peer',
      };
      Object.assign(headers, this.authorizationHeaders(
        state,
        'GET',
        requestPath,
        '',
        { sourceBot: this.peerIdentity ? `bridge:${this.peerIdentity}` : 'bridge:registry' },
      ));
      const response = await proxyFetch(`${config.url}${requestPath}`, {
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
      authMode: state.config.auth
        ? 'peer_capability'
        : state.config.secret
          ? 'legacy_secret_rejected'
          : !state.static && this.agentBusToken
            ? 'core_bearer'
            : 'none',
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
    for (const controller of this.relayPollers.values()) {
      controller.abort();
    }
    this.relayPollers.clear();
  }
}

function agentBusBot(
  entry: {
    botName: string;
    rulesPackStatus?: BotInfo['rulesPackStatus'];
    rulesPackIdentity?: BotInfo['rulesPackIdentity'];
  },
  normalizedUrl: string,
  previous?: PeerBotInfo,
): PeerBotInfo {
  const {
    rulesPackStatus: _staleStatus,
    rulesPackIdentity: _staleIdentity,
    ...stable
  } = previous ?? {} as PeerBotInfo;
  return {
    ...stable,
    name: entry.botName,
    platform: 'agent-bus',
    engine: 'codex',
    workingDirectory: '',
    ...(entry.rulesPackStatus ? { rulesPackStatus: entry.rulesPackStatus } : {}),
    ...(entry.rulesPackIdentity ? { rulesPackIdentity: entry.rulesPackIdentity } : {}),
    peerUrl: normalizedUrl,
    peerName: entry.botName,
  };
}
