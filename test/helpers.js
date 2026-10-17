import { EventEmitter } from 'node:events';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { handleMcpTool } from '../src/mcp/server.js';
import { createDatabase } from '../src/storage/database.js';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';
import { generateToken } from '../src/transport/auth.js';

// 每个用例一份内存库与事件总线，避免用例之间通过落库状态互相影响。
export function createHarness() {
  const db = createDatabase(':memory:');
  const eventBus = new EventEmitter();
  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  // 与 daemon 装配一致：发件人外键要靠协调器核实，否则 SQLite 会抛外键失败。
  messageService.agentResolver = (id) => coordinator.getAgent(id);
  coordinator.messageService = messageService;

  return {
    db,
    eventBus,
    coordinator,
    stateService,
    messageService,
    mcp: (toolName, args) => handleMcpTool(toolName, args, { coordinator, stateService, messageService }),
    close: () => db.close()
  };
}

// 记录某个事件的全部触发，返回已捕获的载荷数组和摘除监听的 stop()。
export function capture(eventBus, event) {
  const events = [];
  const listener = (payload) => events.push(payload);
  eventBus.on(event, listener);
  return { events, stop: () => eventBus.off(event, listener) };
}

// 起一个真实的 daemon（HTTP + WebSocket + 独立数据库），走网络栈而不是直接调 domain。
// 端口传 0 让系统分配，避开并行用例抢 4100。close() 负责关库、停 server 和 WS。
export async function startTestDaemon(options = {}) {
  const ctx = await startDaemon({ port: 0, dbPath: ':memory:', ...options });
  const { port } = ctx.server.address();
  const base = `http://127.0.0.1:${port}`;

  // daemon 现在要求令牌。测试默认用 operator 令牌跑（读写都能，除了它没被测的 mint 路径），
  // 让既有用例的语义不变；需要验证 agent 令牌边界的用例显式传自己的。
  const operatorToken = ctx.tokenStore.all().find((t) => !t.agent_id).secret;

  const request = async (path, { method = 'GET', body, headers = {}, token = operatorToken } = {}) => {
    const auth = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...auth,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  return {
    ...ctx,
    base,
    port,
    operatorToken,
    // 换一枚绑定某个 agent 的令牌，用于验证按令牌隔离的行为。
    agentToken: (agentId) => ctx.tokenStore.issue(generateToken(agentId)).secret,
    request,
    close: () => stopDaemon(ctx)
  };
}
