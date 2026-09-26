import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';

export function startDaemon(options = {}) {
  const port = options.port || parseInt(process.env.NEXUS_PORT || '4100', 10);
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(import.meta.dirname, '../ui/index.html');

  const eventBus = new EventEmitter();
  const db = createDatabase(dbPath);

  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);

  // 定期扫描清理过期租约
  const cleanupTimer = setInterval(() => {
    coordinator.expireLeases();
  }, 5000);
  cleanupTimer.unref();

  const handleRest = createRestRouter(coordinator, stateService, messageService, uiPath);
  const server = createServer(handleRest);
  const wss = createWsServer(server, eventBus);

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[Agent-Nexus] Daemon listening on http://127.0.0.1:${port}`);
      console.log(`[Agent-Nexus] Real-time Dashboard: http://127.0.0.1:${port}/`);
      resolve({ server, wss, coordinator, stateService, messageService, eventBus, db });
    });
  });
}
