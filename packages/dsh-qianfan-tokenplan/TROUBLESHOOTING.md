# dsh-qianfan-tokenplan 插件启动报错修复记录

## 报错信息

第一次启动时报错：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry qianfan-tokenplan (dsh-qianfan-tokenplan):
Cannot find package '@deepseek-ai/dsh-credentials' imported from D:\File\Code\dsh-qianfan-tokenplan\lib\index.js
```

第二次启动时报错（修复 `@deepseek-ai/dsh-credentials` 后）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry typert-loader (@deepseek-ai/dsh-typert-loader):
typert-loader: 1 typert contributor(s) failed to register:
- typert-loader: dsh-qianfan-tokenplan exports "./typert" but importing D:\File\Code\dsh-qianfan-tokenplan\lib\typert.host.js failed:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from D:\File\Code\dsh-qianfan-tokenplan\lib\typert.host.js
```

第三次启动时报错（添加 zod v3 后）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry typert-loader (@deepseek-ai/dsh-typert-loader):
typert-loader: 1 typert contributor(s) failed to register:
- typert-loader: dsh-qianfan-tokenplan invocation "dsh-qianfan-tokenplan#qianfanTokenPlan/getState"
result codec is not backed by a zod v4 schema
```

## 根本原因

### 问题 1: `@deepseek-ai/dsh-credentials` 依赖缺失
插件代码中导入了 `@deepseek-ai/dsh-credentials`，但 `package.json` 声明了依赖，本地开发目录的 `node_modules` 不在 DSH 全局模块解析路径中。

### 问题 2: `zod` 依赖未声明
`lib/typert.host.js` 使用了 `zod` 但 `package.json` 中未声明依赖。

### 问题 3: zod 版本不匹配
DSH 内部使用 zod v4，插件需要使用相同版本。

## 修复步骤

### 1. 检查依赖声明
确认 `package.json` 中已声明 `@deepseek-ai/dsh-credentials`：

```json
"dependencies": {
  "@deepseek-ai/dsh-credentials": "^0.0.1-rc.1"
}
```

### 2. 添加插件到 DSH profile
```bash
dsh plugin add /d/File/Code/dsh-qianfan-tokenplan --profile web
```

这会在 `~/.dsh/profiles/web/package.json` 中添加 link 引用，pnpm 会解析插件的依赖。

### 3. 补全 `zod` 依赖
更新 `package.json`：

```json
"dependencies": {
  "@deepseek-ai/dsh-credentials": "^0.0.1-rc.1",
  "zod": "^4.0.0"
}
```

### 4. 安装依赖
```bash
npm install
```

## 验证结果

```bash
dsh web
```

成功启动：

```
[qianfan-tokenplan] host half ready, endpoint=https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource
[dsh-cost-meter] 已加载,账本:C:\Users\Z - Sir\.dsh\storages\cost-meter\ledger.json
dsh web: http://127.0.0.1:3080
dsh web: opening the default browser; pass --no-open to disable
```

## 关键知识点

1. **DSH 插件开发模式依赖解析**：DSH 通过 `dsh plugin add` 将本地目录链接到 profile，由 pnpm 管理依赖解析，不是直接从插件目录的 `node_modules` 加载。

2. **zod 版本要求**：DSH 的 typert-loader 检查 zod v4 的特定特性，v3 会被拒绝。

3. **package.json 完整性**：插件运行时用到的所有外部依赖必须在 `dependencies` 中声明，否则在 profile 环境中无法解析。

---

# 空白页 / 侧边栏卡片崩溃修复记录（2026-08-22，第二轮）

## 症状

dsh web 可启动、设置页能看到「千帆 Token Plan」导航项，但选中后内容区空白；
侧边栏「千帆 Token Plan」卡片同样崩溃（无内容、无报错弹层）。

## 定位手段：CDP 抓浏览器控制台

用无头 Edge 开启 `--remote-debugging-port=9222`，Node 原生 WebSocket + CDP 协议
连接页面，监听 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`，抓到：

```
TypeError: svc.getState is not a function
console.error: slot entry crashed in 'sidebar.footer.action': TypeError: svc.getState is not a function
```

DSH slots 渲染器的 `SlotErrorBoundary` 在条目渲染抛异常时会渲染**空白
`<div data-slot-error>`**——这就是"选中后空白页"的机制（`dsh-client-ui-renderer`）。

## 根因 1：`ctx.effect(() => { unmount() }, label)` 误用

`remote.$mount(CONTRIBUTION)` 返回的 `unmount` 是**卸载器**，应只在插件卸载时执行。
`ctx.effect(callback, label)` 的语义是：**立即执行 callback，把 callback 的返回值当
卸载器**。若写成 `() => { unmount() }`，等于 mount 完立刻卸载贡献 → 远端命名空间
方法被全部删除 → `ctx.get('remote.<ns>')` 返回无方法对象 → `svc.getState is not a function`。

正确写法（与 dsh-cost-meter 一致）：
```js
ctx.effect(() => () => { unmount() }, 'pkg: remote contribution')
```

## 根因 2：RPC 返回信封未解包

client api 网关（`dsh-api-gateway/lib/client.js`）的 `invoke()` 返回：
`{ ok: true, value: <宿主结果> }` 或 `{ ok: false, error: { code, message } }`。
客户端**必须先查 `env.ok` 再取 `env.value`**，不能直接读业务字段。
（注意 `value` 已按描述符 result codec 预解析；解析失败也不会硬抛，而是包装成
`ok:false` 信封。）参考 dsh-cost-meter 客户端 `call()`。

## 根因 3：宿主启动时 `ctx.get('credentials')` 可能未就绪

凭据服务（`@deepseek-ai/dsh-credentials`）的加载顺序可能晚于本插件，启动时
`ctx.get('credentials')` 返回 `undefined` 会被静默跳过 → 卡片显示「未配置 Cookie」，
即使 Cookie 已存库。修法：每次 `query()` 前先 `ensureCookie()`（懒加载兜底），
凭据服务随时可用后都能补读到 Cookie；`resolve` 返回 `hit.value`。

## 根因 4：宿主服务对象缺 `typertRemote` 绑定（第三轮，2026-08-22）

保存 Cookie 时报：
```
保存失败：typert gateway: qianfanTokenPlan/setConfig: Service "qianfanTokenPlan" has no visible typertRemote binding
```

Host 面 Typert 网关（`dsh-api-gateway/lib/index.js` validateBinding）要求**服务对象
必须自带 `typertRemote` 绑定属性**，否则拒绝派发任何方法（getState/setConfig/refresh
全部失败）。`ctx.get('remote.<ns>')` 能拿到对象、`$mount` 也成功，但每次 RPC 都在网关这层被拒
——这就是"有导航、有布局、但永远没数据"的原因。

必须按 dsh-cost-meter 原样给服务对象打标（在 `ctx.provide` 前、返回前定义）：
```js
Object.defineProperty(service, 'typertRemote', {
  configurable: false, enumerable: false, writable: false,
  value: { service, serviceKey: 'qianfanTokenPlan', namespace: 'qianfanTokenPlan' },
})
return service
// ctx.provide('qianfanTokenPlan', createService(ctx))
```
注意 serviceKey 与 namespace 必须与 TYPERT 清单/客户端贡献的 `service`/`namespace` 完全一致。

## 验证（三轮累计）

- 服务器 `/plugins/dsh-qianfan-tokenplan/client.js` 立即吐新内容（rev 随内容变化），
  浏览器**刷新页面即可**拿到新客户端 bundle；宿主 `lib/index.js` 改动需重启 dsh web。
- 修完后 CDP 复测：`errs:[]`、`.qf-card` 正常渲染、设置导航「千帆 Token Plan」在列。

---

# 第四轮：持久化 + 布局隔离（2026-08-22）

## 问题 1：重启后 Cookie 需重填（应落盘持久化）

根因：`.credentials.yaml` 里 `QIANFAN_TP_COOKIE` 存的是**带 `Cookie:` 伪头 + 换行**的脏值
（约 3910 字符，以 `'Cookie:\n    H_PS_...` 开头）——`curl` 请求头里出现换行 → 400。
重启后读到坏值 → 查询失败 → 用户只能重填。

修法（`lib/index.js`）：
- 插件**自有持久化文件** `$DSH_HOME/qianfan-tokenplan.json`（`$DSH_HOME` = env 或
  `~/.dsh`），`saveConfigFile` 先写 `.tmp` 再 rename 原子落盘；
- 保存/读取统一 `normalizeCookie()`：剥掉 `^Cookie:\s*` 伪头、`\s+` 折叠成单行
  （Cookie 值不含空白/换行，粘贴了整段请求头也能清洗）；
- 启动从文件恢复 → `ensureCookie` 兜底顺序：文件 → 凭据库（resolve 值也归一化并顺手写回文件）；
- `setConfig` 归一化后既写文件又尽力写凭据库。

## 问题 2：布局——只改自己宽度，不动其它插件

sidebar.footer.action 容器 `.hHd-Xa_footerActions` 是 `flex row nowrap`（宽 100%）：
- 曾用 `.hHd-Xa_footerActions{flex-wrap:wrap !important}` 强制换行 → **会把 cost-meter
  拉成全宽 256px、远程控制行也单独成行**=改了别的插件宽度（用户不接受）。
- 正解 = **DOM 手术**（`client.js` QfCard 内 useEffect）：把本卡片根节点从 footerActions
  行**挪到其上方**的 `.hHd-Xa_footArea`（flex column）作为第一项；`.qf-strip` 用
  `width:100%; flex:0 0 auto`（作为列项按宽度占满）。footerActions 行只剩 cost-meter+
  远程控制行，恢复 `cm-footer-stack≈178px` 原始宽度。MutationObserver 在结构变化时重做。
- 注意：挪到 column 后 `flex:0 0 100%` 会按**高度**算，必须用 `flex:0 0 auto; width:100%`。