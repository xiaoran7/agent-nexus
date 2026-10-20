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
  let bgGradient = `
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>
  `;
  let strokeColor = '#ffffff';
  let dotColor = '#38bdf8';

  if (type === 'tray-active') {
    bgGradient = `
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#059669" />
        <stop offset="100%" stop-color="#10b981" />
      </linearGradient>
    `;
    dotColor = '#34d399';
  } else if (type === 'tray-busy') {
    bgGradient = `
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#d97706" />
        <stop offset="100%" stop-color="#f59e0b" />
      </linearGradient>
    `;
    dotColor = '#fbbf24';
  } else if (type === 'tray-idle') {
    bgGradient = `
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0369a1" />
        <stop offset="100%" stop-color="#0ea5e9" />
      </linearGradient>
    `;
    dotColor = '#7dd3fc';
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 256 256">
      <defs>
        ${bgGradient}
        <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.3" />
        </filter>
        <filter id="symbolGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.25" />
        </filter>
      </defs>

      <!-- App Icon Background Squircle with Soft Drop Shadow -->
      <rect x="16" y="16" width="224" height="224" rx="52" fill="url(#bgGrad)" filter="url(#shadow)" />

      <!-- Subtle Glossy Inner Highlight Border -->
      <rect x="17.5" y="17.5" width="221" height="221" rx="50.5" fill="none" stroke="rgba(255, 255, 255, 0.4)" stroke-width="3" />

      <!-- Center Logo Mark: 3-Layered Isometric Diamond -->
      <g transform="translate(48, 48) scale(6.666)" filter="url(#symbolGlow)">
        <path d="M12 2L2 7l10 5 10-5-10-5z" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M2 17l10 5 10-5" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M2 12l10 5 10-5" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      </g>

      <!-- Micro geometric decoration (Aozora UI signature) -->
      <circle cx="204" cy="52" r="7" fill="#ffffff" opacity="0.85" />
      <circle cx="204" cy="52" r="3.5" fill="${dotColor}" />
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
