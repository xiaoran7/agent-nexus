import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { ProjectRegistry } from '../domain/project-registry.js';
import { ProjectMemoryService } from '../domain/memory.js';
import { TopologyService } from '../domain/topology.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';
import { TokenStore, generateToken, getSessionTokenPath } from '../transport/auth.js';

export function startDaemon(options = {}) {
  const port = options.port ?? parseInt(process.env.NEXUS_PORT || '4300', 10);
  const host = options.host ?? process.env.NEXUS_HOST ?? '127.0.0.1';
  const fixedAdminToken = options.adminToken || process.env.NEXUS_ADMIN_TOKEN || null;
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(import.meta.dirname, '../ui/index.html');
  const isRunningInTest = !!(options.isTest || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test');
  const writeSessionToken = options.writeSessionToken ?? (dbPath !== ':memory:' && !isRunningInTest && port === 4300);

  const eventBus = new EventEmitter();
  const db = createDatabase(dbPath);

  const coordinator = new CoordinatorEngine(db, eventBus, {
    isTest: isRunningInTest,
    nodeId: options.nodeId,
    claudeSessionsDir: options.claudeSessionsDir
  });
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  const memoryService = new ProjectMemoryService(db, eventBus);
  const topologyService = new TopologyService(db, eventBus);
  coordinator.topologyService = topologyService;
  const projectRegistry = new ProjectRegistry(db, coordinator, eventBus, null, memoryService);
  projectRegistry.topologyService = topologyService;

  messageService.agentResolver = (agentId) => coordinator.getAgent(agentId);
  coordinator.messageService = messageService;

  // 启动即刻感知本机存量与新会长会话
  try {
    coordinator.syncClaudeSessions();
  } catch {}

  // 毫秒级文件系统目录监视器 (非测试环境下启用)
  const sessionWatcher = isRunningInTest ? null : coordinator.watchClaudeSessions?.();

  const cleanupTimer = setInterval(() => {
    try {
      coordinator.syncClaudeSessions();
    } catch {}
    coordinator.reapDeadAgentLeases();
    coordinator.expireLeases();
    // 每小时最多真正执行一次；放在定时器里，无人打开面板时也会回收过期流水
    coordinator.housekeeping();
    stateService.expireSweep(true);
  }, 3000);
  cleanupTimer.unref();

  const tokenStore = new TokenStore();
  const operator = tokenStore.issue(generateToken(null, fixedAdminToken));
  tokenStore.localOperatorToken = operator.secret;

  const handleRest = createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore, projectRegistry, memoryService, topologyService);
  const server = createServer(handleRest);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  const wss = createWsServer(server, eventBus, tokenStore, coordinator);

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(cleanupTimer);
      coordinator.unwatchClaudeSessions?.();
      db.close();
      reject(describeListenError(err, port, host));
    });
    server.listen(port, host, () => {
      server.removeAllListeners('error');
      const boundPort = server.address().port;
      const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      console.log(`[Agent-Nexus] Daemon listening on http://${host}:${boundPort}`);
      console.log(`[Agent-Nexus] Real-time Dashboard: http://${displayHost}:${boundPort}/`);
      if (projectRegistry.llmConfig?.enabled) {
        const cands = projectRegistry.gatewayRouter?.candidates || [];
        const provs = [...new Set(cands.map(c => c.provider))].join(',') || projectRegistry.llmConfig.provider;
        console.log(`[Agent-Nexus] AI Gateway: ENABLED (strategy=${projectRegistry.gatewayRouter?.strategy || 'smart'}, candidates=${cands.length}, providers=${provs})`);
        console.log(`[Agent-Nexus] AI Project Lead: ENABLED (provider=${projectRegistry.llmConfig.provider}, model=${projectRegistry.llmConfig.model}, endpoint=${projectRegistry.llmConfig.baseUrl})`);
      } else {
        console.log(`[Agent-Nexus] AI Gateway: DISABLED`);
        console.log(`[Agent-Nexus] AI Project Lead: DISABLED (deterministic scheduler only)`);
      }
      if (writeSessionToken) {
        try {
          const tokenPath = getSessionTokenPath();
          const tokenDir = dirname(tokenPath);
          if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });
          writeFileSync(tokenPath, operator.secret, { encoding: 'utf8', mode: 0o600 });
        } catch {}
      }
      console.log(`[Agent-Nexus] Operator token (read + write + mint, active session):`);
      console.log(`  ${operator.secret}`);
      resolve({ server, wss, coordinator, stateService, messageService, projectRegistry, memoryService, topologyService, eventBus, db, tokenStore, cleanupTimer, sessionWatcher, port: boundPort, host, dbPath, writeSessionToken });
    });
  });
}

function describeListenError(err, port, host = '127.0.0.1') {
  if (err.code === 'EADDRINUSE') {
    return new Error(
      `Port ${port} (host: ${host}) is already in use, so the daemon could not start.\n` +
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

export async function stopDaemon({ server, wss, db, cleanupTimer, writeSessionToken }) {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (writeSessionToken) {
    try {
      const tokenPath = getSessionTokenPath();
      if (existsSync(tokenPath)) unlinkSync(tokenPath);
    } catch {}
  }
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  for (const socket of server.closeAllConnections?.() || []) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
