import { EventEmitter } from 'node:events';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { handleMcpTool } from '../src/mcp/server.js';
import { createDatabase } from '../src/storage/database.js';

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
