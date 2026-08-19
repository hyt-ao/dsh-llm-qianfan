/**
 * Qianfan-specific client-side TPM/RPM rate limiter.
 *
 * Four-layer flow control:
 *   Layer 1 – Pre-send token estimation
 *   Layer 2 – Token-bucket / sliding-window pacing (TPM + RPM)
 *   Layer 3 – Response-header awareness (X-Ratelimit-Remaining-Tokens)
 *   Layer 4 – Error-code mapping (336502 / HTTP 429 / code 18 → RATE_LIMIT)
 *
 * Independent from upstream llm-retry policy.
 */

export interface RateLimiterConfig {
  /** Tokens-per-minute quota. 0 = disabled. */
  tpm: number
  /** Requests-per-minute quota. 0 = disabled. */
  rpm: number
  /** Safety margin ratio (0–1). Effective limit = quota × (1 − margin). Default 0.15. */
  safetyMargin?: number
  /** Minimum interval between consecutive requests in ms. Default 200. */
  minIntervalMs?: number
}

interface BucketState {
  tokens: number
  lastRefill: number
}

export class QianfanRateLimiter {
  private readonly tpmLimit: number
  private readonly rpmLimit: number
  private readonly minIntervalMs: number
  private readonly tokenBucket: BucketState
  private readonly requestBucket: BucketState
  private lastRequestTime = 0
  private remainingTokenRatio = 1.0

  constructor(config: RateLimiterConfig) {
    const margin = config.safetyMargin ?? 0.15
    this.tpmLimit = config.tpm > 0 ? Math.floor(config.tpm * (1 - margin)) : 0
    this.rpmLimit = config.rpm > 0 ? Math.floor(config.rpm * (1 - margin)) : 0
    this.minIntervalMs = config.minIntervalMs ?? 200
    this.tokenBucket = { tokens: this.tpmLimit, lastRefill: Date.now() }
    this.requestBucket = { tokens: this.rpmLimit, lastRefill: Date.now() }
  }

  /**
   * Rough token estimate: ~4 chars per token for CJK / mixed content.
   * inputChars  = serialised request body length
   * maxOutTokens = the maxTokens we asked the model to produce
   */
  static estimateTokens(inputChars: number, maxOutTokens: number): number {
    return Math.ceil(inputChars / 4) + maxOutTokens
  }

  /** Parse X-Ratelimit-* headers after every response. */
  updateFromHeaders(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining-tokens')
    const limit = headers.get('x-ratelimit-limit-tokens')
    if (remaining !== null && limit !== null) {
      const r = Number(remaining)
      const l = Number(limit)
      if (Number.isFinite(r) && Number.isFinite(l) && l > 0) {
        this.remainingTokenRatio = Math.max(0, Math.min(1, r / l))
      }
    }
  }

  /** True when remaining tokens < 10 % of the quota. */
  get isThrottledByHeader(): boolean {
    return this.remainingTokenRatio < 0.10
  }

  /**
   * Block until it is safe to send a request that will consume
   * approximately `estimatedTokens`. Respects TPM bucket, RPM bucket,
   * minimum inter-request interval, and header-based back-pressure.
   *
   * Rejects immediately if `signal` is aborted while waiting.
   */
  async acquire(estimatedTokens: number, signal: AbortSignal): Promise<void> {
    // ── minimum inter-request interval ──
    const now = Date.now()
    const elapsed = now - this.lastRequestTime
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed, signal)
    }

    // ── TPM token bucket ──
    if (this.tpmLimit > 0) {
      await this.consumeBucket(this.tokenBucket, estimatedTokens, this.tpmLimit, signal)
    }

    // ── RPM request bucket (cost = 1) ──
    if (this.rpmLimit > 0) {
      await this.consumeBucket(this.requestBucket, 1, this.rpmLimit, signal)
    }

    // ── header-based back-pressure ──
    if (this.isThrottledByHeader) {
      const backoff = Math.min(5_000, 1_000 / Math.max(this.remainingTokenRatio, 0.01))
      console.error(
        `[qianfan-rate] header throttle: remaining=${(this.remainingTokenRatio * 100).toFixed(1)}%, sleeping ${Math.round(backoff)}ms`,
      )
      await sleep(backoff, signal)
    }

    this.lastRequestTime = Date.now()
  }

  // ──────────────────────────────────────────────────────────────

  private async consumeBucket(
    bucket: BucketState,
    cost: number,
    capacity: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      this.refill(bucket, capacity)
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost
        return
      }
      const deficit = cost - bucket.tokens
      const refillRatePerMs = capacity / 60_000
      const waitMs = Math.ceil(deficit / refillRatePerMs)
      console.error(`[qianfan-rate] bucket wait: deficit=${deficit.toFixed(0)}, sleeping ${waitMs}ms`)
      await sleep(waitMs, signal)
    }
  }

  private refill(bucket: BucketState, capacity: number): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    if (elapsed <= 0) return
    const refillRatePerMs = capacity / 60_000
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs)
    bucket.lastRefill = now
  }
}

// ──────────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) {
      clearTimeout(timer)
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}