import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { ProjectRegistry } from '../domain/project-registry.js';
import { ProjectMemoryService } from '../domain/memory.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';
import { TokenStore, generateToken, getSessionTokenPath } from '../transport/auth.js';

export function startDaemon(options = {}) {
  const port = options.port ?? parseInt(process.env.NEXUS_PORT || '4100', 10);
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(import.meta.dirname, '../ui/index.html');

  const eventBus = new EventEmitter();
  const db = createDatabase(dbPath);

  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  const memoryService = new ProjectMemoryService(db, eventBus);
  const projectRegistry = new ProjectRegistry(db, coordinator, eventBus, null, memoryService);

  messageService.agentResolver = (agentId) => coordinator.getAgent(agentId);
  coordinator.messageService = messageService;

  const cleanupTimer = setInterval(() => {
    coordinator.expireLeases();
    stateService.expireSweep(true);
  }, 5000);
  cleanupTimer.unref();

  const tokenStore = new TokenStore();
  const operator = tokenStore.issue(generateToken(null));

  const handleRest = createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore, projectRegistry, memoryService);
  const server = createServer(handleRest);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
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
      if (projectRegistry.llmConfig?.enabled) {
        const cands = projectRegistry.gatewayRouter?.candidates || [];
        const provs = [...new Set(cands.map(c => c.provider))].join(',') || projectRegistry.llmConfig.provider;
        console.log(`[Agent-Nexus] AI Gateway: ENABLED (strategy=${projectRegistry.gatewayRouter?.strategy || 'smart'}, candidates=${cands.length}, providers=${provs})`);
        console.log(`[Agent-Nexus] AI Project Lead: ENABLED (provider=${projectRegistry.llmConfig.provider}, model=${projectRegistry.llmConfig.model}, endpoint=${projectRegistry.llmConfig.baseUrl})`);
      } else {
        console.log(`[Agent-Nexus] AI Gateway: DISABLED`);
        console.log(`[Agent-Nexus] AI Project Lead: DISABLED (deterministic scheduler only)`);
      }
      if (dbPath !== ':memory:') {
        try {
          writeFileSync(getSessionTokenPath(), operator.secret, { encoding: 'utf8', mode: 0o600 });
        } catch {}
      }
      console.log(`[Agent-Nexus] Operator token (read + write + mint, active session):`);
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
  try {
    const tokenPath = getSessionTokenPath();
    if (existsSync(tokenPath)) unlinkSync(tokenPath);
  } catch {}
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  for (const socket of server.closeAllConnections?.() || []) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
