// 本地 UI 预览：起一个真实的 Hub（内存库、固定令牌、网关观测关闭），
// 只用于在浏览器里核对界面与接口联动，不写磁盘、不占生产端口。
import { startDaemon } from '../src/daemon/index.js';

const port = Number(process.env.NEXUS_PREVIEW_PORT || 4400);
process.env.NEXUS_PORT = String(port);
process.env.NEXUS_HOST = '127.0.0.1';
process.env.NEXUS_ADMIN_TOKEN = 'nexus-preview-token';

const daemon = await startDaemon({
  port,
  host: '127.0.0.1',
  dbPath: ':memory:',
  adminToken: 'nexus-preview-token',
  uiPath: new URL('../src/ui/index.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
});

console.log(`[preview] open http://127.0.0.1:${port}/?token=nexus-preview-token`);

const stop = async () => {
  await daemon.db.close?.();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
