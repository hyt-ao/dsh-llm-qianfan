# dsh-qianfan (DeepSeek Harness Qianfan plugin family)

百度千帆（Baidu Qianfan）插件家族，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：

| 包 | 说明 |
|---|---|
| [`packages/dsh-llm-qianfan`](packages/dsh-llm-qianfan) | 千帆 Chat Completions 适配器（含推理档位） |
| [`packages/dsh-qianfan-tokenplan`](packages/dsh-qianfan-tokenplan) | 千帆 Token Plan 个人版套餐余量卡片（侧边栏） |

## packages/dsh-llm-qianfan —— 适配器

将 DSH 的统一 LLM 接口对接到百度千帆的 Chat Completions API。

### 功能

- 流式输出（SSE streaming）
- 工具调用（function calling / tool use）
- 思考模式（thinking / reasoning models）
- **推理档位（reasoning effort）**：支持 `off` / `high` / `max` 三档，经 DSH 模型选择器的「推理等级」菜单选择，映射为千帆 `reasoning_effort` 参数
- 内置速率限制器（token bucket + header-based back-pressure）
- 通过环境变量或 `.env.qianfan` 配置 API Key 和模型列表

### 安装

```bash
# from this monorepo (adapter only)
cd packages/dsh-llm-qianfan
dsh plugin add .

# 或从上游 GitHub 安装（含同一仓库内两包）
dsh plugin add github:hyt-ao/dsh-llm-qianfan
```

仓库已包含预构建的 `lib/` 目录，克隆后无需编译。

### 配置

在 DSH 的 `llm-qianfan:` 设置区块中填入千帆 API Key（或环境变量 `QIANFAN_API_KEY`）。

**推理档位**：为每个模型声明 `reasoningEfforts`，并可设置 provider 级默认 `reasoning`：

```yaml
llm-qianfan:
  reasoning: max            # 默认档位：off | high | max
  models:
    - id: deepseek-v4-pro
      reasoningEfforts:
        off: null
        high: high
        max: max
```

- `off` → 关闭思考（请求发 `thinking: {type:"disabled"}`）
- `high` / `max` → 开启思考并向 API 发 `reasoning_effort: high|max`
- 模型的 `reasoningEfforts` 声明会让模型选择器显示「推理等级」菜单并预选 provider 默认档
- 未声明 `reasoningEfforts` 的模型沿用布尔 `thinking` 开关，不显示档位菜单

### 从源码构建（monorepo）

```bash
pnpm install
pnpm --filter dsh-llm-qianfan build
```

## packages/dsh-qianfan-tokenplan —— Token Plan 余量卡

在 DSH 侧边栏显示千帆 Token Plan 个人版套餐的余量信息（套餐类型 / 剩余百分比 / 剩余与总量 token / 重置时间），并可在「设置 → 千帆 Token Plan」配置控制台 Cookie 自动刷新。

数据来源：千帆控制台「我的订阅」接口（`console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource`），凭据经 DSH 凭据库 `QIANFAN_TP_COOKIE` 引用，**不会**硬编码或写入仓库。

```bash
cd packages/dsh-qianfan-tokenplan
dsh plugin add .
```

## 许可证

MIT