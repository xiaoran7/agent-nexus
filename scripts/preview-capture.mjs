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
const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';

async function capture(url, outName, width = 1440, height = 900) {
  const outFile = path.join(outDir, outName);
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=4000',
      `--screenshot=${outFile}`,
      url
    ];
    console.log(`Capturing ${outName}...`);
    const child = spawn(edgePath, args);
    child.on('close', (code) => {
      console.log(`Finished ${outName} (exit code ${code})`);
      if (fs.existsSync(outFile)) {
        console.log(`Saved screenshot: ${outFile} (${fs.statSync(outFile).size} bytes)`);
        resolve(outFile);
      } else {
        reject(new Error(`Screenshot failed, file not created: ${outFile}`));
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  const proj = 'b7e6c7a3e3b4182e'; // Agent-Nexus project ID
  console.log('Capturing View 3 in Light Theme (Agent-Nexus project)...');
  await capture(`http://127.0.0.1:4300/?token=${encodeURIComponent(token)}&project=${proj}&view=routing&theme=light`, 'routing-view-light.png');

  console.log('Capturing View 3 in Dark Theme (Agent-Nexus project)...');
  await capture(`http://127.0.0.1:4300/?token=${encodeURIComponent(token)}&project=${proj}&view=routing&theme=dark`, 'routing-view-dark.png');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
