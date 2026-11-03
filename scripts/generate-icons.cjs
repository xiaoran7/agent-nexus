const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function findBrowserPath() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium-based browser (Edge/Chrome) found for icon rendering');
}

const BROWSER_PATH = findBrowserPath();
const PORT = 9225;
const ASSETS_DIR = path.resolve(__dirname, '..', 'desktop', 'assets');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function createSvgMarkup(type = 'app') {
  let primaryStart = '#38bdf8';
  let primaryEnd = '#2563eb';
  let nodeGlow = '#60a5fa';
  let accentDot = '#ffffff';

  if (type === 'tray-active') {
    primaryStart = '#34d399';
    primaryEnd = '#059669';
    nodeGlow = '#10b981';
  } else if (type === 'tray-busy') {
    primaryStart = '#fbbf24';
    primaryEnd = '#d97706';
    nodeGlow = '#f59e0b';
  } else if (type === 'tray-idle') {
    primaryStart = '#38bdf8';
    primaryEnd = '#0284c7';
    nodeGlow = '#0ea5e9';
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 256 256" fill="none">
      <defs>
        <linearGradient id="nexusMeshGrad" x1="32" y1="36" x2="224" y2="208" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="${primaryStart}" />
          <stop offset="50%" stop-color="${nodeGlow}" />
          <stop offset="100%" stop-color="${primaryEnd}" />
        </linearGradient>
        <linearGradient id="nexusMeshFill" x1="44" y1="36" x2="212" y2="184" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="${primaryStart}" stop-opacity="0.25" />
          <stop offset="100%" stop-color="${primaryEnd}" stop-opacity="0.08" />
        </linearGradient>
        <linearGradient id="nexusCoreGrad" x1="96" y1="92" x2="160" y2="164" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="${primaryStart}" />
          <stop offset="100%" stop-color="${primaryEnd}" />
        </linearGradient>
      </defs>

      <!-- Coordination Mesh Outer Frame (Rounded Equilateral Triangle) -->
      <polygon points="128,36 212,184 44,184"
               stroke="url(#nexusMeshGrad)"
               stroke-width="10"
               stroke-linejoin="round"
               stroke-linecap="round"
               fill="url(#nexusMeshFill)" />

      <!-- Internal Radial Coordination Vectors -->
      <line x1="128" y1="128" x2="128" y2="36" stroke="url(#nexusMeshGrad)" stroke-width="8" stroke-linecap="round" />
      <line x1="128" y1="128" x2="44" y2="184" stroke="url(#nexusMeshGrad)" stroke-width="8" stroke-linecap="round" />
      <line x1="128" y1="128" x2="212" y2="184" stroke="url(#nexusMeshGrad)" stroke-width="8" stroke-linecap="round" />

      <!-- Central Arbiter Core (Faceted Hexagon) -->
      <polygon points="128,92 160,110 160,146 128,164 96,146 96,110"
               fill="url(#nexusCoreGrad)"
               stroke="#ffffff"
               stroke-width="4"
               stroke-linejoin="round" />
      <circle cx="128" cy="128" r="12" fill="${accentDot}" />

      <!-- Satellite Agent Nodes (High-contrast, Transparent-safe) -->
      <!-- Top Satellite Node -->
      <circle cx="128" cy="36" r="18" fill="#0b0f17" stroke="${primaryStart}" stroke-width="7" />
      <circle cx="128" cy="36" r="8" fill="${primaryStart}" />

      <!-- Left Satellite Node -->
      <circle cx="44" cy="184" r="18" fill="#0b0f17" stroke="${nodeGlow}" stroke-width="7" />
      <circle cx="44" cy="184" r="8" fill="${nodeGlow}" />

      <!-- Right Satellite Node -->
      <circle cx="212" cy="184" r="18" fill="#0b0f17" stroke="${primaryEnd}" stroke-width="7" />
      <circle cx="212" cy="184" r="8" fill="${primaryEnd}" />
    </svg>
  `;
}

function createIcoFromPngBuffers(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const item of pngBuffers) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(p => p.buffer)]);
}

async function main() {
  console.log('[Icon Generator] Launching Headless Edge CDP...');
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  const edge = spawn(BROWSER_PATH, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=600,600',
    'about:blank'
  ]);

  await delay(1500);

  let version;
  for (let i = 0; i < 10; i++) {
    try {
      version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await delay(500);
    }
  }

  if (!version || !version.webSocketDebuggerUrl) {
    console.error('Failed to connect to Edge CDP');
    edge.kill();
    process.exit(1);
  }

  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = targets.find(t => t.type === 'page') || targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let idCounter = 1;
  const callbacks = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      if (msg.error) cb.reject(msg.error);
      else cb.resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      callbacks.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  // 核心关键：设置浏览器默认背景为 100% 纯透明（RGBA: 0, 0, 0, 0），防止 Chromium 填充默认不透明白色底板
  await send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  });

  async function renderToBuffer(svgContent, size) {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; display: flex; align-items: center; justify-content: center; }</style></head><body>${svgContent}</body></html>`;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    await send('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false
    });
    // 每次导航前确保透明背景覆盖生效
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 }
    });
    await send('Page.navigate', { url: dataUrl });
    await delay(300);

    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    });
    const buf = Buffer.from(shot.data, 'base64');

    // 严格自检：检查 PNG 色彩类型（ColorType 必须为 6，即 RGBA 带透明 Alpha 通道）
    if (buf[25] !== 6) {
      console.warn(`[Warning] Generated image size ${size}x${size} is not RGBA (colorType=${buf[25]}). Transparency might be compromised!`);
    }

    return buf;
  }

  try {
    const sizes = [256, 128, 64, 48, 32, 16];
    const pngBuffers = [];
    const appSvg = createSvgMarkup('app');

    for (const s of sizes) {
      console.log(`[Icon Generator] Rendering app icon at ${s}x${s}...`);
      const buf = await renderToBuffer(appSvg, s);
      pngBuffers.push({ width: s, height: s, buffer: buf });
      if (s === 256) {
        fs.writeFileSync(path.resolve(ASSETS_DIR, 'icon.png'), buf);
      }
    }

    // Windows ICO 文件
    const icoBuf = createIcoFromPngBuffers(pngBuffers);
    const icoPath = path.resolve(ASSETS_DIR, 'icon.ico');
    fs.writeFileSync(icoPath, icoBuf);
    console.log(`[Icon Generator] Saved icon.ico (${icoBuf.length} bytes) to ${icoPath}`);

    // 托盘图标 (32x32)
    for (const t of ['tray-idle', 'tray-active', 'tray-busy']) {
      console.log(`[Icon Generator] Rendering ${t}...`);
      const svg = createSvgMarkup(t);
      const buf = await renderToBuffer(svg, 32);
      fs.writeFileSync(path.resolve(ASSETS_DIR, `${t}.png`), buf);
    }

    console.log('[Icon Generator] All icons successfully generated.');
  } finally {
    ws.close();
    edge.kill();
  }
}

main().catch(err => {
  console.error('[Icon Generator] Error:', err);
  process.exit(1);
});
