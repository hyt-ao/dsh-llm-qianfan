// packages/llm/llm-qianfan/src/client.ts

export const DONE = '[DONE]'

export interface SseEvent {
  event?: string
  data?: string
}

/**
 * 规范化工具定义，确保每个 tool 都有 type: "function"。
 * 千帆平台对第三方模型（DeepSeek、GLM 等）要求严格的 tools 格式，
 * 每个 tool 必须显式包含 "type": "function"，否则报错：
 *   "the type of the tool can only be function"
 */
export function normalizeTools(tools?: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool: any) => {
    // 已经是标准格式，直接返回
    if (tool.type === 'function' && tool.function) return tool
    // 有 function 子对象但缺少 type
    if (tool.function) return { type: 'function', ...tool }
    // 扁平格式（name/description/parameters 直接在顶层），包装成标准格式
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} },
      },
    }
  })
}

/**
 * Parse an SSE body into SseEvent payloads, terminated by [DONE].
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onComment?: () => void,
): AsyncIterable<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let bomStripped = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 去除 UTF-8 BOM（千帆响应可能带 BOM）
      if (!bomStripped) {
        bomStripped = true
        if (buffer.charCodeAt(0) === 0xFEFF) {
          buffer = buffer.slice(1)
        }
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一行可能不完整，留到下次

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith(':')) {
          onComment?.()
          continue
        }
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        yield { data }
      }
    }

    // 处理流结束后 buffer 中残留的最后一行
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim()
        yield { data }
      }
    }
  } finally {
    reader.releaseLock()
  }
}