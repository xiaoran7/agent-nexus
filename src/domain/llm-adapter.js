export class LlmAdapter {
  async chat(systemPrompt, userMessage) {
    throw new Error('Not implemented');
  }
}

/**
 * 默认空实现：零成本、零外部依赖，由 Nexus 确定性规则引擎给出精确施工排期
 */
export class NullAdapter extends LlmAdapter {
  async chat() {
    return null;
  }
}

/**
 * 智能规范化 Anthropic messages API 地址：
 * 兼容裸域名、带 /v1、带 /messages、末尾斜杠等常见反代配置
 */
export function formatMessagesUrl(baseUrl = 'https://api.anthropic.com/v1') {
  let raw = (baseUrl || 'https://api.anthropic.com/v1').trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = `https://${raw}`;
  }
  const url = new URL(raw);
  const cleanPath = url.pathname.replace(/\/+$/, '');

  if (cleanPath.endsWith('/messages')) {
    url.pathname = cleanPath;
  } else if (cleanPath.endsWith('/v1')) {
    url.pathname = `${cleanPath}/messages`;
  } else if (cleanPath === '' || cleanPath === '/') {
    url.pathname = '/v1/messages';
  } else {
    url.pathname = `${cleanPath}/v1/messages`;
  }
  return url.toString();
}

/**
 * 解析大模型调度相关环境变量配置
 */
export function parseLlmConfig(env = process.env) {
  const enabledStr = (env.NEXUS_LLM_ENABLED || '').toLowerCase().trim();
  const provider = (env.NEXUS_LLM_PROVIDER || 'anthropic').toLowerCase().trim();
  const apiKey = env.NEXUS_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || null;
  const authToken = env.ANTHROPIC_AUTH_TOKEN || null;
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  const model = env.NEXUS_LLM_MODEL || 'claude-3-5-sonnet-latest';
  const timeoutMs = parseInt(env.NEXUS_LLM_TIMEOUT_MS || '8000', 10);

  // 显式配置优先；未显式配置时，只要有任一 Token/Key 即默认激活
  let enabled = false;
  if (enabledStr === 'true' || enabledStr === '1') {
    enabled = Boolean(apiKey || authToken);
  } else if (enabledStr === 'false' || enabledStr === '0') {
    enabled = false;
  } else {
    enabled = Boolean(apiKey || authToken);
  }

  return {
    enabled,
    provider,
    apiKey,
    authToken,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
  };
}

const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB 响应体积防守上限

/**
 * 生产级 Anthropic 原生适配器：
 * - 采用 Node.js 原生 fetch，天然支持 http:// 与 https://（兼容本地 CPA shim 与云端反代）；
 * - 采用 AbortController 严格控制总超时时间；
 * - 智能组装鉴权标头（x-api-key 与 Authorization: Bearer）；
 * - 任意错误一律静默返回 null，坚决执行降级兜底。
 */
export class AnthropicAdapter extends LlmAdapter {
  constructor({ apiKey = null, authToken = null, baseUrl = 'https://api.anthropic.com/v1', model = 'claude-3-5-sonnet-latest', timeoutMs = 8000 } = {}) {
    super();
    this.apiKey = apiKey;
    this.authToken = authToken;
    this.baseUrl = baseUrl;
    this.endpointUrl = formatMessagesUrl(baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async chat(systemPrompt, userMessage) {
    if (!this.apiKey && !this.authToken) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      };

      if (this.apiKey) {
        if (this.apiKey.startsWith('Bearer ')) {
          headers['authorization'] = this.apiKey;
        } else {
          headers['x-api-key'] = this.apiKey;
        }
      }
      if (this.authToken && !headers['authorization']) {
        headers['authorization'] = `Bearer ${this.authToken}`;
      }

      const payload = JSON.stringify({
        model: this.model,
        max_tokens: 384,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const res = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal
      });

      if (!res.ok) {
        return null;
      }

      // 防御过大响应
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_RESPONSE_BYTES) {
        return null;
      }

      const text = await res.text();
      if (!text || text.length > MAX_RESPONSE_BYTES) {
        return null;
      }

      const data = JSON.parse(text);
      if (!Array.isArray(data.content)) {
        return null;
      }

      const textBlock = data.content.find(b => b && b.type === 'text' && typeof b.text === 'string');
      const content = textBlock?.text?.trim() || null;
      return content ? { content } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
