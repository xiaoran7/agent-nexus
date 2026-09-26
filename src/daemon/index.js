import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';

export function startDaemon(options = {}) {
  const port = options.port || parseInt(process.env.NEXUS_PORT || '4100', 10);
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(process.cwd(), 'src/ui/index.html');

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

// 跨平台直接启动检测
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('daemon/index.js') ||
  process.argv[1].endsWith('daemon\index.js') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isDirectRun) {
  startDaemon();
}
