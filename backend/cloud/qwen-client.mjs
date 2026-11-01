const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const defaultTimeoutMs = 8000;
const defaultRetryCount = 1;
const defaultStreamIdleTimeoutMs = 15000;
const defaultMaxOutputTokens = 1024;

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function qwenRuntimeConfig(env = process.env) {
  return {
    apiKeyConfigured: Boolean(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY),
    baseUrl: (env.QWEN_API_BASE_URL || defaultBaseUrl).replace(/\/$/, ""),
    timeoutMs: boundedInteger(env.QWEN_AGENT_TIMEOUT_MS, defaultTimeoutMs, 100, 120000),
    retryCount: boundedInteger(env.QWEN_AGENT_RETRY_COUNT, defaultRetryCount, 0, 3),
    streamIdleTimeoutMs: boundedInteger(env.QWEN_STREAM_IDLE_TIMEOUT_MS, defaultStreamIdleTimeoutMs, 100, 120000),
    maxOutputTokens: boundedInteger(env.QWEN_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens, 1, 16384),
    liveEnabled: env.QWEN_LIVE_CALLS === "true"
  };
}

export async function qwenChatJson({ role, model, system, prompt, fallback, env = process.env, onToken = null }) {
  const config = qwenRuntimeConfig(env);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  if (!config.apiKeyConfigured || !config.liveEnabled) {
    return {
      ...fallback,
      provider: "local-fallback",
      fallback: config.apiKeyConfigured
        ? "Qwen credentials found, but QWEN_LIVE_CALLS is not true"
        : "Qwen credentials missing; used deterministic local fallback",
      qwenCall: {
        role,
        model,
        provider: "local-fallback",
        systemPrompt: system,
        userPrompt: prompt,
        rawResponse: null,
        parsedResponse: fallback,
        usage: null,
        finishReason: null,
        timestamp: startedAt,
        latencyMs: Date.now() - startedMs,
        error: config.apiKeyConfigured
          ? "Qwen credentials found, but QWEN_LIVE_CALLS is not true"
          : "Qwen credentials missing; used deterministic local fallback"
      }
    };
  }

  const apiKey = env.QWEN_API_KEY || env.DASHSCOPE_API_KEY;
  const streamingRequested = typeof onToken === "function";
  let lastError = null;
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    if (attempt > 0) {
      const backoffMs = Math.min(2000, 250 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    try {
      const requestBody = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: config.maxOutputTokens,
        ...(streamingRequested ? {
          stream: true,
          stream_options: { include_usage: true }
        } : {})
      };
      const response = await postWithTimeout(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }, config.timeoutMs);

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Qwen provider returned HTTP ${response.status}`);
      }

      if (streamingRequested) {
        return await readStreamingJsonResponse({
          response,
          role,
          model,
          system,
          prompt,
          fallback,
          startedAt,
          startedMs,
          onToken,
          idleTimeoutMs: config.streamIdleTimeoutMs
        });
      }

      const payload = JSON.parse(await readBoundedBody(response));
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = validateModelOutput(parseJsonObject(content), fallback);
      const finishReason = payload?.choices?.[0]?.finish_reason || null;
      const usage = payload.usage || null;
      return {
        ...fallback,
        ...parsed,
        provider: "qwen-live",
        rawModelResponse: content,
        usage,
        finishReason,
        qwenCall: {
          role,
          model,
          provider: "qwen-live",
          systemPrompt: system,
          userPrompt: prompt,
          rawResponse: content,
          parsedResponse: parsed,
          usage,
          finishReason,
          timestamp: startedAt,
          latencyMs: Date.now() - startedMs,
          error: null
        }
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ...fallback,
    provider: "local-fallback",
    fallback: `Qwen ${role} call failed: ${lastError?.message || "unknown error"}`,
    qwenCall: {
      role,
      model,
      provider: "local-fallback",
      systemPrompt: system,
      userPrompt: prompt,
      rawResponse: null,
      parsedResponse: fallback,
      usage: null,
      finishReason: null,
      timestamp: startedAt,
      latencyMs: Date.now() - startedMs,
      error: `Qwen ${role} call failed: ${lastError?.message || "unknown error"}`
    }
  };
}

async function readStreamingJsonResponse({ response, role, model, system, prompt, fallback, startedAt, startedMs, onToken, idleTimeoutMs }) {
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  let content = "";
  let usage = null;
  let finishReason = null;

  const reader = response.body.getReader();
  let idleTimer = null;
  let idleAborted = false;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAborted = true;
      reader.cancel(new Error(`stream idle for ${idleTimeoutMs}ms`)).catch(() => {});
    }, idleTimeoutMs);
  };

  try {
    resetIdleTimer();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer();
      receivedBytes += value.byteLength;
      if (receivedBytes > 1024 * 1024) throw new Error("Qwen response exceeds 1 MiB");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let payload = null;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (payload.usage) usage = payload.usage;
        const choice = payload.choices?.[0] || null;
        const delta = choice?.delta?.content || choice?.message?.content || "";
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (delta) {
          content += delta;
          onToken(delta, {
            role,
            model,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (idleAborted) {
    throw new Error(`Qwen streaming response idle for ${idleTimeoutMs}ms`);
  }

  const parsed = validateModelOutput(parseJsonObject(content), fallback);
  return {
    ...fallback,
    ...parsed,
    provider: "qwen-live",
    rawModelResponse: content,
    usage,
    finishReason,
    qwenCall: {
      role,
      model,
      provider: "qwen-live",
      systemPrompt: system,
      userPrompt: prompt,
      rawResponse: content,
      parsedResponse: parsed,
      usage,
      finishReason,
      timestamp: startedAt,
      latencyMs: Date.now() - startedMs,
      error: null
    }
  };
}

async function postWithTimeout(url, options, timeoutMs) {
  // The abort signal stays alive until the response body has been consumed.
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
}

async function readBoundedBody(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error("Qwen response exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateModelOutput(parsed, fallback) {
  // Only model-owned fields with the expected top-level shape may override policy output.
  const output = {};
  for (const [key, expected] of Object.entries(fallback)) {
    if (["mcp", "agent", "cost"].includes(key)) continue;
    const value = parsed[key];
    if (value === undefined) continue;
    if (expected !== null && (typeof value !== typeof expected || Array.isArray(value) !== Array.isArray(expected) || value === null)) throw new Error(`Invalid Qwen field: ${key}`);
    if (typeof value === "number" && (!Number.isFinite(value) || (key === "confidence" && (value < 0 || value > 1)))) throw new Error(`Invalid Qwen field: ${key}`);
    output[key] = value;
  }
  if (!Object.keys(output).length) throw new Error("Qwen response contains no recognized fields");
  return output;
}

export function parseJsonObject(content) {
  if (!content || typeof content !== "string") throw new Error("Qwen response is empty");
  let direct;
  try { direct = JSON.parse(content); } catch { /* Try a fenced JSON object below. */ }
  if (direct !== undefined) {
    if (!direct || typeof direct !== "object" || Array.isArray(direct)) throw new Error("Qwen response must be a JSON object");
    return direct;
  }
  const candidates = extractJsonCandidates(content);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Qwen response must contain a valid JSON object");
}

function extractJsonCandidates(content) {
  const candidates = [];
  const stack = [];
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (!stack.length) start = i;
      stack.push(ch);
    } else if (ch === "}") {
      stack.pop();
      if (!stack.length && start !== -1) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}
