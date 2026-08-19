// packages/llm/llm-qianfan/src/adapter.ts

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './client.ts'
import { translate } from './translate.ts'
import { QianfanRateLimiter } from './rate-limiter.ts'
import type {
  QianfanAdapterOptions,
  QianfanCatalogModel,
  QianfanConnectionOptions,
  WireError,
} from './types.ts'

export type { QianfanAdapterOptions, QianfanCatalogModel, QianfanConnectionOptions }

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 8_192
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** Qianfan-specific error codes that indicate rate limiting. */
const QIANFAN_RATE_LIMIT_CODES = new Set([336502, 18])

function modelInfo(provider: string, model: QianfanCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export class QianfanAdapter extends LlmAdapter {
  /** Shared rate limiter – one per adapter instance (per process). */
  private readonly rateLimiter: QianfanRateLimiter | null

  constructor(private readonly config: QianfanAdapterOptions) {
    super()
    const rl = config.options().rateLimit
    this.rateLimiter =
      rl !== undefined && (rl.tpm > 0 || rl.rpm > 0)
        ? new QianfanRateLimiter(rl)
        : null
  }

  // ─── Provider metadata ───────────────────────────────────────

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Baidu Qianfan' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.config.options().models.map((m) => modelInfo(provider, m)),
    )
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find((e) => e.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    return Promise.resolve({
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    })
  }

  // ─── Streaming entry point ───────────────────────────────────

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream =
      options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])

    using watchdog = idleWatchdog(
      upstream,
      connection.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    )

    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()

    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Qianfan stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Qianfan request aborted by caller', 'ABORTED', {
          cause: error,
        })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `Qianfan API stream from ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    } finally {
      consumer.abort('Qianfan stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try { await iterator.return() } catch { /* best-effort */ }
      }
    }
  }

  // ─── Internal request with four-layer flow control ───────────

  private async *request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: QianfanConnectionOptions,
    apiKey: string,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    // Auto-inject thinking parameter based on model config
    const configured = connection.models.find((m) => m.id === options.model)
    const optionsWithThinking = {
      ...options,
      ...(configured?.thinking ? { thinking: true } : {}),
    }

    const body = serializeRequest(optionsWithThinking, connection.maxTokens)
    const payload = JSON.stringify(body)

    // ═══ Layer 1 + 2: Pre-send estimation + token-bucket pacing ═══
    if (this.rateLimiter !== null) {
      const estimatedTokens = QianfanRateLimiter.estimateTokens(
        payload.length,
        options.maxTokens ?? connection.maxTokens ?? DEFAULT_MAX_TOKENS,
      )
      console.error(`[qianfan-rate] acquiring: est=${estimatedTokens} tokens`)
      await this.rateLimiter.acquire(estimatedTokens, signal)
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
    }

    const url = `${connection.baseURL}/chat/completions`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Qianfan API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // ═══ Layer 3: Response-header awareness ═══
    if (this.rateLimiter !== null) {
      this.rateLimiter.updateFromHeaders(response.headers)
    }

    if (!response.ok) {
      let message = `Qianfan API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const errorBody = await response.text()
        const parsed = JSON.parse(errorBody) as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch { /* non-JSON error body */ }

      // ═══ Layer 4: Map Qianfan-specific rate-limit codes ═══
      const qianfanErrorCode = (providerError as Record<string, unknown> | undefined)?.code
      if (
        response.status === 429 ||
        (typeof qianfanErrorCode === 'number' &&
          QIANFAN_RATE_LIMIT_CODES.has(qianfanErrorCode))
      ) {
        throw new LlmError(message, 'RATE_LIMIT', { status: response.status })
      }

      throw new LlmError(
        message,
        httpErrorCode(response.status, providerError),
        { status: response.status },
      )
    }

    if (!response.body) {
      throw new LlmError('Qianfan API returned no response body', 'EMPTY_RESPONSE')
    }

    try {
      let gotChunk = false
      for await (const chunk of translate(parseSse(response.body, onComment))) {
        gotChunk = true
        yield JSON.parse(JSON.stringify(chunk)) as StreamChunk
      }
      if (!gotChunk) {
        throw new LlmError('Qianfan SSE stream ended without any data', 'EMPTY_RESPONSE')
      }
    } catch (err: unknown) {
      if (err instanceof LlmError) throw err
      throw new LlmError('Qianfan stream processing failed', 'TRANSPORT', {
        cause: err,
      })
    }
  }
}