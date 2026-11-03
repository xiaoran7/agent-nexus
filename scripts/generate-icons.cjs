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
const DESKTOP_ASSETS_DIR = path.resolve(__dirname, '..', 'desktop', 'assets');
const UI_DIR = path.resolve(__dirname, '..', 'src', 'ui');
const MASTER_IMAGE_PATH = path.resolve(DESKTOP_ASSETS_DIR, 'master-icon.jpg');

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
  console.log('[Icon Generator] Checking master image...');
  if (!fs.existsSync(MASTER_IMAGE_PATH)) {
    throw new Error(`Master image not found at ${MASTER_IMAGE_PATH}`);
  }

  const base64Jpg = fs.readFileSync(MASTER_IMAGE_PATH).toString('base64');
  console.log(`[Icon Generator] Master image loaded (${base64Jpg.length} chars base64).`);

  if (!fs.existsSync(DESKTOP_ASSETS_DIR)) fs.mkdirSync(DESKTOP_ASSETS_DIR, { recursive: true });
  if (!fs.existsSync(UI_DIR)) fs.mkdirSync(UI_DIR, { recursive: true });

  console.log('[Icon Generator] Launching Headless Chromium/Edge via CDP...');
  const edge = spawn(BROWSER_PATH, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1200,1200',
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
  await send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  });

  try {
    const renderScript = `
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c1024 = document.createElement('canvas');
          c1024.width = 1024;
          c1024.height = 1024;
          const ctx1024 = c1024.getContext('2d');
          ctx1024.drawImage(img, 0, 0, 1024, 1024);

          const imgData = ctx1024.getImageData(0, 0, 1024, 1024);
          const d = imgData.data;
          const threshold = 246;

          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i+1], b = d[i+2];
            const minChannel = Math.min(r, g, b);
            if (minChannel >= threshold) {
              d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i+3] = 0;
            } else {
              const alphaNorm = 1 - (minChannel / threshold);
              const alpha = Math.min(1, Math.max(0, Math.pow(alphaNorm, 0.85)));
              const unblend = (c) => Math.max(0, Math.min(255, Math.round((c - 255 * (1 - alpha)) / alpha)));
              d[i] = unblend(r);
              d[i+1] = unblend(g);
              d[i+2] = unblend(b);
              d[i+3] = Math.round(alpha * 255);
            }
          }
          ctx1024.putImageData(imgData, 0, 0);

          function renderResized(size, overlay = null) {
            const cvs = document.createElement('canvas');
            cvs.width = size;
            cvs.height = size;
            const ctx = cvs.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(c1024, 0, 0, size, size);

            if (overlay) {
              overlay(ctx, size);
            }
            return cvs.toDataURL('image/png').split(',')[1];
          }

          const out = {};
          for (const s of [256, 128, 64, 48, 32, 16]) {
            out['app_' + s] = renderResized(s);
          }

          out['tray_idle'] = renderResized(32);

          out['tray_active'] = renderResized(32, (ctx, s) => {
            ctx.beginPath();
            ctx.arc(s - 5.5, s - 5.5, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = '#0f172a';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(s - 5.5, s - 5.5, 3.2, 0, Math.PI * 2);
            ctx.fillStyle = '#10b981';
            ctx.fill();
          });

          out['tray_busy'] = renderResized(32, (ctx, s) => {
            ctx.beginPath();
            ctx.arc(s - 5.5, s - 5.5, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = '#0f172a';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(s - 5.5, s - 5.5, 3.2, 0, Math.PI * 2);
            ctx.fillStyle = '#f59e0b';
            ctx.fill();
          });

          resolve(out);
        };
        img.src = 'data:image/jpeg;base64,${base64Jpg}';
      })
    `;

    console.log('[Icon Generator] Extracting pure alpha channel and generating resolutions...');
    const evalRes = await send('Runtime.evaluate', {
      expression: renderScript,
      awaitPromise: true,
      returnByValue: true
    });

    const buffersMap = evalRes.result.value;
    const sizes = [256, 128, 64, 48, 32, 16];
    const pngBuffers = [];

    for (const s of sizes) {
      const b = Buffer.from(buffersMap['app_' + s], 'base64');
      if (b[25] !== 6) {
        console.warn(`[Warning] Generated ${s}x${s} is not RGBA (colorType=${b[25]})`);
      }
      pngBuffers.push({ width: s, height: s, buffer: b });
      console.log(`[Icon Generator] Generated ${s}x${s} transparent PNG (${b.length} bytes)`);
    }

    const png256 = pngBuffers[0].buffer;

    // 1. 保存桌面主图标
    fs.writeFileSync(path.resolve(DESKTOP_ASSETS_DIR, 'icon.png'), png256);
    // 2. 保存 Web 端主图标
    fs.writeFileSync(path.resolve(UI_DIR, 'icon.png'), png256);

    // 3. 打包生成 Windows ICO (桌面与 Web 双份)
    const icoBuf = createIcoFromPngBuffers(pngBuffers);
    fs.writeFileSync(path.resolve(DESKTOP_ASSETS_DIR, 'icon.ico'), icoBuf);
    fs.writeFileSync(path.resolve(UI_DIR, 'favicon.ico'), icoBuf);
    console.log(`[Icon Generator] Saved icon.ico and favicon.ico (${icoBuf.length} bytes)`);

    // 4. 保存托盘图标 (32x32)
    const trayIdle = Buffer.from(buffersMap['tray_idle'], 'base64');
    const trayActive = Buffer.from(buffersMap['tray_active'], 'base64');
    const trayBusy = Buffer.from(buffersMap['tray_busy'], 'base64');

    fs.writeFileSync(path.resolve(DESKTOP_ASSETS_DIR, 'tray-idle.png'), trayIdle);
    fs.writeFileSync(path.resolve(DESKTOP_ASSETS_DIR, 'tray-active.png'), trayActive);
    fs.writeFileSync(path.resolve(DESKTOP_ASSETS_DIR, 'tray-busy.png'), trayBusy);
    console.log('[Icon Generator] Saved tray-idle.png, tray-active.png, tray-busy.png');

    // 5. 生成精美自适应 SVG 图标 (favicon.svg)
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="100%" height="100%">
  <title>Agent-Nexus Emblem</title>
  <image width="256" height="256" href="data:image/png;base64,${buffersMap['app_256']}" />
</svg>
`;
    fs.writeFileSync(path.resolve(UI_DIR, 'favicon.svg'), svgContent, 'utf8');
    console.log('[Icon Generator] Saved favicon.svg');

    console.log('[Icon Generator] All icons successfully generated and saved.');
  } finally {
    ws.close();
    edge.kill();
  }
}

main().catch(err => {
  console.error('[Icon Generator] Error:', err);
  process.exit(1);
});
