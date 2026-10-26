import { WebSocketServer } from 'ws';
import { extractQueryToken, verifySecret } from './auth.js';

// 一次推送只算一轮：cockpit 内部已经包含 dashboard 与 collab，
// 过去这里先 getDashboardSnapshot 再 getUnifiedCockpit，把同一批 agent 查询、
// 生命周期判定和拓扑计算全做两遍，然后把几乎相同的数据在同一个帧里发两遍。
// 现在只算一轮，并把帧内重复的 dashboard/collab 剥掉：前端渲染路由图时会用
// 同帧的 snapshot 补回 dashboard（见 app.js 的 init:state 分支），
// 90 会话规模下单个帧因此少发约三分之一。
function buildStatePayload(coordinator, projectId) {
  const { dashboard, collab, ...cockpit } = coordinator.getUnifiedCockpit(projectId);
  return { cockpit, snapshot: dashboard };
}

export function createWsServer(httpServer, eventBus, tokenStore, coordinator = null) {
  const wss = new WebSocketServer({ noServer: true });

  // 在 HTTP upgrade 阶段就拒绝，不要先握手再关。
  // 走到 'connection' 再 close() 的方案有一个真实的窗口：握手已经完成、
  // 客户端拿到 open 事件，广播也可能在这段时间里把它算进接收方。
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const token = verifySecret(tokenStore, extractQueryToken(url));
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 让 daemon 能按连接区分身份（比如只向相关 agent 推定向消息）。
      ws.nexusToken = token;
      wss.emit('connection', ws, req);
    });
  });

  // ws 订阅了 httpServer 的 'error' 并把同一个 error 转发到 WebSocketServer 上。
  // 自己的 WebSocketServer 一旦再 'error' 而没有监听者，Node 会按未捕获异常
  // 抛出——端口占用这类再常见不过的启动失败因此变成一屏原始堆栈。
  // 挂一个空监听器把转发消化掉，真正的错误由 startDaemon 里的 http server
  // 监听器（server.once('error', ...)）转成可读的启动提示。
  wss.on('error', () => {});

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    let initialProjectId = null;
    try {
      if (req?.url) {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        initialProjectId = parsedUrl.searchParams.get('project') || parsedUrl.searchParams.get('project_id');
      }
    } catch {}

    // 全双工长连接连接建立即刻主动下发全景初始化状态 (init:state)
    // 零延迟建立全态势同步，告别原始轮询
    if (coordinator) {
      try {
        const targetPid = initialProjectId || 'all';
        const { cockpit, snapshot } = buildStatePayload(coordinator, targetPid);
        ws.send(JSON.stringify({
          type: 'init:state',
          data: {
            project_id: targetPid,
            snapshot,
            cockpit,
            timestamp: Date.now()
          }
        }), () => {});
      } catch (err) {
        console.error('[Agent-Nexus] Failed to push init:state to WS client:', err);
      }
    }

    // 处理客户端全双工双向交互请求
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }), () => {});
        } else if (msg.type === 'sync:request') {
          if (coordinator) {
            const pid = msg.project_id || 'all';
            const { cockpit, snapshot } = buildStatePayload(coordinator, pid);
            ws.send(JSON.stringify({
              type: 'sync:response',
              data: { project_id: pid, snapshot, cockpit, timestamp: Date.now() }
            }), () => {});
          }
        }
      } catch {}
    });
  });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    });
  }, 30000);
  heartbeatInterval.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  eventBus.on('timeline:event', (event) => {
    broadcast(wss, { type: 'timeline', data: event });
  });

  eventBus.on('agent:woken', (data) => {
    broadcast(wss, { type: 'agent:woken', data });
  });

  eventBus.on('agent:telemetry', (data) => {
    broadcast(wss, { type: 'agent:telemetry', data });
  });

  eventBus.on('agent:status', (data) => {
    broadcast(wss, { type: 'agent:status', data });
  });

  eventBus.on('resource:freed', (data) => {
    broadcast(wss, { type: 'resource:freed', data });
  });

  eventBus.on('state:changed', (data) => {
    broadcast(wss, { type: 'state:changed', data });
  });

  eventBus.on('message:sent', (data) => {
    broadcast(wss, { type: 'message:sent', data });
  });

  eventBus.on('lead:broadcast', (data) => {
    broadcast(wss, { type: 'lead:broadcast', data });
  });

  eventBus.on('lead:awakened', (data) => {
    broadcast(wss, { type: 'lead:awakened', data });
  });

  eventBus.on('agent:progress', (data) => {
    broadcast(wss, { type: 'agent:progress', data });
  });

  eventBus.on('messages:read', (data) => {
    broadcast(wss, { type: 'messages:read', data });
  });

  eventBus.on('memory:saved', (data) => {
    broadcast(wss, { type: 'memory:saved', data });
  });

  eventBus.on('memory:deleted', (data) => {
    broadcast(wss, { type: 'memory:deleted', data });
  });

  eventBus.on('topology:node_created', (data) => {
    broadcast(wss, { type: 'topology:node_created', data });
  });

  return wss;
}

function broadcast(wss, payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message, () => {});
    }
  });
}
