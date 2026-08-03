// 冒烟测试：隐藏窗口加载界面，检查 preload 是否注入、按钮是否响应、抓取渲染进程报错
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
try { app.setPath('userData', path.join(__dirname, '.smoke-data')); } catch (e) {}


// 注册桩处理器：冒烟测试不跑主应用，只验证渲染层（preload/脚本/按钮）
function registerStubIpc() {
  const { ipcMain } = require('electron');
  const cfg = { logDir: '', pollMs: 1500, apiDelayMs: 350, autoQueryCurrentMatch: true };
  const handle = (ch, fn) => ipcMain.handle(ch, fn);
  handle('config:get', () => ({ ...cfg }));
  handle('config:set', (e, patch) => Object.assign(cfg, patch));
  handle('config:selectDir', () => null);
  handle('config:detectDir', () => '');
  handle('config:validateDir', () => ({ ok: true, files: 0 }));
  handle('watcher:status', () => ({ dir: '', file: null, listening: false }));
  handle('session:get', () => ({ localName: null, lobbyPlayers: {}, currentDeck: '', current: null, archivedCount: 0 }));
  handle('search:players', () => ({ players: [] }));
  handle('report:player', () => ({ error: 'smoke' }));
  handle('match:queryCurrent', () => true);
  handle('archive:list', () => []);
  handle('archive:clear', () => true);
  handle('deck:paths', () => ({ decks: '', backups: '' }));
  handle('deck:list', () => ({ decks: [], backups: [], decksDir: '(桩)', backupsDir: '(桩)' }));
  handle('deck:backup', () => ({ ok: true, message: 'smoke' }));
  handle('deck:deploy', () => ({ ok: true, message: 'smoke' }));
  handle('deck:delete', () => ({ ok: true, message: 'smoke' }));
  handle('deck:openFolder', () => true);
  handle('shell:open', () => true);
}

app.whenReady().then(async () => {
  registerStubIpc();
  const logs = [];
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', (e, level, message) => {
    logs.push(`[console:${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logs.push(`[fail-load] ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (e, d) => {
    logs.push(`[gone] ${d.reason}`);
  });

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 2000));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const out = { hasApi: typeof window.api !== 'undefined' };
      out.statusText = (document.getElementById('statusText') || {}).textContent;
      out.listenDot = (document.getElementById('listenDot') || {}).className;
      if (window.api) {
        const cfg = await window.api.getConfig().catch((e) => ({ ERR: String(e) }));
        out.config = cfg && cfg.ERR ? cfg.ERR : { logDir: cfg.logDir, pollMs: cfg.pollMs };
        // 点设置
        document.getElementById('btnSettings').click();
        await new Promise((r) => setTimeout(r, 400));
        const modal = document.getElementById('settingsModal');
        out.settingsOpened = !modal.classList.contains('hidden');
        out.setLogDirValue = document.getElementById('setLogDir').value;
        // 点卡组刷新
        const before = document.getElementById('deckFront').options.length;
        document.getElementById('btnDeckRefresh').click();
        await new Promise((r) => setTimeout(r, 600));
        out.deckFrontCount = document.getElementById('deckFront').options.length;
        out.deckPathsText = (document.getElementById('deckPaths') || {}).textContent || '';
        out.deckMsg = (document.getElementById('deckMsg') || {}).textContent || '';
      }
      return out;
    })()`);
    logs.push('RESULT: ' + JSON.stringify(result, null, 1));
  } catch (e) {
    logs.push('SMOKE ERROR: ' + (e && e.stack || e));
  }
  const out = '==== SMOKE OUTPUT ====\n' + logs.join('\n') + '\n';
  console.log(out);
  try { fs.writeFileSync(require('path').join(__dirname, 'smoke-result.txt'), out, 'utf8'); } catch (e) {}
  app.exit(0);
});
