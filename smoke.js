// 冒烟测试：隐藏窗口加载界面，检查 preload 是否注入、按钮是否响应、抓取渲染进程报错
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
try { app.setPath('userData', path.join(__dirname, '.smoke-data')); } catch (e) {}
let winRef = null;


// 注册桩处理器：冒烟测试不跑主应用，只验证渲染层（preload/脚本/按钮）
function registerStubIpc() {
  const { ipcMain } = require('electron');
  const cfg = { logDir: '', pollMs: 1500, apiDelayMs: 350, autoQueryCurrentMatch: true, inputHookEnabled: false, replayEnabled: false, replayServerUrl: '', replaySecret: '', replayQuality: 720, replayFps: 30, replayBitrateMbps: 5, replayExposure: 0, replayAudio: 'default', replaySaveDir: '', lang: 'zh' };
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
  handle('report:maggot', async () => {
    if (winRef) winRef.webContents.send('maggot:progress', { done: 1, total: 12, scanned: 1, of: 12 });
    await new Promise((r) => setTimeout(r, 120));
    return { maggotIndex: 3.5, calls: 1, name: 'Zola', stbid: '8863', trend: [], tags: [], units: [], refs: [] };
  });
  handle('match:queryRoster', () => true);
  handle('tracker:profile', (e, id) => {
    if (String(id) === '999') {
      return { id: '999', player: { id: '999', names: [{ name: 'X' }], firstSeen: 0, lastSeen: 0 }, stats: {}, encounters: [], nameHistory: [], banned: false, banInfo: null, recentMatches: [], recentError: 'BATrace 暂时不可用（测试）', info: null };
    }
    return { id: '8863', player: { id: '8863', names: [{ name: 'Zola' }], firstSeen: 0, lastSeen: 0 }, stats: {}, encounters: [], nameHistory: [], banned: false, banInfo: null, recentMatches: [
      { fid: '8422864', map: 'Baltiisk', endTime: Date.now() - 3600000, eloDelta: 10, won: true, teamId: 1, custom: false },
      { fid: '8422225', map: 'River', endTime: Date.now() - 7200000, eloDelta: -5, won: false, teamId: 1, custom: false }
    ], recentError: null, info: null };
  });
  handle('tracker:getBans', () => ({ list: [], lastSync: 0 }));
  handle('tracker:syncBans', () => ({ list: [], lastSync: 0 }));
  handle('tracker:matches', () => ({
    list: [
      { fid: '8049993', map: 'Ignalina Powerplant', endTime: Date.now() - 86400000, durationSec: 2700, localWon: false, winnerTeam: null, custom: false, mode: 'ranked', localSpectator: false, localEloDelta: -16.5, localEloAfter: 2555.5225, localScores: { destruction: 5855, losses: 6840, objectives: 4 }, localPersona: 'Zola', localName: 'Zola', playerCount: 10 },
      { fid: '8028345', map: 'Airport', endTime: Date.now() - 172800000, durationSec: 2700, localWon: null, winnerTeam: 1, custom: true, mode: 'custom', localSpectator: true, localEloDelta: null, localScores: null, localPersona: 'Zola', localName: 'Zola', playerCount: 14 },
      { fid: '8026925', map: 'Baltiisk', endTime: Date.now() - 259200000, durationSec: 2699, localWon: true, winnerTeam: null, custom: true, mode: 'custom', localSpectator: false, localEloDelta: null, localScores: { destruction: 7690, losses: 5870, objectives: 6 }, localPersona: '公安九课', localName: 'Zola', playerCount: 13, restarted: true }
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
  handle('replay:status', () => ({ recording: { active: false, current: null } }));
  handle('replay:localList', () => ({ list: [{ id: '8028345__8863__Zola__100__11__1700000000000__5a6f6c61.webm', fid: '8028345', map: 'Airport', mapId: 11, uploaderId: '8863', uploaderName: 'Zola', teamId: 100, size: 2048, createdAt: Date.now() - 200000, localPath: '(桩)' }, { id: '8049993__8863__Zola__1__22__1700000000000__5a6f6c61.webm', fid: '8049993', map: 'Ignalina Powerplant', mapId: 22, uploaderId: '8863', uploaderName: 'Zola', teamId: 1, size: 1024, createdAt: Date.now() - 1000, localPath: '(桩)' }] }));
  handle('replay:localDelete', () => ({ ok: true, message: '已删除本地录像' }));
  handle('replay:localClean', () => ({ ok: true, removed: 2 }));
  handle('replay:localRead', () => ({ ok: true, data: new ArrayBuffer(8), size: 8 }));
  handle('replay:openLocalFolder', () => true);
  handle('replay:dirInfo', () => ({ ok: true, dir: 'C:\\smoke-replays', count: 2 }));
  handle('replay:testRecord', () => ({ ok: true, message: '开始录制' }));
  handle('replay:displays', () => ([{ id: '1', label: '主显示器 · 1920x1080', thumb: '' }, { id: '2', label: '副显示器 · 2560x1440', thumb: '' }]));
  handle('replay:setDisplay', () => ({ ok: true }));
  handle('replay:selectSaveDir', () => ({ ok: true, dir: 'C:\\smoke-replays' }));
  handle('replay:setSaveDir', () => ({ ok: true }));
  handle('replay:moveReplays', () => ({ ok: true, moved: 2, failed: 0 }));
  handle('replay:screenThumbnail', () => ({ ok: true, thumb: '' }));
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
  winRef = win;
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
        out.panelOrderListExists = !!document.getElementById('panelOrderList');
        out.panelOrderRowCount = document.querySelectorAll('#panelOrderList .panel-order-row').length;
        out.addMatchUiExists = !!document.getElementById('btnAddMatch') && !!document.getElementById('addMatchFid');
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
        out.mdEloCell = (document.querySelectorAll('.md-table tbody tr td')[2] || {}).textContent || '';
        out.mdEloShowsValue = out.mdEloCell.trim().length > 0 && out.mdEloCell.indexOf('(') >= 0;
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
        // 调查弹窗：最近 10 局渲染 + 失败提示
        openInvestigate('8863', 'Zola');
        await new Promise((r) => setTimeout(r, 400));
        out.invRecentCount = document.querySelectorAll('#invRecent .inv-item').length;
        out.invRecentHasMap = (document.getElementById('invRecent') || {}).textContent.indexOf('Baltiisk') >= 0;
        document.getElementById('btnInvClose').click();
        openInvestigate('999', 'X');
        await new Promise((r) => setTimeout(r, 400));
        out.invRecentErrorText = (document.getElementById('invRecent') || {}).textContent || '';
        out.invRecentErrorShown = out.invRecentErrorText.indexOf('最近 10 局加载失败') >= 0;
        document.getElementById('btnInvClose').click();
        // 点卡组刷新
        const before = document.getElementById('deckFront').options.length;
        document.getElementById('btnDeckRefresh').click();
        await new Promise((r) => setTimeout(r, 600));
        out.deckFrontCount = document.getElementById('deckFront').options.length;
        out.deckPathsText = (document.getElementById('deckPaths') || {}).textContent || '';
        out.deckMsg = (document.getElementById('deckMsg') || {}).textContent || '';
        out.deckToggleExists = !!document.getElementById('btnDeckToggle');
        // 行车记录仪卡片（常驻，开关只控制自动录制；列表按时间倒序管理）
        out.replayCardExists = !!document.getElementById('replayCard');
        out.replayCardHidden = (document.getElementById('replayCard') || {}).classList.contains('hidden');
        out.replaySwitchCount = document.querySelectorAll('#setReplayEnabled').length;
        out.replayTitle = ((document.querySelector('#replayCard h2') || {}).textContent || '').trim();
        out.hasReplayApi = typeof window.api.getReplayStatus === 'function' && typeof window.api.listLocalReplays === 'function';
        out.cspMediaSrc = (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '';
        out.noPollField = !document.getElementById('setPoll');
        out.noDelayField = !document.getElementById('setDelay');
        out.noHeartbeatUrlField = !document.getElementById('setHeartbeatUrl');
        out.noReplayStorageFields = !document.getElementById('setReplayEndpoint') && !document.getElementById('setReplayAccessKey') && !document.getElementById('setReplaySecretKey') && !document.getElementById('setReplayBucket') && !document.getElementById('setReplayRegion');
        out.hasReplayListEl = !!document.getElementById('replayList');
        out.hasReplayListInfo = !!document.getElementById('replayListInfo');
        out.hasReplayAudioBadge = !!document.getElementById('replayPreviewAudio');
        out.hasReplayOpenFolderBtn = !!document.getElementById('btnReplayOpenFolder');
        out.hasReplayClean30Btn = !!document.getElementById('btnReplayClean30');
        out.apmLabel = ((document.getElementById('settingsModal') || {}).textContent || '').indexOf('APM 监测功能') >= 0;
        const settingsEl = document.getElementById('settingsModal');
        out.settingsNoReplaySwitch = !settingsEl || (settingsEl.querySelectorAll('#setReplayEnabled').length === 0);
        out.settingsNoLocalList = !document.getElementById('localReplayList');
        out.hasLocalReplayBlock = !!document.getElementById('localReplayInfo') && !!document.getElementById('btnLocalClean30') && !!document.getElementById('btnLocalCleanAll') && !!document.getElementById('btnOpenLocalReplay');
        out.localReplayInfo = (document.getElementById('localReplayInfo') || {}).textContent || '';
        // 录像设置弹窗：字段齐全；分辨率/帧数/码率滑块；预计大小显示
        out.hasBtnRecSettings = !!document.getElementById('btnRecSettings');
        out.noReplaySearchEl = !document.getElementById('replaySearch');
        document.getElementById('btnRecSettings').click();
        await new Promise((r) => setTimeout(r, 300));
        out.recModalOpened = !(document.getElementById('recSettingsModal') || {}).classList.contains('hidden');
        out.recFields = !!document.getElementById('recDisplay') && !!document.getElementById('recQualityRange') && !!document.getElementById('recFpsRange') && !!document.getElementById('recBitrateRange') && !!document.getElementById('recQualityVal') && !!document.getElementById('recFpsVal') && !!document.getElementById('recBitrateVal') && !!document.getElementById('recEstSize') && !!document.getElementById('recAudio') && !!document.getElementById('recSaveDir');
        out.recDisplayOptions = (document.getElementById('recDisplay') || {}).options ? document.getElementById('recDisplay').options.length : 0;
        out.recSliderDefaults = (function () {
          const q = document.getElementById('recQualityRange');
          const f = document.getElementById('recFpsRange');
          const b = document.getElementById('recBitrateRange');
          return q && f && b && Number(q.value) === 720 && Number(f.value) === 30 && Number(b.value) === 5;
        })();
        out.recQualityLabel = (document.getElementById('recQualityVal') || {}).textContent || '';
        out.recFpsLabel = (document.getElementById('recFpsVal') || {}).textContent || '';
        out.recBitrateLabel = (document.getElementById('recBitrateVal') || {}).textContent || '';
        out.recQualityTicks = document.querySelectorAll('#qualityTicks option').length;
        out.recEstText = (document.getElementById('recEstSize') || {}).textContent || '';
        out.recEstHasMb = (out.recEstText || '').indexOf('MB') >= 0 || (out.recEstText || '').indexOf('GB') >= 0;
        out.replayListRowCount = document.querySelectorAll('#replayList .replay-row').length;
        document.getElementById('btnRecSettingsClose').click();
        out.recModalClosed = (document.getElementById('recSettingsModal') || {}).classList.contains('hidden');
        // 关闭自动录制 → 卡片仍可见、config 写回 false
        const replaySw = document.getElementById('setReplayEnabled');
        replaySw.checked = false;
        replaySw.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 300));
        out.replayCardStillVisibleAfterOff = !(document.getElementById('replayCard') || {}).classList.contains('hidden');
        out.replayEnabledAfterOff = (await window.api.getConfig().catch(() => ({}))).replayEnabled;
        out.replayPreviewWrap = !!document.getElementById('replayPreviewWrap');
        out.replayPreviewHidden = (document.getElementById('replayPreviewWrap') || {}).classList.contains('hidden');
        out.replayPreviewImg = !!document.getElementById('replayPreviewImg');
        out.hasReplayPreviewApi = typeof window.api.onReplayPreview === 'function';
        out.noUploadProgressApi = typeof window.api.onReplayUploadProgress !== 'function';
        out.hasAnnouncementApi = typeof window.api.onAnnouncement === 'function';
        out.announcementModalExists = !!document.getElementById('announcementModal');
        out.btnUpdateDownloadExists = !!document.getElementById('btnUpdateDownload');
        out.noRowProgress = !document.querySelector('.r-progress');
        // 点对局档案的 📹 → 多个视角先弹选择列表，选一个再播放
        const amark = document.querySelector('.archive-row .replay-mark');
        if (amark) { amark.click(); await new Promise((r) => setTimeout(r, 400)); }
        out.replayPickerShown = !(document.getElementById('replayPickerModal') || {}).classList.contains('hidden');
        out.replayPickerCount = document.querySelectorAll('#replayPickerList .replay-pick-item').length;
        const firstPick = document.querySelector('#replayPickerList .replay-pick-item');
        if (firstPick) { firstPick.click(); await new Promise((r) => setTimeout(r, 400)); }
        out.replayOpenedFromArchive = !(document.getElementById('replayModal') || {}).classList.contains('hidden');
        out.archiveReplayMark = (document.querySelector('.archive-row .replay-mark') || {}).textContent || '';
        out.replayModalExists = !!document.getElementById('replayModal') && !!document.getElementById('replayVideo') && !!document.querySelector('.replay-speed-btn');
        out.themeSwatchCount = document.querySelectorAll('.theme-swatch').length;
        out.openLocalReplayBtn = !!document.getElementById('btnOpenLocalReplay');
        out.hasRoomToolApi = typeof window.api.onRoomToolUsers === 'function';
        out.noReplayConfirmModal = !document.getElementById('replayConfirmModal') && !document.getElementById('btnReplayConfirmUpload');
        out.noConfirmApi = typeof window.api.confirmUpload !== 'function' && typeof window.api.onConfirmUpload !== 'function';
        out.hasTestRecord = !!document.getElementById('btnTestRecord') && typeof window.api.testRecord === 'function';
        out.hasNewReplayApi = typeof window.api.selectReplaySaveDir === 'function' && typeof window.api.setReplaySaveDir === 'function' && typeof window.api.moveReplays === 'function' && typeof window.api.getScreenThumbnail === 'function';
        // 查蛆指数：点击后按钮禁用 + 进度行可见 → 完成恢复 + 进度行隐藏
        lastReport = { id: '8863', name: 'Zola' }; // app.js 全局变量，模拟已选玩家
        const maggotBtn = document.getElementById('btnMaggot');
        maggotBtn.click();
        await new Promise((r) => setTimeout(r, 60));
        out.maggotBusy = maggotBtn.disabled === true;
        out.maggotProgressVisible = !(document.getElementById('maggotProgressRow') || {}).classList.contains('hidden');
        out.maggotProgressText = (document.getElementById('maggotProgressText') || {}).textContent || '';
        out.maggotProgressBarW = (document.getElementById('maggotProgressBar') || {}).style.width || '';
        out.maggotProgressPct = (document.getElementById('maggotProgressPct') || {}).textContent || '';
        out.maggotOtherBtnsBusy = document.getElementById('btnMaggotFromReport') && document.getElementById('btnMaggotFromReport').disabled === true;
        await new Promise((r) => setTimeout(r, 400));
        out.maggotDone = maggotBtn.disabled === false;
        out.maggotProgressHiddenAfter = (document.getElementById('maggotProgressRow') || {}).classList.contains('hidden');
        // 顶栏心跳无「经代理」文案
        out.noProxyTextInHeartbeat = !((document.getElementById('onlineText') || {}).title || '').includes('经代理');
        out.displayPicker = !!document.getElementById('displayPickerModal') && !!document.getElementById('displayThumbs') && typeof window.api.listDisplays === 'function';
        // 四语言：按钮齐全；默认中文激活；录像行右键菜单；切英文后标题变英文；档案行「已重开」徽标
        out.langButtons = ['langEn', 'langZh', 'langJa', 'langRu'].every((id) => !!document.getElementById(id));
        out.langZhActive = ((document.getElementById('langZh') || {}).classList || []).contains('active');
        out.archiveHasRestarted = ((document.getElementById('archiveList') || {}).textContent || '').indexOf('已重开') >= 0;
        const rr = document.querySelector('#replayList .replay-row[data-key]');
        if (rr) rr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }));
        await new Promise((r) => setTimeout(r, 60));
        out.replayCtxText = (document.getElementById('ctxMenu') || {}).textContent || '';
        out.replayCtxHasOpenDetail = out.replayCtxText.indexOf('打开对局详情') >= 0 && out.replayCtxText.indexOf('打开位置') >= 0 && out.replayCtxText.indexOf('删除录像') >= 0;
        document.dispatchEvent(new MouseEvent('click'));
        document.getElementById('langEn').click();
        await new Promise((r) => setTimeout(r, 250));
        out.archiveTitleEn = (document.querySelector('h2[data-i18n="card.archive"]') || {}).textContent || '';
        out.archiveTitleIsEn = /Match archive/.test(out.archiveTitleEn);
        out.langHtmlLang = document.documentElement.lang;
        // 语言保存修复：切英文后 config.lang 应写入 settings（preload 只暴露 setConfig）
        out.langSavedEn = (await window.api.getConfig().catch(() => ({}))).lang === 'en';
        // 英文下：标题 / 品牌 / 关于段落
        out.titleEn = document.title;
        out.titleIsEn = /Broken Arrow Log Assistant/.test(out.titleEn);
        out.brandEn = ((document.querySelector('.brand-name') || {}).textContent || '').trim();
        out.brandIsEn = /Broken Arrow Log Assistant/.test(out.brandEn);
        out.aboutEn = ((document.getElementById('aboutCard') || {}).textContent || '');
        out.aboutIsEn = /How it works/.test(out.aboutEn) && /Credits/.test(out.aboutEn);
        // 两栏底部留白修复：.archive-list 无 max-height、.split > .card 有 max-height
        const al = document.getElementById('archiveList');
        const alCs = al ? getComputedStyle(al) : null;
        out.archiveListMaxHeight = alCs ? alCs.maxHeight : '';
        out.archiveListNoMaxH = !alCs || alCs.maxHeight === 'none' || alCs.maxHeight === '';
        const splitCard = document.querySelector('.split > .card');
        const scCs = splitCard ? getComputedStyle(splitCard) : null;
        out.splitCardMaxHeight = scCs ? scCs.maxHeight : '';
        out.splitCardHasMaxH = !!scCs && scCs.maxHeight !== 'none' && scCs.maxHeight !== '';
        // 档案列表贴底：列表底部到卡片底部无大留白（粗略断言高度差）
        const cardBox = splitCard ? splitCard.getBoundingClientRect() : null;
        const listBox = al ? al.getBoundingClientRect() : null;
        out.splitGapBottom = cardBox && listBox ? Math.round(cardBox.bottom - listBox.bottom) : -1;
        out.splitNoGap = cardBox && listBox ? (cardBox.bottom - listBox.bottom) <= 40 : false;
        out.langHtmlLang = document.documentElement.lang;
        document.getElementById('langZh').click();
        await new Promise((r) => setTimeout(r, 150));
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
