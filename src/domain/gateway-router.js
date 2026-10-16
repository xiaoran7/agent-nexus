import { EventEmitter } from 'node:events';

/**
 * Magpie 启发式错误分类字典与正则引擎
 * 将各厂商及中转的异常精准分类为：credit / quota / rate / server / timeout / auth / other
 */
export const FAILURE_TYPES = {
  CREDIT: 'credit',
  QUOTA: 'quota',
  RATE: 'rate',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  OTHER: 'other'
};

const CREDIT_WORDS = /insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i;
const BROKE_WORDS = /insufficient.?(balance|credit|fund)|\bcredits? (are )?exhausted\b|余额不足|欠费|请充值/i;
const USED_UP_WORDS = /quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限/i;
const RATE_WORDS = /rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁/i;
const PLANNED_WORDS = /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(day|week|month)|daily|weekly|monthly|额度|用量|套餐|限额已用完/i;

/**
 * 默认冷却时长配置（毫秒）
 */
export const DEFAULT_COOLDOWNS_MS = {
  [FAILURE_TYPES.CREDIT]: 24 * 60 * 60 * 1000, // 欠费/余额不足：24 小时（需人工充值）
  [FAILURE_TYPES.QUOTA]: 60 * 60 * 1000,        // 配额用尽但未指定具体重置时间：1 小时
  [FAILURE_TYPES.RATE]: 30 * 1000,              // 短时限频：30 秒
  [FAILURE_TYPES.SERVER]: 15 * 1000,            // 服务端 5xx / 529：基础 15 秒（支持指数退避）
  [FAILURE_TYPES.TIMEOUT]: 15 * 1000,           // 超时：15 秒
  [FAILURE_TYPES.AUTH]: 24 * 60 * 60 * 1000,    // 认证失败：24 小时
  [FAILURE_TYPES.OTHER]: 10 * 1000              // 其他错误：10 秒
};

/**
 * 精准归因错误类型
 */
export function classifyFailure(status, headers = {}, body = '', err = null) {
  if (err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || /timeout|aborted/i.test(err.message || ''))) {
    return FAILURE_TYPES.TIMEOUT;
  }

  const textBody = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');

  // 认证失败
  if (status === 401 || (status === 403 && /invalid_api_key|authentication_error|unauthorized/i.test(textBody))) {
    return FAILURE_TYPES.AUTH;
  }

  // 欠费 / 余额不足
  if (status === 402 || (status === 429 && BROKE_WORDS.test(textBody)) || (status >= 400 && status < 500 && CREDIT_WORDS.test(textBody) && !RATE_WORDS.test(textBody))) {
    return FAILURE_TYPES.CREDIT;
  }

  // 配额耗尽
  if (status === 429 && PLANNED_WORDS.test(textBody) && !RATE_WORDS.test(textBody)) {
    return FAILURE_TYPES.QUOTA;
  }
  if (status === 429 && USED_UP_WORDS.test(textBody) && !RATE_WORDS.test(textBody)) {
    return FAILURE_TYPES.QUOTA;
  }

  // 短时限流
  if (status === 429) {
    return FAILURE_TYPES.RATE;
  }

  // 上游服务故障或超载 (500, 502, 503, 504, 529)
  if (status >= 500 || status === 529) {
    return FAILURE_TYPES.SERVER;
  }

  return FAILURE_TYPES.OTHER;
}

/**
 * 解析重置或重试等待时间（毫秒）
 */
export function resetsIn(headers = {}, body = '', failureType = FAILURE_TYPES.OTHER, consecutiveFailures = 0) {
  const normHeaders = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((v, k) => {
      normHeaders[k.toLowerCase()] = v;
    });
  } else if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      normHeaders[k.toLowerCase()] = String(v);
    }
  }

  // 1. 尝试解析 Retry-After 标头（支持纯数字秒数或 HTTP-Date）
  const retryAfter = normHeaders['retry-after'];
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(Math.max(seconds * 1000, 1000), 24 * 3600 * 1000);
    }
    const dateVal = Date.parse(retryAfter);
    if (!Number.isNaN(dateVal) && dateVal > Date.now()) {
      return Math.min(dateVal - Date.now(), 24 * 3600 * 1000);
    }
  }

  // 2. 尝试解析 Anthropic 与 OpenAI 常见重置标头
  const resetHeaders = [
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens'
  ];
  for (const h of resetHeaders) {
    const val = normHeaders[h];
    if (val) {
      const s = parseFloat(val);
      if (!Number.isNaN(s) && s > 0) {
        // 部分标头是秒数，部分是毫秒或时间戳
        if (s > 10000000000) { // 毫秒级时间戳
          const diff = s - Date.now();
          if (diff > 0) return Math.min(diff, 24 * 3600 * 1000);
        } else if (s > 1000000000) { // 秒级时间戳
          const diff = (s * 1000) - Date.now();
          if (diff > 0) return Math.min(diff, 24 * 3600 * 1000);
        } else {
          return Math.min(s * 1000, 300 * 1000);
        }
      }
    }
  }

  // 3. 从响应体正则匹配重置时间（例如 Claude Code 的 "limit reached|1729000000"）
  const textBody = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const resetsMatch = textBody.match(/limit reached\|(\d{10})/i);
  if (resetsMatch) {
    const unixSec = parseInt(resetsMatch[1], 10);
    const diff = (unixSec * 1000) - Date.now();
    if (diff > 0) {
      return Math.min(diff, 24 * 3600 * 1000);
    }
  }

  // 4. 服务端错误支持简易指数退避（15s, 30s, 45s, 60s）
  if (failureType === FAILURE_TYPES.SERVER) {
    const multiplier = Math.min(consecutiveFailures + 1, 4);
    return DEFAULT_COOLDOWNS_MS[FAILURE_TYPES.SERVER] * multiplier;
  }

  return DEFAULT_COOLDOWNS_MS[failureType] || 15000;
}

/**
 * 候选上游节点实体
 */
export class Candidate {
  constructor({
    id,
    name = null,
    provider = 'anthropic',
    adapter,
    priority = 0,
    weight = 1,
    model = null,
    baseUrl = null
  }) {
    if (!id || !adapter) {
      throw new Error('Candidate requires id and adapter');
    }
    this.id = id;
    this.name = name || id;
    this.provider = provider;
    this.adapter = adapter;
    this.priority = priority;
    this.weight = Number.isFinite(weight) && weight > 0 ? weight : 1;
    this.model = model || adapter.model || 'unknown';
    this.baseUrl = baseUrl || adapter.baseUrl || 'default';

    // 运行态指标
    this.restingUntil = null;
    this.consecutiveFailures = 0;
    this.totalRequests = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.lastUsedAt = null;
    this.lastLatencyMs = 0;
    this.lastFailure = null;
  }

  isResting(now = Date.now()) {
    if (!this.restingUntil) return false;
    if (now >= this.restingUntil) {
      this.restingUntil = null; // 冷却到期自动解除
      return false;
    }
    return true;
  }

  remainingRestMs(now = Date.now()) {
    if (!this.restingUntil || now >= this.restingUntil) return 0;
    return this.restingUntil - now;
  }

  recordSuccess(latencyMs = 0) {
    this.restingUntil = null;
    this.consecutiveFailures = 0;
    this.totalRequests += 1;
    this.successCount += 1;
    this.lastUsedAt = Date.now();
    this.lastLatencyMs = latencyMs;
  }

  recordFailure(failureType, cooldownMs, meta = {}) {
    this.consecutiveFailures += 1;
    this.totalRequests += 1;
    this.failureCount += 1;
    this.lastUsedAt = Date.now();
    this.restingUntil = Date.now() + cooldownMs;
    this.lastFailure = {
      type: failureType,
      cooldownMs,
      timestamp: Date.now(),
      status: meta.status || 0,
      message: meta.message || failureType
    };
  }

  reset() {
    this.restingUntil = null;
    this.consecutiveFailures = 0;
  }

  toSafeJson() {
    const now = Date.now();
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      model: this.model,
      priority: this.priority,
      weight: this.weight,
      baseUrl: this.baseUrl,
      resting: this.isResting(now),
      remainingRestSeconds: Math.ceil(this.remainingRestMs(now) / 1000),
      consecutiveFailures: this.consecutiveFailures,
      totalRequests: this.totalRequests,
      successCount: this.successCount,
      failureCount: this.failureCount,
      lastLatencyMs: this.lastLatencyMs,
      lastFailure: this.lastFailure
    };
  }
}

/**
 * 路由策略：Smart（亲和性优先、Prompt Cache 优化）
 */
export function selectSmart(candidates, { affinityKey = null } = {}) {
  const healthy = candidates.filter(c => !c.isResting());
  if (healthy.length === 0) return [];

  // 如果提供了 affinityKey（如项目 ID），对 healthy 列表进行确定性亲和路由
  if (affinityKey) {
    let hash = 0;
    for (let i = 0; i < affinityKey.length; i++) {
      hash = ((hash << 5) - hash) + affinityKey.charCodeAt(i);
      hash |= 0;
    }
    const primeIdx = Math.abs(hash) % healthy.length;
    return [healthy[primeIdx], ...healthy.filter((_, idx) => idx !== primeIdx)];
  }

  // 默认按优先级升序排序
  return [...healthy].sort((a, b) => a.priority - b.priority);
}

/**
 * 路由策略：Ordered（主备瀑布流）
 */
export function selectOrdered(candidates) {
  return candidates
    .filter(c => !c.isResting())
    .sort((a, b) => a.priority - b.priority);
}

/**
 * 路由策略：Rotate（轮询分发）
 */
export function selectRotate(candidates, state = { turn: 0 }) {
  const healthy = candidates.filter(c => !c.isResting());
  if (healthy.length === 0) return [];
  const offset = state.turn % healthy.length;
  state.turn += 1;
  return [...healthy.slice(offset), ...healthy.slice(0, offset)];
}

/**
 * 路由策略：LeastUsed（最少使用 / 负载均衡）
 */
export function selectLeastUsed(candidates) {
  return candidates
    .filter(c => !c.isResting())
    .sort((a, b) => {
      const loadA = a.totalRequests / a.weight;
      const loadB = b.totalRequests / b.weight;
      if (loadA !== loadB) return loadA - loadB;
      return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
    });
}

/**
 * 统一网关路由器 (GatewayRouter)
 */
export class GatewayRouter extends EventEmitter {
  constructor({ strategy = 'smart', eventBus = null } = {}) {
    super();
    this.strategy = strategy;
    this.eventBus = eventBus;
    this.candidates = [];
    this.rotateState = { turn: 0 };
  }

  addCandidate(config) {
    const candidate = config instanceof Candidate ? config : new Candidate(config);
    this.candidates.push(candidate);
    return candidate;
  }

  getCandidates() {
    return this.candidates.map(c => c.toSafeJson());
  }

  resetCandidate(id) {
    const target = this.candidates.find(c => c.id === id);
    if (target) {
      target.reset();
      return true;
    }
    return false;
  }

  resetAll() {
    let count = 0;
    for (const c of this.candidates) {
      if (c.restingUntil) {
        c.reset();
        count++;
      }
    }
    return count;
  }

  orderCandidates(options = {}) {
    const strat = options.strategy || this.strategy;
    switch (strat) {
      case 'ordered':
        return selectOrdered(this.candidates);
      case 'rotate':
        return selectRotate(this.candidates, this.rotateState);
      case 'least-used':
        return selectLeastUsed(this.candidates);
      case 'smart':
      default:
        return selectSmart(this.candidates, options);
    }
  }

  /**
   * 自动多候选故障转移执行调用
   */
  async routeAndExecute(systemPrompt, userMessage, options = {}) {
    if (this.candidates.length === 0) {
      return null;
    }

    const ordered = this.orderCandidates(options);
    const tries = [];

    // 若全部健康候选者都在休眠，且距离最近解除时间小于 1.2 秒，可短暂等待一次
    if (ordered.length === 0) {
      const earliest = [...this.candidates].sort((a, b) => a.remainingRestMs() - b.remainingRestMs())[0];
      const waitMs = earliest ? earliest.remainingRestMs() : Infinity;
      if (waitMs <= 1200) {
        await new Promise(r => setTimeout(r, waitMs + 10));
        return this.routeAndExecute(systemPrompt, userMessage, options);
      }
      this.emit('gateway:exhausted', { candidates: this.getCandidates() });
      if (this.eventBus) {
        this.eventBus.emit('gateway:exhausted', { timestamp: Date.now() });
      }
      return null;
    }

    for (let i = 0; i < ordered.length; i++) {
      const candidate = ordered[i];
      const start = Date.now();

      try {
        let res = null;
        if (typeof candidate.adapter.chatWithDetails === 'function') {
          res = await candidate.adapter.chatWithDetails(systemPrompt, userMessage);
        } else {
          const raw = await candidate.adapter.chat(systemPrompt, userMessage);
          res = raw ? { ok: true, status: 200, content: raw } : { ok: false, status: 500, error: 'Empty response' };
        }

        const latencyMs = Date.now() - start;

        if (res && res.ok && res.content) {
          candidate.recordSuccess(latencyMs);

          const result = {
            content: res.content,
            candidateId: candidate.id,
            provider: candidate.provider,
            model: candidate.model,
            latencyMs,
            tries: [...tries, { id: candidate.id, success: true, latencyMs }]
          };

          this.emit('gateway:success', result);
          return result;
        }

        // 走到此处表示返回失败（如 HTTP 错误码）
        const status = res ? res.status : 500;
        const headers = res ? res.headers : {};
        const body = res ? res.body : (res?.error || '');
        const failureType = classifyFailure(status, headers, body);
        const cooldownMs = resetsIn(headers, body, failureType, candidate.consecutiveFailures);

        candidate.recordFailure(failureType, cooldownMs, { status, message: typeof body === 'string' ? body.slice(0, 200) : '' });
        tries.push({ id: candidate.id, success: false, failureType, cooldownMs, latencyMs });

        this.emit('gateway:cooldown', {
          candidateId: candidate.id,
          failureType,
          cooldownMs,
          status
        });

        // 尝试下一个候选节点
        continue;
      } catch (err) {
        const latencyMs = Date.now() - start;
        const failureType = classifyFailure(0, {}, '', err);
        const cooldownMs = resetsIn({}, '', failureType, candidate.consecutiveFailures);

        candidate.recordFailure(failureType, cooldownMs, { status: 0, message: err.message });
        tries.push({ id: candidate.id, success: false, failureType, cooldownMs, latencyMs, error: err.message });

        this.emit('gateway:cooldown', {
          candidateId: candidate.id,
          failureType,
          cooldownMs,
          error: err.message
        });
      }
    }

    // 所有候选节点全部尝试失败
    this.emit('gateway:exhausted', { tries, candidates: this.getCandidates() });
    return null;
  }
}
