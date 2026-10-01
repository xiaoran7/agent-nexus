import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { ProjectRegistry } from '../domain/project-registry.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';
import { TokenStore, generateToken } from '../transport/auth.js';

export function startDaemon(options = {}) {
  const port = options.port ?? parseInt(process.env.NEXUS_PORT || '4100', 10);
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(import.meta.dirname, '../ui/index.html');

  const eventBus = new EventEmitter();
  const db = createDatabase(dbPath);

  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  const projectRegistry = new ProjectRegistry(db, coordinator, eventBus);

  messageService.agentResolver = (agentId) => coordinator.getAgent(agentId);

  const cleanupTimer = setInterval(() => {
    coordinator.expireLeases();
  }, 5000);
  cleanupTimer.unref();

  const tokenStore = new TokenStore();
  const operator = tokenStore.issue(generateToken(null));

  const handleRest = createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore, projectRegistry);
  const server = createServer(handleRest);
  const wss = createWsServer(server, eventBus, tokenStore);

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(cleanupTimer);
      db.close();
      reject(describeListenError(err, port));
    });
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      const boundPort = server.address().port;
      console.log(`[Agent-Nexus] Daemon listening on http://127.0.0.1:${boundPort}`);
      console.log(`[Agent-Nexus] Real-time Dashboard: http://127.0.0.1:${boundPort}/`);
      console.log(`[Agent-Nexus] Operator token (read + write + mint, printed once, not stored):`);
      console.log(`  ${operator.secret}`);
      resolve({ server, wss, coordinator, stateService, messageService, projectRegistry, eventBus, db, tokenStore, cleanupTimer, port: boundPort });
    });
  });
}

function describeListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    return new Error(
      `Port ${port} is already in use, so the daemon could not start.\n` +
      `  - If an earlier Agent-Nexus is still running, stop it, or start this one on another port with NEXUS_PORT.\n` +
      `  - Otherwise another program holds the port; pick a free one with NEXUS_PORT.\n` +
      `  - Note: the hook reads NEXUS_PORT from its own environment, so a globally\n` +
      `    installed hook must see the same value or it will not reach this daemon.`
    );
  }
  if (err.code === 'EACCES') {
    return new Error(
      `Not allowed to bind port ${port}. Ports below 1024 need elevated privileges on most systems; choose one above that range with NEXUS_PORT.`
    );
  }
  return err;
}

export async function stopDaemon({ server, wss, db, cleanupTimer }) {
  if (cleanupTimer) clearInterval(cleanupTimer);
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  for (const socket of server.closeAllConnections?.() || []) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
