import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { ProjectRegistry } from '../domain/project-registry.js';
import { ProjectMemoryService } from '../domain/memory.js';
import { ClusterNodeService } from '../domain/cluster-nodes.js';
import { ProjectHandoffService } from '../domain/handoff.js';
import { getSharedCpaGatewayService } from '../domain/cpa-gateway.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';
import { TokenStore, generateToken, getSessionTokenPath, readSessionToken, readHubConfig } from '../transport/auth.js';

export function startDaemon(options = {}) {
  const isRunningInTest = !!(options.isTest || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test');
  const hubConfig = isRunningInTest ? null : readHubConfig();
  const port = options.port ?? parseInt(process.env.NEXUS_PORT || String(hubConfig?.port || '4300'), 10);
  const host = options.host ?? process.env.NEXUS_HOST ?? hubConfig?.host ?? '127.0.0.1';
  const dbPath = options.dbPath || null;
  const uiPath = options.uiPath || join(import.meta.dirname, '../ui/index.html');
  const writeSessionToken = options.writeSessionToken ?? (dbPath !== ':memory:' && !isRunningInTest && port === 4300);
  const fixedAdminToken = options.adminToken || process.env.NEXUS_ADMIN_TOKEN || hubConfig?.adminToken || (writeSessionToken ? readSessionToken() : null) || null;

  const eventBus = new EventEmitter();
  const db = createDatabase(dbPath);

  const coordinator = new CoordinatorEngine(db, eventBus, {
    isTest: isRunningInTest,
    nodeId: options.nodeId,
    claudeSessionsDir: options.claudeSessionsDir
  });
  const memoryService = new ProjectMemoryService(db, eventBus);
  const clusterNodeService = new ClusterNodeService(db, eventBus, coordinator.localNodeId);
  const handoffService = new ProjectHandoffService(db, eventBus);
  coordinator.clusterNodeService = clusterNodeService;
  coordinator.handoffService = handoffService;
  const projectRegistry = new ProjectRegistry(db, coordinator);
  // CPA 网关只读观测：默认关闭于测试环境，避免单测去连宿主机的真实管理端口。
  const cpaGatewayService = options.cpaGatewayService
    ?? (isRunningInTest ? null : getSharedCpaGatewayService());

  try {
    coordinator.syncClaudeSessions();
  } catch {}

  const sessionWatcher = isRunningInTest ? null : coordinator.watchClaudeSessions?.();

  const cleanupTimer = setInterval(() => {
    try {
      coordinator.syncClaudeSessions();
    } catch {}
    clusterNodeService.sweepStaleNodes();
    coordinator.reapDeadAgentLeases();
    coordinator.expireLeases();
    coordinator.housekeeping();
  }, 3000);
  cleanupTimer.unref();

  const tokenStore = new TokenStore();
  const operator = tokenStore.issue(generateToken(null, fixedAdminToken));
  tokenStore.localOperatorToken = operator.secret;

  const handleRest = createRestRouter(coordinator, uiPath, tokenStore, {
    projectRegistry,
    memoryService,
    handoffService,
    clusterNodeService,
    cpaGatewayService
  });
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
      resolve({
        server,
        wss,
        coordinator,
        projectRegistry,
        memoryService,
        clusterNodeService,
        handoffService,
        eventBus,
        db,
        tokenStore,
        cleanupTimer,
        sessionWatcher,
        port: boundPort,
        host,
        dbPath,
        writeSessionToken
      });
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
  if (writeSessionToken && !readHubConfig()?.adminToken) {
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
