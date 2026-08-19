// packages/llm/llm-qianfan/src/translate.ts

import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SseEvent } from './client.ts'

interface QianfanDelta {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      role?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

function mapFinishReason(reason?: string | null): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: (reason ?? 'UNKNOWN').toUpperCase() },
      }
  }
}

function mapUsage(usage: NonNullable<QianfanDelta['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

export async function* translate(
  events: AsyncIterable<SseEvent>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const event of events) {
    if (!event.data) continue
    if (event.data === '[DONE]') break

    let parsed: QianfanDelta
    try {
      parsed = JSON.parse(event.data) as QianfanDelta
    } catch {
      throw new LlmError(
        `malformed SSE payload: ${event.data.slice(0, 120)}`,
        'MALFORMED_RESPONSE',
      )
    }

    const choice = parsed.choices?.[0]
    if (!choice) continue

    const delta = choice.delta

    // Reasoning
    const reasoning = delta?.reasoning_content
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (!reasoningBlock) {
        reasoningBlock = open('reasoning')
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      reasoningBlock.text += reasoning
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
    }

    // Text content
    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      if (!textBlock) {
        textBlock = open('text')
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += content
      yield { type: 'text-delta', index: textBlock.index, text: content }
    }

    // Tool calls
    for (const call of delta?.tool_calls ?? []) {
      const wireIndex = call.index ?? 0
      let block = toolBlocks.get(wireIndex)
      if (!block) {
        block = open('tool-call')
        toolBlocks.set(wireIndex, block)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      if (call.id !== undefined) block.callId = call.id
      if (call.function?.name !== undefined) block.name = call.function.name
      const fragment = call.function?.arguments ?? ''
      block.text += fragment
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: CallId(block.callId ?? ''),
        ...block.name !== undefined ? { name: block.name } : {},
        argumentsDelta: fragment,
      }
    }

    // Finish reason & usage (deferred to [DONE])
    if (typeof choice.finish_reason === 'string') {
      pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (parsed.usage) {
      pendingUsage = mapUsage(parsed.usage)
    }
  }

  // Emit block-ends, usage, and finish at stream end
  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }

  const reason = pendingFinish ?? { kind: 'stop' as const }
  yield {
    type: 'finish',
    reason: reason.kind === 'stop' && order.length === 0
      ? {
          kind: 'error',
          failure: {
            message: 'model returned a completed response with no content',
            code: 'EMPTY_RESPONSE',
          },
        }
      : reason,
  }
}