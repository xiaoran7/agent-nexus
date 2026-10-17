import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tokenPath = path.join(os.homedir(), '.agent-nexus', 'session.token');
const token = fs.readFileSync(tokenPath, 'utf8').trim();

async function request(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 4100,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let respData = '';
      res.on('data', chunk => respData += chunk);
      res.on('end', () => resolve(JSON.parse(respData || '{}')));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Registering agents...');
  await request('/api/agents/register', {
    agent_id: 'claude-architect',
    agent_name: 'Claude Architect',
    provider: 'claude-fable',
    project_id: 'default'
  });

  await request('/api/agents/register', {
    agent_id: 'nexus-desktop-dev',
    agent_name: 'Nexus Desktop Specialist',
    provider: 'codex',
    project_id: 'default'
  });

  console.log('Declaring milestone 1...');
  await request('/api/intents/declare', {
    agent_id: 'claude-architect',
    project_id: 'default',
    summary: '重构前端控制台为通透微晶卡片体系与圆润大字系',
    claims: [
      { type: 'file', target: 'src/ui/style.css' },
      { type: 'file', target: 'src/ui/index.html' }
    ],
    ttl_seconds: 600
  });

  await request('/api/hook/git-release', {
    agent_id: 'claude-architect',
    project_id: 'default',
    action: 'commit',
    commit_msg: 'feat(ui): 落地通透无黑框卡片风格与全量SVG矢量替换'
  });

  console.log('Declaring milestone 2...');
  await request('/api/intents/declare', {
    agent_id: 'nexus-desktop-dev',
    project_id: 'default',
    summary: '落地桌面端系统托盘常驻与按时间顺序的功能演进拓扑图',
    claims: [
      { type: 'file', target: 'desktop/main.cjs' },
      { type: 'file', target: 'desktop/daemon-runner.cjs' }
    ],
    ttl_seconds: 600
  });

  await request('/api/hook/git-release', {
    agent_id: 'nexus-desktop-dev',
    project_id: 'default',
    action: 'commit',
    commit_msg: 'feat(desktop): 落地托盘单实例锁与拓扑贝塞尔曲线渲染'
  });

  console.log('Seeding finished successfully.');
}

main().catch(console.error);
