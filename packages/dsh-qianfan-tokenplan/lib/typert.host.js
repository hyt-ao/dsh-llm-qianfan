/**
 * dsh-qianfan-tokenplan 的 Host 面 Typert 清单（由 typert-loader 自动扫描注册）。
 * 手写清单，结构与 @deepseek-ai/dsh-typert-generator 产物一致。
 * `./typert` 导出 TYPERT，invocations 的 codec 必须是 zod v4 实例。
 */

import { z } from 'zod'

const num = z.number()

const stateSchema = z.object({
  status: z.enum(['off', 'ok', 'error']),
  message: z.string(),
  fetchedAt: num,
  planType: z.string(),
  planLabel: z.string(),
  resourceStatus: z.string(),
  effectiveAt: z.string(),
  expiresAt: z.string(),
  totalTokens: num,
  usedTokens: num,
  remainingTokens: num,
  remainingPercent: num,
})

const configSchema = z.object({
  cookie: z.string(),
  referer: z.string(),
  userAgent: z.string(),
  refreshMinutes: num,
})

const setConfigArgsSchema = z.object({
  cookie: z.string().optional(),
  referer: z.string().optional(),
  userAgent: z.string().optional(),
  refreshMinutes: num.optional(),
})

const resultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  configured: z.boolean(),
  state: stateSchema.optional(),
})

const rateLimitSchema = z.object({
  tpm: num,
  rpm: num,
  safetyMargin: num,
  minIntervalMs: num,
})

const setRateLimitArgsSchema = z.object({
  tpm: num.optional(),
  rpm: num.optional(),
  safetyMargin: num.optional(),
  minIntervalMs: num.optional(),
})

const rateLimitResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  rateLimit: rateLimitSchema.optional(),
})

const getStateResultSchema = z.object({
  configured: z.boolean(),
  state: stateSchema,
})

const _state$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#TokenPlanState', schema: stateSchema }
const _setConfigArgs$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#SetConfigArgs', schema: setConfigArgsSchema }
const _result$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#Result', schema: resultSchema }
const _getStateResult$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#GetStateResult', schema: getStateResultSchema }
const _setRateLimitArgs$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#SetRateLimitArgs', schema: setRateLimitArgsSchema }
const _rateLimitResult$codec = { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#RateLimitResult', schema: rateLimitResultSchema }

export { stateSchema as stateSchema }

export const TYPERT = {
  package: 'dsh-qianfan-tokenplan',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/getState',
      service: 'qianfanTokenPlan',
      namespace: 'qianfanTokenPlan',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _getStateResult$codec,
    },
    {
      id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/setConfig',
      service: 'qianfanTokenPlan',
      namespace: 'qianfanTokenPlan',
      method: 'setConfig',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'args', wire: 'args', source: 'json', codec: _setConfigArgs$codec },
      ],
      result: _result$codec,
    },
    {
      id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/refresh',
      service: 'qianfanTokenPlan',
      namespace: 'qianfanTokenPlan',
      method: 'refresh',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _result$codec,
    },
    {
      id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/getRateLimit',
      service: 'qianfanTokenPlan',
      namespace: 'qianfanTokenPlan',
      method: 'getRateLimit',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _rateLimitResult$codec,
    },
    {
      id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/setRateLimit',
      service: 'qianfanTokenPlan',
      namespace: 'qianfanTokenPlan',
      method: 'setRateLimit',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'args', wire: 'args', source: 'json', codec: _setRateLimitArgs$codec },
      ],
      result: _rateLimitResult$codec,
    },
  ],
  model: {
    services: [
      {
        description: '百度千帆 Token Plan 个人版余量查询服务 (ctx.qianfanTokenPlan)。Qianfan Token Plan Personal quota service.',
        summary: '千帆 Token Plan 余量服务 (dsh-qianfan-tokenplan)。',
        tags: [],
        jsDoc: '/** 千帆 Token Plan 个人版余量查询服务 (ctx.qianfanTokenPlan)。 */',
        key: 'qianfanTokenPlan',
        exportName: 'QianfanTokenPlanService',
        members: [
          {
            kind: 'method',
            name: 'getState',
            signature: 'getState(): GetStateResult',
            summary: '读取当前余量状态与配置标记。Read current quota state and config flag.',
            jsDoc: '/** 读取当前余量状态与配置标记。 */',
          },
          {
            kind: 'method',
            name: 'setConfig',
            signature: 'setConfig(args: SetConfigArgs): Result',
            summary: '保存配置（Cookie/Referer/UA/刷新间隔）并立即刷新。Save config and refresh immediately.',
            jsDoc: '/** 保存配置并立即刷新。 */',
          },
          {
            kind: 'method',
            name: 'refresh',
            signature: 'refresh(): Result',
            summary: '立即强制刷新余量。Force-refresh quota now.',
            jsDoc: '/** 立即强制刷新余量。 */',
          },
          {
            kind: 'method',
            name: 'getRateLimit',
            signature: 'getRateLimit(): RateLimitResult',
            summary: '读取千帆适配器速率限制配置。Read the qianfan adapter rate-limit config.',
            jsDoc: '/** 读取千帆适配器速率限制配置。 */',
          },
          {
            kind: 'method',
            name: 'setRateLimit',
            signature: 'setRateLimit(args: SetRateLimitArgs): RateLimitResult',
            summary: '保存速率限制配置（跨命名空间写 llm-qianfan settings）。Save rate-limit config (cross-namespace write to llm-qianfan settings).',
            jsDoc: '/** 保存速率限制配置。 */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
