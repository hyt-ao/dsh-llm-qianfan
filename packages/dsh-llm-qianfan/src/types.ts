import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { RateLimiterConfig } from './rate-limiter.ts'

// ─── Wire types (Qianfan API response shape) ───────────────────

export interface WireError {
  error: {
    code?: number | string
    message?: string
    type?: string
  }
}

export interface WireToolCall {
  /** Tool-call index in the stream (for parallel tool calls). */
  index?: number
  /** Stable call id assigned by the model. */
  id?: string
  /** Tool/function name and incremental arguments. */
  function?: {
    name?: string
    arguments?: string
  }
  type?: string
}

export interface WireChoiceDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCall[] | null
}

export interface WireChoice {
  index?: number
  delta?: WireChoiceDelta
  finish_reason?: string | null
}

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface WireChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: WireChoice[]
  usage?: WireUsage
}

// ─── Catalog / model types ─────────────────────────────────────

/** One selectable reasoning-effort level surfaced to the model picker. */
export interface QianfanReasoningEffort {
  id: string
  name: string
  description?: string
}

/** The provider-level default reasoning effort id, if any. */
export type QianfanDefaultReasoning = string | undefined

export interface QianfanCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  /** Enable extended-thinking mode for this model (legacy boolean switch). */
  thinking?: boolean
  /**
   * Reasoning-effort declaration for this model: a map of level id → wire
   * value. `off` maps to `null` (disabled thinking), higher levels map to the
   * wire string the API expects (e.g. `high` → the `reasoning_effort` param).
   * `false` explicitly opts the model out of any reasoning menu.
   */
  reasoningEfforts?: Record<string, string | null> | false
}

// ─── Connection options (resolved at runtime) ──────────────────

export interface QianfanConnectionOptions {
  baseURL: string
  maxTokens: number
  defaultContextWindow: number
  models: readonly QianfanCatalogModel[]
  streamIdleTimeoutMs: number
  retryPolicy: import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy
  /**
   * Client-side TPM / RPM rate limiter configuration.
   * Resolved per field from the `rateLimit` settings section, falling back to
   * `QIANFAN_RATE_LIMIT_*` env vars, then documented defaults.
   * `undefined` ⇒ limiter disabled.
   */
  rateLimit?: RateLimiterConfig
  /** Provider-level default reasoning effort id drives effort-menu pre-selection. */
  defaultReasoning?: QianfanDefaultReasoning
}

// ─── Adapter constructor options ───────────────────────────────

export interface QianfanAdapterOptions {
  options(): QianfanConnectionOptions
  resolveApiKey(connection: QianfanConnectionOptions): Promise<string>
}

// ─── Re-export for convenience ─────────────────────────────────
export type { RateLimiterConfig }