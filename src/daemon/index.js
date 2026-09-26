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
  // 用 ?? 而不是 ||：0 是合法端口（让系统分配临时端口），|| 会把它误当成未提供
  // 而回落到 4100，导致第二个实例直接撞端口。
  const port = options.port ?? parseInt(process.env.NEXUS_PORT || '4100', 10);
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const boundPort = server.address().port;
      console.log(`[Agent-Nexus] Daemon listening on http://127.0.0.1:${boundPort}`);
      console.log(`[Agent-Nexus] Real-time Dashboard: http://127.0.0.1:${boundPort}/`);
      resolve({ server, wss, coordinator, stateService, messageService, eventBus, db, port: boundPort });
    });
  });
}

// 关停入口。顺序很关键：先断掉所有已建立的连接，再等 close() 回调。
// node:http 的 server.close() 只停止接受新连接，keep-alive 套接字会一直挂着；
// 而 ws 的 close() 在还有存活连接时同样不返回。先 terminate 掉它们，两边才能干净退出。
export async function stopDaemon({ server, wss, db }) {
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  for (const socket of server.closeAllConnections?.() || []) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
