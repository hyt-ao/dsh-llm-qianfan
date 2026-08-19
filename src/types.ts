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

export interface WireChoiceDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
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

export interface QianfanCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  /** Enable extended-thinking mode for this model. */
  thinking?: boolean
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
   * Sourced exclusively from QIANFAN_RATE_LIMIT_* env vars.
   * `undefined` ⇒ limiter disabled.
   */
  rateLimit?: RateLimiterConfig
}

// ─── Adapter constructor options ───────────────────────────────

export interface QianfanAdapterOptions {
  options(): QianfanConnectionOptions
  resolveApiKey(connection: QianfanConnectionOptions): Promise<string>
}

// ─── Re-export for convenience ─────────────────────────────────
export type { RateLimiterConfig }