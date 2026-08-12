import type { ChildRavelRole, HarnessId, RavelUsage } from './types'

/** Rough proxy for tokenization. Deliberately uniform across models. */
export const CHARS_PER_TOKEN = 4

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN)
}

/**
 * USD per million tokens. Operator-editable and expected to drift — nothing
 * load-bearing depends on it, because the ceiling is denominated in tokens.
 * A model absent from this table yields a null cost, never zero.
 */
export const MODEL_RATES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  'claude-opus-5': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
  'claude-haiku-4-5': { input: 0.8, output: 4 }
}

/** Claude-tiered routing. Only consulted when the brief's harness is 'claude'. */
export const DEFAULT_MODEL_BY_ROLE: Record<ChildRavelRole, string> = {
  'lead-engineer': 'opus',
  auditor: 'sonnet',
  'minor-task': 'haiku',
  researcher: 'sonnet',
  'test-engineer': 'sonnet',
  'security-engineer': 'sonnet',
  'performance-engineer': 'sonnet',
  'release-engineer': 'sonnet'
}

export function defaultModelForRole(role: ChildRavelRole, harness: HarnessId): string | undefined {
  return harness === 'claude' ? DEFAULT_MODEL_BY_ROLE[role] : undefined
}

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number
): number | null {
  if (model === null) return null
  const rate = MODEL_RATES_USD_PER_MTOK[model]
  if (rate === undefined) return null
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000
}

/**
 * Sums two usages. A null cost on a side that actually spent tokens keeps the
 * total null — an unknown component makes the whole figure unknown, not
 * cheaper. A side with no tokens spent nothing, so its null is absence rather
 * than uncertainty and it contributes zero; without this the empty starting
 * usage would pin every running total at null forever.
 */
export function addUsage(a: RavelUsage, b: RavelUsage): RavelUsage {
  const costOf = (usage: RavelUsage): number | null =>
    usage.costUsd === null && usage.inputTokens === 0 && usage.outputTokens === 0 ? 0 : usage.costUsd
  const left = costOf(a)
  const right = costOf(b)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: left === null || right === null ? null : left + right
  }
}
