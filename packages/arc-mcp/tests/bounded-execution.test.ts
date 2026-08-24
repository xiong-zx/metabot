import { describe, expect, it } from 'vitest';

import {
  assertBoundedBudgetPolicy,
  BOUNDABLE_PROVIDERS,
  MAX_BOUNDED_USD_TOTAL,
  UNBOUNDABLE_PROVIDERS,
  type OfficialBudgetDocument,
} from '../src/bounded-execution.js';

const POLICY = 'arc-006-bounded-acceptance';
const CONFIG_SHA = 'c'.repeat(64);

type Section = Record<string, unknown>;

/**
 * A configuration that is genuinely bounded, as the effective-config probe
 * would report it. Every test below starts here and breaks exactly one thing,
 * so a refusal is always attributable to the field it names.
 */
function budgetSection(): Section {
  return {
    enforcement: 'required',
    policy_id: POLICY,
    provider: 'anthropic',
    max_calls: 40,
    max_prompt_tokens_per_call: 32_000,
    max_completion_tokens_per_call: 4_000,
    max_prompt_tokens_total: 600_000,
    max_completion_tokens_total: 80_000,
    max_usd_total: 5,
    allow_preflight: true,
    models: [{ model: 'claude-haiku-4-5', max_completion_tokens: 4_000 }],
  };
}

function llmSection(): Section {
  return { provider: 'anthropic', primary_model: 'claude-haiku-4-5', fallback_models: [] };
}

/** Every unbudgetable stage switch off, as an ARC-006 config must set them. */
function experimentSection(): Section {
  return {
    opencode_enabled: false,
    repair_enabled: true,
    repair_uses_opencode: false,
    cli_agent_provider: 'llm',
    gemini_image_enabled: false,
  };
}

function doc(mutate: (document: {
  budget: Section;
  llm: Section;
  experiment: Section;
}) => void = () => {}): OfficialBudgetDocument {
  const parts = { budget: budgetSection(), llm: llmSection(), experiment: experimentSection() };
  mutate(parts);
  return { config_sha256: CONFIG_SHA, ...parts };
}

const check = (document: OfficialBudgetDocument, maxUsdTotal?: number) =>
  assertBoundedBudgetPolicy(document, { policyId: POLICY, ...(maxUsdTotal === undefined ? {} : { maxUsdTotal }) });

describe('bounded budget policy: the authorized shape', () => {
  it('mirrors the providers the upstream guard can and cannot bound', () => {
    // Drift here is silent and dangerous: a provider this driver believes is
    // boundable but the guard refuses becomes a mid-run refusal after spend.
    expect([...BOUNDABLE_PROVIDERS].sort()).toEqual([
      'anthropic',
      'deepseek',
      'kimi-anthropic',
      'minimax',
      'novita',
      'ollama',
      'openai',
      'openai-compatible',
      'openrouter',
    ]);
    expect([...UNBOUNDABLE_PROVIDERS.keys()].sort()).toEqual([
      'acp',
      'cli-agent',
      'embeddings',
      'gemini-image',
      'opencode',
    ]);
  });

  it('accepts a config that provably bounds the run, and states what it checked', () => {
    const evidence = check(doc());
    expect(evidence).toEqual({
      policy_id: POLICY,
      provider: 'anthropic',
      max_calls: 40,
      max_prompt_tokens_per_call: 32_000,
      max_completion_tokens_per_call: 4_000,
      max_prompt_tokens_total: 600_000,
      max_completion_tokens_total: 80_000,
      max_usd_total: 5,
      allow_preflight: true,
      models: [{ model: 'claude-haiku-4-5', max_completion_tokens: 4_000 }],
      dispatchable_models: ['claude-haiku-4-5'],
      config_sha256: CONFIG_SHA,
    });
  });

  it('carries the ceiling exactly at the authorized maximum', () => {
    expect(MAX_BOUNDED_USD_TOTAL).toBe(5);
    expect(check(doc((d) => void (d.budget.max_usd_total = MAX_BOUNDED_USD_TOTAL))).max_usd_total).toBe(5);
  });

  it('bounds every model the run can dispatch, including fallbacks', () => {
    const evidence = check(
      doc((d) => {
        d.llm.fallback_models = ['claude-sonnet-4-5'];
        d.budget.models = [
          { model: 'claude-haiku-4-5', max_completion_tokens: 4_000 },
          { model: 'claude-sonnet-4-5', max_completion_tokens: 2_000 },
        ];
      }),
    );
    expect(evidence.dispatchable_models).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5']);
  });
});

describe('bounded budget policy: refusals', () => {
  it('refuses a run that names no policy', () => {
    expect(() => assertBoundedBudgetPolicy(doc(), { policyId: '   ' })).toThrow(/without naming a budget policy/i);
  });

  it('refuses a document with no budget section', () => {
    expect(() => check({ config_sha256: CONFIG_SHA, llm: llmSection(), experiment: experimentSection() })).toThrow(
      /declares no budget section/i,
    );
  });

  it('refuses anything short of enforcement: required', () => {
    for (const enforcement of ['off', 'warn', '', undefined]) {
      expect(() => check(doc((d) => void (d.budget.enforcement = enforcement)))).toThrow(/only "required"/i);
    }
  });

  it('refuses enforcement without a policy id, and a policy that is not the authorized one', () => {
    expect(() => check(doc((d) => void (d.budget.policy_id = '')))).toThrow(/declares no budget.policy_id/i);
    expect(() => check(doc((d) => void (d.budget.policy_id = 'some-other-policy')))).toThrow(
      /but the run was authorized for/i,
    );
  });

  it('refuses every provider the guard declares structurally unbudgetable', () => {
    for (const provider of UNBOUNDABLE_PROVIDERS.keys()) {
      expect(() =>
        check(
          doc((d) => {
            d.budget.provider = provider;
            d.llm.provider = provider;
          }),
        ),
        provider,
      ).toThrow(/can never be bounded/i);
    }
  });

  it('refuses a provider nobody has shown can be bounded', () => {
    expect(() =>
      check(
        doc((d) => {
          d.budget.provider = 'some-new-vendor';
          d.llm.provider = 'some-new-vendor';
        }),
      ),
    ).toThrow(/not known to enforce a per-request completion cap/i);
    expect(() => check(doc((d) => void (d.budget.provider = '')))).toThrow(/names no provider/i);
  });

  it('refuses a policy that bounds a provider the run does not use', () => {
    expect(() => check(doc((d) => void (d.llm.provider = 'openai')))).toThrow(
      /the guard would bound a provider the run never uses/i,
    );
    expect(() => check(doc((d) => void delete d.llm.provider))).toThrow(/llm.provider is "\(absent\)"/i);
  });

  it('refuses a ceiling expressed as anything but a positive integer count', () => {
    const fields = [
      'max_calls',
      'max_prompt_tokens_per_call',
      'max_completion_tokens_per_call',
      'max_prompt_tokens_total',
      'max_completion_tokens_total',
    ] as const;
    for (const field of fields) {
      for (const value of [0, -1, 1.5, '40', null, undefined]) {
        expect(() => check(doc((d) => void (d.budget[field] = value))), `${field}=${String(value)}`).toThrow(
          /must be a positive integer/i,
        );
      }
    }
  });

  it('refuses totals that cannot cover a single call they authorize', () => {
    expect(() => check(doc((d) => void (d.budget.max_prompt_tokens_total = 100)))).toThrow(
      /max_prompt_tokens_total \(100\) is below/i,
    );
    expect(() => check(doc((d) => void (d.budget.max_completion_tokens_total = 100)))).toThrow(
      /max_completion_tokens_total \(100\) is below/i,
    );
  });

  it('refuses a USD ceiling that is absent, non-positive, or above what was authorized', () => {
    expect(() => check(doc((d) => void (d.budget.max_usd_total = '5')))).toThrow(/must be a number/i);
    expect(() => check(doc((d) => void (d.budget.max_usd_total = 0)))).toThrow(/must be positive/i);
    expect(() => check(doc((d) => void (d.budget.max_usd_total = 5.01)))).toThrow(
      /above the authorized ceiling of USD 5/i,
    );
    // A caller may tighten the bound, never loosen it beyond its own request.
    expect(() => check(doc((d) => void (d.budget.max_usd_total = 2)), 1)).toThrow(
      /above the authorized ceiling of USD 1/i,
    );
  });

  it('refuses a model list that bounds nothing', () => {
    expect(() => check(doc((d) => void (d.budget.models = [])))).toThrow(/names no model/i);
    expect(() => check(doc((d) => void (d.budget.models = 'claude-haiku-4-5')))).toThrow(/names no model/i);
    expect(() => check(doc((d) => void (d.budget.models = ['claude-haiku-4-5'])))).toThrow(/not a mapping/i);
    expect(() => check(doc((d) => void (d.budget.models = [{ max_completion_tokens: 8 }])))).toThrow(
      /no model identifier/i,
    );
  });

  it('refuses a duplicated or over-capped model bound', () => {
    expect(() =>
      check(
        doc(
          (d) =>
            void (d.budget.models = [
              { model: 'claude-haiku-4-5', max_completion_tokens: 4_000 },
              { model: 'claude-haiku-4-5', max_completion_tokens: 8 },
            ]),
        ),
      ),
    ).toThrow(/more than once/i);
    expect(() =>
      check(doc((d) => void (d.budget.models = [{ model: 'claude-haiku-4-5', max_completion_tokens: 4_001 }]))),
    ).toThrow(/above the per-call ceiling/i);
  });

  it('refuses a run whose dispatchable models are not all bounded', () => {
    expect(() => check(doc((d) => void (d.llm.primary_model = '')))).toThrow(/names no llm.primary_model/i);
    expect(() => check(doc((d) => void (d.llm.fallback_models = ['claude-opus-4-5'])))).toThrow(
      /which budget.models does not bound/i,
    );
    expect(() => check(doc((d) => void (d.llm.fallback_models = 'claude-opus-4-5')))).toThrow(/must be a list/i);
  });
});

describe('bounded budget policy: unbudgetable stages', () => {
  it('refuses opencode, which the guard can only refuse mid-run', () => {
    expect(() => check(doc((d) => void (d.experiment.opencode_enabled = true)))).toThrow(
      /experiment\.opencode\.enabled is true/i,
    );
  });

  it('refuses an enabled repair loop that repairs through opencode', () => {
    expect(() => check(doc((d) => void (d.experiment.repair_uses_opencode = true)))).toThrow(
      /experiment\.repair\.use_opencode is true/i,
    );
  });

  it('accepts an opencode repair backend the disabled repair loop never reaches', () => {
    expect(() =>
      check(
        doc((d) => {
          d.experiment.repair_enabled = false;
          d.experiment.repair_uses_opencode = true;
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a CLI coding agent, whose spend is its own self-report', () => {
    for (const provider of ['claude_code', 'codex']) {
      expect(() => check(doc((d) => void (d.experiment.cli_agent_provider = provider))), provider).toThrow(
        /experiment\.cli_agent\.provider is/i,
      );
    }
    expect(() => check(doc((d) => void (d.experiment.cli_agent_provider = '')))).toThrow(
      /no experiment\.cli_agent\.provider/i,
    );
  });

  it('refuses Gemini image generation, which is billed per image with no usage to reconcile', () => {
    expect(() => check(doc((d) => void (d.experiment.gemini_image_enabled = true)))).toThrow(
      /nano_banana_enabled is true/i,
    );
  });

  /**
   * The regression this whole section exists for. Upstream defaults enable
   * opencode, the opencode repair backend and Gemini image generation, so a
   * probe that omits a switch must never be read as "off" — that would let a
   * config which simply says nothing pass a check it does not satisfy, and
   * then die mid-run having already spent.
   */
  it('refuses a probe that stayed silent about a stage that defaults to enabled', () => {
    const switches = [
      'opencode_enabled',
      'repair_enabled',
      'repair_uses_opencode',
      'gemini_image_enabled',
    ] as const;
    for (const name of switches) {
      expect(() => check(doc((d) => void delete d.experiment[name])), name).toThrow(/reported no boolean/i);
      expect(() => check(doc((d) => void (d.experiment[name] = 'false'))), name).toThrow(/reported no boolean/i);
    }
    expect(() => check({ config_sha256: CONFIG_SHA, budget: budgetSection(), llm: llmSection() })).toThrow(
      /reported no experiment section/i,
    );
  });
});

describe('bounded budget policy: config identity', () => {
  it('reports the digest of the document it validated, and nothing when there was none', () => {
    expect(check(doc()).config_sha256).toBe(CONFIG_SHA);
    const noDigest = doc() as Record<string, unknown>;
    delete noDigest.config_sha256;
    expect(check(noDigest as OfficialBudgetDocument).config_sha256).toBe('');
  });
});
