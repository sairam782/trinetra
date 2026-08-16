const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const defaultTimeoutMs = 8000;
const defaultRetryCount = 1;
const defaultStreamIdleTimeoutMs = 15000;
const defaultMaxOutputTokens = 1024;

function parseFiniteNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function qwenRuntimeConfig(env = process.env) {
  return {
    apiKeyConfigured: Boolean(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY),
    baseUrl: (env.QWEN_API_BASE_URL || defaultBaseUrl).replace(/\/$/, ""),
    timeoutMs: parseFiniteNumber(env.QWEN_AGENT_TIMEOUT_MS, defaultTimeoutMs),
    retryCount: Math.max(0, parseFiniteNumber(env.QWEN_AGENT_RETRY_COUNT, defaultRetryCount)),
    streamIdleTimeoutMs: parseFiniteNumber(env.QWEN_STREAM_IDLE_TIMEOUT_MS, defaultStreamIdleTimeoutMs),
    maxOutputTokens: parseFiniteNumber(env.QWEN_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens),
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
        const text = await response.text();
        throw new Error(`Qwen ${response.status}: ${text.slice(0, 500)}`);
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

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = parseJsonObject(content);
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
  }

  if (idleAborted) {
    throw new Error(`Qwen streaming response idle for ${idleTimeoutMs}ms`);
  }

  const parsed = parseJsonObject(content);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonObject(content) {
  if (!content || typeof content !== "string") return {};
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to bracket scan
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
  return {};
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
