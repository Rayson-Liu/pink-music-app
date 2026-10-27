const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = 'development';

const PORT = process.env.VITE_DEV_PORT || 5173;
const DEV_URL = `http://localhost:${PORT}`;

function checkServerReady(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await checkServerReady(url);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  let viteProcess = null;
  const isReady = await checkServerReady(DEV_URL);

  if (!isReady) {
    console.log(`[dev-electron] Vite 开发服务器未运行，正在启动 Vite (${DEV_URL})...`);
    viteProcess = spawn(/^win/.test(process.platform) ? 'npx.cmd' : 'npx', ['vite', '--port', String(PORT)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: true
    });

    viteProcess.on('error', (err) => {
      console.error('[dev-electron] 启动 Vite 失败:', err);
    });

    const ready = await waitForServer(DEV_URL);
    if (!ready) {
      console.error('[dev-electron] 等待 Vite 服务器启动超时');
      if (viteProcess) viteProcess.kill();
      process.exit(1);
    }
    console.log(`[dev-electron] Vite 开发服务器已就绪！`);
  } else {
    console.log(`[dev-electron] 检测到 Vite 已在 ${DEV_URL} 运行。`);
  }

  console.log('[dev-electron] 正在启动 Electron 客户端...');
  const electronProcess = spawn(
    /^win/.test(process.platform) ? 'npx.cmd' : 'npx',
    ['electron', '.', '--no-sandbox'],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'development'
      }
    }
  );

  electronProcess.on('close', (code) => {
    console.log(`[dev-electron] Electron 客户端已退出 (code: ${code})`);
    if (viteProcess) {
      console.log('[dev-electron] 正在关闭后台 Vite 开发服务器...');
      try {
        if (/^win/.test(process.platform)) {
          spawn('taskkill', ['/pid', viteProcess.pid.toString(), '/f', '/t']);
        } else {
          viteProcess.kill('SIGTERM');
        }
      } catch (_) {}
    }
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('[dev-electron] 异常:', err);
  process.exit(1);
});
