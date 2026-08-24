import type * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../utils/logger.js';
import type { BotRegistry } from '../bot-registry.js';
import type { TaskScheduler } from '../../scheduler/task-scheduler.js';
import type { DocSync } from '../../sync/doc-sync.js';
import type { PeerManager } from '../peer-manager.js';

import type { AsyncTaskStore } from '../async-task-store.js';
import type { IntentRouter } from '../intent-router.js';
import type { CircuitBreaker } from '../circuit-breaker.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TeamManager } from '../team-manager.js';
import type { VoiceMeetingService } from '../voice-meeting.js';
import type { VoiceIdentityStore } from '../voice-identity.js';
import type { RtcVoiceChatService } from '../rtc-voice-chat.js';
import type { WebSocketHandle } from '../../web/ws-server.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { ActivityStore } from '../activity-store.js';
import type { AgentTeamStore } from '../../agent-teams/team-store.js';
import type { AgentTeamSupervisor } from '../../agent-teams/team-supervisor.js';
import type { AgentTeamGovernanceExtension } from '../../agent-teams/governance-extension.js';
import type { AgentTeamExecutionPrincipal } from '../../agent-teams/governance-capability.js';
import type { ExecutionCapabilityService } from '../../services/execution-capabilities.js';
import type { TerminalEventDispatcher, TerminalEventStore } from '../../services/terminal-event-store.js';
import type { TerminalEventRateLimiter } from './worker-events-routes.js';
import type { RulesPackExecutionPrincipal } from '@metabot/rulespack-adapter';
import type { RulesPackWorkerCoordinator } from '../../extensions/rulespack-worker-coordinator.js';

export interface RouteContext {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  asyncTaskStore: AsyncTaskStore;
  intentRouter: IntentRouter;
  circuitBreaker: CircuitBreaker;
  budgetManager: BudgetManager;
  teamManager: TeamManager;
  meetingService: VoiceMeetingService;
  voiceIdentityStore: VoiceIdentityStore;
  rtcService?: RtcVoiceChatService;
  ws: { handle?: WebSocketHandle };
  sessionRegistry?: SessionRegistry;
  activityStore?: ActivityStore;
  agentTeamStore?: AgentTeamStore;
  agentTeamSupervisor?: AgentTeamSupervisor;
  agentTeamGovernance?: AgentTeamGovernanceExtension;
  resolveAgentTeamPrincipal?: (req: http.IncomingMessage) => AgentTeamExecutionPrincipal;
  /** Verified engine identity only; undefined for local-admin and generic Core bearer requests. */
  resolveAgentTeamCapabilityPrincipal?: (req: http.IncomingMessage) => AgentTeamExecutionPrincipal | undefined;
  resolveRulesPackTransportIssuer?: (req: http.IncomingMessage) => string | undefined;
  resolveRulesPackApiPrincipal?: (
    req: http.IncomingMessage,
    target: Parameters<typeof import('../../extensions/rulespack-api-principal.js').resolveRulesPackApiPrincipal>[1],
  ) => RulesPackExecutionPrincipal;
  executionCapabilityService?: ExecutionCapabilityService;
  rulesPackWorkerCoordinator?: RulesPackWorkerCoordinator;
  terminalEventStore?: TerminalEventStore;
  terminalEventDispatcher?: TerminalEventDispatcher;
  terminalEventRateLimiter?: TerminalEventRateLimiter;
}

/**
 * A route handler function. Returns true if it handled the request, false otherwise.
 */
export type RouteHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
) => Promise<boolean>;
