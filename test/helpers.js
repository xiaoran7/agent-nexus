import { EventEmitter } from 'node:events';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { handleMcpTool } from '../src/mcp/server.js';
import { createDatabase } from '../src/storage/database.js';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';

// 每个用例一份内存库与事件总线，避免用例之间通过落库状态互相影响。
export function createHarness() {
  const db = createDatabase(':memory:');
  const eventBus = new EventEmitter();
  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);

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
export async function startTestDaemon() {
  const ctx = await startDaemon({ port: 0, dbPath: ':memory:' });
  const { port } = ctx.server.address();
  const base = `http://127.0.0.1:${port}`;

  const request = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
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
    request,
    close: () => stopDaemon(ctx)
  };
}
