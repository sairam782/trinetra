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

export async function qwenChatJson({ role, model, system, prompt, fallback, env = process.env }) {
  const config = qwenRuntimeConfig(env);
  if (!config.apiKeyConfigured || !config.liveEnabled) {
    return {
      ...fallback,
      provider: "local-fallback",
      fallback: config.apiKeyConfigured
        ? "Qwen credentials found, but QWEN_LIVE_CALLS is not true"
        : "Qwen credentials missing; used deterministic local fallback"
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
          response_format: { type: "json_object" }
        })
      }, config.timeoutMs);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Qwen ${response.status}: ${text.slice(0, 500)}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = parseJsonObject(content);
      return {
        ...fallback,
        ...parsed,
        provider: "qwen-live",
        rawModelResponse: content,
        usage: payload.usage || null
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ...fallback,
    provider: "local-fallback",
    fallback: `Qwen ${role} call failed: ${lastError?.message || "unknown error"}`
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
