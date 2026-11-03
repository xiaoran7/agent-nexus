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

// 预览专用的派发树样例：让界面在有真实形状的数据上被核对一次。
// 只写进内存库，不落盘；生产环境的数据只来自 SubagentStart / SubagentStop。
const now = Date.now();
const seed = (agentId, extra) => daemon.coordinator.recordAgentSpawn({
  agentId,
  sessionId: 'preview-session-0001',
  hostId: daemon.coordinator.localNodeId,
  projectId: 'default',
  ...extra
});
seed('a1f4c2e9', { agentType: 'Explore', description: '查看数据库结构与迁移约定', model: 'sonnet', runInBackground: true, at: now - 184_000 });
seed('b7d1e803', { agentType: 'Plan', description: '设计子代理派发树的接线方案', model: 'opus', at: now - 121_000 });
seed('c3a9f15d', { agentType: 'Explore', description: '排查嵌套派发的父级关联字段', parentAgentId: 'b7d1e803', spawnDepth: 2, at: now - 96_000 });
seed('d8e2b470', { agentType: 'general-purpose', description: '补充派发树接口的单元测试', runInBackground: true, at: now - 47_000 });
daemon.coordinator.recordAgentStop({ agentId: 'c3a9f15d', sessionId: 'preview-session-0001', hostId: daemon.coordinator.localNodeId, at: now - 12_000 });
daemon.coordinator.touchAgentSpawn({ agentId: 'a1f4c2e9', sessionId: 'preview-session-0001', toolName: 'Read', toolTarget: 'src/storage/database.js' });
daemon.coordinator.touchAgentSpawn({ agentId: 'd8e2b470', sessionId: 'preview-session-0001', toolName: 'Bash', toolTarget: 'npm test' });

const stop = async () => {
  await daemon.db.close?.();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
