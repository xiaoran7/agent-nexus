const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { packager } = require('@electron/packager');

const ROOT_DIR = path.resolve(__dirname, '..');
const DELIVERABLES_DIR = path.resolve(ROOT_DIR, '..', '..', 'Deliverables', 'Agent-Nexus');
const TEMP_BUILD_DIR = path.resolve(ROOT_DIR, '.build-temp');

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  console.log('====================================================');
  console.log('   Agent-Nexus Windows EXE 打包构建工具');
  console.log('====================================================');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version || '0.2.6';
  console.log(`[Build] Target Version: ${version}`);

  // 1. 确保图标存在，若无则先生成
  const iconPath = path.resolve(ROOT_DIR, 'desktop', 'assets', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.log('[Build] Icon file not found. Running generate-icons...');
    execSync('node scripts/generate-icons.cjs', { stdio: 'inherit', cwd: ROOT_DIR });
  }

  // 2. 准备临时构建环境
  if (fs.existsSync(TEMP_BUILD_DIR)) {
    fs.rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_BUILD_DIR, { recursive: true });

  const appStagingDir = path.join(TEMP_BUILD_DIR, 'app');
  fs.mkdirSync(appStagingDir, { recursive: true });

  console.log('[Build] Staging application source files...');
  // 拷贝核心业务源码
  copyRecursiveSync(path.join(ROOT_DIR, 'src'), path.join(appStagingDir, 'src'));
  copyRecursiveSync(path.join(ROOT_DIR, 'desktop'), path.join(appStagingDir, 'desktop'));

  // 拷贝必需的生产依赖
  const nodeModulesTarget = path.join(appStagingDir, 'node_modules');
  fs.mkdirSync(nodeModulesTarget, { recursive: true });
  if (fs.existsSync(path.join(ROOT_DIR, 'node_modules', 'ws'))) {
    copyRecursiveSync(path.join(ROOT_DIR, 'node_modules', 'ws'), path.join(nodeModulesTarget, 'ws'));
  }

  // 写入面向 Desktop 的 package.json
  const desktopPkg = {
    name: 'agent-nexus',
    version: version,
    type: 'module',
    description: pkg.description,
    main: 'desktop/main.cjs',
    author: 'tangwg',
    license: 'MIT'
  };
  fs.writeFileSync(path.join(appStagingDir, 'package.json'), JSON.stringify(desktopPkg, null, 2), 'utf8');

  console.log('[Build] Running @electron/packager for win32 x64...');
  const appPaths = await packager({
    dir: appStagingDir,
    out: TEMP_BUILD_DIR,
    name: 'Agent-Nexus',
    executableName: 'Agent-Nexus',
    platform: 'win32',
    arch: 'x64',
    icon: iconPath,
    appVersion: version,
    appCopyright: 'Copyright (c) 2026 WANGUI TANG',
    overwrite: true,
    asar: false,
    win32metadata: {
      CompanyName: 'TannerLab',
      FileDescription: 'Agent-Nexus Multi-Agent Coordinator & Dashboard',
      OriginalFilename: 'Agent-Nexus.exe',
      ProductName: 'Agent-Nexus',
      InternalName: 'Agent-Nexus'
    }
  });

  const outputFolder = appPaths[0];
  console.log(`[Build] Package generated successfully at: ${outputFolder}`);

  // 3. 产物归档与存储铁律：唯一归档目录为 Deliverables/Agent-Nexus/，打新包必删旧包
  console.log(`[Build] Archiving to Deliverables: ${DELIVERABLES_DIR}`);
  if (!fs.existsSync(DELIVERABLES_DIR)) {
    fs.mkdirSync(DELIVERABLES_DIR, { recursive: true });
  }

  // 删除历史旧版本
  const existingFiles = fs.readdirSync(DELIVERABLES_DIR);
  for (const f of existingFiles) {
    const fullPath = path.join(DELIVERABLES_DIR, f);
    console.log(`[Build] Cleaning old deliverable: ${f}`);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }

  const finalAppDir = path.join(DELIVERABLES_DIR, `Agent-Nexus-v${version}-win32-x64`);
  copyRecursiveSync(outputFolder, finalAppDir);
  console.log(`[Build] Staged release folder: ${finalAppDir}`);

  // 压缩为 zip 归档
  const zipName = `Agent-Nexus-v${version}-win32-x64.zip`;
  const zipPath = path.join(DELIVERABLES_DIR, zipName);
  console.log(`[Build] Compressing deliverable to ${zipName}...`);
  try {
    execSync(`powershell -Command "Compress-Archive -Path '${finalAppDir}\\*' -DestinationPath '${zipPath}' -Force"`, {
      stdio: 'inherit'
    });
    console.log(`[Build] Created release archive: ${zipPath}`);
  } catch (err) {
    console.warn('[Build] Warning: Compress-Archive failed, release folder is still intact.', err.message);
  }

  // 4. 清理临时构建目录
  fs.rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
  console.log('====================================================');
  console.log('   Agent-Nexus 打包完成！');
  console.log(`   主执行程序: ${path.join(finalAppDir, 'Agent-Nexus.exe')}`);
  console.log(`   分发压缩包: ${zipPath}`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('[Build] Packaging failed:', err);
  process.exit(1);
});
