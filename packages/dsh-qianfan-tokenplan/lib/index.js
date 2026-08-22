/**
 * dsh-qianfan-tokenplan 宿主插件。
 *
 * 单一 Loader 行（见 cordis.patch.yml）挂载本模块，职责：
 *  1. 从 DSH 凭据库读取 QIANFAN_TP_COOKIE（千帆控制台登录 Cookie）；
 *  2. 通过本机 curl 直连千帆控制台「我的订阅」接口（Node fetch/https 被
 *     千帆网关按 TLS 指纹拦截恒 302 到登录页，只有 curl 能通过）；
 *  3. 解析套餐余量，提供 qianfanTokenPlan 服务（Typert RPC），客户端经
 *     remote.qianfanTokenPlan.* 读取状态与刷新。
 *
 * 不导入 cordis/dsh-* 运行时包中的 Service/Context 类：仅用 ctx API 与
 * Node 内建能力，与宿主进程共享同一套运行时实例。
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'qianfan-tokenplan'

const ENDPOINT = 'https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource'
const CRED_REF_NAME = 'QIANFAN_TP_COOKIE'
const PLAN_LABELS = { mini: 'Mini', lite: 'Lite', pro: 'Pro', max: 'Max' }
// 插件自有的持久化配置文件（跨重启保存 Cookie 与刷新设置），位于 DSH 主目录。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_FILE = join(DSH_HOME, 'qianfan-tokenplan.json')

/**
 * 归一化 Cookie：剥掉可能误粘贴的 "Cookie: " 伪头，折叠换行/多余空白为单行
 * （Cookie 头值本身不含空白，粘贴了完整请求头时也能清洗成可用值）。
 * @param {*} v - 待清洗值。
 * @returns {string} 归一化后的 Cookie（不含 "Cookie: " 前缀、无换行）。
 */
function normalizeCookie(v) {
  let s = typeof v === 'string' ? v.trim() : ''
  if (!s) return ''
  s = s.replace(/^Cookie:\s*/i, '').replace(/\s+/g, ' ').trim()
  return s
}

/** 读取持久化配置文件（损坏/缺失返回空对象）。 */
function loadConfigFile() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

/** 原子写持久化配置文件（先写 .tmp 再 rename，避免中断损坏）。 */
function saveConfigFile(partial) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    const next = { ...loadConfigFile(), ...partial }
    const tmp = CONFIG_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, CONFIG_FILE)
  } catch (e) {
    console.log('[qianfan-tokenplan] config persist failed (ignored):', String(e && e.message || e))
  }
}

/** 余额状态占位（未查询/失败时的空值）。 */
function emptyState() {
  return {
    status: 'off',
    message: '',
    fetchedAt: 0,
    planType: '',
    planLabel: '',
    resourceStatus: '',
    effectiveAt: '',
    expiresAt: '',
    totalTokens: 0,
    usedTokens: 0,
    remainingTokens: 0,
    remainingPercent: 0,
  }
}

/**
 * 用本机 curl 请求千帆控制台接口。
 * Node fetch/https 被千帆网关按 TLS 指纹拦截（恒 302 到登录页），
 * 只有 curl 能稳定通过——经多轮实测确认（2026-08-22）。
 * @param {string} cookie - 千帆控制台登录 Cookie。
 * @param {string} referer - Referer 头。
 * @param {string} userAgent - User-Agent 头。
 * @returns {Promise<string>} 响应正文（JSON 字符串）。
 */
function curlQianfan(cookie, referer, userAgent) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '20', '-L', '-X', 'GET', ENDPOINT,
      '-H', 'Cookie: ' + cookie,
      '-H', 'Accept: application/json;charset=UTF-8',
      '-H', 'User-Agent: ' + userAgent]
    if (referer) args.push('-H', 'Referer: ' + referer)
    const proc = spawn('curl', args, { cwd: undefined, windowsHide: true })
    const chunks = []
    const errChunks = []
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.stderr.on('data', (c) => errChunks.push(c))
    proc.on('error', (e) => reject(new Error('curl 启动失败：' + String(e && e.message || e))))
    proc.on('close', (code) => {
      const body = Buffer.concat(chunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8').trim()
      if (code !== 0 || body.length === 0) {
        reject(new Error('请求失败（curl 退出码 ' + code + (stderr ? '：' + stderr.slice(0, 200) : '') + '）'))
        return
      }
      resolve(body)
    })
  })
}

/**
 * 解析千帆控制台响应，归一化为余额状态对象。
 * @param {string} body - JSON 响应正文。
 * @returns {object} 余额状态。
 */
function parseResponseBody(body) {
  if (body.charAt(0) !== '{') {
    throw new Error('响应不是 JSON，Cookie 可能已失效。请到 设置 → 千帆 Token Plan 更新 Cookie。')
  }
  let data
  try { data = JSON.parse(body) } catch { throw new Error('响应 JSON 解析失败') }
  if (!data || data.success !== true) {
    const msg = data && (data.error_msg || data.message || data.msg)
    throw new Error('接口返回失败' + (msg ? '：' + String(msg) : ''))
  }
  const result = data && data.result ? data.result : null
  const items = result && Array.isArray(result.items) ? result.items : []
  if (items.length === 0) {
    return { ...emptyState(), status: 'off', message: '未订阅 Token Plan 个人版套餐', fetchedAt: Date.now() }
  }
  const item = items[0] || {}
  const totalN = Number(item.totalTokens)
  const usedN = Number(item.usedTokens)
  const total = Number.isFinite(totalN) && totalN > 0 ? totalN : 0
  const used = Number.isFinite(usedN) && usedN > 0 ? usedN : 0
  const remaining = Math.max(0, total - used)
  const pct = total > 0 ? Math.round((remaining / total) * 1000) / 10 : 0
  const planType = typeof item.planType === 'string' ? item.planType : ''
  return {
    status: 'ok',
    message: '',
    fetchedAt: Date.now(),
    planType,
    planLabel: PLAN_LABELS[planType] || planType || '未知',
    resourceStatus: typeof item.resourceStatus === 'string' ? item.resourceStatus : '',
    effectiveAt: typeof item.effectiveAt === 'string' ? item.effectiveAt : '',
    expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : '',
    totalTokens: total,
    usedTokens: used,
    remainingTokens: remaining,
    remainingPercent: pct,
  }
}

/**
 * 创建 qianfanTokenPlan 服务对象。客户端经 remote.qianfanTokenPlan.* 调用。
 * @param ctx - 宿主插件上下文。
 * @returns 服务对象。
 */
function createService(ctx) {
  // 配置（宿主内存，启动时从凭据注入，客户端可经 setConfig 更新）。
  const config = {
    cookie: '',
    referer: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    refreshMinutes: 15,
  }
  // 启动时从持久化配置文件恢复（Cookie 归一化，兼容历史坏值）。
  const saved = loadConfigFile()
  if (saved && typeof saved.cookie === 'string') config.cookie = normalizeCookie(saved.cookie)
  if (saved && typeof saved.referer === 'string' && saved.referer.length > 0) config.referer = saved.referer
  if (saved && typeof saved.userAgent === 'string' && saved.userAgent.length > 0) config.userAgent = saved.userAgent
  const rm = Number(saved && saved.refreshMinutes)
  if (Number.isFinite(rm) && rm >= 1) config.refreshMinutes = Math.min(1440, Math.round(rm))
  let state = emptyState()

  // ---- 凭据读取（启动时 + 懒加载兜底） ----
  // 凭据服务可能因加载顺序晚于本插件就绪；每次查询前 ensureCookie 再兜底读一次，
  // 无论何时可用都能拿到 Cookie（已配置时直接返回，避免反复 resolve）。
  async function ensureCookie() {
    if (config.cookie.length > 0) return true
    // 持久化配置文件兜底（可能被其它会话保存/手动编辑更新）。
    const saved = loadConfigFile()
    const fc = saved && typeof saved.cookie === 'string' ? normalizeCookie(saved.cookie) : ''
    if (fc) { config.cookie = fc; return true }
    // 凭据库兜底（.credentials.yaml 的历史值也做归一化，并顺手清洗回文件）。
    const creds = ctx.get('credentials')
    if (creds === undefined) return false
    try {
      const hit = await creds.resolve(credentialRef(CRED_REF_NAME))
      if (hit && typeof hit.value === 'string' && hit.value.trim().length > 0) {
        const clean = normalizeCookie(hit.value)
        if (clean) {
          config.cookie = clean
          saveConfigFile({ cookie: clean })
          return true
        }
      }
    } catch (e) {
      console.log('[qianfan-tokenplan] credentials read failed:', String(e && e.message || e))
    }
    return false
  }

  // 启动时尝试从凭据库读取 Cookie 并刷新一次（失败/未就绪不阻塞，后续查询再兜底）。
  ensureCookie().then((ok) => {
    if (ok) {
      console.log('[qianfan-tokenplan] cookie seeded from credentials')
      refresh(false).catch(() => {})
    }
  })

  // ---- 查询 ----
  async function query() {
    const hasCookie = await ensureCookie()
    if (!hasCookie) {
      const err = new Error('未配置控制台 Cookie。请到 设置 → 千帆 Token Plan 粘贴 console.bce.baidu.com 的登录 Cookie。')
      err.soft = true
      throw err
    }
    const body = await curlQianfan(config.cookie, config.referer, config.userAgent)
    return parseResponseBody(body)
  }

  // ---- 刷新（10 秒防抖 + 并发去重；失败不崩） ----
  let inFlight = null
  let lastAttemptAt = 0
  async function refresh(force) {
    const now = Date.now()
    if (!force && now - lastAttemptAt < 10000) return state
    if (inFlight !== null) { try { await inFlight } catch { /* 等待已有请求 */ } return state }
    const task = (async () => { state = await query() })()
      .catch((error) => {
        const soft = error && error.soft === true
        state = {
          ...emptyState(),
          status: soft ? 'off' : 'error',
          message: error && error.message ? error.message : String(error),
          fetchedAt: Date.now(),
        }
      })
      .finally(() => { inFlight = null; lastAttemptAt = Date.now() })
    inFlight = task
    try { await task } catch { /* 已在 catch 内落状态 */ }
    return state
  }

  // ---- 自动刷新定时器（Node 全局 setInterval + ctx.effect 清理） ----
  const pollTimer = setInterval(() => {
    const min = Math.max(1, Number(config.refreshMinutes) || 15)
    if (config.cookie && config.cookie.length > 0 && Date.now() - state.fetchedAt >= min * 60000) {
      refresh(false).catch(() => {})
    }
  }, 30000)
  ctx.effect(() => () => { clearInterval(pollTimer) }, 'qianfan-tokenplan: poll timer')

  const service = {
    /** 读取当前状态与配置标记。 */
    async getState() {
      return {
        configured: typeof config.cookie === 'string' && config.cookie.length > 0,
        state,
      }
    },

    /** 更新配置（Cookie/Referer/UA/刷新间隔）并立即刷新。 */
    async setConfig(patch) {
      const a = patch || {}
      if (typeof a.cookie === 'string') {
        const normalized = normalizeCookie(a.cookie)
        if (normalized.length > 0) config.cookie = normalized
      }
      if (typeof a.referer === 'string') config.referer = a.referer.trim()
      if (typeof a.userAgent === 'string' && a.userAgent.trim().length > 0) config.userAgent = a.userAgent.trim()
      const rm = Number(a.refreshMinutes)
      if (Number.isFinite(rm) && rm >= 1) config.refreshMinutes = Math.min(1440, Math.round(rm))
      // 持久化到插件自有配置文件（原子写，跨重启保留）。
      saveConfigFile({
        cookie: config.cookie,
        referer: config.referer,
        userAgent: config.userAgent,
        refreshMinutes: config.refreshMinutes,
      })
      // 同时尽力写回凭据库（可选通道，失败不影响）。
      if (config.cookie.length > 0) {
        const creds = ctx.get('credentials')
        if (creds !== undefined) {
          try { await creds.set(credentialRef(CRED_REF_NAME), config.cookie) } catch (e) {
            console.log('[qianfan-tokenplan] credential persist failed (ignored):', String(e && e.message || e))
          }
        }
      }
      await refresh(true)
      return {
        ok: state.status === 'ok',
        message: state.status === 'ok' ? '已保存并刷新成功' : '已保存，刷新：' + (state.message || '稍后再试'),
        configured: config.cookie.length > 0,
        state,
      }
    },

    /** 立即强制刷新。 */
    async refresh() {
      const s = await refresh(true)
      return {
        ok: s.status === 'ok',
        message: s.status === 'ok' ? '已刷新'
          : s.status === 'off' ? (s.message || '未配置 Cookie') : (s.message || '刷新失败'),
        configured: config.cookie.length > 0,
        state: s,
      }
    },
  }

  // Typert 网关要求服务对象暴露 typertRemote 绑定（与 dsh-cost-meter 完全一致），
  // 否则客户端 RPC 会报告:
  //   typert gateway: qianfanTokenPlan/<method>: Service "qianfanTokenPlan" has no visible typertRemote binding
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'qianfanTokenPlan', namespace: 'qianfanTokenPlan' },
  })

  return service
}

export function apply(ctx) {
  console.log('[qianfan-tokenplan] host half ready, endpoint=' + ENDPOINT)
  ctx.provide('qianfanTokenPlan', createService(ctx))
}
