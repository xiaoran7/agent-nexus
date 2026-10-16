export class LlmAdapter {
  async chat(systemPrompt, userMessage, options = {}) {
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
 * 智能规范化 OpenAI chat completions API 地址：
 * 兼容裸域名、带 /v1、带 /chat/completions、末尾斜杠等常见反代配置
 */
export function formatOpenAiUrl(baseUrl = 'https://api.openai.com/v1') {
  let raw = (baseUrl || 'https://api.openai.com/v1').trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = `https://${raw}`;
  }
  const url = new URL(raw);
  const cleanPath = url.pathname.replace(/\/+$/, '');

  if (cleanPath.endsWith('/chat/completions')) {
    url.pathname = cleanPath;
  } else if (cleanPath.endsWith('/v1')) {
    url.pathname = `${cleanPath}/chat/completions`;
  } else if (cleanPath === '' || cleanPath === '/') {
    url.pathname = '/v1/chat/completions';
  } else {
    url.pathname = `${cleanPath}/v1/chat/completions`;
  }
  return url.toString();
}

const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB 响应体积防守上限

/**
 * 生产级 Anthropic 原生适配器：
 * - 采用 Node.js 原生 fetch，天然支持 http:// 与 https://；
 * - 采用 AbortController 严格控制总超时时间；
 * - 智能组装鉴权标头（x-api-key 与 Authorization: Bearer）；
 * - 提供底层 chatWithDetails 接口以便网关路由器实施精准错误归因。
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

  async chatWithDetails(systemPrompt, userMessage) {
    if (!this.apiKey && !this.authToken) {
      return { ok: false, status: 401, error: 'Missing Anthropic API Key or Auth Token' };
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

      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          headers: res.headers,
          body: text,
          error: `HTTP ${res.status}: ${text.slice(0, 150)}`
        };
      }

      if (text.length > MAX_RESPONSE_BYTES) {
        return { ok: false, status: 500, error: 'Response exceeded maximum allowed bytes' };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, status: 500, error: 'Invalid JSON response from Anthropic' };
      }

      if (!Array.isArray(data.content)) {
        return { ok: false, status: 500, error: 'Malformed response content from Anthropic' };
      }

      const textBlock = data.content.find(b => b && b.type === 'text' && typeof b.text === 'string');
      const content = textBlock?.text?.trim() || null;
      return content ? { ok: true, status: 200, content } : { ok: false, status: 500, error: 'No text content found in response' };
    } catch (err) {
      return { ok: false, status: 0, error: err.message, exception: err };
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(systemPrompt, userMessage) {
    const details = await this.chatWithDetails(systemPrompt, userMessage);
    return details && details.ok && details.content ? { content: details.content } : null;
  }
}

/**
 * 生产级 OpenAI / DeepSeek / 兼容网关适配器：
 * - 采用 Node.js 原生 fetch，支持 Bearer 鉴权；
 * - 智能组装 OpenAI Chat Completions 协议；
 * - 支持微秒级超载与错误截断。
 */
export class OpenAiAdapter extends LlmAdapter {
  constructor({ apiKey = null, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini', timeoutMs = 8000 } = {}) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.endpointUrl = formatOpenAiUrl(baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async chatWithDetails(systemPrompt, userMessage) {
    if (!this.apiKey) {
      return { ok: false, status: 401, error: 'Missing OpenAI API Key' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const authHeader = this.apiKey.startsWith('Bearer ') ? this.apiKey : `Bearer ${this.apiKey}`;
      const headers = {
        'content-type': 'application/json',
        'authorization': authHeader
      };

      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: userMessage });

      const payload = JSON.stringify({
        model: this.model,
        max_tokens: 384,
        messages
      });

      const res = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal
      });

      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          headers: res.headers,
          body: text,
          error: `HTTP ${res.status}: ${text.slice(0, 150)}`
        };
      }

      if (text.length > MAX_RESPONSE_BYTES) {
        return { ok: false, status: 500, error: 'Response exceeded maximum allowed bytes' };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, status: 500, error: 'Invalid JSON response from OpenAI' };
      }

      const choice = data.choices && data.choices[0];
      const content = choice?.message?.content?.trim() || null;
      return content ? { ok: true, status: 200, content } : { ok: false, status: 500, error: 'No content in choice message' };
    } catch (err) {
      return { ok: false, status: 0, error: err.message, exception: err };
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(systemPrompt, userMessage) {
    const details = await this.chatWithDetails(systemPrompt, userMessage);
    return details && details.ok && details.content ? { content: details.content } : null;
  }
}

/**
 * 包装 GatewayRouter 的通用 LlmAdapter 实现
 * 供 ProjectLead 及其他业务直接无缝使用
 */
export class GatewayRouterAdapter extends LlmAdapter {
  constructor(gatewayRouter) {
    super();
    this.gatewayRouter = gatewayRouter;
  }

  async chat(systemPrompt, userMessage, options = {}) {
    if (!this.gatewayRouter) {
      return null;
    }
    const result = await this.gatewayRouter.routeAndExecute(systemPrompt, userMessage, options);
    if (!result || !result.content) {
      return null;
    }
    return {
      content: result.content,
      _gateway: {
        candidateId: result.candidateId,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs
      }
    };
  }
}

/**
 * 解析大模型调度与网关路由环境变量配置
 */
export function parseLlmConfig(env = process.env) {
  const enabledStr = (env.NEXUS_LLM_ENABLED || '').toLowerCase().trim();
  const provider = (env.NEXUS_LLM_PROVIDER || 'anthropic').toLowerCase().trim();
  const apiKey = env.NEXUS_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || null;
  const authToken = env.ANTHROPIC_AUTH_TOKEN || null;
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  const model = env.NEXUS_LLM_MODEL || 'claude-3-5-sonnet-latest';
  const timeoutMs = parseInt(env.NEXUS_LLM_TIMEOUT_MS || '8000', 10);

  // OpenAI 相关配置
  const openAiKey = env.NEXUS_OPENAI_API_KEY || env.OPENAI_API_KEY || null;
  const openAiBaseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const openAiModel = env.NEXUS_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini';

  // 网关策略配置
  const strategy = (env.NEXUS_GATEWAY_STRATEGY || 'smart').toLowerCase().trim();

  // 解析显式候选者 JSON
  let explicitCandidates = null;
  if (env.NEXUS_GATEWAY_CANDIDATES) {
    try {
      const parsed = JSON.parse(env.NEXUS_GATEWAY_CANDIDATES);
      if (Array.isArray(parsed) && parsed.length > 0) {
        explicitCandidates = parsed;
      }
    } catch {
      // 畸形配置回退
    }
  }

  const hasAnthropic = Boolean(apiKey || authToken);
  const hasOpenAi = Boolean(openAiKey);

  let enabled = false;
  if (enabledStr === 'true' || enabledStr === '1') {
    enabled = Boolean(hasAnthropic || hasOpenAi || explicitCandidates);
  } else if (enabledStr === 'false' || enabledStr === '0') {
    enabled = false;
  } else {
    enabled = Boolean(hasAnthropic || hasOpenAi || explicitCandidates);
  }

  // 构造候选者列表
  const candidates = [];
  if (explicitCandidates) {
    for (let i = 0; i < explicitCandidates.length; i++) {
      const c = explicitCandidates[i];
      const prov = (c.provider || 'anthropic').toLowerCase();
      let adapter;
      if (prov === 'openai') {
        adapter = new OpenAiAdapter({
          apiKey: c.apiKey || openAiKey,
          baseUrl: c.baseUrl || openAiBaseUrl,
          model: c.model || openAiModel,
          timeoutMs: c.timeoutMs || timeoutMs
        });
      } else {
        adapter = new AnthropicAdapter({
          apiKey: c.apiKey || apiKey,
          authToken: c.authToken || authToken,
          baseUrl: c.baseUrl || baseUrl,
          model: c.model || model,
          timeoutMs: c.timeoutMs || timeoutMs
        });
      }
      candidates.push({
        id: c.id || `candidate-${i + 1}`,
        name: c.name || c.id || `Candidate ${i + 1}`,
        provider: prov,
        adapter,
        priority: Number.isFinite(c.priority) ? c.priority : i,
        weight: Number.isFinite(c.weight) ? c.weight : 1,
        model: adapter.model,
        baseUrl: adapter.baseUrl
      });
    }
  } else {
    // 自动根据配置环境变量组装候选链
    if (hasAnthropic) {
      candidates.push({
        id: 'anthropic-primary',
        name: 'Anthropic Messages',
        provider: 'anthropic',
        adapter: new AnthropicAdapter({
          apiKey,
          authToken,
          baseUrl,
          model,
          timeoutMs
        }),
        priority: 0,
        weight: 1,
        model,
        baseUrl
      });
    }
    if (hasOpenAi) {
      candidates.push({
        id: 'openai-fallback',
        name: 'OpenAI Chat',
        provider: 'openai',
        adapter: new OpenAiAdapter({
          apiKey: openAiKey,
          baseUrl: openAiBaseUrl,
          model: openAiModel,
          timeoutMs
        }),
        priority: hasAnthropic ? 1 : 0,
        weight: 1,
        model: openAiModel,
        baseUrl: openAiBaseUrl
      });
    }
  }

  return {
    enabled,
    provider,
    apiKey,
    authToken,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
    strategy,
    candidates
  };
}
