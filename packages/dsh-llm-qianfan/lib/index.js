import z from "@deepseek-ai/schemastery";
import { CallId, LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema, assertUsableApiKey, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
//#region src/client.ts
/**
* 规范化工具定义，确保每个 tool 都有 type: "function"。
* 千帆平台对第三方模型（DeepSeek、GLM 等）要求严格的 tools 格式，
* 每个 tool 必须显式包含 "type": "function"，否则报错：
*   "the type of the tool can only be function"
*/
function normalizeTools(tools) {
	if (!tools || tools.length === 0) return void 0;
	return tools.map((tool) => {
		if (tool.type === "function" && tool.function) return tool;
		if (tool.function) return {
			type: "function",
			...tool
		};
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters ?? tool.input_schema ?? {
					type: "object",
					properties: {}
				}
			}
		};
	});
}
/**
* Parse an SSE body into SseEvent payloads, terminated by [DONE].
*/
async function* parseSse(body, onComment) {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let bomStripped = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			if (!bomStripped) {
				bomStripped = true;
				if (buffer.charCodeAt(0) === 65279) buffer = buffer.slice(1);
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed.startsWith(":")) {
					onComment?.();
					continue;
				}
				if (!trimmed.startsWith("data:")) continue;
				yield { data: trimmed.slice(5).trim() };
			}
		}
		if (buffer.trim()) {
			const trimmed = buffer.trim();
			if (trimmed.startsWith("data:")) yield { data: trimmed.slice(5).trim() };
		}
	} finally {
		reader.releaseLock();
	}
}
//#endregion
//#region src/serialize.ts
/**
* 将 message content 转为千帆 v2 接受的纯文本字符串。
*
* 千帆 v2 chat/completions 的 messages[].content 只接受 string。
* 上游可能传入：
*   - 纯字符串: "你好"
*   - 内容块数组: [{"type":"text","text":"你好"}]
*/
function normalizeContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const texts = [];
		for (const block of content) if (block && typeof block === "object") {
			const b = block;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		}
		if (texts.length > 0) return texts.join("");
		return JSON.stringify(content);
	}
	if (content === null || content === void 0) return "";
	return String(content);
}
function serializeRequest(options, maxTokens) {
	const tools = normalizeTools(options.tools);
	const effort = options.reasoningEffort;
	const reasoningFields = effort === void 0 ? options.thinking === true ? { thinking: { type: "enabled" } } : {} : effort === "off" ? { thinking: { type: "disabled" } } : { reasoning_effort: effort };
	return {
		model: options.model,
		messages: options.messages.map((m) => ({
			role: m.role,
			content: normalizeContent(m.content)
		})),
		temperature: options.temperature,
		top_p: options.topP,
		max_tokens: options.maxTokens ?? maxTokens,
		stop: options.stop,
		...tools ? {
			tools,
			tool_choice: options.toolChoice
		} : {},
		stream: true,
		...reasoningFields
	};
}
//#endregion
//#region src/translate.ts
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: (reason ?? "UNKNOWN").toUpperCase()
			}
		};
	}
}
function mapUsage(usage) {
	return {
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0
	};
}
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
async function* translate(events) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const event of events) {
		if (!event.data) continue;
		if (event.data === "[DONE]") break;
		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${event.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		const choice = parsed.choices?.[0];
		if (!choice) continue;
		const delta = choice.delta;
		const reasoning = delta?.reasoning_content;
		if (typeof reasoning === "string" && reasoning.length > 0) {
			if (!reasoningBlock) {
				reasoningBlock = open("reasoning");
				yield {
					type: "block-start",
					index: reasoningBlock.index,
					blockType: "reasoning"
				};
			}
			reasoningBlock.text += reasoning;
			yield {
				type: "reasoning-delta",
				index: reasoningBlock.index,
				text: reasoning
			};
		}
		const content = delta?.content;
		if (typeof content === "string" && content.length > 0) {
			if (!textBlock) {
				textBlock = open("text");
				yield {
					type: "block-start",
					index: textBlock.index,
					blockType: "text"
				};
			}
			textBlock.text += content;
			yield {
				type: "text-delta",
				index: textBlock.index,
				text: content
			};
		}
		for (const call of delta?.tool_calls ?? []) {
			const wireIndex = call.index ?? 0;
			let block = toolBlocks.get(wireIndex);
			if (!block) {
				block = open("tool-call");
				toolBlocks.set(wireIndex, block);
				yield {
					type: "block-start",
					index: block.index,
					blockType: "tool-call"
				};
			}
			if (call.id !== void 0) block.callId = call.id;
			if (call.function?.name !== void 0) block.name = call.function.name;
			const fragment = call.function?.arguments ?? "";
			block.text += fragment;
			yield {
				type: "tool-call-delta",
				index: block.index,
				id: CallId(block.callId ?? ""),
				...block.name !== void 0 ? { name: block.name } : {},
				argumentsDelta: fragment
			};
		}
		if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		if (parsed.usage) pendingUsage = mapUsage(parsed.usage);
	}
	for (const block of order) yield {
		type: "block-end",
		index: block.index,
		block: closeBlock(block)
	};
	if (pendingUsage) yield {
		type: "usage",
		usage: pendingUsage
	};
	const reason = pendingFinish ?? { kind: "stop" };
	yield {
		type: "finish",
		reason: reason.kind === "stop" && order.length === 0 ? {
			kind: "error",
			failure: {
				message: "model returned a completed response with no content",
				code: "EMPTY_RESPONSE"
			}
		} : reason
	};
}
//#endregion
//#region src/rate-limiter.ts
var QianfanRateLimiter = class {
	tpmLimit;
	rpmLimit;
	minIntervalMs;
	tokenBucket;
	requestBucket;
	lastRequestTime = 0;
	remainingTokenRatio = 1;
	constructor(config) {
		const margin = config.safetyMargin ?? .15;
		this.tpmLimit = config.tpm > 0 ? Math.floor(config.tpm * (1 - margin)) : 0;
		this.rpmLimit = config.rpm > 0 ? Math.floor(config.rpm * (1 - margin)) : 0;
		this.minIntervalMs = config.minIntervalMs ?? 200;
		this.tokenBucket = {
			tokens: this.tpmLimit,
			lastRefill: Date.now()
		};
		this.requestBucket = {
			tokens: this.rpmLimit,
			lastRefill: Date.now()
		};
	}
	/**
	* Rough token estimate: ~4 chars per token for CJK / mixed content.
	* inputChars  = serialised request body length
	* maxOutTokens = the maxTokens we asked the model to produce
	*/
	static estimateTokens(inputChars, maxOutTokens) {
		return Math.ceil(inputChars / 4) + maxOutTokens;
	}
	/** Parse X-Ratelimit-* headers after every response. */
	updateFromHeaders(headers) {
		const remaining = headers.get("x-ratelimit-remaining-tokens");
		const limit = headers.get("x-ratelimit-limit-tokens");
		if (remaining !== null && limit !== null) {
			const r = Number(remaining);
			const l = Number(limit);
			if (Number.isFinite(r) && Number.isFinite(l) && l > 0) this.remainingTokenRatio = Math.max(0, Math.min(1, r / l));
		}
	}
	/** True when remaining tokens < 10 % of the quota. */
	get isThrottledByHeader() {
		return this.remainingTokenRatio < .1;
	}
	/**
	* Block until it is safe to send a request that will consume
	* approximately `estimatedTokens`. Respects TPM bucket, RPM bucket,
	* minimum inter-request interval, and header-based back-pressure.
	*
	* Rejects immediately if `signal` is aborted while waiting.
	*/
	async acquire(estimatedTokens, signal) {
		const elapsed = Date.now() - this.lastRequestTime;
		if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed, signal);
		if (this.tpmLimit > 0) await this.consumeBucket(this.tokenBucket, estimatedTokens, this.tpmLimit, signal);
		if (this.rpmLimit > 0) await this.consumeBucket(this.requestBucket, 1, this.rpmLimit, signal);
		if (this.isThrottledByHeader) {
			const backoff = Math.min(5e3, 1e3 / Math.max(this.remainingTokenRatio, .01));
			console.error(`[qianfan-rate] header throttle: remaining=${(this.remainingTokenRatio * 100).toFixed(1)}%, sleeping ${Math.round(backoff)}ms`);
			await sleep(backoff, signal);
		}
		this.lastRequestTime = Date.now();
	}
	async consumeBucket(bucket, cost, capacity, signal) {
		while (true) {
			this.refill(bucket, capacity);
			if (bucket.tokens >= cost) {
				bucket.tokens -= cost;
				return;
			}
			const deficit = cost - bucket.tokens;
			const refillRatePerMs = capacity / 6e4;
			const waitMs = Math.ceil(deficit / refillRatePerMs);
			console.error(`[qianfan-rate] bucket wait: deficit=${deficit.toFixed(0)}, sleeping ${waitMs}ms`);
			await sleep(waitMs, signal);
		}
	}
	refill(bucket, capacity) {
		const now = Date.now();
		const elapsed = now - bucket.lastRefill;
		if (elapsed <= 0) return;
		const refillRatePerMs = capacity / 6e4;
		bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
		bucket.lastRefill = now;
	}
};
function sleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/adapter.ts
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** Qianfan-specific error codes that indicate rate limiting. */
const QIANFAN_RATE_LIMIT_CODES = /* @__PURE__ */ new Set([336502, 18]);
/** Structural equality for rate-limit configs (avoids rebuilding on every request). */
function sameRateLimitConfig(a, b) {
	if (a === b) return true;
	if (a === void 0 || b === void 0) return false;
	return a.tpm === b.tpm && a.rpm === b.rpm && a.safetyMargin === b.safetyMargin && a.minIntervalMs === b.minIntervalMs;
}
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text"]
	};
}
/** "off" is the canonical disabled-thinking level id used across DSH adapters. */
const OFF_LEVEL = "off";
/**
* Build the reasoning-effort metadata the DSH catalog projection reads to
* render the model picker's effort menu, from a model's `reasoningEfforts`
* declaration and the provider's configured default level.
*
* The declaration maps level id → wire value (`off: null` disables thinking,
* `high`/`max` pass through to the API's `reasoning_effort` parameter).
* Only levels with a usable wire value are surfaced; `false` (explicit
* opt-out) and absent declarations expose no menu at all.
*
* @param model - the resolved catalog model (may be a plain object shape).
* @param defaultLevel - the provider-level default effort id, if any.
* @returns the reasoning metadata (or undefined when none can be offered).
*/
function reasoningOf(model, defaultLevel) {
	const efforts = model?.reasoningEfforts;
	if (efforts === void 0 || efforts === null) return void 0;
	if (efforts === false || typeof efforts !== "object") return void 0;
	const levels = [];
	for (const [id, wire] of Object.entries(efforts)) {
		if (id === OFF_LEVEL && wire === null) {
			levels.push({
				id: OFF_LEVEL,
				name: "Off"
			});
			continue;
		}
		if (typeof wire !== "string" || wire.length === 0) continue;
		levels.push({
			id,
			name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`
		});
	}
	if (levels.length === 0) return void 0;
	const hasDefault = typeof defaultLevel === "string" && levels.some((level) => level.id === defaultLevel);
	return {
		efforts: levels.map((level) => ({
			id: ReasoningEffortId(level.id),
			name: level.name
		})),
		...hasDefault ? { defaultEffort: ReasoningEffortId(defaultLevel) } : {}
	};
}
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
var QianfanAdapter = class extends LlmAdapter {
	config;
	/** Effective rate-limit config this adapter is currently pacing with. */
	rateLimiterConfig;
	/** Shared rate limiter – rebuilt lazily whenever `rateLimiterConfig` changes. */
	rateLimiter;
	constructor(config) {
		super();
		this.config = config;
		this.syncRateLimiter();
	}
	/**
	* Re-read the resolved rate-limit config (settings section merged over env)
	* and rebuild the limiter only when it actually changed, so edits made in the
	* plugin's settings card apply without restarting the process.
	*/
	syncRateLimiter() {
		const next = this.config.options().rateLimit;
		if (sameRateLimitConfig(next, this.rateLimiterConfig)) return;
		this.rateLimiterConfig = next;
		this.rateLimiter = next !== void 0 && (next.tpm > 0 || next.rpm > 0) ? new QianfanRateLimiter(next) : null;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Baidu Qianfan"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((m) => modelInfo(provider, m)));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((e) => e.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		const reasoning = reasoningOf(configured, connection.defaultReasoning);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	async *stream(options) {
		const connection = this.config.options();
		const apiKey = await this.config.resolveApiKey(connection);
		const consumer = new AbortController();
		const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
		using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
		const iterator = this.request(options, watchdog.signal, connection, apiKey, () => {
			watchdog.pulse();
		})[Symbol.asyncIterator]();
		let exhausted = false;
		try {
			while (true) {
				const result = await watchdog.next(iterator);
				if (result.done) {
					exhausted = true;
					return;
				}
				yield result.value;
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`Qianfan stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError("Qianfan request aborted by caller", "ABORTED", { cause: error });
			if (error instanceof LlmError) throw error;
			throw new LlmError(`Qianfan API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		} finally {
			consumer.abort("Qianfan stream consumer stopped");
			if (!exhausted && iterator.return !== void 0) try {
				await iterator.return();
			} catch {}
		}
	}
	async *request(options, signal, connection, apiKey, onComment) {
		const configured = connection.models.find((m) => m.id === options.model);
		const hasEffort = options.reasoningEffort !== void 0;
		const body = serializeRequest({
			...options,
			...!hasEffort && configured?.thinking ? { thinking: true } : {}
		}, connection.maxTokens);
		const payload = JSON.stringify(body);
		this.syncRateLimiter();
		if (this.rateLimiter !== null) {
			const estimatedTokens = QianfanRateLimiter.estimateTokens(payload.length, options.maxTokens ?? connection.maxTokens ?? 8192);
			console.error(`[qianfan-rate] acquiring: est=${estimatedTokens} tokens`);
			await this.rateLimiter.acquire(estimatedTokens, signal);
		}
		const headers = {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			accept: "text/event-stream",
			...attributionHeaders()
		};
		const url = `${connection.baseURL}/chat/completions`;
		let response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: payload,
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`Qianfan API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (this.rateLimiter !== null) this.rateLimiter.updateFromHeaders(response.headers);
		if (!response.ok) {
			let message = `Qianfan API error (HTTP ${response.status})`;
			let providerError;
			try {
				const errorBody = await response.text();
				providerError = JSON.parse(errorBody).error;
				if (providerError?.message) message = providerError.message;
			} catch {}
			const qianfanErrorCode = providerError?.code;
			if (response.status === 429 || typeof qianfanErrorCode === "number" && QIANFAN_RATE_LIMIT_CODES.has(qianfanErrorCode)) throw new LlmError(message, "RATE_LIMIT", { status: response.status });
			throw new LlmError(message, httpErrorCode(response.status, providerError), { status: response.status });
		}
		if (!response.body) throw new LlmError("Qianfan API returned no response body", "EMPTY_RESPONSE");
		try {
			let gotChunk = false;
			for await (const chunk of translate(parseSse(response.body, onComment))) {
				gotChunk = true;
				yield JSON.parse(JSON.stringify(chunk));
			}
			if (!gotChunk) throw new LlmError("Qianfan SSE stream ended without any data", "EMPTY_RESPONSE");
		} catch (err) {
			if (err instanceof LlmError) throw err;
			throw new LlmError("Qianfan stream processing failed", "TRANSPORT", { cause: err });
		}
	}
};
//#endregion
//#region src/index.ts
const name = "llm-qianfan";
function loadLocalEnvFile() {
	const result = /* @__PURE__ */ new Map();
	for (const name of [
		".env.qianfan",
		".env.local",
		".env"
	]) {
		const filePath = resolve(process.cwd(), name);
		if (!existsSync(filePath)) continue;
		for (const line of readFileSync(filePath, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx <= 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
			if (key.length > 0 && !result.has(key)) result.set(key, value);
		}
	}
	return result;
}
const localEnv = loadLocalEnvFile();
const inject = ["llm"];
const NS = settingsNamespace("llm-qianfan");
const DEFAULT_API_KEY_ENV = "QIANFAN_API_KEY";
const PROVIDER = "qianfan";
const DEFAULT_MODELS = (() => {
	const envModels = process.env.QIANFAN_MODELS;
	if (envModels) try {
		return JSON.parse(envModels);
	} catch (e) {
		console.warn("Failed to parse QIANFAN_MODELS, using defaults:", e);
	}
	return [];
})();
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	thinking: z.boolean(),
	reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]))])
});
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema,
	reasoning: z.string(),
	rateLimit: z.object({
		tpm: z.number().min(0),
		rpm: z.number().min(0),
		safetyMargin: z.number().min(0).max(1),
		minIntervalMs: z.number().min(0)
	})
});
const PUBLIC_BASE_URL = "https://qianfan.baidubce.com/v2";
const BASE_URL_ENV = "QIANFAN_BASE_URL";
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-qianfan: catalog model ids must be non-empty");
		if (seen.has(model.id)) throw new Error(`llm-qianfan: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return { ...model };
	});
}
function resolveRateLimitFromEnv() {
	const tpm = Number(process.env.QIANFAN_RATE_LIMIT_TPM);
	const rpm = Number(process.env.QIANFAN_RATE_LIMIT_RPM);
	if ((!Number.isFinite(tpm) || tpm <= 0) && (!Number.isFinite(rpm) || rpm <= 0)) return;
	const safetyMargin = Number(process.env.QIANFAN_RATE_LIMIT_SAFETY_MARGIN);
	const minIntervalMs = Number(process.env.QIANFAN_RATE_LIMIT_MIN_INTERVAL_MS);
	return {
		tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : 0,
		rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0,
		safetyMargin: Number.isFinite(safetyMargin) && safetyMargin >= 0 && safetyMargin <= 1 ? safetyMargin : .15,
		minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : 200
	};
}
/**
* ★ 新增：settings 优先、env 兜底的 rateLimit 合并 ★
*
* Per-field precedence: `config.rateLimit` (settings section) > `QIANFAN_RATE_LIMIT_*`
* env vars > documented defaults. `undefined` (limiter disabled) is returned only
* when both effective tpm and rpm end up ≤ 0.
*/
function resolveRateLimit(configured) {
	const env = resolveRateLimitFromEnv();
	const pick = (key) => {
		const fromSettings = configured?.[key];
		if (fromSettings !== void 0) return fromSettings;
		const fromEnv = env?.[key];
		if (fromEnv !== void 0) return fromEnv;
	};
	const tpm = pick("tpm") ?? 0;
	const rpm = pick("rpm") ?? 0;
	if (!(tpm > 0) && !(rpm > 0)) return void 0;
	return {
		tpm: Math.max(0, tpm),
		rpm: Math.max(0, rpm),
		safetyMargin: pick("safetyMargin") ?? .15,
		minIntervalMs: pick("minIntervalMs") ?? 200
	};
}
function resolveAdapterOptions(config, environment) {
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://qianfan.baidubce.com/v2",
		maxTokens: config.maxTokens ?? 8192,
		defaultContextWindow: config.defaultContextWindow ?? 128e3,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-qianfan: retryPolicy"),
		rateLimit: resolveRateLimit(config.rateLimit),
		defaultReasoning: config.reasoning
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-qianfan: keeping last good config after invalid settings");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-qianfan", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-qianfan", ref);
		}
		const localValue = localEnv.get(ref);
		if (localValue !== void 0 && localValue.length > 0) return assertUsableApiKey(localValue, "llm-qianfan", `${ref} (local .env)`);
		throw new LlmError(`llm-qianfan: no API key for "${PROVIDER}"; set ${ref} via credentials, environment, or .env.qianfan`, "MISSING_CREDENTIAL");
	};
	const adapter = new QianfanAdapter({
		options,
		resolveApiKey
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Baidu Qianfan",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PUBLIC_BASE_URL, QianfanAdapter, apply, inject, name, resolveAdapterOptions };
