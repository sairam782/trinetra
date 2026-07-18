const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export function qwenRuntimeConfig(env = process.env) {
  return {
    apiKeyConfigured: Boolean(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY),
    baseUrl: (env.QWEN_API_BASE_URL || defaultBaseUrl).replace(/\/$/, ""),
    timeoutMs: Number(env.QWEN_AGENT_TIMEOUT_MS || 8000),
    retryCount: Number(env.QWEN_AGENT_RETRY_COUNT || 1),
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
  let lastError = null;
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    try {
      const response = await postWithTimeout(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
          ...(typeof onToken === "function" ? {
            stream: true,
            stream_options: { include_usage: true }
          } : {})
        })
      }, config.timeoutMs);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Qwen ${response.status}: ${text.slice(0, 500)}`);
      }

      if (typeof onToken === "function") {
        return await readStreamingJsonResponse({
          response,
          role,
          model,
          system,
          prompt,
          fallback,
          startedAt,
          startedMs,
          onToken
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

async function readStreamingJsonResponse({ response, role, model, system, prompt, fallback, startedAt, startedMs, onToken }) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = null;
  let finishReason = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
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

function parseJsonObject(content) {
  if (!content || typeof content !== "string") return {};
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}
