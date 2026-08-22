// packages/llm/llm-qianfan/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  QianfanAdapter,
} from './adapter.ts'
import type { QianfanCatalogModel, QianfanConnectionOptions, QianfanDefaultReasoning } from './adapter.ts'
import type { RateLimiterConfig } from './rate-limiter.ts'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, QianfanAdapter } from './adapter.ts'
export type { QianfanAdapterOptions, QianfanCatalogModel, QianfanConnectionOptions } from './adapter.ts'
export type * from './types.ts'

export const name = 'llm-qianfan'
function loadLocalEnvFile(): Map<string, string> {
  const result = new Map<string, string>()
  const candidates = ['.env.qianfan', '.env.local', '.env']
  for (const name of candidates) {
    const filePath = resolve(process.cwd(), name)
    if (!existsSync(filePath)) continue
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key.length > 0 && !result.has(key)) result.set(key, value)
    }
  }
  return result
}

const localEnv = loadLocalEnvFile()

export const inject = ['llm']

const NS = settingsNamespace('llm-qianfan')
const DEFAULT_API_KEY_ENV = 'QIANFAN_API_KEY'
const PROVIDER = 'qianfan'

// 从环境变量解析模型列表，回退到默认值
const DEFAULT_MODELS: QianfanCatalogModel[] = (() => {
  const envModels = process.env.QIANFAN_MODELS;
  if (envModels) {
    try {
      return JSON.parse(envModels);
    } catch (e) {
      console.warn('Failed to parse QIANFAN_MODELS, using defaults:', e);
    }
  }
  return []
})();

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  maxTokens?: number
  defaultContextWindow?: number
  models?: QianfanCatalogModel[]
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  /** Provider-level default reasoning effort id (e.g. `high` / `max` / `off`). */
  reasoning?: QianfanDefaultReasoning
  /**
   * Rate limiter quotas. Per-field precedence: settings > QIANFAN_RATE_LIMIT_* env > defaults.
   * Omitted entirely (or both tpm and rpm ≤ 0) disables the limiter.
   * Editable from the plugin's settings card; takes effect without a restart.
   */
  rateLimit?: Partial<RateLimiterConfig>
}

const catalogModel: z<QianfanCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  thinking: z.boolean(),
  reasoningEfforts: z.union([
    z.const(false),
    z.dict(z.union([z.string(), z.const(null)])),
  ]),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  reasoning: z.string(),
  // Optional rate limiter quotas surfaced in the plugin's settings card. Fields
  // left absent fall back to `QIANFAN_RATE_LIMIT_*` env vars (or defaults).
  rateLimit: z.object({
    tpm: z.number().min(0),
    rpm: z.number().min(0),
    safetyMargin: z.number().min(0).max(1),
    minIntervalMs: z.number().min(0),
  }),
})

export const PUBLIC_BASE_URL = 'https://qianfan.baidubce.com/v2'
const BASE_URL_ENV = 'QIANFAN_BASE_URL'

export type ResolvedQianfanOptions = QianfanConnectionOptions

function resolveModels(models: readonly QianfanCatalogModel[] | undefined): QianfanCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-qianfan: catalog model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-qianfan: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return { ...model }
  })
}

// ★ 新增：从环境变量解析 rateLimit 配置 ★
function resolveRateLimitFromEnv(): RateLimiterConfig | undefined {
  const tpm = Number(process.env.QIANFAN_RATE_LIMIT_TPM)
  const rpm = Number(process.env.QIANFAN_RATE_LIMIT_RPM)

  // 两个都为 0 或未设置 → 禁用限流
  if ((!Number.isFinite(tpm) || tpm <= 0) && (!Number.isFinite(rpm) || rpm <= 0)) {
    return undefined
  }

  const safetyMargin = Number(process.env.QIANFAN_RATE_LIMIT_SAFETY_MARGIN)
  const minIntervalMs = Number(process.env.QIANFAN_RATE_LIMIT_MIN_INTERVAL_MS)

  return {
    tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : 0,
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0,
    safetyMargin:
      Number.isFinite(safetyMargin) && safetyMargin >= 0 && safetyMargin <= 1
        ? safetyMargin
        : 0.15,
    minIntervalMs:
      Number.isFinite(minIntervalMs) && minIntervalMs >= 0
        ? minIntervalMs
        : 200,
  }
}

/**
 * ★ 新增：settings 优先、env 兜底的 rateLimit 合并 ★
 *
 * Per-field precedence: `config.rateLimit` (settings section) > `QIANFAN_RATE_LIMIT_*`
 * env vars > documented defaults. `undefined` (limiter disabled) is returned only
 * when both effective tpm and rpm end up ≤ 0.
 */
function resolveRateLimit(configured: Partial<RateLimiterConfig> | undefined): RateLimiterConfig | undefined {
  const env = resolveRateLimitFromEnv()

  const pick = <K extends keyof RateLimiterConfig>(key: K): RateLimiterConfig[K] | undefined => {
    const fromSettings = configured?.[key]
    if (fromSettings !== undefined) return fromSettings
    const fromEnv = env?.[key]
    if (fromEnv !== undefined) return fromEnv
    return undefined
  }

  const tpm = pick('tpm') ?? 0
  const rpm = pick('rpm') ?? 0
  if (!(tpm > 0) && !(rpm > 0)) return undefined

  return {
    tpm: Math.max(0, tpm),
    rpm: Math.max(0, rpm),
    safetyMargin: pick('safetyMargin') ?? 0.15,
    minIntervalMs: pick('minIntervalMs') ?? 200,
  }
}

export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedQianfanOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-qianfan: retryPolicy'),
    // 从 settings 段优先解析 rateLimit；settings 未配置的字段回退到环境变量
    rateLimit: resolveRateLimit(config.rateLimit),
    // Provider-level default reasoning effort, drives each model's effort menu
    // pre-selection (via resolveModel metadata) unless overridden per request.
    defaultReasoning: config.reasoning,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedQianfanOptions | undefined

  const options = (): ResolvedQianfanOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw; lastGood = next; return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-qianfan: keeping last good config after invalid settings')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedQianfanOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-qianfan', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0)
        return assertUsableApiKey(ambient.value, 'llm-qianfan', ref)
    }
    // Fallback: read from local .env file
    const localValue = localEnv.get(ref)
    if (localValue !== undefined && localValue.length > 0) {
      return assertUsableApiKey(localValue, 'llm-qianfan', `${ref} (local .env)`)
    }
    throw new LlmError(
      `llm-qianfan: no API key for "${PROVIDER}"; set ${ref} via credentials, environment, or .env.qianfan`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new QianfanAdapter({ options, resolveApiKey })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Baidu Qianfan', settingsNs: NS, settingsPath: [] },
  ])

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy

  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: ensureRegistrationFacts,
  })
}