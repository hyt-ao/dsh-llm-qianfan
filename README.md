# dsh-llm-qianfan

百度千帆（Baidu Qianfan）大模型适配器插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 LLM 接口层。

## 功能

- 将 DSH 的统一 LLM 接口对接到百度千帆的 Chat Completions API
- 支持流式输出（SSE streaming）
- 支持工具调用（function calling / tool use）
- 支持思考模式（thinking / reasoning models，如 ERNIE-4.5）
- 内置速率限制器（token bucket + header-based back-pressure）
- 支持通过环境变量或 `.env.qianfan` 文件配置 API Key 和模型列表

## 安装

### 方式一：从 GitHub 安装（推荐，零编译）

```bash
dsh plugin add github:你的用户名/dsh-llm-qianfan
```

> 仓库已包含预构建的 `lib/` 目录，克隆后无需编译，无需配置 `allowBuilds`。

### 方式二：克隆后本地安装

```bash
git clone https://github.com/你的用户名/dsh-llm-qianfan.git
dsh plugin add ./dsh-llm-qianfan
```

## 配置

### 1. 设置 API Key

在 DSH 的 `llm-qianfan:` 设置区块中填入你的千帆 API Key，或通过环境变量提供：

```bash
export QIANFAN_API_KEY="your-api-key-here"
```

也可以在项目根目录创建 `.env.qianfan` 文件：

```
QIANFAN_API_KEY=your-api-key-here
```

### 2. 自定义模型列表（可选）

默认支持以下模型。如需添加或修改，设置环境变量：

```bash
export QIANFAN_MODELS='[{"id":"ernie-4.5-turbo-128k","thinking":true},{"id":"deepseek-v3"}]'
```

每个模型对象的字段：
- `id`（必填）：千帆平台上的模型标识
- `thinking`（可选，布尔值）：是否为思考模式模型

### 3. 速率限制（可选）

通过环境变量配置速率限制器：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `QIANFAN_RATE_LIMIT_TPM` | 每分钟 token 上限 | 不限制 |
| `QIANFAN_RATE_LIMIT_RPM` | 每分钟请求上限 | 不限制 |
| `QIANFAN_RATE_LIMIT_CONCURRENCY` | 最大并发请求数 | 不限制 |
| `QIANFAN_RATE_LIMIT_IDLE_TIMEOUT_MS` | 空闲超时（毫秒） | 300000 |

## 从源码构建

如需自行修改并重新构建：

```bash
pnpm install
pnpm build
```

构建产物输出到 `lib/` 目录。

## 技术参数

| 参数 | 默认值 |
|------|--------|
| 上下文窗口 | 128,000 tokens |
| 最大输出 tokens | 8,192 |
| 流式空闲超时 | 300,000 ms (5 分钟) |

## 许可证

MIT
