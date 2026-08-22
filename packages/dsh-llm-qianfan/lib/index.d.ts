import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import { LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import { Context } from "@deepseek-ai/cordis";
//#region src/rate-limiter.d.ts
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
interface RateLimiterConfig {
  /** Tokens-per-minute quota. 0 = disabled. */
  tpm: number;
  /** Requests-per-minute quota. 0 = disabled. */
  rpm: number;
  /** Safety margin ratio (0–1). Effective limit = quota × (1 − margin). Default 0.15. */
  safetyMargin?: number;
  /** Minimum interval between consecutive requests in ms. Default 200. */
  minIntervalMs?: number;
}
//#endregion
//#region src/types.d.ts
interface WireError {
  error: {
    code?: number | string;
    message?: string;
    type?: string;
  };
}
interface WireChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
}
interface WireChoice {
  index?: number;
  delta?: WireChoiceDelta;
  finish_reason?: string | null;
}
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface WireChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: WireChoice[];
  usage?: WireUsage;
}
/** One selectable reasoning-effort level surfaced to the model picker. */
interface QianfanReasoningEffort {
  id: string;
  name: string;
  description?: string;
}
/** The provider-level default reasoning effort id, if any. */
type QianfanDefaultReasoning = string | undefined;
interface QianfanCatalogModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Enable extended-thinking mode for this model (legacy boolean switch). */
  thinking?: boolean;
  /**
   * Reasoning-effort declaration for this model: a map of level id → wire
   * value. `off` maps to `null` (disabled thinking), higher levels map to the
   * wire string the API expects (e.g. `high` → the `reasoning_effort` param).
   * `false` explicitly opts the model out of any reasoning menu.
   */
  reasoningEfforts?: Record<string, string | null> | false;
}
interface QianfanConnectionOptions {
  baseURL: string;
  maxTokens: number;
  defaultContextWindow: number;
  models: readonly QianfanCatalogModel[];
  streamIdleTimeoutMs: number;
  retryPolicy: import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy;
  /**
   * Client-side TPM / RPM rate limiter configuration.
   * Resolved per field from the `rateLimit` settings section, falling back to
   * `QIANFAN_RATE_LIMIT_*` env vars, then documented defaults.
   * `undefined` ⇒ limiter disabled.
   */
  rateLimit?: RateLimiterConfig;
  /** Provider-level default reasoning effort id drives effort-menu pre-selection. */
  defaultReasoning?: QianfanDefaultReasoning;
}
interface QianfanAdapterOptions {
  options(): QianfanConnectionOptions;
  resolveApiKey(connection: QianfanConnectionOptions): Promise<string>;
}
//#endregion
//#region src/adapter.d.ts
declare const DEFAULT_CONTEXT_WINDOW = 128000;
declare const DEFAULT_MAX_TOKENS = 8192;
declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
declare class QianfanAdapter extends LlmAdapter {
  private readonly config;
  /** Effective rate-limit config this adapter is currently pacing with. */
  private rateLimiterConfig;
  /** Shared rate limiter – rebuilt lazily whenever `rateLimiterConfig` changes. */
  private rateLimiter;
  constructor(config: QianfanAdapterOptions);
  /**
   * Re-read the resolved rate-limit config (settings section merged over env)
   * and rebuild the limiter only when it actually changed, so edits made in the
   * plugin's settings card apply without restarting the process.
   */
  private syncRateLimiter;
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private request;
}
//#endregion
//#region src/index.d.ts
declare const name = "llm-qianfan";
declare const inject: string[];
interface Config {
  apiKeyEnv?: string;
  baseURL?: string;
  maxTokens?: number;
  defaultContextWindow?: number;
  models?: QianfanCatalogModel[];
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
  /** Provider-level default reasoning effort id (e.g. `high` / `max` / `off`). */
  reasoning?: QianfanDefaultReasoning;
  /**
   * Rate limiter quotas. Per-field precedence: settings > QIANFAN_RATE_LIMIT_* env > defaults.
   * Omitted entirely (or both tpm and rpm ≤ 0) disables the limiter.
   * Editable from the plugin's settings card; takes effect without a restart.
   */
  rateLimit?: Partial<RateLimiterConfig>;
}
declare const Config: z<Config>;
declare const PUBLIC_BASE_URL = "https://qianfan.baidubce.com/v2";
type ResolvedQianfanOptions = QianfanConnectionOptions;
declare function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedQianfanOptions;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PUBLIC_BASE_URL, QianfanAdapter, type QianfanAdapterOptions, type QianfanCatalogModel, type QianfanConnectionOptions, type QianfanDefaultReasoning, type QianfanReasoningEffort, type RateLimiterConfig, ResolvedQianfanOptions, type WireChoice, type WireChoiceDelta, type WireChunk, type WireError, type WireUsage, apply, inject, name, resolveAdapterOptions };