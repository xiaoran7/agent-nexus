import { WebSocketServer } from 'ws';

export function createWsServer(httpServer, eventBus) {
  const wss = new WebSocketServer({ server: httpServer });

  // ws 订阅了 httpServer 的 'error' 并把同一个 error 转发到 WebSocketServer 上。
  // 自己的 WebSocketServer 一旦再 'error' 而没有监听者，Node 会按未捕获异常
  // 抛出——端口占用这类再常见不过的启动失败因此变成一屏原始堆栈。
  // 挂一个空监听器把转发消化掉，真正的错误由 startDaemon 里的 http server
  // 监听器（server.once('error', ...)）转成可读的启动提示。
  wss.on('error', () => {});

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
