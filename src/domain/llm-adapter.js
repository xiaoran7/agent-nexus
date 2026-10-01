import { request } from 'node:https';

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
 * 原生 HTTPS 调用的 Anthropic 适配器，支持官方端点及自定义反代 (如 cpa.tannerlab.xyz)
 */
export class AnthropicAdapter extends LlmAdapter {
  constructor({ apiKey, baseUrl, model = 'claude-3-5-sonnet-latest' }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  }

  async chat(systemPrompt, userMessage) {
    if (!this.apiKey) return null;

    try {
      const url = new URL(this.baseUrl.endsWith('/') ? `${this.baseUrl}messages` : `${this.baseUrl}/messages`);
      const payload = JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      return await new Promise((resolvePromise) => {
        const req = request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01'
          },
          timeout: 10000
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                const text = parsed.content?.[0]?.text || null;
                resolvePromise({ content: text });
              } catch {
                resolvePromise(null);
              }
            } else {
              resolvePromise(null);
            }
          });
        });

        req.on('error', () => resolvePromise(null));
        req.on('timeout', () => {
          req.destroy();
          resolvePromise(null);
        });

        req.write(payload);
        req.end();
      });
    } catch {
      return null;
    }
  }
}
