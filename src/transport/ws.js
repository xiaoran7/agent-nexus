import { WebSocketServer } from 'ws';

export function createWsServer(httpServer, eventBus) {
  const wss = new WebSocketServer({ server: httpServer });

  eventBus.on('timeline:event', (event) => {
    broadcast(wss, { type: 'timeline', data: event });
  });

  eventBus.on('agent:woken', (data) => {
    broadcast(wss, { type: 'agent:woken', data });
  });

  eventBus.on('state:changed', (data) => {
    broadcast(wss, { type: 'state:changed', data });
  });

  eventBus.on('message:sent', (data) => {
    broadcast(wss, { type: 'message:sent', data });
  });

  return wss;
}

function broadcast(wss, payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}
