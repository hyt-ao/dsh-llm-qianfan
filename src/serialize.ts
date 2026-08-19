// packages/llm/llm-qianfan/src/serialize.ts

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { normalizeTools } from './client.ts'

export interface SerializedRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
  tools?: any[]
  tool_choice?: any
  stream: boolean
  thinking?: boolean
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
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text)
        }
      }
    }
    if (texts.length > 0) return texts.join('')
    return JSON.stringify(content)
  }

  if (content === null || content === undefined) return ''
  return String(content)
}

export function serializeRequest(
  options: GenerateOptions & { thinking?: boolean },
  maxTokens: number,
): SerializedRequest {
  const tools = normalizeTools(options.tools)

  return {
    model: options.model,
    messages: options.messages.map((m: any) => ({
      role: m.role,
      content: normalizeContent(m.content),
    })),
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens ?? maxTokens,
    stop: options.stop,
    ...(tools ? { tools, tool_choice: options.toolChoice } : {}),
    stream: true,
    ...(options.thinking === true && { thinking: { type: 'enabled' } }),
  }
}