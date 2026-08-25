import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { Logger } from '../utils/logger.js';
import { buildAgentTeamPromptContext } from './prompt-context.js';
import type { AgentTeamStore, TeamAgent, TeamMessage, TeamRun, TeamTask } from './team-store.js';
import type { AgentTeamGovernanceExtension } from './governance-extension.js';
import {
  AgentTeamRunBudget,
  resolveAgentTeamExecutionLimits,
  type AgentTeamExecutionLimits,
} from './run-budget.js';
import {
  ExecutionPolicyError,
  executionFailureMetadata,
  type ExecutionFailureMetadata,
} from '../services/execution-failure.js';

export interface AgentTeamSupervisorOptions {
  registry: BotRegistry;
  store: AgentTeamStore;
  governance?: AgentTeamGovernanceExtension;
  logger: Logger;
  intervalMs?: number;
  executionLimits?: Partial<AgentTeamExecutionLimits>;
}

interface RunnableAgent {
  agent: TeamAgent;
  messages: TeamMessage[];
  tasks: TeamTask[];
  key: string;
  isolatedSession: boolean;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PARALLEL_PER_AGENT = 4;

export class AgentTeamSupervisor {
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly maxParallelPerAgent: number;
  private readonly executionLimits: AgentTeamExecutionLimits;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tickInProgress = false;
  private readonly inFlight = new Set<string>();
  private readonly inFlightRuns = new Map<string, { teamName: string; agentName: string; chatId: string; bridge: MessageBridge; taskIds: number[] }>();
  private readonly teamsAwaitingIdleDigest = new Set<string>();

  constructor(private readonly options: AgentTeamSupervisorOptions) {
    this.logger = options.logger.child({ module: 'agent-team-supervisor' });
    const envInterval = Number(process.env.METABOT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS);
    this.intervalMs = Math.max(1_000, options.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS));
    const envMaxParallel = Number(process.env.METABOT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT);
    this.maxParallelPerAgent = Math.max(
      1,
      Number.isFinite(envMaxParallel) && envMaxParallel > 0
        ? Math.floor(envMaxParallel)
        : DEFAULT_MAX_PARALLEL_PER_AGENT,
    );
    this.executionLimits = resolveAgentTeamExecutionLimits(options.executionLimits);
  }

  start(): void {
    if (this.timer || process.env.METABOT_AGENT_TEAM_SUPERVISOR === '0') return;
    this.stopped = false;
    this.recoverStaleRunningRuns();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error({ err }, 'Agent team supervisor tick failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch((err) => {
      this.logger.error({ err }, 'Agent team supervisor initial tick failed');
    });
    this.logger.info({ intervalMs: this.intervalMs }, 'Agent team supervisor started');
  }

  destroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const run of this.inFlightRuns.values()) {
      run.bridge.stopChatTask(run.chatId);
    }
    this.inFlightRuns.clear();
  }

  stopRun(teamName: string, runId: string): TeamRun | undefined {
    const run = this.options.store.updateRun(teamName, runId, { status: 'stopped' });
    if (!run) return undefined;
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) {
      inFlight.bridge.stopChatTask(inFlight.chatId);
      for (const taskId of inFlight.taskIds) {
        const task = this.options.store.getTask(teamName, taskId);
        if (task?.status === 'in_progress') {
          this.options.store.updateTask(teamName, taskId, {
            status: 'pending',
            result: `Stopped run ${runId}; task requeued.`,
          });
        }
      }
    } else if (run.taskId != null) {
      const task = this.options.store.getTask(teamName, run.taskId);
      if (task?.status === 'in_progress') {
        this.options.store.updateTask(teamName, run.taskId, {
          status: 'pending',
          result: `Stopped run ${runId}; task requeued.`,
        });
      }
    }
    return run;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      this.reapExpiredGovernedAgents();
      if (!this.selectExecutionBot()) return;
      for (const team of this.options.store.listTeams()) {
        if (team.status !== 'active') continue;
        this.markOpenWorkForIdleDigest(team.name);
        if (!this.hasActiveLeadAgent(team.name)) {
          this.drainLeaderActivityInbox(team.name);
        }
        const agents = this.options.store.listAgents(team.name).filter((agent) => agent.status !== 'stopped');
        for (const agent of agents) {
          const runnables = this.findRunnableAgents(team.name, agent);
          for (const runnable of runnables) {
            const key = `${team.name}:${agent.name}:${runnable.key}`;
            if (this.inFlight.has(key)) continue;
            this.inFlight.add(key);
            void this.runAgent(team.name, runnable)
              .catch((err) =>
                this.logger.error({ err, teamName: team.name, agentName: agent.name }, 'Agent team run rejected'),
              )
              .finally(() => {
                this.inFlight.delete(key);
                if (!this.stopped) this.maybeEmitIdleDigest(team.name);
              });
          }
        }
        this.maybeEmitIdleDigest(team.name);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private selectExecutionBot(): RegisteredBot | undefined {
    return this.options.registry.get('metabot') ?? this.options.registry.listRegistered()[0];
  }

  private recoverStaleRunningRuns(): void {
    for (const team of this.options.store.listTeams()) {
      for (const run of this.options.store.listRuns(team.name)) {
        if (run.status !== 'running') continue;
        const message = 'Bridge restarted before this Agent Team run completed; marking stale run failed and requeueing assigned task.';
        this.options.store.updateRun(team.name, run.id, {
          status: 'failed',
          error: message,
        });
        if (run.taskId != null) {
          const task = this.options.store.getTask(team.name, run.taskId);
          if (task?.status === 'in_progress') {
            this.options.store.updateTask(team.name, run.taskId, {
              status: 'pending',
              result: `${message} Run: ${run.id}`,
            });
          }
        }
        if (run.agentName) {
          const agent = this.options.store.getAgent(team.name, run.agentName);
          // A temporary Agent may have been reaped immediately before a
          // process crash. Preserve its stopped state while repairing the
          // stale Run/task; reviving it would bypass the recycled lease.
          if (agent && agent.status !== 'stopped') {
            this.options.store.setAgentStatus(team.name, run.agentName, 'idle');
          }
          if (run.agentName !== 'lead') {
            this.options.store.sendMessage(team.name, {
              fromName: run.agentName,
              toName: 'lead',
              summary: `Recovered stale run ${run.id}`,
              body: `Agent ${run.agentName} had stale running run ${run.id} after bridge restart. The run was marked failed and its assigned task was requeued if it was still in progress.`,
            });
            this.notifyTeamActivity(team.name, run.agentName, `Recovered stale run ${run.id}; assigned task was requeued if it was still in progress.`);
          }
        }
      }
    }
  }

  private findRunnableAgents(teamName: string, agent: TeamAgent): RunnableAgent[] {
    const runningCount = this.options.store.listRuns(teamName)
      .filter((run) => run.agentName === agent.name && run.status === 'running')
      .length;
    const capacity = this.maxParallelPerAgent - runningCount;
    if (capacity <= 0) return [];

    const messages = this.options.store.listMessages(teamName, agent.name, true);
    const tasks = this.options.store.listTasks(teamName)
      .filter((task) => task.owner === agent.name && task.status === 'pending' && task.blockedBy.length === 0);
    if (messages.length === 0 && tasks.length === 0) return [];

    const runnables: RunnableAgent[] = [];
    const usedMessageIds = new Set<number>();
    for (const task of tasks.slice(0, capacity)) {
      const taskMessages = messages.filter((message) => messageReferencesTask(message, task.id));
      for (const message of taskMessages) usedMessageIds.add(message.id);
      runnables.push({
        agent,
        messages: taskMessages,
        tasks: [task],
        key: `task:${task.id}`,
        isolatedSession: false,
      });
    }

    const unmatchedMessages = messages.filter((message) => !usedMessageIds.has(message.id));
    // An unrelated inbox message must not open a parallel message-only lane
    // while this Agent has task work running or ready to start. Leave it
    // unread; the next tick after task Runs drain will pick it up. Messages
    // associated with a newly runnable task remain attached to that task lane.
    if (runningCount === 0 && runnables.length === 0 && unmatchedMessages.length > 0) {
      runnables.push({
        agent,
        messages: unmatchedMessages,
        tasks: [],
        key: 'messages',
        isolatedSession: false,
      });
    }

    const shouldIsolateSessions = runningCount > 0 || runnables.length > 1;
    return runnables.map((runnable) => ({
      ...runnable,
      isolatedSession: shouldIsolateSessions,
    }));
  }

  private async runAgent(teamName: string, runnable: RunnableAgent): Promise<void> {
    const { agent, messages, tasks, isolatedSession } = runnable;
    const preparation = this.options.governance?.prepareRun(teamName, agent.name);
    const bot = preparation?.executionBot
      ? this.options.registry.get(preparation.executionBot)
      : this.selectExecutionBot();
    if (!bot) {
      this.logger.error(
        { teamName, agentName: agent.name, executionBot: preparation?.executionBot },
        'Agent team execution bot unavailable',
      );
      return;
    }
    if (preparation) this.options.governance!.assertCanStartRun(preparation.instanceId, agent.name);
    const preflightChatId = preparation?.chatId ?? `team:${teamName}:${agent.name}`;
    const preflight = tasks.length > 0
      ? bot.bridge.preflightApiTask?.({ chatId: preflightChatId, engine: agent.engine })
      : undefined;
    if (preflight && !preflight.ok) {
      this.failTasksTerminally(teamName, tasks, preflight.failure, 'Preflight rejected before creating a Run');
      if (messages.length > 0) {
        this.options.store.markMessagesReadById(teamName, agent.name, messages.map((message) => message.id));
      }
      this.notifyTeamActivity(teamName, agent.name, `Task failed preflight [${preflight.failure.code}]: ${preflight.failure.message}`);
      this.sendFailureToLead(teamName, agent, undefined, preflight.failure, 'preflight');
      return;
    }
    const run = this.options.store.createRun(teamName, {
      agentName: agent.name,
      taskId: tasks[0]?.id,
    });
    const chatId =
      preparation?.chatId ??
      (isolatedSession ? `team:${teamName}:${agent.name}:${run.id}` : `team:${teamName}:${agent.name}`);
    const rulesContext = preparation
      ? this.options.governance!.buildRulesContext(preparation.instanceId, {
          agentName: agent.name,
          agentRole: agent.role,
        }).text
      : undefined;
    this.inFlightRuns.set(run.id, {
      teamName,
      agentName: agent.name,
      chatId,
      bridge: bot.bridge,
      taskIds: tasks.map((task) => task.id),
    });
    this.options.store.setAgentStatus(teamName, agent.name, 'working');
    for (const task of tasks) {
      this.options.store.updateTask(teamName, task.id, { status: 'in_progress' });
    }
    if (messages.length > 0) {
      this.options.store.markMessagesReadById(teamName, agent.name, messages.map((message) => message.id));
    }
    const leadMessageIdsBeforeRun = new Set(
      agent.name === 'lead'
        ? []
        : this.options.store.listMessages(teamName, 'lead').map((message) => message.id),
    );
    const budget = new AgentTeamRunBudget(this.executionLimits);
    let budgetFailure: ExecutionFailureMetadata | undefined;

    try {
      this.applyAgentSession(bot.bridge, chatId, agent, !!preparation || !isolatedSession);
      const result = await bot.bridge.executeApiTask({
        chatId,
        userId: 'agent-team-supervisor',
        sendCards: false,
        maxTurns: this.executionLimits.maxTurns,
        maxBudgetUsd: this.executionLimits.maxBudgetUsd,
        timeoutMs: this.executionLimits.timeoutMs,
        idleTimeoutMs: this.executionLimits.idleTimeoutMs,
        prompt: this.buildPrompt(teamName, agent, messages, tasks, rulesContext),
        rulesPack: {
          principal: {
            kind: 'scoped',
            source: 'capability',
            botName: bot.name,
            chatId,
            roles: [agent.role ?? 'agent'],
            agentName: agent.name,
            taskId: tasks[0] ? String(tasks[0].id) : run.id,
            userId: 'agent-team-supervisor',
            dataClasses: ['agent-team'],
            outputTypes: ['text'],
          },
        },
        onUpdate: (state) => {
          if (preparation) this.options.governance!.touchAgent(preparation.instanceId, agent.name);
          const current = this.options.store.getRun(teamName, run.id);
          if (!current || current.status !== 'running') return;
          const output = state.responseText?.trim();
          if (output) {
            this.options.store.appendRunOutput(teamName, run.id, output);
            const terminalReason = budget.observe(output);
            if (terminalReason && !budgetFailure) {
              budgetFailure = executionFailureMetadata(
                new ExecutionPolicyError('EXECUTION_BUDGET_EXCEEDED', terminalReason),
              );
              bot.bridge.stopChatTask(chatId);
            }
          } else {
            this.options.store.updateRun(teamName, run.id, {});
          }
        },
      });
      const currentRun = this.options.store.getRun(teamName, run.id);
      if (currentRun?.status === 'stopped') {
        this.requeueInProgressTasks(teamName, tasks, `Stopped run ${run.id}; task requeued.`);
        return;
      }
      if (result.sessionId && (preparation || !isolatedSession)) {
        this.options.store.setAgentSessionId(teamName, agent.name, result.sessionId, agent.engine);
      }
      const effectiveSuccess = result.success && !budgetFailure;
      const failure = effectiveSuccess
        ? undefined
        : budgetFailure ?? result.failure ?? executionFailureMetadata(result.error ?? 'Execution failed');
      this.options.store.updateRun(teamName, run.id, {
        status: effectiveSuccess ? 'completed' : 'failed',
        output: result.responseText,
        error: failure?.message,
      });
      const memberLeadMessage = agent.name === 'lead'
        ? undefined
        : this.findLatestMemberLeadMessage(teamName, agent.name, leadMessageIdsBeforeRun);
      if (memberLeadMessage && !this.hasActiveLeadAgent(teamName)) {
        this.options.store.markMessagesRead(teamName, 'lead');
        this.notifyTeamActivity(teamName, 'lead', truncateActivity(memberLeadMessage.body));
      } else if (agent.name !== 'lead' || messages.length > 0) {
        this.notifyTeamActivity(
          teamName,
          agent.name,
          effectiveSuccess
            ? truncateActivity(result.responseText)
            : `Run ${run.id} failed${failure ? ` [${failure.code}]: ${failure.message}` : ''}.\n\n${truncateActivity(result.responseText)}`,
        );
      }
      if (effectiveSuccess) {
        for (const task of tasks) {
          const latest = this.options.store.getTask(teamName, task.id);
          if (latest?.status === 'in_progress') {
            this.options.store.updateTask(teamName, task.id, {
              status: 'completed',
              result: result.responseText,
            });
          }
        }
      } else {
        this.settleFailedTasks(teamName, tasks, run.id, failure!);
      }
      if (agent.name !== 'lead' && !memberLeadMessage) {
        this.options.store.sendMessage(teamName, {
          fromName: agent.name,
          toName: 'lead',
          summary: effectiveSuccess ? `Completed run ${run.id}` : `Run ${run.id} failed`,
          body: [
            `Agent ${agent.name} finished run ${run.id}.`,
            effectiveSuccess ? 'Status: completed' : `Status: failed${failure ? ` [${failure.code}] (${failure.message})` : ''}`,
            result.responseText ? `\nReport:\n${result.responseText}` : '',
          ].filter(Boolean).join('\n'),
        });
      }
    } catch (err: any) {
      const currentRun = this.options.store.getRun(teamName, run.id);
      if (currentRun?.status === 'stopped') {
        this.requeueInProgressTasks(teamName, tasks, `Stopped run ${run.id}; task requeued.`);
        return;
      }
      const failure = executionFailureMetadata(err);
      this.options.store.updateRun(teamName, run.id, {
        status: 'failed',
        error: failure.message,
      });
      this.settleFailedTasks(teamName, tasks, run.id, failure);
      this.notifyTeamActivity(teamName, agent.name, `Run ${run.id} crashed [${failure.code}]: ${failure.message}`);
      this.sendFailureToLead(teamName, agent, run.id, failure, 'crashed');
      this.logger.error({ err, teamName, agentName: agent.name, runId: run.id }, 'Agent team member run failed');
    } finally {
      if (preparation) this.options.governance!.touchAgent(preparation.instanceId, agent.name);
      this.setAgentIdleIfNoRunningRuns(teamName, agent.name);
      this.inFlightRuns.delete(run.id);
      this.maybeEmitIdleDigest(teamName);
    }
  }

  private reapExpiredGovernedAgents(): void {
    const actions = this.options.governance?.reapExpired() ?? [];
    for (const action of actions) {
      for (const run of action.runningRuns) {
        this.stopRun(action.lease.teamName, run.runId);
        if (run.taskId != null) {
          const task = this.options.store.getTask(action.lease.teamName, run.taskId);
          if (task && (task.status === 'in_progress' || task.status === 'pending')) {
            this.options.store.updateTask(action.lease.teamName, run.taskId, {
              status: 'pending',
              result: `Temporary agent ${action.lease.agentName} recycled (${action.reason}); task requeued.`,
            });
          }
        }
      }
      this.logger.info(
        {
          teamName: action.lease.teamName,
          agentName: action.lease.agentName,
          reason: action.reason,
          stoppedRuns: action.runningRuns.map((run) => run.runId),
        },
        'Reaped governed temporary Agent',
      );
    }
  }

  private applyAgentSession(bridge: MessageBridge, chatId: string, agent: TeamAgent, reuseSession: boolean): void {
    const sessionManager = bridge.getSessionManager();
    if (agent.engine) sessionManager.setSessionEngine(chatId, agent.engine);
    if (reuseSession && agent.sessionId) sessionManager.setSessionId(chatId, agent.sessionId, agent.engine);
  }

  private setAgentIdleIfNoRunningRuns(teamName: string, agentName: string): void {
    const agent = this.options.store.getAgent(teamName, agentName);
    if (!agent || agent.status === 'stopped') return;
    if (this.options.store.getRunningRun(teamName, agentName)) return;
    this.options.store.setAgentStatus(teamName, agentName, 'idle');
  }

  private requeueInProgressTasks(teamName: string, tasks: TeamTask[], result: string): void {
    for (const task of tasks) {
      const latest = this.options.store.getTask(teamName, task.id);
      if (latest?.status === 'in_progress') {
        this.options.store.updateTask(teamName, task.id, {
          status: 'pending',
          result,
        });
      }
    }
  }

  private settleFailedTasks(
    teamName: string,
    tasks: TeamTask[],
    runId: string,
    failure: ExecutionFailureMetadata,
  ): void {
    const runs = this.options.store.listRuns(teamName);
    for (const task of tasks) {
      const latest = this.options.store.getTask(teamName, task.id);
      if (latest?.status !== 'in_progress') continue;
      const failures = runs.filter((run) => run.taskId === task.id && run.status === 'failed');
      const sameFailures = failures.filter((run) =>
        executionFailureMetadata(run.error ?? 'Execution failed').fingerprint === failure.fingerprint,
      ).length;
      const terminal = !failure.retryable ||
        sameFailures >= this.executionLimits.sameFailureLimit ||
        failures.length >= this.executionLimits.failedRunLimit;
      this.options.store.updateTask(teamName, task.id, {
        status: terminal ? 'failed' : 'pending',
        result: terminal
          ? `Terminal failure [${failure.code}] after run ${runId}: ${failure.message}`
          : `Run ${runId} failed [${failure.code}] and may retry: ${failure.message}`,
      });
    }
  }

  private failTasksTerminally(
    teamName: string,
    tasks: TeamTask[],
    failure: ExecutionFailureMetadata,
    prefix: string,
  ): void {
    for (const task of tasks) {
      const latest = this.options.store.getTask(teamName, task.id);
      if (latest?.status !== 'pending' && latest?.status !== 'in_progress') continue;
      this.options.store.updateTask(teamName, task.id, {
        status: 'failed',
        result: `${prefix} [${failure.code}]: ${failure.message}`,
      });
    }
  }

  private sendFailureToLead(
    teamName: string,
    agent: TeamAgent,
    runId: string | undefined,
    failure: ExecutionFailureMetadata,
    phase: string,
  ): void {
    if (agent.name === 'lead') return;
    const label = runId ? `run ${runId}` : 'execution';
    this.options.store.sendMessage(teamName, {
      fromName: agent.name,
      toName: 'lead',
      summary: `${label} failed`,
      body: `Agent ${agent.name} ${phase} during ${label}: [${failure.code}] ${failure.message}`,
    });
  }

  private findLatestMemberLeadMessage(teamName: string, agentName: string, idsBeforeRun: Set<number>): TeamMessage | undefined {
    return this.options.store.listMessages(teamName, 'lead')
      .filter((message) => message.fromName === agentName && !idsBeforeRun.has(message.id))
      .at(-1);
  }

  private hasActiveLeadAgent(teamName: string): boolean {
    const lead = this.options.store.getAgent(teamName, 'lead');
    return !!lead && lead.status !== 'stopped';
  }

  private drainLeaderActivityInbox(teamName: string): void {
    const messages = this.options.store.listMessages(teamName, 'lead', true);
    if (messages.length === 0) return;
    const latest = messages.at(-1);
    if (!latest) return;
    this.options.store.markMessagesRead(teamName, 'lead');
    this.notifyTeamActivity(teamName, 'lead', truncateActivity(latest.body));
  }

  private markOpenWorkForIdleDigest(teamName: string): void {
    if (this.hasOpenWork(teamName)) {
      this.teamsAwaitingIdleDigest.add(teamName);
    }
  }

  private maybeEmitIdleDigest(teamName: string): void {
    if (!this.teamsAwaitingIdleDigest.has(teamName)) return;
    const team = this.options.store.getTeam(teamName);
    if (!team || team.status !== 'active') {
      this.teamsAwaitingIdleDigest.delete(teamName);
      return;
    }
    if (this.hasOpenWork(teamName)) return;
    this.teamsAwaitingIdleDigest.delete(teamName);
    this.notifyTeamActivity(teamName, 'idle digest', this.buildIdleDigest(teamName));
  }

  private hasOpenWork(teamName: string): boolean {
    const hasWorkingAgent = this.options.store.listAgents(teamName)
      .some((agent) => agent.status === 'working');
    if (hasWorkingAgent) return true;
    const hasOpenTask = this.options.store.listTasks(teamName)
      .some((task) => task.status === 'pending' || task.status === 'in_progress');
    if (hasOpenTask) return true;
    const hasRunningRun = this.options.store.listRuns(teamName)
      .some((run) => run.status === 'running');
    if (hasRunningRun) return true;
    const hasInFlightRun = [...this.inFlightRuns.values()]
      .some((run) => run.teamName === teamName);
    if (hasInFlightRun) return true;
    return this.options.store.listMessages(teamName, 'lead', true).length > 0;
  }

  private buildIdleDigest(teamName: string): string {
    const agents = this.options.store.listAgents(teamName).filter((agent) => agent.status !== 'stopped');
    const completedTasks = this.options.store.listTasks(teamName).filter((task) => task.status === 'completed');
    const recentRuns = this.options.store.listRuns(teamName).slice(0, 3);
    const runSummary = recentRuns.length
      ? recentRuns.map((run) => `${run.agentName ?? 'agent'} ${run.status}`).join(', ')
      : 'no recent runs';
    return [
      'Team is idle.',
      `Members idle: ${agents.length}. Open tasks: 0. Running runs: 0. Unread lead messages: 0.`,
      `Completed tasks: ${completedTasks.length}. Recent runs: ${runSummary}.`,
    ].join('\n');
  }

  private notifyTeamActivity(teamName: string, agentName: string, body: string): void {
    const team = this.options.store.getTeam(teamName);
    if (!team || team.status !== 'active') return;
    const chatIds = team.displayChatIds;
    if (chatIds.length === 0) return;
    const pinnedPmBot = this.options.governance?.findInstanceByTeamName(teamName)?.pmBot;
    const bot = (pinnedPmBot ? this.options.registry.get(pinnedPmBot) : undefined) ?? this.selectExecutionBot();
    if (pinnedPmBot && bot?.config.name !== pinnedPmBot) {
      this.logger.warn(
        { teamName, pinnedPmBot, fallbackBot: bot?.config.name },
        'Pinned Agent Team PM bot unavailable for activity card; using fallback',
      );
    }
    const bridge = bot?.bridge as MessageBridge & { sendAgentActivityCard?: (chatId: string, body: string) => Promise<void> };
    if (!bridge?.sendAgentActivityCard) return;
    const cardBody = [
      `**${teamName} / ${agentName}**`,
      body,
    ].join('\n\n');
    for (const chatId of chatIds) {
      void Promise.resolve(bridge.sendAgentActivityCard(chatId, cardBody)).catch((err) => {
        this.logger.warn({ err, teamName, agentName, chatId }, 'Agent team activity card failed');
      });
    }
  }

  private buildPrompt(
    teamName: string,
    agent: TeamAgent,
    messages: TeamMessage[],
    tasks: TeamTask[],
    governedRules?: string,
  ): string {
    const teamContext = buildAgentTeamPromptContext(this.options.store, teamName) ?? '';
    const role = agent.role ? `Role: ${agent.role}` : 'Role: team member';
    const customPrompt = agent.prompt ? `\nMember instructions:\n${agent.prompt}\n` : '';
    const rulesContext = governedRules ? `\nPinned governance rules:\n${governedRules}\n` : '';
    const messageBlock = messages.length
      ? messages.map((message) => `- #${message.id} from ${message.fromName ?? 'system'}: ${message.summary ? `${message.summary}\n  ` : ''}${message.body}`).join('\n')
      : '- none';
    const taskBlock = tasks.length
      ? tasks.map((task) => [
        `- #${task.id} ${task.subject}`,
        task.description ? `  ${task.description}` : undefined,
      ].filter(Boolean).join('\n')).join('\n')
      : '- none';

    if (agent.name === 'lead') {
      return [
        `You are MetaBot Agent Team lead in team "${teamName}".`,
        role,
        customPrompt,
        rulesContext,
        teamContext,
        '',
        'You were woken in the background by Agent Team messages between user turns.',
        'Your response will be sent to the user as an Agent Activity card.',
        'Write only the final user-facing answer or concise status the user needs.',
        'Do not include internal bookkeeping such as run ids, touched ids, inbox ids, "blocked", or implementation notes unless the user explicitly needs them.',
        'Do not create new tasks or handoffs unless the incoming message asks for follow-up work.',
        '',
        'Unread team messages:',
        messageBlock,
        '',
        'Assigned pending tasks now moved to in_progress:',
        taskBlock,
      ].join('\n');
    }

    return [
      `You are MetaBot Agent Team member "${agent.name}" in team "${teamName}".`,
      role,
      customPrompt,
      rulesContext,
      teamContext,
      '',
      'You run in an independent persistent chat session. Coordinate through the MetaBot teams CLI, not through user chat.',
      '',
      'Unread team messages:',
      messageBlock,
      '',
      'Assigned pending tasks now moved to in_progress:',
      taskBlock,
      '',
      'When useful, update task status/results with `metabot teams tasks update`, send messages with `metabot teams send`, and create more tasks for other members.',
      'Finish this turn with a concise report of what you did, what remains blocked, and which team task/message IDs you touched.',
    ].join('\n');
  }
}

function truncateActivity(text: string | undefined, max = 800): string {
  const value = text?.trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function messageReferencesTask(message: TeamMessage, taskId: number): boolean {
  const text = `${message.summary ?? ''}\n${message.body ?? ''}`;
  return text.includes(`#${taskId}`) || text.includes(`task ${taskId}`) || text.includes(`Task ${taskId}`);
}
