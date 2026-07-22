// Shared types used across IM platforms (Feishu, Telegram, etc.)

import type { TeamActorRole } from './agent-teams/team-store.js';

export type CardStatus =
  | 'thinking'
  | 'running'
  | 'complete'
  | 'error'
  | 'waiting_for_input'
  /**
   * Card was emitted by `flushSpontaneous` at the end of a between-turn
   * burst (background task return / Agent Team ping / `/goal` evaluator).
   * Rendered in blue with an "Agent activity" title so users can tell
   * it apart from a normal user-prompted turn without reading body text.
   */
  | 'agent_activity';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
}

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type CardLifecycleStage =
  | 'received'
  | 'acknowledged'
  | 'executing'
  | 'checkpointing'
  | 'responding'
  | 'closed'
  | 'recovering'
  | 'blocked';

export interface BackgroundEvent {
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  /** Latest stdout event line from the task, if any. */
  lastEvent?: string;
}

/**
 * Snapshot of an Agent Teams session, derived from Claude Code's
 * TaskCreated / TaskCompleted / TeammateIdle hooks. Rendered in the
 * Feishu card and Web UI as a "team panel" so the user can see
 * agents and the shared task list at a glance.
 */
export interface TeamMember {
  name: string;
  status: 'working' | 'idle';
  /** Most recent task subject this agent touched (best-effort). */
  lastSubject?: string;
}

export interface TeamTask {
  taskId: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  agent?: string;
  /** @deprecated Compatibility for persisted pre-terminology card state. */
  teammate?: string;
}

export interface TeamState {
  /** Team name as reported by the SDK hooks (first non-empty wins). */
  name?: string;
  agents: TeamMember[];
  /** @deprecated Compatibility for persisted pre-terminology card state. */
  teammates?: TeamMember[];
  tasks: TeamTask[];
}

/** Per-turn model provenance. Never populated from assistant natural-language claims. */
export interface ModelTelemetry {
  configuredModel?: string;
  spawnModel?: string;
  runtimeModel?: string;
  runtimeModelSource?: 'assistant_jsonl' | 'result_model_usage';
  sessionId?: string;
  sessionMode?: 'fresh' | 'resume' | 'continue';
  fallbackOriginalModel?: string;
  fallbackModel?: string;
  fallbackReason?: string;
  /** Whether the observed CLI session may be resumed for a later user turn. */
  sessionDisposition?: 'active' | 'retired';
  /** Machine-readable reason for retiring a session from resume mappings. */
  sessionRetireReason?: 'turn_start_timeout';
  /** Whether the PTY accepted this turn's prompt, for bounded bridge recovery. */
  promptSubmission?: 'accepted' | 'not_submitted' | 'ambiguous';
  /** Machine-readable PTY input failure classification. */
  promptFailureReason?:
    | 'tui_not_ready'
    | 'tui_not_idle'
    | 'session_disposed'
    | 'input_not_echoed'
    | 'submit_unacknowledged'
    | 'unknown';
}

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  /** Bounded card lifecycle stage used for recovery, observability, and stuck-card prevention. */
  lifecycleStage?: CardLifecycleStage;
  /** Optional idempotency/recovery key for the card lifecycle. */
  lifecycleKey?: string;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  pendingQuestion?: PendingQuestion;
  /** Primary model used (e.g. "claude-fable-5") */
  model?: string;
  /** Auditable configured/spawn/runtime model provenance for this turn. */
  modelTelemetry?: ModelTelemetry;
  /** Total input+output tokens consumed */
  totalTokens?: number;
  /** Context window size of the primary model */
  contextWindow?: number;
  /** Cumulative session cost (USD), accumulated across queries until /reset */
  sessionCostUsd?: number;
  /** Background tasks (e.g. Monitor) the agent has spawned during this turn. */
  backgroundEvents?: BackgroundEvent[];
  /** Active /goal condition for this session, if any. Mirrored locally so the card can show "🎯 Goal" badge across turns. */
  goalCondition?: string;
  /** Snapshot of the active Agent Team (agents + tasks), if any. */
  teamState?: TeamState;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  /** Authority role for synthetic/internal messages. Human chat messages default to user. */
  actorRole?: TeamActorRole;
  timestamp?: number;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  /** Message explicitly referenced by a user reply. Added to the model prompt, not the card title. */
  replyContext?: {
    messageId: string;
    messageType: string;
    text?: string;
    truncated?: boolean;
  };
  /** Additional media from batched messages (smart debounce). */
  extraMedia?: Array<{
    messageId: string;
    imageKey?: string;
    fileKey?: string;
    fileName?: string;
  }>;
}
