import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('Deliverables', 'preview');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const tokenPath = path.join(os.homedir(), '.agent-nexus', 'session.token');
const token = fs.readFileSync(tokenPath, 'utf8').trim();

async function capture(url, outName) {
  const outFile = path.join(outDir, outName);
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--window-size=1440,960',
      '--virtual-time-budget=3500',
      `--screenshot=${outFile}`,
      url
    ];
    console.log(`Capturing ${outName}...`);
    const child = spawn(edgePath, args);
    child.on('close', (code) => {
      console.log(`Finished ${outName} (exit code ${code})`);
      resolve(outFile);
    });
    child.on('error', reject);
  });
}

async function main() {
  await capture(`http://127.0.0.1:4100/?token=${token}&tab=war-room`, 'war-room.png');
  await capture(`http://127.0.0.1:4100/?token=${token}&tab=topology`, 'topology.png');
  await capture(`http://127.0.0.1:4100/?token=${token}&tab=gateway`, 'gateway.png');
}

main().catch(console.error);
