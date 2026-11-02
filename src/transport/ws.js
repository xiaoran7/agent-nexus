import { WebSocketServer } from 'ws';
import { extractQueryToken, verifySecret } from './auth.js';

function buildStatePayload(coordinator, projectId) {
  const { dashboard, collab, ...cockpit } = coordinator.getUnifiedCockpit(projectId);
  return { cockpit, snapshot: dashboard };
}

export function createWsServer(httpServer, eventBus, tokenStore, coordinator = null) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const token = verifySecret(tokenStore, extractQueryToken(url));
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.nexusToken = token;
      wss.emit('connection', ws, req);
    });
  });

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

  const forwardedEvents = [
    ['timeline:event', 'timeline'],
    ['agent:woken', 'agent:woken'],
    ['agent:telemetry', 'agent:telemetry'],
    ['agent:status', 'agent:status'],
    ['resource:freed', 'resource:freed'],
    ['memory:saved', 'memory:saved'],
    ['memory:deleted', 'memory:deleted'],
    ['handoff:created', 'handoff:created'],
    ['handoff:consumed', 'handoff:consumed'],
    ['node:status', 'node:status']
  ];

  for (const [busEvent, wsType] of forwardedEvents) {
    eventBus.on(busEvent, (data) => {
      broadcast(wss, { type: wsType, data });
    });
  }

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
