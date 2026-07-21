import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { AgentActivityCardMetadata, MessageBridge } from '../bridge/message-bridge.js';
import type { Logger } from '../utils/logger.js';
import type { AgentTeam, AgentTeamStore, TeamAgent, TeamMessage, TeamRule, TeamRun, TeamTask } from './team-store.js';

export interface AgentTeamSupervisorOptions {
  registry: BotRegistry;
  store: AgentTeamStore;
  logger: Logger;
  intervalMs?: number;
  /** Explicit bridge bot used to execute Agent Team runs. */
  executionBotName?: string;
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
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tickInProgress = false;
  private readonly inFlight = new Set<string>();
  private readonly inFlightRuns = new Map<string, { teamName: string; agentName: string; chatId: string; bridge: MessageBridge; taskIds: number[] }>();
  private readonly teamsAwaitingIdleDigest = new Set<string>();
  private readonly teamsSuppressNextIdleDigest = new Set<string>();

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
    }
    return run;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      const fallbackBot = this.selectExecutionBot();
      if (!fallbackBot) return;
      this.recycleExpiredTemporaryAgents();
      for (const team of this.options.store.listTeams()) {
        if (team.status !== 'active') continue;
        // A chat/project-scoped instance runs through its own PM bot so a
        // pm-claude-owned team is not forced through the globally configured
        // execution bot. Teams without pmBot keep the legacy selection.
        const bot = this.selectExecutionBotForTeam(team) ?? fallbackBot;
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
            void this.runAgent(bot, team.name, runnable).finally(() => {
              this.inFlight.delete(key);
              this.maybeEmitIdleDigest(team.name);
            });
          }
        }
        this.maybeEmitIdleDigest(team.name);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Prefer the team instance's own `pmBot` when it is registered. Returns
   * `undefined` so the caller falls back to the globally configured execution
   * bot (and then the legacy fallback chain) when there is no usable pmBot.
   */
  private selectExecutionBotForTeam(team: AgentTeam): RegisteredBot | undefined {
    const pmBot = team.pmBot?.trim();
    if (!pmBot) return undefined;
    const bot = this.options.registry.get(pmBot);
    if (bot) return bot;
    this.logger.warn({ team: team.name, pmBot }, 'Agent Team pmBot not registered; falling back to configured execution bot');
    return undefined;
  }

  private selectExecutionBot(): RegisteredBot | undefined {
    const configured = this.options.executionBotName?.trim();
    if (configured) {
      const bot = this.options.registry.get(configured);
      if (bot) return bot;
      this.logger.warn({ executionBotName: configured }, 'Configured Agent Team execution bot not found; falling back');
    }
    return this.options.registry.get('metabot')
      ?? this.options.registry.get('research-pm')
      ?? this.options.registry.listRegistered().find((bot) => bot.name !== 'manager')
      ?? this.options.registry.listRegistered()[0];
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
          this.options.store.setAgentStatus(team.name, run.agentName, 'idle');
          if (run.agentName !== 'lead') {
            this.options.store.sendMessage(team.name, {
              fromName: run.agentName,
              toName: 'lead',
              summary: `Recovered stale run ${run.id}`,
              body: `Agent ${run.agentName} had stale running run ${run.id} after bridge restart. The run was marked failed and its assigned task was requeued if it was still in progress.`,
            });
            this.notifyTeamActivity(
              team.name,
              run.agentName,
              `Recovered stale run ${run.id}; assigned task was requeued if it was still in progress.`,
              { runId: run.id, taskIds: run.taskId == null ? [] : [run.taskId] },
            );
          }
        }
      }
    }
  }

  private findRunnableAgents(teamName: string, agent: TeamAgent): RunnableAgent[] {
    const team = this.options.store.getTeam(teamName);
    const maxParallelForAgent = Math.min(
      this.maxParallelPerAgent,
      team?.quotas.maxParallelRunsPerAgent ?? this.maxParallelPerAgent,
    );
    const runningCount = this.options.store.listRuns(teamName)
      .filter((run) => run.agentName === agent.name && run.status === 'running')
      .length;
    const capacity = maxParallelForAgent - runningCount;
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
    if (unmatchedMessages.length > 0 && runnables.length < capacity) {
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

  private async runAgent(bot: RegisteredBot, teamName: string, runnable: RunnableAgent): Promise<void> {
    const { agent, messages, tasks, isolatedSession } = runnable;
    const run = this.options.store.createRun(teamName, {
      agentName: agent.name,
      taskId: tasks[0]?.id,
    });
    const chatId = this.buildAgentChatId(teamName, agent.name, isolatedSession ? run.id : undefined);
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

    try {
      this.applyAgentSession(bot.bridge, chatId, agent, !isolatedSession);
      const result = await bot.bridge.executeApiTask({
        chatId,
        userId: 'agent-team-supervisor',
        sendCards: false,
        lifecycleKey: buildAgentRunLifecycleKey(this.options.store.getTeam(teamName), teamName, agent.name, run.id),
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        approvalPolicy: agent.approvalPolicy,
        sandbox: agent.sandbox,
        timeoutMs: agent.timeoutMs,
        idleTimeoutMs: agent.idleTimeoutMs,
        allowedTools: agent.allowedTools,
        prompt: this.buildPrompt(teamName, agent, messages, tasks),
        onUpdate: (state) => {
          const current = this.options.store.getRun(teamName, run.id);
          if (!current || current.status !== 'running') return;
          const output = state.responseText?.trim();
          if (output) {
            this.options.store.appendRunOutput(teamName, run.id, output);
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
      if (result.sessionId && !isolatedSession) {
        this.options.store.setAgentSessionId(teamName, agent.name, result.sessionId, agent.engine);
      }
      this.options.store.updateRun(teamName, run.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.responseText,
        error: result.error,
      });
      const memberLeadMessage = agent.name === 'lead'
        ? undefined
        : this.findLatestMemberLeadMessage(teamName, agent.name, leadMessageIdsBeforeRun);
      let emittedRunActivity = false;
      if (memberLeadMessage && !this.hasActiveLeadAgent(teamName)) {
        emittedRunActivity = this.notifyTeamActivity(
          teamName,
          'lead',
          truncateActivity(memberLeadMessage.body),
          { runId: run.id, taskIds: tasks.map((task) => task.id) },
        );
        if (emittedRunActivity) {
          this.options.store.markMessagesRead(teamName, 'lead');
        }
      } else if (agent.name !== 'lead' || messages.length > 0) {
        emittedRunActivity = this.notifyTeamActivity(
          teamName,
          agent.name,
          result.success
            ? truncateActivity(result.responseText)
            : `Run ${run.id} failed${result.error ? `: ${result.error}` : ''}.\n\n${truncateActivity(result.responseText)}`,
          { runId: run.id, taskIds: tasks.map((task) => task.id) },
        );
      }
      if (emittedRunActivity) {
        this.teamsSuppressNextIdleDigest.add(teamName);
      }
      if (result.success) {
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
        this.requeueInProgressTasks(teamName, tasks, `Run ${run.id} failed${result.error ? `: ${result.error}` : ''}`);
      }
      if (agent.name !== 'lead' && !memberLeadMessage && (!emittedRunActivity || this.hasActiveLeadAgent(teamName))) {
        this.options.store.sendMessage(teamName, {
          fromName: agent.name,
          toName: 'lead',
          summary: result.success ? `Completed run ${run.id}` : `Run ${run.id} failed`,
          body: [
            `Agent ${agent.name} finished run ${run.id}.`,
            result.success ? 'Status: completed' : `Status: failed${result.error ? ` (${result.error})` : ''}`,
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
      this.options.store.updateRun(teamName, run.id, {
        status: 'failed',
        error: err?.message || String(err),
      });
      this.requeueInProgressTasks(teamName, tasks, `Run ${run.id} crashed: ${err?.message || String(err)}`);
      const emittedCrashActivity = this.notifyTeamActivity(
        teamName,
        agent.name,
        `Run ${run.id} crashed: ${err?.message || String(err)}`,
        { runId: run.id, taskIds: tasks.map((task) => task.id) },
      );
      if (emittedCrashActivity) {
        this.teamsSuppressNextIdleDigest.add(teamName);
      }
      if (agent.name !== 'lead' && (!emittedCrashActivity || this.hasActiveLeadAgent(teamName))) {
        this.options.store.sendMessage(teamName, {
          fromName: agent.name,
          toName: 'lead',
          summary: `Run ${run.id} crashed`,
          body: `Agent ${agent.name} crashed in run ${run.id}: ${err?.message || String(err)}`,
        });
      }
      this.logger.error({ err, teamName, agentName: agent.name, runId: run.id }, 'Agent team member run failed');
    } finally {
      this.setAgentIdleIfNoRunningRuns(teamName, agent.name);
      this.inFlightRuns.delete(run.id);
      this.maybeEmitIdleDigest(teamName);
    }
  }

  private applyAgentSession(bridge: MessageBridge, chatId: string, agent: TeamAgent, reuseSession: boolean): void {
    const sessionManager = bridge.getSessionManager();
    if (agent.engine) sessionManager.setSessionEngine(chatId, agent.engine);
    if (agent.model) sessionManager.setSessionModel(chatId, agent.model, agent.engine);
    if (reuseSession && agent.sessionId) sessionManager.setSessionId(chatId, agent.sessionId, agent.engine);
  }

  private buildAgentChatId(teamName: string, agentName: string, runId?: string): string {
    const team = this.options.store.getTeam(teamName);
    const base = team?.instanceId
      ? `teaminst:${team.instanceId}:${agentName}`
      : `team:${teamName}:${agentName}`;
    return runId ? `${base}:${runId}` : base;
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
    if (this.teamsSuppressNextIdleDigest.delete(teamName)) return;
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

  private recycleExpiredTemporaryAgents(): void {
    const expired = this.options.store.stopExpiredTemporaryAgents();
    for (const agent of expired) {
      for (const run of this.options.store.listRuns(agent.teamName)) {
        if (run.agentName !== agent.name || run.status !== 'running') continue;
        const inFlight = this.inFlightRuns.get(run.id);
        if (inFlight) {
          inFlight.bridge.stopChatTask(inFlight.chatId);
        }
        this.options.store.updateRun(agent.teamName, run.id, {
          status: 'stopped',
          error: 'Temporary Agent TTL expired; run stopped and assigned task was requeued if needed.',
        });
        if (run.taskId != null) {
          const task = this.options.store.getTask(agent.teamName, run.taskId);
          if (task?.status === 'in_progress') {
            this.options.store.updateTask(agent.teamName, run.taskId, {
              status: 'pending',
              result: `Temporary Agent ${agent.name} expired during run ${run.id}; task requeued.`,
            });
          }
        }
      }
      this.options.store.sendMessage(agent.teamName, {
        fromName: agent.name,
        toName: 'lead',
        summary: `Temporary Agent ${agent.name} expired`,
        body: `Temporary Agent ${agent.name} reached its TTL and was stopped. Any running assigned task was requeued if it was still in progress.`,
      });
      this.notifyTeamActivity(agent.teamName, agent.name, 'Temporary Agent TTL expired; Agent was stopped and any running assigned task was requeued.');
    }
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

  private notifyTeamActivity(
    teamName: string,
    agentName: string,
    body: string,
    metadata?: Omit<AgentActivityCardMetadata, 'teamName' | 'instanceId' | 'agentName'>,
  ): boolean {
    const team = this.options.store.getTeam(teamName);
    if (!team || team.status !== 'active') return false;
    const chatIds = team.displayChatIds;
    if (chatIds.length === 0) return false;
    const bot = this.selectExecutionBotForTeam(team) ?? this.selectExecutionBot();
    const bridge = bot?.bridge as MessageBridge & {
      sendAgentActivityCard?: (chatId: string, body: string, metadata?: AgentActivityCardMetadata) => Promise<void>;
    };
    if (!bridge?.sendAgentActivityCard) return false;
    const cardBody = [
      `**${teamName} / ${agentName}**`,
      body,
    ].join('\n\n');
    const activityMetadata: AgentActivityCardMetadata = {
      teamName,
      ...(team.instanceId ? { instanceId: team.instanceId } : {}),
      agentName,
      ...(metadata?.runId ? { runId: metadata.runId } : {}),
      ...(metadata?.taskIds?.length ? { taskIds: metadata.taskIds } : {}),
    };
    for (const chatId of chatIds) {
      void Promise.resolve(bridge.sendAgentActivityCard(chatId, cardBody, activityMetadata)).catch((err) => {
        this.logger.warn({ err, teamName, agentName, chatId }, 'Agent team activity card failed');
      });
    }
    return true;
  }

  private buildPrompt(teamName: string, agent: TeamAgent, messages: TeamMessage[], tasks: TeamTask[]): string {
    const team = this.options.store.getTeam(teamName);
    const role = agent.role ? `Role: ${agent.role}` : 'Role: team member';
    const customPrompt = agent.prompt ? `\nMember instructions:\n${agent.prompt}\n` : '';
    const rulesBlock = this.buildRulesBlock(team, agent, tasks);
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
        rulesBlock,
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
      rulesBlock,
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

  private buildRulesBlock(team: AgentTeam | undefined, agent: TeamAgent, tasks: TeamTask[]): string {
    const inlineRules: TeamRule[] = [];
    if (isManagerAgent(agent)) {
      inlineRules.push({
        text: 'Manager boundary: coordinate internal tasks, summarize status, and request PM approval for new Agents, worker_dispatch, service restarts, and template/rule promotion. Do not spawn Agents or run worker_dispatch yourself.',
        overridable: false,
      });
    }
    if (tasks.length > 0) {
      inlineRules.push({
        text: `Current assigned task ids: ${tasks.map((task) => `#${task.id}`).join(', ')}. Keep work scoped to these tasks unless the incoming message explicitly asks for broader follow-up.`,
        overridable: true,
      });
    }
    const pack = this.options.store.buildRuntimeRulesContextPack({
      purpose: 'agent-run',
      teamName: team?.name,
      agentName: agent.name,
      agentRole: agent.role,
      inlineRules,
    });
    if (!pack.text) return '';
    const provenance = pack.provenance.length
      ? `\n\nRules provenance: ${pack.provenance.map((item) => `${item.scope}:${item.name}@v${item.version}`).join(', ')}`
      : '';
    return [
      'Rules Context Pack:',
      pack.text,
      provenance,
      '',
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

function isManagerAgent(agent: TeamAgent): boolean {
  const text = `${agent.name} ${agent.role ?? ''}`.toLowerCase();
  return text.includes('manager') || text.includes('coordinator');
}

function buildAgentRunLifecycleKey(
  team: AgentTeam | undefined,
  teamName: string,
  agentName: string,
  runId: string,
): string {
  const teamKey = team?.instanceId ? `teaminst:${team.instanceId}` : `team:${teamName}`;
  return `${teamKey}:${agentName}:${runId}`;
}
