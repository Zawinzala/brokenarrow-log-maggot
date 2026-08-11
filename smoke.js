// 冒烟测试：隐藏窗口加载界面，检查 preload 是否注入、按钮是否响应、抓取渲染进程报错
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
try { app.setPath('userData', path.join(__dirname, '.smoke-data')); } catch (e) {}


// 注册桩处理器：冒烟测试不跑主应用，只验证渲染层（preload/脚本/按钮）
function registerStubIpc() {
  const { ipcMain } = require('electron');
  const cfg = { logDir: '', pollMs: 1500, apiDelayMs: 350, autoQueryCurrentMatch: true, inputHookEnabled: false, replayEnabled: false, replayServerUrl: '', replaySecret: '', replayQuality: 720 };
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
  handle('deck:list', () => ({ decks: [], backups: [], sync: [], decksDir: '(桩)', backupsDir: '(桩)', syncDir: '(桩)', found: false }));
  handle('deck:backup', () => ({ ok: true, message: 'smoke' }));
  handle('deck:deploy', () => ({ ok: true, message: 'smoke' }));
  handle('deck:delete', () => ({ ok: true, message: 'smoke' }));
  handle('deck:syncRestore', () => ({ ok: true, message: 'smoke' }));
  handle('deck:syncIgnore', () => ({ ok: true, message: 'smoke' }));
  handle('deck:syncDismiss', () => ({ ok: true, message: 'smoke' }));
  handle('deck:openFolder', () => true);
  handle('usage:get', () => ({ used24h: 0, limit24h: 120, calls: 0 }));
  handle('heartbeat:get', () => null);
  handle('api:health', () => ({ state: 'ok', checks: [{ path: '/api/units', label: '单位库', ok: true, ms: 80 }], at: Date.now(), okCount: 4, total: 4 }));
  handle('heartbeat:ping', () => null);
  handle('app:version', () => null);
  handle('report:maggot', () => ({ error: 'smoke' }));
  handle('match:queryRoster', () => true);
  handle('tracker:profile', () => ({ id: '0', player: null, stats: {}, encounters: [], nameHistory: [], banned: false, banInfo: null, info: null }));
  handle('tracker:getBans', () => ({ list: [], lastSync: 0 }));
  handle('tracker:syncBans', () => ({ list: [], lastSync: 0 }));
  handle('tracker:matches', () => ({
    list: [
      { fid: '8049993', map: 'Ignalina Powerplant', endTime: Date.now() - 86400000, durationSec: 2700, localWon: false, winnerTeam: null, custom: false, mode: 'ranked', localSpectator: false, localEloDelta: -16.5, localEloAfter: 2555.5225, localScores: { destruction: 5855, losses: 6840, objectives: 4 }, localPersona: 'Zola', localName: 'Zola', playerCount: 10 },
      { fid: '8028345', map: 'Airport', endTime: Date.now() - 172800000, durationSec: 2700, localWon: null, winnerTeam: 1, custom: true, mode: 'custom', localSpectator: true, localEloDelta: null, localScores: null, localPersona: 'Zola', localName: 'Zola', playerCount: 14 },
      { fid: '8026925', map: 'Baltiisk', endTime: Date.now() - 259200000, durationSec: 2699, localWon: true, winnerTeam: null, custom: true, mode: 'custom', localSpectator: false, localEloDelta: null, localScores: { destruction: 7690, losses: 5870, objectives: 6 }, localPersona: '公安九课', localName: 'Zola', playerCount: 13 }
    ]
  }));
  handle('tracker:refreshMatch', () => ({ ok: true, message: '已刷新对局信息' }));
  handle('tracker:matchDetail', (e, fid) => ({
    fid, map: 'Ignalina Powerplant', mapId: 22, endTime: Date.now() - 86400000, durationSec: 2700,
    localWon: false, winnerTeam: 1, localTeam: 'Bravo', localTeamId: 1, localSpectator: false, localEloDelta: -16.5,
    localScores: { destruction: 5855, losses: 6840, objectives: 4 }, localPersona: 'Zola', localName: 'Zola', custom: false, mode: 'ranked', fetched: false,
    players: [
      { id: '8863', name: 'Zola', team: 'Bravo', teamId: 1, oldRating: 2571.987, newRating: 2555.5225, destructionScore: 5855, lossesScore: 6840, objectivesCaptured: 4, killed: 12, damageDealt: 5000, damageReceived: 3100, dlRatio: 1.31, supplyPoints: 18000, exp: 2351, medals: 1 },
      { id: '33422', name: 'eXqtor', team: 'Alpha', teamId: 0, oldRating: 2880, newRating: 2906, destructionScore: 6945, lossesScore: 6065, objectivesCaptured: 1, killed: 8, damageDealt: 3000, damageReceived: 2000, dlRatio: 1.1, supplyPoints: 9000, exp: 1500, medals: 2 }
    ]
  }));
  handle('tracker:listAccounts', () => ({ list: [{ id: '8863', name: 'Zola', persona: 'Zola', matchCount: 3 }] }));
  handle('tracker:deleteAccount', (e, id) => ({ ok: true, message: 'smoke deleted ' + id }));
  handle('replay:status', () => ({ recording: { active: false, current: null }, uploader: { pending: 0, uploading: 0, lastError: null, queue: [] } }));
  handle('replay:list', () => ({ list: [{ id: 'replays/8049993__8863__Zola__1__22__1700000000000__5a6f6c61.webm', fid: '8049993', map: 'Ignalina Powerplant', mapId: 22, uploaderId: '8863', uploaderName: 'Zola', teamId: 1, team: 'Bravo', size: 1024, createdAt: Date.now(), durationSec: 0, videoUrl: 'https://example/x.webm' }], error: null }));
  handle('replay:localList', () => ({ list: [{ id: '8028345__8863__Zola__100__11__1700000000000__5a6f6c61.webm', fid: '8028345', map: 'Airport', mapId: 11, uploaderId: '8863', uploaderName: 'Zola', teamId: 100, size: 2048, createdAt: Date.now() - 200000, localPath: '(桩)' }, { id: '8049993__8863__Zola__1__22__1700000000000__5a6f6c61.webm', fid: '8049993', map: 'Ignalina Powerplant', mapId: 22, uploaderId: '8863', uploaderName: 'Zola', teamId: 1, size: 1024, createdAt: Date.now() - 1000, localPath: '(桩)' }] }));
  handle('replay:localDelete', () => ({ ok: true, message: '已删除本地录像' }));
  handle('replay:localClean', () => ({ ok: true, removed: 2 }));
  handle('replay:localRead', () => ({ ok: true, data: new ArrayBuffer(8), size: 8 }));
  handle('replay:openLocalFolder', () => true);
  handle('replay:cacheRemote', () => ({ ok: true, message: '已缓存到本地' }));
  handle('replay:confirmUpload', () => ({ ok: true, message: '已加入上传队列' }));
  handle('replay:testRecord', () => ({ ok: true, message: '开始录制' }));
  handle('replay:displays', () => ([{ id: '1', label: '主显示器 · 1920x1080', thumb: '' }, { id: '2', label: '副显示器 · 2560x1440', thumb: '' }]));
  handle('replay:setDisplay', () => ({ ok: true }));
  handle('replay:delete', () => ({ ok: true, message: 'smoke deleted replay' }));
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
    console.log('[SMOKE] loadFile');
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    console.log('[SMOKE] loaded');
    await new Promise((r) => setTimeout(r, 2000));
    console.log('[SMOKE] exec start');
    const result = await Promise.race([
      win.webContents.executeJavaScript(`(async () => {
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
        out.accountListText = (document.getElementById('accountList') || {}).textContent || '';
        out.multiBondChecked = (document.getElementById('setMultiBond') || {}).checked;
        out.apiHealthClass = (document.getElementById('apiHealth') || {}).className;
        out.apiHealthText = (document.getElementById('apiHealth') || {}).textContent;
        out.archiveRows = document.querySelectorAll('.archive-row').length;
        out.archiveFirstRow = (document.querySelector('.archive-row') || {}).textContent || '';
        out.archiveFirstElo = (document.querySelectorAll('.archive-row td')[3] || {}).textContent || '';
        // 点击第一行 → 详情表格
        (document.querySelector('.archive-row') || {}).click();
        await new Promise((r) => setTimeout(r, 500));
        out.matchHasRadar = !!document.getElementById('matchGame');
        out.mdHeader = (document.querySelector('.md-table thead') || {}).textContent || '';
        out.mdHasSupply = (document.querySelector('.md-table thead') || {}).textContent.indexOf('补给') >= 0;
        out.mdLayout = (function () {
          const tbl = document.querySelector('.md-table');
          const cs = tbl ? getComputedStyle(tbl) : null;
          const id = document.querySelector('.md-table .md-id');
          const idcs = id ? getComputedStyle(id) : null;
          const mb = document.querySelector('#matchModal .modal-box');
          return {
            fixed: cs ? cs.tableLayout : '',
            idBreak: idcs ? idcs.wordBreak : '',
            modalW: mb ? getComputedStyle(mb).width : '',
            cols: document.querySelectorAll('.md-table colgroup col').length
          };
        })();
        // 右键档案行 → 菜单含「刷新对局信息」
        const row = document.querySelector('.archive-row');
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
        out.ctxText = (document.getElementById('ctxMenu') || {}).textContent || '';
        document.dispatchEvent(new MouseEvent('click'));
        document.getElementById('btnMatchClose').click();
        // 点卡组刷新
        const before = document.getElementById('deckFront').options.length;
        document.getElementById('btnDeckRefresh').click();
        await new Promise((r) => setTimeout(r, 600));
        out.deckFrontCount = document.getElementById('deckFront').options.length;
        out.deckPathsText = (document.getElementById('deckPaths') || {}).textContent || '';
        out.deckMsg = (document.getElementById('deckMsg') || {}).textContent || '';
        // 对局录像卡片（常驻，开关只控制自动录制）
        out.replayCardExists = !!document.getElementById('replayCard');
        out.replayCardHidden = (document.getElementById('replayCard') || {}).classList.contains('hidden');
        out.replaySwitchCount = document.querySelectorAll('#setReplayEnabled').length;
        out.hasReplayApi = typeof window.api.listReplays === 'function' && typeof window.api.getReplayStatus === 'function' && typeof window.api.deleteReplay === 'function';
        out.cspMediaSrc = (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '';
        out.noPollField = !document.getElementById('setPoll');
        out.noDelayField = !document.getElementById('setDelay');
        out.noHeartbeatUrlField = !document.getElementById('setHeartbeatUrl');
        out.noReplayStorageFields = !document.getElementById('setReplayEndpoint') && !document.getElementById('setReplayAccessKey') && !document.getElementById('setReplaySecretKey') && !document.getElementById('setReplayBucket') && !document.getElementById('setReplayRegion');
        out.apmLabel = ((document.getElementById('settingsModal') || {}).textContent || '').indexOf('APM 监测功能') >= 0;
        const settingsEl = document.getElementById('settingsModal');
        out.settingsNoReplaySwitch = !settingsEl || (settingsEl.querySelectorAll('#setReplayEnabled').length === 0);
        out.settingsNoLocalList = !document.getElementById('localReplayList');
        out.hasLocalReplayBlock = !!document.getElementById('localReplayInfo') && !!document.getElementById('btnLocalClean30') && !!document.getElementById('btnLocalCleanAll') && !!document.getElementById('btnOpenLocalReplay');
        out.localReplayInfo = (document.getElementById('localReplayInfo') || {}).textContent || '';
        // 关闭自动录制 → 卡片仍可见、config 写回 false
        const replaySw = document.getElementById('setReplayEnabled');
        replaySw.checked = false;
        replaySw.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 300));
        out.replayCardStillVisibleAfterOff = !(document.getElementById('replayCard') || {}).classList.contains('hidden');
        out.replayEnabledAfterOff = (await window.api.getConfig().catch(() => ({}))).replayEnabled;
        document.getElementById('btnReplayRefresh').click();
        await new Promise((r) => setTimeout(r, 300));
        out.replayListText = (document.getElementById('replayList') || {}).textContent || '';
        out.replayListHasRow = !!document.querySelector('.replay-row');
        out.replayPreviewWrap = !!document.getElementById('replayPreviewWrap');
        out.replayPreviewHidden = (document.getElementById('replayPreviewWrap') || {}).classList.contains('hidden');
        out.replayPreviewImg = !!document.getElementById('replayPreviewImg');
        out.hasReplayPreviewApi = typeof window.api.onReplayPreview === 'function';
        out.replayFirstGroup = (document.querySelector('.replay-group-title') || {}).textContent || '';
        // 右键录像行 → 菜单含 打开位置/对局详情/BATrace/删除
        const lrow = document.querySelector('.replay-row[data-source="local"]');
        if (lrow) {
          lrow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
          out.replayCtxLocalText = (document.getElementById('ctxMenu') || {}).textContent || '';
          document.dispatchEvent(new MouseEvent('click'));
        } else { out.replayCtxLocalText = ''; }
        // 云端下载到本地后合并为一行：[云端][本地] 双标签 + 右键同时含本地/云端操作
        const mrow = document.querySelector('.replay-row[data-source="both"]');
        out.mergedRowCount = document.querySelectorAll('.replay-row[data-source="both"]').length;
        out.mergedRowBothTags = !!(mrow && mrow.querySelector('.r-src.cloud') && mrow.querySelector('.r-src.local'));
        if (mrow) {
          mrow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
          out.replayCtxBothText = (document.getElementById('ctxMenu') || {}).textContent || '';
          document.dispatchEvent(new MouseEvent('click'));
        } else { out.replayCtxBothText = ''; }        out.replayCtxBothHasLocalDelete = out.replayCtxBothText.indexOf('删除本地副本') >= 0;
        out.replayCtxBothHasCloudDelete = out.replayCtxBothText.indexOf('删除云端录像') >= 0;
        out.archiveReplayMark = (document.querySelector('.archive-row .replay-mark') || {}).textContent || '';
        out.localBadge = !!document.querySelector('.r-src.local');
        out.cloudBadge = !!document.querySelector('.r-src.cloud');
        out.replayModalExists = !!document.getElementById('replayModal') && !!document.getElementById('replayVideo') && !!document.querySelector('.replay-speed-btn');
        out.themeSwatchCount = document.querySelectorAll('.theme-swatch').length;
        out.openLocalReplayBtn = !!document.getElementById('btnOpenLocalReplay');
        out.hasRoomToolApi = typeof window.api.onRoomToolUsers === 'function' && typeof window.api.cacheRemoteReplay === 'function';
        out.replayConfirmModal = !!document.getElementById('replayConfirmModal') && !!document.getElementById('btnReplayConfirmUpload') && !!document.getElementById('btnReplayConfirmLater');
        out.hasConfirmApi = typeof window.api.confirmUpload === 'function' && typeof window.api.onConfirmUpload === 'function';
        out.hasTestRecord = !!document.getElementById('btnTestRecord') && typeof window.api.testRecord === 'function';
        out.displayPicker = !!document.getElementById('displayPickerModal') && !!document.getElementById('displayThumbs') && typeof window.api.listDisplays === 'function';
      }
      return out;
      })()`),
      new Promise((res) => setTimeout(() => res('EXEC_TIMEOUT'), 12000))
    ]);
    logs.push('RESULT: ' + JSON.stringify(result, null, 1));
  } catch (e) {
    logs.push('SMOKE ERROR: ' + (e && e.stack || e));
  }
  const out = '==== SMOKE OUTPUT ====\n' + logs.join('\n') + '\n';
  console.log(out);
  try { fs.writeFileSync(require('path').join(__dirname, 'smoke-result.txt'), out, 'utf8'); } catch (e) {}
  app.exit(0);
});
