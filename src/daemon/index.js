import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createDatabase } from '../storage/database.js';
import { CoordinatorEngine } from './coordinator.js';
import { StateService } from '../domain/state.js';
import { MessageService } from '../domain/messages.js';
import { createRestRouter } from '../transport/rest.js';
import { createWsServer } from '../transport/ws.js';
import { TokenStore, generateToken } from '../transport/auth.js';

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

  // 消息的发件人外键由协调器保证：进程内发消息的 agent 必须先注册过。
  // 把解析器交给 MessageService，未知发件人就能变成 400 而不是 SQLite 外键失败。
  messageService.agentResolver = (agentId) => coordinator.getAgent(agentId);

  // 定期扫描清理过期租约
  const cleanupTimer = setInterval(() => {
    coordinator.expireLeases();
  }, 5000);
  cleanupTimer.unref();

  // 认证：没有令牌就不服务 /api/*。令牌在启动时签发、不落盘，重启即轮换。
  // agent 的令牌按需签发——协调库里没有"有哪些 agent"的清单，
  // 只有它们第一次来登记时才发。
  const tokenStore = new TokenStore();
  const operator = tokenStore.issue(generateToken(null));

  const handleRest = createRestRouter(coordinator, stateService, messageService, uiPath, tokenStore);
  const server = createServer(handleRest);
  const wss = createWsServer(server, eventBus, tokenStore);

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      // listen 失败时 db 和清理定时器都已经开着了。抛出前先回收，否则调用方
      // 拿到的是 reject 出来的错误句柄，进程若继续跑（比如测试里换个端口重试）
      // 就会漏掉一个打开的库和一条常驻定时器。
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
      resolve({ server, wss, coordinator, stateService, messageService, eventBus, db, tokenStore, cleanupTimer, port: boundPort });
    });
  });
}

// 启动失败要能直接告诉用户下一步做什么。裸的 EADDRINUSE 只说明"有个东西
// 占着这个端口"，不告诉他是自己上一个实例还是别的程序。
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

// 关停入口。顺序很关键：先断掉所有已建立的连接，再等 close() 回调。
// node:http 的 server.close() 只停止接受新连接，keep-alive 套接字会一直挂着；
// 而 ws 的 close() 在还有存活连接时同样不返回。先 terminate 掉它们，两边才能干净退出。
export async function stopDaemon({ server, wss, db, cleanupTimer }) {
  // 必须先停掉清理定时器，再关库。unref() 只保证它不拖住进程退出，
  // 不会阻止它在进程还活着时照常触发：stopDaemon 关掉 db 之后，下一次
  // expireLeases 就会打进已关闭的库，抛 "database is not open"。
  // 进程还在跑时（测试逐个起停 daemon）这不是噪音，是会污染后续用例的真错误。
  if (cleanupTimer) clearInterval(cleanupTimer);
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  for (const socket of server.closeAllConnections?.() || []) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
