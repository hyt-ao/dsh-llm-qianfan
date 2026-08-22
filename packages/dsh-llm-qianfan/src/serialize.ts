// packages/llm/llm-qianfan/src/serialize.ts

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { normalizeTools } from './client.ts'

export interface SerializedMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface SerializedRequest {
  model: string
  messages: SerializedMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
  tools?: any[]
  tool_choice?: any
  stream: boolean
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: string
}

function isBlock(b: unknown): b is Record<string, unknown> {
  return !!b && typeof b === 'object' && !Array.isArray(b)
}

/**
 * 将 message content 转为千帆 v2 接受的纯文本字符串。
 *
 * 千帆 v2 chat/completions 的 messages[].content 只接受 string。
 * 上游可能传入：
 *   - 纯字符串: "你好"
 *   - 内容块数组: [{"type":"text","text":"你好"}]
 */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (isBlock(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
    return texts.join('')
  }

  if (content === null || content === undefined) return ''
  return String(content)
}

/**
 * 将上游 DSH 消息序列化为千帆 v2 OpenAI 兼容格式。
 *
 * 关键修复：assistant 消息的 tool-call 块必须作为 `tool_calls` 独立字段发送，
 * tool-result 消息（DSH 中 role='user' + content=[{type:'tool-result'}]）必须
 * 转为 `role: "tool"` 并带 `tool_call_id`。
 * 此前把所有块压扁成纯文本（JSON.stringify(content)）会让模型看到
 * 历史里的 tool call 变成 JSON 文本，导致上下文污染与异常截断。
 *
 * 返回 undefined 表示该消息应被跳过（空 assistant）。
 */
function serializeMessage(m: any): SerializedMessage | undefined {
  const role = m.role
  const content = m.content

  const isToolResult =
    Array.isArray(content) &&
    content.length > 0 &&
    isBlock(content[0]) &&
    content[0].type === 'tool-result'

  // tool-result（DSH role='user' + [ToolResultBlock]）→ OpenAI role='tool'
  if (isToolResult) {
    const block = content[0] as Record<string, unknown>
    const toolCallId =
      typeof m.toolCallId === 'string' && m.toolCallId
        ? m.toolCallId
        : typeof block.toolCallId === 'string'
          ? block.toolCallId
          : ''
    if (!toolCallId) return undefined
    const inner = block.content
    const texts: string[] = []
    if (typeof inner === 'string') {
      texts.push(inner)
    } else if (Array.isArray(inner)) {
      for (const b of inner) {
        if (isBlock(b) && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      }
    }
    const msg: SerializedMessage = {
      role: 'tool',
      content: texts.join('\n').trim() || '(no tool output)',
      tool_call_id: toolCallId,
    }
    if (typeof m.toolName === 'string') msg.name = m.toolName
    return msg
  }

  // system / user：纯文本
  if (role === 'system' || role === 'user') {
    const text = normalizeContent(content)
    return { role, content: text }
  }

  // assistant：text → content，tool-call 块 → tool_calls
  if (role === 'assistant') {
    const texts: string[] = []
    const toolCalls: NonNullable<SerializedMessage['tool_calls']> = []
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isBlock(block)) continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          texts.push(block.text)
        } else if (block.type === 'tool-call') {
          const id = String(block.id ?? '')
          const name = String(block.name ?? '')
          const args = block.arguments
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              // ToolCallBlock.arguments 已是模型产出的原始 JSON 字符串
              arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            },
          })
        }
      }
    }
    const hasText = texts.length > 0
    // 无内容且无 tool_calls 的空 assistant 消息跳掉（部分 provider 不接受空消息）
    if (!hasText && toolCalls.length === 0) return undefined
    return {
      role: 'assistant',
      content: hasText ? texts.join('') : '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
  }

  // 兜底：其他 role 原样转文本
  const text = normalizeContent(content)
  return { role, content: text }
}

export function serializeRequest(
  options: GenerateOptions & { thinking?: boolean },
  maxTokens: number,
): SerializedRequest {
  const tools = normalizeTools(options.tools)

  // Reasoning effort (IDSH model picker) → wire:
  //   off   → thinking: { type: "disabled" }  (no reasoning at all)
  //   high / max → reasoning_effort: "<id>"
  // No effort → legacy boolean `thinking` switch → thinking: { type: "enabled" }
  const effort = options.reasoningEffort
  const reasoningFields =
    effort === undefined
      ? options.thinking === true
        ? { thinking: { type: 'enabled' as const } }
        : {}
      : effort === 'off'
        ? { thinking: { type: 'disabled' as const } }
        : { reasoning_effort: effort }

  const messages = options.messages
    .map((m: any) => serializeMessage(m))
    .filter((m: SerializedMessage | undefined): m is SerializedMessage => m !== undefined)

  return {
    model: options.model,
    messages,
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens ?? maxTokens,
    stop: options.stop,
    ...(tools ? { tools, tool_choice: options.toolChoice } : {}),
    stream: true,
    ...reasoningFields,
  }
}