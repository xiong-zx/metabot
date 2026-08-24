import { ArcError } from './errors.js';

/**
 * What a bounded ARC run must prove about its own configuration before the
 * official process is spawned.
 *
 * The upstream guard enforces a ceiling inside the official process. That is
 * necessary but not sufficient for ARC-006: the guard only enforces the policy
 * it is actually given, so a run started with `enforcement: off`, with a
 * different policy, or with a ceiling far above the authorized one would be
 * "guarded" and still spend more than was approved. Everything here is
 * therefore checked against the real parsed configuration file — the same
 * bytes the supervisor hands to the official runner — and refused before any
 * process that could spend money exists.
 *
 * Nothing in this module reads the environment. `RESEARCHCLAW_BUDGET_ENFORCEMENT`
 * makes the official process fail closed, which is a useful backstop, but an
 * environment variable is a statement about a process rather than a statement
 * about a ceiling: it names no policy, no provider, no model, and no amount.
 * Accepting it — or accepting a bare `enforcement: required` with no policy —
 * as evidence would reintroduce exactly the "configured therefore bounded"
 * assumption ARC-011 exists to remove.
 */

/** Hard ceiling this driver will authorize for a bounded acceptance run. */
export const MAX_BOUNDED_USD_TOTAL = 5;

/**
 * Providers whose wire protocol lets the upstream guard both bound a call
 * before dispatch and reconcile it afterwards. Mirrors
 * `researchclaw.budget.policy.SUPPORTED_PROVIDERS` on the guard branch.
 */
export const BOUNDABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'openai-compatible',
  'openrouter',
  'deepseek',
  'novita',
  'minimax',
  'ollama',
  'anthropic',
  'kimi-anthropic',
]);

/**
 * Billable paths that are structurally incapable of a hard ceiling. The guard
 * refuses each of them at dispatch; naming them here turns a mid-run refusal
 * that has already spent money into a refusal to start.
 */
export const UNBOUNDABLE_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['acp', 'the ACP client forwards neither model nor max_tokens to the agent and reports no token usage'],
  ['cli-agent', 'a CLI coding agent picks its own model and turn count; max_budget_usd is its own self-report'],
  ['opencode', 'the opencode CLI manages its own model, turns and token limits and reports no usage'],
  ['gemini-image', 'image generation is billed per image with no token usage to reconcile'],
  ['embeddings', 'the embeddings endpoint is billed per input token with no per-request cap'],
]);

/** One model the configuration authorizes for dispatch. */
export interface BoundedModelEvidence {
  model: string;
  max_completion_tokens: number;
}

/**
 * Exactly what was checked, kept so the run record can state the ceiling it
 * was started under rather than the ceiling someone remembers approving.
 */
export interface BoundedBudgetEvidence {
  policy_id: string;
  provider: string;
  max_calls: number;
  max_prompt_tokens_per_call: number;
  max_completion_tokens_per_call: number;
  max_prompt_tokens_total: number;
  max_completion_tokens_total: number;
  max_usd_total: number;
  allow_preflight: boolean;
  models: BoundedModelEvidence[];
  /** Models the LLM section can dispatch, each of which must be bounded. */
  dispatchable_models: string[];
  config_sha256: string;
}

/**
 * The subset of an official config this driver validates, already resolved by
 * the release's own loader.
 *
 * These are effective values, not the bytes on disk. That distinction is the
 * whole point: ARC's defaults enable several unbudgetable stages, and a named
 * `project.profile` may supply `llm` and `budget` keys the file omits, so a
 * ceiling read straight out of the YAML would describe a run that does not
 * exist.
 *
 * Deliberately narrow: the probe extracts these fields and nothing else, so
 * no API key, base URL, or prompt text is ever read into the daemon or written
 * into a run record.
 */
export interface OfficialBudgetDocument {
  config_sha256?: unknown;
  budget?: unknown;
  llm?: unknown;
  experiment?: unknown;
}

export interface BoundedBudgetRequirement {
  /** The policy the caller authorized; the config must name exactly this one. */
  policyId: string;
  /** Defaults to {@link MAX_BOUNDED_USD_TOTAL}. */
  maxUsdTotal?: number;
}

/**
 * Refuses unless the configuration provably bounds the run to the authorized
 * policy and ceiling. Returns the evidence on success.
 */
export function assertBoundedBudgetPolicy(
  document: OfficialBudgetDocument,
  requirement: BoundedBudgetRequirement,
): BoundedBudgetEvidence {
  const policyId = requirement.policyId.trim();
  if (!policyId) {
    throw refuse('a bounded run was requested without naming a budget policy');
  }
  const ceiling = requirement.maxUsdTotal ?? MAX_BOUNDED_USD_TOTAL;

  const budget = record(document.budget);
  if (!budget) {
    throw refuse('the official config declares no budget section, so nothing bounds the run');
  }

  const enforcement = text(budget.enforcement).toLowerCase();
  if (enforcement !== 'required') {
    throw refuse(
      `the official config sets budget.enforcement=${JSON.stringify(enforcement || '(absent)')}; ` +
        'only "required" refuses an unbudgetable dispatch',
    );
  }

  const configuredPolicy = text(budget.policy_id);
  if (!configuredPolicy) {
    throw refuse('the official config sets budget.enforcement=required but declares no budget.policy_id');
  }
  if (configuredPolicy !== policyId) {
    throw refuse(
      `the official config names budget policy ${JSON.stringify(configuredPolicy)} but the run was authorized ` +
        `for ${JSON.stringify(policyId)}`,
    );
  }

  const llm = record(document.llm) ?? {};
  const provider = text(budget.provider).toLowerCase();
  if (!provider) throw refuse('the budget policy names no provider');
  const unboundable = UNBOUNDABLE_PROVIDERS.get(provider);
  if (unboundable) {
    throw refuse(`budget.provider=${JSON.stringify(provider)} can never be bounded: ${unboundable}`);
  }
  if (!BOUNDABLE_PROVIDERS.has(provider)) {
    throw refuse(
      `budget.provider=${JSON.stringify(provider)} is not known to enforce a per-request completion cap ` +
        'and report token usage',
    );
  }
  const llmProvider = text(llm.provider).toLowerCase();
  if (llmProvider !== provider) {
    throw refuse(
      `the budget policy bounds provider ${JSON.stringify(provider)} but llm.provider is ` +
        `${JSON.stringify(llmProvider || '(absent)')}; the guard would bound a provider the run never uses`,
    );
  }

  const maxCalls = positiveInteger(budget.max_calls, 'budget.max_calls');
  const promptPerCall = positiveInteger(budget.max_prompt_tokens_per_call, 'budget.max_prompt_tokens_per_call');
  const completionPerCall = positiveInteger(
    budget.max_completion_tokens_per_call,
    'budget.max_completion_tokens_per_call',
  );
  const promptTotal = positiveInteger(budget.max_prompt_tokens_total, 'budget.max_prompt_tokens_total');
  const completionTotal = positiveInteger(budget.max_completion_tokens_total, 'budget.max_completion_tokens_total');
  // A total below one call's own ceiling describes a run that cannot complete
  // a single dispatch, which means the stated ceilings were never reconciled.
  if (promptTotal < promptPerCall) {
    throw refuse(
      `budget.max_prompt_tokens_total (${promptTotal}) is below budget.max_prompt_tokens_per_call (${promptPerCall})`,
    );
  }
  if (completionTotal < completionPerCall) {
    throw refuse(
      `budget.max_completion_tokens_total (${completionTotal}) is below ` +
        `budget.max_completion_tokens_per_call (${completionPerCall})`,
    );
  }

  const maxUsd = finiteNumber(budget.max_usd_total, 'budget.max_usd_total');
  if (maxUsd <= 0) throw refuse(`budget.max_usd_total must be positive, got ${maxUsd}`);
  if (maxUsd > ceiling) {
    throw refuse(`budget.max_usd_total is ${maxUsd}, above the authorized ceiling of USD ${ceiling}`);
  }

  const models = modelBounds(budget.models, completionPerCall);
  const named = new Set(models.map((entry) => entry.model));
  // Every model the LLM section can reach must be named, including fallbacks:
  // an unnamed fallback is refused by the guard mid-run, after the primary has
  // already failed and spent.
  const dispatchable = dispatchableModels(llm);
  if (!dispatchable.length) {
    throw refuse('the official config names no llm.primary_model, so no model can be bounded');
  }
  const unbounded = dispatchable.filter((model) => !named.has(model));
  if (unbounded.length) {
    throw refuse(
      `the official config can dispatch ${unbounded.map((model) => JSON.stringify(model)).join(', ')}, ` +
        `which budget.models does not bound`,
    );
  }

  assertNoUnbudgetableStages(record(document.experiment));

  return {
    policy_id: policyId,
    provider,
    max_calls: maxCalls,
    max_prompt_tokens_per_call: promptPerCall,
    max_completion_tokens_per_call: completionPerCall,
    max_prompt_tokens_total: promptTotal,
    max_completion_tokens_total: completionTotal,
    max_usd_total: maxUsd,
    allow_preflight: budget.allow_preflight !== false,
    models,
    dispatchable_models: dispatchable,
    config_sha256: text(document.config_sha256),
  };
}

/**
 * Stages that reach a billable path the guard cannot bound. Each refuses at
 * dispatch inside the official process, so leaving them enabled turns an
 * unbounded path into a run that dies partway through having already spent.
 *
 * Every switch is read as a value the probe must actually have reported, and
 * absence is refused rather than read as "off". Three of these default to
 * *enabled* upstream, so silence here would mean the opposite of safe — which
 * is also why the probe resolves the effective config rather than the file.
 */
function assertNoUnbudgetableStages(experiment: Record<string, unknown> | null): void {
  if (!experiment) {
    throw refuse('the budget probe reported no experiment section, so no unbudgetable stage can be ruled out');
  }
  if (requiredBoolean(experiment.opencode_enabled, 'experiment.opencode.enabled')) {
    throw refuse(`experiment.opencode.enabled is true: ${UNBOUNDABLE_PROVIDERS.get('opencode')}`);
  }
  // The repair loop only reaches opencode when the loop itself runs, so a
  // disabled loop leaves nothing to bound and its backend does not matter.
  if (
    requiredBoolean(experiment.repair_enabled, 'experiment.repair.enabled') &&
    requiredBoolean(experiment.repair_uses_opencode, 'experiment.repair.use_opencode')
  ) {
    throw refuse(`experiment.repair.use_opencode is true: ${UNBOUNDABLE_PROVIDERS.get('opencode')}`);
  }
  const cliAgent = text(experiment.cli_agent_provider);
  if (!cliAgent) throw refuse('the budget probe reported no experiment.cli_agent.provider');
  if (cliAgent !== 'llm') {
    throw refuse(
      `experiment.cli_agent.provider is ${JSON.stringify(cliAgent)}: ${UNBOUNDABLE_PROVIDERS.get('cli-agent')}`,
    );
  }
  if (requiredBoolean(experiment.gemini_image_enabled, 'experiment.figure_agent.nano_banana_enabled')) {
    throw refuse(`experiment.figure_agent.nano_banana_enabled is true: ${UNBOUNDABLE_PROVIDERS.get('gemini-image')}`);
  }
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw refuse(`the budget probe reported no boolean ${label}, so its billable path is unproven`);
  }
  return value;
}

function modelBounds(value: unknown, completionPerCall: number): BoundedModelEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse('budget.models names no model, so every dispatch would be refused');
  }
  const bounds: BoundedModelEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const bound = record(entry);
    if (!bound) throw refuse('budget.models contains an entry that is not a mapping');
    const model = text(bound.model);
    if (!model) throw refuse('budget.models contains an entry with no model identifier');
    if (seen.has(model)) throw refuse(`budget.models names ${JSON.stringify(model)} more than once`);
    seen.add(model);
    const cap = positiveInteger(bound.max_completion_tokens, `budget.models[${model}].max_completion_tokens`);
    if (cap > completionPerCall) {
      throw refuse(
        `budget.models[${JSON.stringify(model)}].max_completion_tokens is ${cap}, above the per-call ceiling ` +
          `${completionPerCall}`,
      );
    }
    bounds.push({ model, max_completion_tokens: cap });
  }
  return bounds;
}

function dispatchableModels(llm: Record<string, unknown>): string[] {
  const models: string[] = [];
  const primary = text(llm.primary_model);
  if (primary) models.push(primary);
  const fallbacks = llm.fallback_models;
  if (fallbacks !== undefined && fallbacks !== null && !Array.isArray(fallbacks)) {
    throw refuse('llm.fallback_models must be a list');
  }
  for (const entry of Array.isArray(fallbacks) ? fallbacks : []) {
    const model = text(entry);
    if (model && !models.includes(model)) models.push(model);
  }
  return models;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw refuse(`${label} must be a positive integer, got ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw refuse(`${label} must be a number, got ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

function refuse(reason: string): ArcError {
  return new ArcError('runner_unconfigured', `Bounded execution refused: ${reason}`);
}
