export interface ComputeRetryScheduleInput {
  /** Valeur APRÈS incrément (= downloadRetryCount post-échec). */
  retryCount: number
  baseDelayMs: number
  maxDelayMs: number
  now: Date
  /** Injectable — () => [0, 1). */
  random: () => number
}

export interface ComputeRetryScheduleResult {
  delayMs: number
  nextRetryAt: Date
}

const MAX_SAFE_DELAY = Number.MAX_SAFE_INTEGER

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), MAX_SAFE_DELAY)
}

/**
 * Backoff exponentiel + jitter — pur, hors Prisma.
 * delay = min(maxDelay, base * 2^(retryCount-1)) * (0.5 + random)
 */
export function computeRetrySchedule(input: ComputeRetryScheduleInput): ComputeRetryScheduleResult {
  const retryCount = Math.max(1, Math.floor(input.retryCount))
  const maxDelayMs = Math.max(1, clampPositiveInt(input.maxDelayMs, 1))
  const baseDelayMs = Math.min(maxDelayMs, Math.max(1, clampPositiveInt(input.baseDelayMs, 1)))

  const exponent = Math.min(retryCount - 1, 30)
  let raw = baseDelayMs * 2 ** exponent
  if (!Number.isFinite(raw) || raw > maxDelayMs) raw = maxDelayMs
  const capped = Math.min(raw, maxDelayMs)

  const r = input.random()
  const unit = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0
  const jittered = Math.floor(capped * (0.5 + unit))
  const delayMs = Math.min(Math.max(0, jittered), maxDelayMs)

  return {
    delayMs,
    nextRetryAt: new Date(input.now.getTime() + delayMs),
  }
}
