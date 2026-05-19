const { app, BrowserWindow, screen, ipcMain, dialog } = require('electron');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

// LAN IPアドレスを取得
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { execSync } = require('child_process');

let launcherWin = null;
let mainWin     = null;
let displayWin  = null;
let serverProcess = null;
let currentBindIp = null;

const defaultServerPath = path.join(__dirname, '..', 'kakimoni');

function normalizeVersion(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  if (!/^[0-9A-Za-z._-]+$/.test(v)) return null;
  return v;
}

function compareVersions(a, b) {
  const parsePart = (part) => {
    const m = String(part || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const pa = String(a || '0').split(/[._-]/).map(parsePart);
  const pb = String(b || '0').split(/[._-]/).map(parsePart);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function normalizeUpdateChannel(input) {
  const v = String(input || 'client').trim().toLowerCase();
  if (v === 'client' || v === 'host' || v === 'layout') return v;
  return null;
}

function toFileHashSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function toSafeRepo(input) {
  const v = String(input || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return null;
  return v;
}

function githubRequestJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'kakimoni-host-updater',
      'Accept': 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {}
          const apiMessage = parsed && parsed.message ? String(parsed.message) : '';
          if (res.statusCode === 404) {
            return reject(new Error('GitHub Release が見つかりません。初回は Release を作成してください。'));
          }
          return reject(new Error(`GitHub API error ${res.statusCode}${apiMessage ? `: ${apiMessage}` : ''}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`GitHub JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadBinary(url, outputPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'kakimoni-host-updater',
      'Accept': 'application/octet-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadBinary(res.headers.location, outputPath, token));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download error ${res.statusCode}`));
      }

      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(outputPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function publishAppUpdateToServer({ serverPath, sourceExePath, version, notes, channel }) {
  const safeChannel = normalizeUpdateChannel(channel);
  if (!safeChannel) {
    return { ok: false, error: 'channel は client / host / layout を指定してください。' };
  }
  if (!serverPath || !fs.existsSync(path.join(serverPath, 'server.js'))) {
    return { ok: false, error: 'server.js がある kakimoni フォルダを指定してください。' };
  }
  if (!sourceExePath || !fs.existsSync(sourceExePath)) {
    return { ok: false, error: '更新用 .exe ファイルが見つかりません。' };
  }
  if (!version) {
    return { ok: false, error: 'バージョンは英数字・ドット・ハイフンで入力してください。' };
  }

  const updatesDir = path.join(serverPath, 'updates', safeChannel);
  const updatesFilesDir = path.join(updatesDir, 'files');
  fs.mkdirSync(updatesFilesDir, { recursive: true });

  const targetFileName = `kakimoni-${safeChannel}-${version}.exe`;
  const targetPath = path.join(updatesFilesDir, targetFileName);
  fs.copyFileSync(sourceExePath, targetPath);

  const stat = fs.statSync(targetPath);
  const sha256 = toFileHashSha256(targetPath);
  const manifest = {
    channel: safeChannel,
    version,
    fileName: targetFileName,
    size: stat.size,
    sha256,
    notes: String(notes || '').trim(),
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(updatesDir, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    ok: true,
    channel: safeChannel,
    version,
    fileName: targetFileName,
    size: stat.size,
    sha256,
    path: targetPath,
  };
}

// nodeの実行ファイルパスを取得
function getNodePath() {
  try {
    const p = execSync('where node', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    return p;
  } catch {
    return 'node';
  }
}

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    resizable: true,
    title: 'KakiMoni 親機',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  launcherWin.setMenuBarVisibility(false);
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWin.on('closed', () => {
    if (serverProcess) serverProcess.kill();
    app.quit();
  });
}

ipcMain.handle('get-default-path', () => defaultServerPath);
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  return displays.map(d => ({
    id: d.id,
    isPrimary: d.id === primary.id,
    width:  d.bounds.width,
    height: d.bounds.height,
    scaleFactor: d.scaleFactor,
  }));
});

ipcMain.handle('get-interfaces', () => {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address });
      }
    }
  }
  return result;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(launcherWin, {
    properties: ['openDirectory'],
    title: 'kakimoniフォルダ（server.jsがある場所）を選択',
    defaultPath: defaultServerPath,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-update-exe', async () => {
  const result = await dialog.showOpenDialog(launcherWin, {
    properties: ['openFile'],
    title: '子機更新用 .exe を選択',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('publish-client-update', async (event, payload = {}) => {
  try {
    const serverPath = payload.serverPath;
    const sourceExePath = payload.sourceExePath;
    const version = normalizeVersion(payload.version);
    const notes = String(payload.notes || '').trim();
    return publishAppUpdateToServer({ serverPath, sourceExePath, version, notes, channel: 'client' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('publish-app-update', async (event, payload = {}) => {
  try {
    const serverPath = String(payload.serverPath || '').trim();
    const sourceExePath = String(payload.sourceExePath || '').trim();
    const version = normalizeVersion(payload.version);
    const notes = String(payload.notes || '').trim();
    const channel = normalizeUpdateChannel(payload.channel);
    if (!channel) return { ok: false, error: 'channel は client / host / layout を指定してください。' };
    return publishAppUpdateToServer({ serverPath, sourceExePath, version, notes, channel });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function importAppUpdateFromGithubRelease(payload = {}) {
  try {
    const serverPath = String(payload.serverPath || '').trim();
    const repo = toSafeRepo(payload.repo);
    const releaseTag = String(payload.releaseTag || '').trim();
    const token = String(payload.token || '').trim();
    const assetPattern = String(payload.assetPattern || '').trim().toLowerCase();
    const versionOverride = normalizeVersion(payload.versionOverride);
    const notes = String(payload.notes || '').trim();
    const channel = normalizeUpdateChannel(payload.channel || 'client');

    if (!channel) {
      return { ok: false, error: 'channel は client / host / layout を指定してください。' };
    }

    if (!repo) {
      return { ok: false, error: 'repo は owner/repo 形式で入力してください。' };
    }

    const apiUrl = releaseTag
      ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`
      : `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await githubRequestJson(apiUrl, token || null);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exeAssets = assets.filter(a => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe'));
    if (exeAssets.length === 0) {
      return { ok: false, error: 'Releaseに .exe アセットがありません。' };
    }

    let picked = null;
    if (assetPattern) {
      const matched = exeAssets.filter(a => a.name.toLowerCase().includes(assetPattern));
      picked = matched.find(a => /setup/i.test(a.name)) || matched[0] || null;
    }
    if (!picked) picked = exeAssets[0];
    if (!picked.browser_download_url) {
      return { ok: false, error: 'ダウンロードURLを取得できませんでした。' };
    }

    const tempName = `km-release-${Date.now()}-${path.basename(picked.name)}`;
    const tempFilePath = path.join(app.getPath('temp'), tempName);
    await downloadBinary(picked.browser_download_url, tempFilePath, token || null);

    const derivedVersion = versionOverride || normalizeVersion(release.tag_name) || normalizeVersion(release.name);
    if (!derivedVersion) {
      try { fs.unlinkSync(tempFilePath); } catch {}
      return { ok: false, error: 'versionOverride を指定してください。' };
    }

    const publishResult = publishAppUpdateToServer({
      serverPath,
      sourceExePath: tempFilePath,
      version: derivedVersion,
      notes: notes || `GitHub Release: ${release.html_url || ''}`,
      channel,
    });
    try { fs.unlinkSync(tempFilePath); } catch {}

    if (!publishResult.ok) return publishResult;
    return {
      ...publishResult,
      channel,
      repo,
      releaseTag: release.tag_name || '',
      releaseUrl: release.html_url || '',
      assetName: picked.name,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('publish-client-update-from-github-release', async (event, payload = {}) => {
  return importAppUpdateFromGithubRelease({ ...payload, channel: 'client' });
});

ipcMain.handle('publish-app-update-from-github-release', async (event, payload = {}) => {
  return importAppUpdateFromGithubRelease(payload);
});

ipcMain.handle('check-host-self-update-from-github', async (event, payload = {}) => {
  try {
    const repo = toSafeRepo(payload.repo);
    const releaseTag = String(payload.releaseTag || '').trim();
    const token = String(payload.token || '').trim();
    const assetPattern = String(payload.assetPattern || '').trim().toLowerCase();
    const versionOverride = normalizeVersion(payload.versionOverride);

    if (!repo) {
      return { ok: false, error: 'repo は owner/repo 形式で入力してください。' };
    }

    const apiUrl = releaseTag
      ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`
      : `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await githubRequestJson(apiUrl, token || null);

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exeAssets = assets.filter(a => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe'));
    if (exeAssets.length === 0) {
      return { ok: false, error: 'Releaseに .exe アセットがありません。' };
    }

    let picked = null;
    if (assetPattern) picked = exeAssets.find(a => a.name.toLowerCase().includes(assetPattern));
    // 親機自己更新は Setup を最優先にする（Portable は更新適用向きではない）
    if (!picked) picked = exeAssets.find(a => /setup/i.test(a.name));
    if (!picked) picked = exeAssets.find(a => !/portable/i.test(a.name));
    if (!picked) picked = exeAssets[0];
    if (!picked.browser_download_url) {
      return { ok: false, error: 'ダウンロードURLを取得できませんでした。' };
    }

    const latestVersion = versionOverride || normalizeVersion(release.tag_name) || normalizeVersion(release.name);
    if (!latestVersion) {
      return { ok: false, error: 'versionOverride を指定してください。' };
    }

    const currentVersion = app.getVersion();
    const available = compareVersions(latestVersion, currentVersion) > 0;

    return {
      ok: true,
      available,
      currentVersion,
      latestVersion,
      repo,
      releaseTag: release.tag_name || '',
      releaseUrl: release.html_url || '',
      assetName: picked.name,
      downloadUrl: picked.browser_download_url,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('download-host-self-update-from-github', async (event, payload = {}) => {
  try {
    const downloadUrl = String(payload.downloadUrl || '').trim();
    const token = String(payload.token || '').trim();
    const assetName = path.basename(String(payload.assetName || 'kakimoni-host-update.exe'));
    if (!downloadUrl) return { ok: false, error: 'downloadUrl が空です。' };

    const tempName = `km-host-self-${Date.now()}-${assetName}`;
    const tempFilePath = path.join(app.getPath('temp'), tempName);
    await downloadBinary(downloadUrl, tempFilePath, token || null);

    return { ok: true, downloadedPath: tempFilePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply-host-self-update', async (event, payload = {}) => {
  try {
    const downloadedPath = String(payload.downloadedPath || '').trim();
    if (!app.isPackaged) {
      return { ok: false, error: '開発モードでは自己更新を実行できません。' };
    }
    if (!downloadedPath || !fs.existsSync(downloadedPath)) {
      return { ok: false, error: '更新ファイルが見つかりません。' };
    }

    const toPsSingleQuoted = (v) => String(v).replace(/'/g, "''");
    // UACで通常インストーラーを起動し、起動確認できた時だけアプリを終了する
    const launchCmd = [
      "$ErrorActionPreference = 'Stop'",
      `$null = Start-Process -FilePath '${toPsSingleQuoted(downloadedPath)}' -Verb RunAs`,
      'Write-Output OK',
    ].join('; ');
    const launched = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', launchCmd,
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });

    if (launched.status !== 0 || !String(launched.stdout || '').includes('OK')) {
      const errText = String((launched.stderr || launched.stdout || '')).trim();
      return { ok: false, error: errText || 'インストーラーの起動に失敗しました（UACが拒否された可能性があります）。' };
    }

    setTimeout(() => app.quit(), 500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('start-server', (event, { serverPath, port, bindIp }) => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
  currentBindIp = bindIp || null;
  let handledPortConflict = false;

  const nodePath = getNodePath();
  if (launcherWin) launcherWin.webContents.send('server-log', `node: ${nodePath}`);

  serverProcess = spawn(nodePath, ['server.js'], {
    cwd: serverPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KAKIMONI_PORT: String(parseInt(port, 10) || 3000),
      ...(currentBindIp ? { KAKIMONI_IP: currentBindIp } : {}),
    },
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    if (launcherWin) launcherWin.webContents.send('server-log', text);
    // 起動完了メッセージを検出
    if (text.includes('起動完了') || text.includes('KakiMoni')) {
      const ip = currentBindIp || getLanIp();
      if (launcherWin) launcherWin.webContents.send('server-ready', { port, ip });
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('EADDRINUSE')) {
      handledPortConflict = true;
      const p = parseInt(port, 10) || 3000;
      if (launcherWin) {
        launcherWin.webContents.send('server-error',
          `ポート ${p} は既に使用中です。\n` +
          `他で起動中の node server.js を停止するか、別ポートに変更してください。\n` +
          `確認: Get-NetTCPConnection -LocalPort ${p} | Select-Object OwningProcess\n` +
          `停止: Stop-Process -Id <PID> -Force`
        );
      }
      return;
    }
    if (launcherWin) launcherWin.webContents.send('server-log', text);
  });

  serverProcess.on('error', (err) => {
    if (launcherWin) launcherWin.webContents.send('server-error', err.message);
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      if (!handledPortConflict) {
        if (launcherWin) launcherWin.webContents.send('server-error', `プロセス終了 (code ${code})`);
      }
    }
  });
});

function openMainWindow(port, hostPath) {
  const targetUrl = `http://localhost:${port}${hostPath}`;
  if (mainWin) {
    mainWin.loadURL(targetUrl);
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    width: 1280,
    height: 960,
    fullscreen: true,
    title: 'KakiMoni 親機',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'main-preload.js'),
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL(targetUrl);
  mainWin.on('closed', () => { mainWin = null; });
}

ipcMain.on('open-main', (event, { port }) => {
  openMainWindow(port, '/host');
});

ipcMain.on('open-main-v2', (event, { port }) => {
  openMainWindow(port, '/host-v2');
});

ipcMain.on('toggle-display', (event, { port }) => {
  if (displayWin) {
    displayWin.close();
    return;
  }
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const target   = displays.find(d => d.id !== primary.id) || primary;

  displayWin = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    title: 'KakiMoni 親機セカンド',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  displayWin.setMenuBarVisibility(false);
  displayWin.loadURL(`http://localhost:${port}/host-display`);
  displayWin.on('closed', () => {
    displayWin = null;
    if (launcherWin) launcherWin.webContents.send('display-status', false);
  });
  if (launcherWin) launcherWin.webContents.send('display-status', true);
});

ipcMain.handle('quit-app', async (event) => {
  // 親機画面の「ソフト終了」は、送信元ウィンドウのみ閉じる。
  // ランチャーとサーバーは継続稼働させる。
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (senderWin && !senderWin.isDestroyed() && senderWin !== launcherWin) {
    senderWin.close();
  } else if (mainWin && !mainWin.isDestroyed()) {
    mainWin.close();
  }
  return { ok: true };
});

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
