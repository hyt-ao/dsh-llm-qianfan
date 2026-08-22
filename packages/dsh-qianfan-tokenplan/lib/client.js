/**
 * dsh-qianfan-tokenplan 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 提供两个界面：
 *  - sidebar.footer.action：侧边栏余量小卡片（套餐类型/剩余%/剩余token/总量/重置时间）；
 *  - settings.section「千帆 Token Plan」：Cookie 配置与刷新间隔。
 *
 * 数据通道：
 *  - remote.qianfanTokenPlan.*（Typert RPC）→ 状态读取、配置更新、手动刷新。
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 * RPC 服务经 props.qfService 注入组件（稳定对象，非闭包）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qianfan-tokenplan',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ── 样式（静态 bundle 无 styles 内置，手工注入 style 标签） ───────────────

    const css = [
      '/* dsh-qianfan-tokenplan: 侧边栏余量卡片与设置页 */',
      '.qf-card{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary)}',
      '.qf-card:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.qf-card.busy{opacity:.55}',
      '.qf-head{display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.qf-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qf-plan{flex:none;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted);white-space:nowrap}',
      '.qf-pct{font-size:16px;line-height:20px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.qf-pct.ok{color:var(--dsw-alias-state-ok-primary,#3ba272)}',
      '.qf-pct.warn{color:var(--dsw-alias-state-warn-primary)}',
      '.qf-pct.over{color:var(--dsw-alias-state-error-primary)}',
      '.qf-bar{height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}',
      '.qf-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-ok-primary,#3ba272);transition:width .3s ease}',
      '.qf-fill.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.qf-fill.over{background:var(--dsw-alias-state-error-primary)}',
      '.qf-num{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qf-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qf-note{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      // 通栏横条（布局手术已把本卡片挪到 footerActions 上方独立成行，不参与其它插件的行内挤压）：
      // width:100% 占满整行，横排 flex-wrap 自适应。order/flex 保留为手术失败时的兜底排序。
      '.qf-strip{order:-1;flex:0 0 auto;box-sizing:border-box;width:100%;min-width:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary)}',
      '.qf-strip:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.qf-strip.busy{opacity:.55;cursor:default}',
      '.qf-strip .qf-head{flex:none;gap:6px}',
      '.qf-strip .qf-pct{font-size:15px;line-height:18px}',
      '.qf-strip .qf-bar{flex:1 1 120px;min-width:70px;height:6px}',
      '.qf-strip .qf-num{font-size:12px;white-space:nowrap}',
      '.qf-strip .qf-meta{font-size:11px;white-space:nowrap}',
      // 底部提示行：独占整行的淡色小字（flex-basis 100% 换到最下一行）。
      '.qf-tip{flex:none;width:100%;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 收起窄栏（rail）：居中百分比方块
      '.qf-rail{width:44px;box-sizing:border-box;padding:6px 3px;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.qf-rail:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.qf-rail .qf-pct{font-size:15px;line-height:16px;font-weight:700}',
      '.qf-rail .qf-bar{width:26px;height:4px}',
      // 设置页
      '.qf-cfg{display:flex;flex-direction:column;gap:14px;padding:2px 2px 20px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.qf-cfg h3{margin:0;font-size:14px;font-weight:600}',
      '.qf-field{display:flex;flex-direction:column;gap:5px}',
      '.qf-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.qf-input{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;outline:none}',
      '.qf-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.qf-textarea{font-family:ui-monospace,Consolas,monospace;font-size:12px;min-height:110px;resize:vertical;white-space:pre-wrap;word-break:break-all}',
      '.qf-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.qf-btn{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 14px;cursor:pointer}',
      '.qf-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.qf-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
      '.qf-btn:disabled{opacity:.5;cursor:default}',
      '.qf-msg{font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}',
      '.qf-msg.ok{color:var(--dsw-alias-state-success-primary)}',
      '.qf-msg.err{color:var(--dsw-alias-state-error-primary)}',
      '.qf-note2{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
      '.qf-q{display:inline;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-family:ui-monospace,Consolas,monospace;font-size:11px}',
    ].join('\n')
    const cssTagId = 'dsh-qianfan-tokenplan/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-qianfan-tokenplan'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 工具函数 ──────────────────────────────────────────────────────────────

    function fmtTokens(n) {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return '0'
      if (v >= 100000000) return (v / 100000000).toFixed(2).replace(/\.?0+$/, '') + ' 亿'
      if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.?0+$/, '') + ' 万'
      return String(Math.round(v))
    }
    function fmtTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const p = (x) => String(x).padStart(2, '0')
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function pctClass(p) {
      const n = Number(p) || 0
      if (n < 30) return 'over'
      if (n < 70) return 'warn'
      return 'ok'
    }

    // ── RPC codec（轻量 {parse} 函数，与 dsh-cost-meter client 同模式） ──────

    function fail(path, expected) {
      throw new Error(path + ' expects ' + expected)
    }
    function parseState(v, path) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path || 'state', 'object')
      const s = v.state || {}
      return {
        configured: v.configured === true,
        state: {
          status: typeof s.status === 'string' ? s.status : 'off',
          message: typeof s.message === 'string' ? s.message : '',
          fetchedAt: typeof s.fetchedAt === 'number' ? s.fetchedAt : 0,
          planType: typeof s.planType === 'string' ? s.planType : '',
          planLabel: typeof s.planLabel === 'string' ? s.planLabel : '',
          resourceStatus: typeof s.resourceStatus === 'string' ? s.resourceStatus : '',
          effectiveAt: typeof s.effectiveAt === 'string' ? s.effectiveAt : '',
          expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : '',
          totalTokens: typeof s.totalTokens === 'number' ? s.totalTokens : 0,
          usedTokens: typeof s.usedTokens === 'number' ? s.usedTokens : 0,
          remainingTokens: typeof s.remainingTokens === 'number' ? s.remainingTokens : 0,
          remainingPercent: typeof s.remainingPercent === 'number' ? s.remainingPercent : 0,
        },
      }
    }
    function parseResult(v, path) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path || 'result', 'object')
      let state = null
      if (v.state !== null && v.state !== undefined) {
        state = parseState({ configured: v.configured === true, state: v.state }, path + '.state').state
      }
      return {
        ok: v.ok === true,
        message: typeof v.message === 'string' ? v.message : '',
        configured: v.configured === true,
        state,
      }
    }
    /** 解包 client api RPC 信封（{ ok, value } 或 { ok:false, error }），失败抛错。 */
    async function unwrap(promise) {
      const env = await promise
      if (env === null || typeof env !== 'object' || env.ok !== true) {
        throw new Error(env && env.error && env.error.message ? env.error.message : 'RPC 调用失败')
      }
      return env.value
    }
    function codecOf(parse) { return { parse } }
    const stateCodec = codecOf(parseState)
    const resultCodec = codecOf(parseResult)
    const configCodec = codecOf((v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('config', 'object')
      return v
    })

    // ── RPC 贡献（与 ./typert 清单一一对应；typeSymbol 必须与 Host 完全一致） ──

    const CONTRIBUTION = {
      package: 'dsh-qianfan-tokenplan',
      descriptors: [
        {
          id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/getState', service: 'qianfanTokenPlan', namespace: 'qianfanTokenPlan', method: 'getState',
          invocation: { kind: 'direct' }, parameters: [],
          result: { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#GetStateResult', schema: stateCodec },
        },
        {
          id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/setConfig', service: 'qianfanTokenPlan', namespace: 'qianfanTokenPlan', method: 'setConfig',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#SetConfigArgs', schema: configCodec } }],
          result: { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#Result', schema: resultCodec },
        },
        {
          id: 'dsh-qianfan-tokenplan#qianfanTokenPlan/refresh', service: 'qianfanTokenPlan', namespace: 'qianfanTokenPlan', method: 'refresh',
          invocation: { kind: 'direct' }, parameters: [],
          result: { mode: 'strict', typeSymbol: 'dsh-qianfan-tokenplan#Result', schema: resultCodec },
        },
      ],
    }

    // ── 侧边栏卡片组件 ──────────────────────────────────────────────────────────

    function QfCard(props) {
      const wide = props && props.wide !== false
      const svc = props && props.qfService
      const [view, setView] = React.useState({ configured: false, state: null })
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)

      // 布局手术：侧边栏底部 footerActions 是 flex-row+nowrap，多个插件会并排互相压缩。
      // 不动其它插件的宽度——把本卡片从该行【挪到其上方】的 footArea（flex-column）作为第一项，
      // 通栏横条独占顶部；footerActions 行只留下 cost-meter/远程控制行，恢复它们原有的并排布局。
      React.useEffect(() => {
        const root = rootRef.current
        if (!root || typeof document === 'undefined') return
        const outlet = root.parentElement          // data-slot=sidebar.footer.action（display:contents）
        const fa = outlet && outlet.parentElement  // .hHd-Xa_footerActions（flex row nowrap）
        const area = fa && fa.parentElement        // .hHd-Xa_footArea（flex column）
        if (!fa || !area || fa === area) return
        const isRow = /footerActions/.test(String(fa.className))
        if (!isRow) return
        const apply = () => {
          if (!root.isConnected || !area.isConnected) return
          if (root.parentElement !== area) {
            area.insertBefore(root, fa)            // 移到 footerActions 正上方，成为列首行
          }
        }
        apply()
        const mo = new MutationObserver(() => apply())
        mo.observe(area, { childList: true })
        mo.observe(fa, { childList: true })
        return () => mo.disconnect()
      }, [])

      const load = React.useCallback(() => {
        if (!svc) return
        unwrap(svc.getState()).then((v) => {
          const p = parseState(v, 'getState')
          setView({ configured: p.configured, state: p.state || null })
        }).catch((e) => {
          setView({ configured: false, state: { status: 'error', message: String(e && e.message || e) } })
        })
      }, [svc])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        const timer = setInterval(() => { if (!document.hidden) load() }, 30000)
        return () => { clearInterval(timer) }
      }, [load])

      const onClick = () => {
        if (busy || !svc) return
        setBusy(true)
        unwrap(svc.refresh()).then((v) => {
          const p = parseResult(v, 'refresh')
          setView({ configured: p.configured, state: p.state || null })
        }).catch(() => {}).finally(() => setBusy(false))
      }

      const s = view.state
      const wideCls = busy ? 'qf-strip busy' : 'qf-strip'
      const e = React.createElement

      // 无配置/无状态
      if (!s || s.status === 'off' || s.status === 'error') {
        const msg = !view.configured
          ? '未配置 Cookie，到 设置 → 千帆 Token Plan 配置'
          : (s.message || (s.status === 'error' ? '查询失败，点击重试' : '未订阅 Token Plan'))
        if (!wide) {
          return e('div', { ref: rootRef, className: 'qf-rail', onClick, title: msg },
            e('div', { className: 'qf-pct over' }, '--'))
        }
        return e('div', { ref: rootRef, className: wideCls, onClick }, [
          e('div', { className: 'qf-head' }, e('div', { className: 'qf-title' }, '千帆 Token Plan')),
          e('div', { className: 'qf-note' }, msg),
        ])
      }

      const pct = Number(s.remainingPercent) || 0
      const tone = pctClass(pct)

      if (!wide) {
        return e('div', { ref: rootRef, className: 'qf-rail', onClick, title: s.planLabel + ' · 剩余 ' + pct.toFixed(1) + '% · ' + fmtTime(s.expiresAt) },
          e('div', { className: 'qf-pct ' + tone }, pct.toFixed(0) + '%'),
          e('div', { className: 'qf-bar' },
            e('div', { className: 'qf-fill ' + tone, style: { width: Math.max(0, Math.min(100, pct)).toFixed(1) + '%' } }, null)))
      }

      // 通栏横条（布局手术已把本卡片挪到 footerActions 上方单独独占一行，
      // 不参与其它插件的行内挤压）：标题+档位徽章 / 剩余% / 进度条 / 数字 / 时间元信息，横排自适应。
      return e('div', { ref: rootRef, className: wideCls, onClick, title: '点击立即刷新' }, [
        e('div', { className: 'qf-head' }, [
          e('div', { className: 'qf-title' }, '千帆 Token Plan'),
          s.planLabel ? e('span', { className: 'qf-plan' }, s.planLabel) : null,
        ]),
        e('div', { className: 'qf-pct ' + tone }, pct.toFixed(1) + '%'),
        e('div', { className: 'qf-bar' },
          e('div', { className: 'qf-fill ' + tone, style: { width: Math.max(0, Math.min(100, pct)).toFixed(1) + '%' } }, null)),
        e('div', { className: 'qf-num' }, '剩余 ' + fmtTokens(s.remainingTokens) + ' / ' + fmtTokens(s.totalTokens)),
        e('div', { className: 'qf-meta' }, [
          s.expiresAt ? '重置 ' + fmtTime(s.expiresAt) + ' · ' : '',
          '更新 ' + fmtTime(new Date(s.fetchedAt).toISOString()),
        ].join('')),
        // 底部提示：指定模型闲时 2 折。
        e('div', { className: 'qf-tip' }, '闲时 2 折：每日 21:00–次日 8:00'),
      ])
    }

    // ── 设置页组件 ──────────────────────────────────────────────────────────────

    function QfConfig(props) {
      const e = React.createElement
      const svc = props && props.qfService
      const [configured, setConfigured] = React.useState(false)
      const [stateView, setStateView] = React.useState(null)
      const [cookie, setCookie] = React.useState('')
      const [referer, setReferer] = React.useState('')
      const [ua, setUa] = React.useState('')
      const [minutes, setMinutes] = React.useState('15')
      const [msg, setMsg] = React.useState({ kind: '', text: '' })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!svc) return
        unwrap(svc.getState()).then((v) => {
          const p = parseState(v, 'getState')
          setConfigured(p.configured)
          setStateView(p.state || null)
        }).catch(() => {})
      }, [svc])

      const save = () => {
        if (!svc) return
        setBusy(true)
        setMsg({ kind: '', text: '' })
        unwrap(svc.setConfig({
          cookie: cookie,
          referer: referer || undefined,
          userAgent: ua || undefined,
          refreshMinutes: minutes ? Number(minutes) : 15,
        })).then((v) => {
          const p = parseResult(v, 'setConfig')
          setConfigured(p.configured)
          setStateView(p.state || null)
          setMsg({ kind: p.ok ? 'ok' : 'err', text: p.message || (p.ok ? '已保存' : '保存失败') })
        }).catch((err) => {
          setMsg({ kind: 'err', text: '保存失败：' + String(err && err.message || err) })
        }).finally(() => setBusy(false))
      }

      const d = configured ? '已配置（Cookie 存于宿主内存与 DSH 凭据库，页面不回显明文）' : '未配置 Cookie'
      const sv = stateView
      return e('div', { className: 'qf-cfg' }, [
        e('h3', null, '千帆 Token Plan 个人版 · 余量查询（官方控制台）'),
        e('p', { className: 'qf-note2' }, [
          '功能：查询并显示「我的订阅」中的套餐类型、剩余百分比、剩余/总量 token 与到期（重置）时间。',
          e('br', null),
          '数据来源：', e('span', { className: 'qf-q' }, 'console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource'),
          '（需控制台登录 Cookie 认证）。插件通过本机 curl 直连官方控制台，凭据不传至浏览器页面。',
        ]),
        e('div', { className: 'qf-msg ' + (configured ? 'ok' : 'err') }, d),
        sv && sv.status === 'ok' ? e('div', { className: 'qf-msg ok' },
          '当前套餐 ' + sv.planLabel + ' · 剩余 ' + fmtTokens(sv.remainingTokens) + ' / ' + fmtTokens(sv.totalTokens)
          + ' token（' + sv.remainingPercent.toFixed(1) + '%）· 重置 ' + fmtTime(sv.expiresAt)) : null,
        e('div', { className: 'qf-field' }, [
          e('label', null, '控制台 Cookie（必填：DevTools → Network → tokenPlanPersonal/resource 请求 → 复制 Cookie 请求头全部内容）'),
          e('textarea', { className: 'qf-input qf-textarea', value: cookie, placeholder: '粘贴 Cookie…', onChange: (ev) => setCookie(ev.target.value) }),
        ]),
        e('div', { className: 'qf-field' }, [
          e('label', null, 'Referer（可选，默认官方页面）'),
          e('input', { className: 'qf-input', value: referer, onChange: (ev) => setReferer(ev.target.value) }),
        ]),
        e('div', { className: 'qf-field' }, [
          e('label', null, 'User-Agent（可选）'),
          e('input', { className: 'qf-input', value: ua, onChange: (ev) => setUa(ev.target.value) }),
        ]),
        e('div', { className: 'qf-field' }, [
          e('label', null, '自动刷新间隔（分钟，默认 15）'),
          e('input', { className: 'qf-input', value: minutes, onChange: (ev) => setMinutes(ev.target.value) }),
        ]),
        e('div', { className: 'qf-row' }, [
          e('button', { className: 'qf-btn primary', onClick: save, disabled: busy }, '保存并立即刷新'),
        ]),
        msg.text ? e('div', { className: 'qf-msg ' + (msg.kind === 'ok' ? 'ok' : 'err') }, msg.text) : null,
        e('p', { className: 'qf-note2' }, [
          '如何获取 Cookie：浏览器登录千帆控制台 → 打开「我的订阅」页面 → F12 → Network → 刷新页面 → 找到 ',
          e('span', { className: 'qf-q' }, 'tokenPlanPersonal/resource'),
          ' 请求 → 复制其 Cookie 请求头的完整值粘贴到上方。Cookie 过期后在此更新即可。',
        ]),
      ])
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    const inject = ['remote']

    async function apply(ctx) {
      const remote = ctx.remote
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      // ctx.effect(callback, label) 立即执行 callback、把其返回值当卸载器；
      // 必须返回 () => unmount() 兜底函数，而不是在这里就调用 unmount()，
      // 否则贡献刚挂载完就被卸载、remote 方法全部消失（svc.getState is not a function）。
      ctx.effect(() => () => { unmount() }, 'qianfan-tokenplan: remote contribution')

      const svc = ctx.get('remote.qianfanTokenPlan')
      if (svc === undefined) return

      const slots = ctx.get('slots')
      if (slots !== undefined) {
        slots.inject('sidebar.footer.action', () => {
          const dispose = slots.register(
            { name: 'sidebar.footer.action', id: 'qianfan-tokenplan-card', order: -1 },
            (props) => React.createElement(QfCard, { ...props, qfService: svc }),
          )
          return () => dispose()
        })
        slots.inject('settings.section', () => {
          const dispose = slots.register(
            { name: 'settings.section', id: 'qianfan-tokenplan', order: 9, label: () => '千帆 Token Plan' },
            (props) => React.createElement(QfConfig, { ...props, qfService: svc }),
          )
          return () => dispose()
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
