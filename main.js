// ================= Electron 主进程 =================
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Config, detectSteamLogDir } = require('./src/config');
const { LogParser } = require('./src/logParser');
const { LogWatcher } = require('./src/logWatcher');
const { BatraceClient, Cache, ApiUsage } = require('./src/batrace');
const { Heartbeat } = require('./src/heartbeat');
const { Analyzer } = require('./src/analyzer');
const { MatchArchive } = require('./src/storage');
const { zipCreate, zipExtract } = require('./src/zip');

let win = null;
let config = null;
let parser = null;
let watcher = null;
let client = null;
let analyzer = null;
let archive = null;
let usage = null;        // 24h API 配额
let heartbeat = null;    // 心跳统计（可选）

// 软件图标：优先使用 build/icon.png（由根目录 logo.png 生成），否则用默认
function appIcon() {
  const p = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

// ---------------- 窗口 ----------------
function createWindow() {
  win = new BrowserWindow({
    icon: appIcon(),
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '断箭蛆工具 byZola',
    autoHideMenuBar: true,
    backgroundColor: '#10131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 渲染进程日志落盘，便于排查界面问题
  const rendererLog = path.join(app.getPath('userData'), 'renderer.log');
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    try {
      fs.appendFileSync(rendererLog, `[${new Date().toISOString()}] L${level} ${sourceId || ''}:${line} ${message}\n`);
    } catch (err) {}
  });
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- 初始化 ----------------
app.whenReady().then(() => {
  config = new Config(app.getPath('userData'));
  parser = new LogParser(onParserEvent);
  watcher = new LogWatcher({ dir: config.get().logDir, pollMs: config.get().pollMs, parser });
  usage = new ApiUsage(path.join(app.getPath('userData'), 'api-usage.json'), config.get().apiDailyLimit ?? 120);
  client = new BatraceClient({
    delayMs: config.get().apiDelayMs,
    cache: new Cache(path.join(app.getPath('userData'), 'batrace-cache.json')),
    usage,
    onUsage: () => send('budget', budgetPayload({}))
  });
  analyzer = new Analyzer(client);
  archive = new MatchArchive(path.join(app.getPath('userData'), 'match-archive.json'));
  heartbeat = new Heartbeat({
    url: config.get().heartbeatUrl || '',
    uidFile: path.join(app.getPath('userData'), 'heartbeat-uid.txt'),
    version: app.getVersion(),
    onStats: (stats) => send('heartbeat', stats)
  });
  if (config.get().heartbeatEnabled && heartbeat.url) heartbeat.start();

  createWindow();
  watcher.start();
  applyAutoQuery();
  checkVersion();
  send('budget', budgetPayload({}));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- 解析器事件 ----------------
function onParserEvent(type, data) {
  if (type === 'matchEnd') {
    archive.add(data);
    send('archive:changed', archive.list().slice(0, 20));
    send('session', parser.snapshot());
  } else if (type === 'matchMeta') {
    // 补记时长（网络统计行在对局结束后才出现）
    const list = archive.list();
    const hit = data.fid ? list.find((m) => m.fid === data.fid) : list.find((m) => !m.durationSec && m.startTime === data.startTime);
    if (hit && data.durationSec) {
      hit.durationSec = data.durationSec;
      archive.flush();
      send('archive:changed', list.slice(0, 20));
    }
  } else if (type === 'lobbyPlayers' || type === 'localName') {
    // 开战前：房间内玩家名单/本机名更新推给界面；有新玩家加入自动触发粗查
    send('session', parser.snapshot());
    if (type === 'lobbyPlayers') applyLobbyAutoQuery();
  } else if (type === 'lobbyReset') {
    // 换大厅/退房：重置大厅粗查去重与防抖
    lastLobbyIds = new Set();
    if (lobbyDebounce) { clearTimeout(lobbyDebounce); lobbyDebounce = null; }
    send('session', parser.snapshot());
  } else if (type === 'session' || type === 'watcher') {
    send('session', parser.snapshot());
    if (type === 'watcher') send('watcher', data);
    applyAutoQuery();
  } else if (type === 'roster') {
    send('session', parser.snapshot());
    applyAutoQuery();
  }
}

function budgetPayload(extra = {}) {
  return {
    calls: client ? (client.networkCalls || 0) : 0,
    used24h: usage ? usage.count() : 0,
    limit24h: usage ? usage.limit : 120,
    ...extra
  };
}

let queryToken = 0;
const autoQueriedFids = new Set(); // 已自动查询过的对局（每局只自动查一次）
let lastLobbyIds = new Set();      // 大厅已触发过粗查的玩家集合（有新玩家才再触发）

// 降低调用的规则：跳过机器人、观战者，去重
function isSkippable(p) {
  return !p || !p.id || /\[Bot\]/i.test(p.name || '') || p.team === 'Spectators';
}

let lobbyDebounce = null;
function applyLobbyAutoQuery() {
  // 改动1：玩家加入房间（未开战）自动触发粗查；已开战交给 FID 自动查询
  if (!config.get().autoQueryCurrentMatch) return;
  const snap = parser.snapshot();
  if (snap.current) return;
  // 防抖 1.5s：合并日志回放/连串进出房间事件，只查一次
  if (lobbyDebounce) clearTimeout(lobbyDebounce);
  lobbyDebounce = setTimeout(() => {
    lobbyDebounce = null;
    const s2 = parser.snapshot();
    if (s2.current) return;
    const lobby = s2.lobbyPlayers || {};
    const ids = Object.keys(lobby).filter((id) => !isSkippable({ id, name: lobby[id] }));
    if (!ids.length) return;
    const hasNew = ids.some((id) => !lastLobbyIds.has(id));
    if (!hasNew) return;
    lastLobbyIds = new Set(ids);
    queryCurrentMatch().catch(() => {});
  }, 1500);
}

function applyAutoQuery() {
  if (!config.get().autoQueryCurrentMatch) return;
  const cur = parser.snapshot().current;
  if (!cur || !cur.fid || !cur.players.length) return;
  if (autoQueriedFids.has(cur.fid)) return; // 同一局只自动查一次
  autoQueriedFids.add(cur.fid);
  const token = ++queryToken;
  setTimeout(() => {
    if (token !== queryToken) return;
    queryCurrentMatch().catch(() => {});
  }, 600);
}

// 查询当前对局所有玩家（每人 1 次 /api/analysis/player，跳过机器人/观战，去重）
async function queryCurrentMatch() {
  const snap = parser.snapshot();
  const cur = snap.current;
  // 名单来源：已开战用对局名单，未开战退回房间内玩家（Incoming client，ID 即 batrace ID）
  let roster = (cur && cur.players.length) ? cur.players : [];
  if (!roster.length) {
    for (const [uid, name] of Object.entries(snap.lobbyPlayers || {})) {
      roster.push({ id: uid, name, team: null });
    }
  }
  if (!roster.length) return;
  const seen = new Set();
  const players = [];
  for (const p of roster) {
    if (isSkippable(p)) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    players.push({ id: p.id, name: p.name, team: p.team });
  }
  // 保险：单局最多查询 20 人（正常 10v10 只会查 10 人，机器人/观战/重复都跳过）
  const capped = players.slice(0, 20);
  const skipped = ((cur && cur.players) || []).length - capped.length;
  send('match:querying', { fid: cur ? cur.fid : null, players: capped, skipped });
  let done = 0;
  for (const p of capped) {
    const row = { id: p.id, name: p.name, team: p.team, info: null, error: null };
    try {
      const a = await client.analysisPlayer(p.id);
      const mini = analyzer.extractMini(a);
      if (mini) row.info = mini; else row.error = '无数据';
    } catch (e) {
      row.error = '查询失败';
    }
    done++;
    send('match:player', row);
    send('budget', budgetPayload({ done, total: capped.length, skipped }));
  }
  send('match:done', { fid: cur ? cur.fid : null, count: capped.length });
  send('budget', budgetPayload({ done: capped.length, total: capped.length, skipped, finished: true }));
}


// ---------------- 软件版本检查（从用户 GitHub 的 version.txt 读取） ----------------
const VERSION_URL = 'https://raw.githubusercontent.com/Zawinzala/brokenarrow-log-maggot/main/version.txt';
let versionInfo = null;

function parseVersion(v) {
  const mm = String(v || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return mm ? [parseInt(mm[1], 10), parseInt(mm[2] || '0', 10), parseInt(mm[3] || '0', 10)] : [0, 0, 0];
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
function parseVersionText(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const version = lines[0] || '';
  const announcement = lines.slice(1).join('\n').replace(/^公告\s*[:：]?\s*/, '').trim();
  return { version, announcement };
}
async function checkVersion() {
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const text = await res.text();
    const { version, announcement } = parseVersionText(text);
    const latest = parseVersion(version);
    const local = parseVersion(app.getVersion());
    versionInfo = {
      latest: version || '未知',
      current: app.getVersion(),
      hasUpdate: latest.some((n) => n > 0) && cmpVer(latest, local) > 0,
      announcement,
      url: 'https://github.com/Zawinzala/brokenarrow-log-maggot'
    };
    send('version', versionInfo);
  } catch (e) { /* 离线/失败静默，不打扰使用 */ }
}
// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (e, patch) => {
    const before = config.get();
    const next = config.set(patch);
    if (next.logDir !== before.logDir || next.pollMs !== before.pollMs) {
      watcher.stop();
      watcher = new LogWatcher({ dir: next.logDir, pollMs: next.pollMs, parser });
      watcher.start();
    }
    if (next.apiDailyLimit !== before.apiDailyLimit && usage) {
      usage.limit = next.apiDailyLimit ?? 120;
    }
    if (next.heartbeatEnabled !== before.heartbeatEnabled || next.heartbeatUrl !== before.heartbeatUrl) {
      if (heartbeat) {
        heartbeat.stop();
        heartbeat.url = (next.heartbeatUrl || '').replace(/\/+$/, '');
        if (next.heartbeatEnabled && heartbeat.url) heartbeat.start();
      }
    }
    return next;
  });
  ipcMain.handle('config:selectDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('config:detectDir', () => detectSteamLogDir());
  ipcMain.handle('config:validateDir', (e, dir) => config.validateLogDir(dir));

  ipcMain.handle('watcher:status', () => watcher.status());
  ipcMain.handle('session:get', () => parser.snapshot());

  ipcMain.handle('search:players', (e, q) => client.searchPlayers(q || '', 20));
  ipcMain.handle('report:player', (e, stbid) => analyzer.buildReport(stbid));
  ipcMain.handle('report:maggot', (e, stbid) =>
    analyzer.buildMaggotReport(stbid, (p) => send('maggot:progress', p)));
  ipcMain.handle('app:version', () => versionInfo || null);
  ipcMain.handle('usage:get', () => (usage ? { used24h: usage.count(), limit24h: usage.limit, calls: client ? client.networkCalls || 0 : 0 } : null));
  ipcMain.handle('heartbeat:get', () => (heartbeat ? heartbeat.stats : null));
  ipcMain.handle('heartbeat:ping', (e, url) => (heartbeat ? heartbeat.pingNow(url) : null));
  ipcMain.handle('match:queryCurrent', () => queryCurrentMatch());

  ipcMain.handle('archive:list', () => archive.list().slice(0, 50));
  ipcMain.handle('archive:clear', () => { archive.clear(); return true; });

  ipcMain.handle('shell:open', (e, url) => {
    if (/^https?:\/\//.test(url || '')) shell.openExternal(url);
    return true;
  });
}


// ---------------- 卡组工具 ----------------
// 卡组目录兼容性：不同用户机器上目录名/位置可能有差异，按候选顺序自动检测；
// Decks 是游戏数据目录，绝不自动创建（只在不存在时提示用户）。
function deckPaths() {
  const localLow = path.join(os.homedir(), 'AppData', 'LocalLow');
  const candidates = [
    path.join(localLow, 'SteelBalalaikaStudio', 'BrokenArrow'),
    path.join(localLow, 'BrokenArrow'),
    path.join(localLow, 'SteelBalalaikaStudio', 'BrokenArrowBeta'),
    path.join(localLow, 'SteelBalalaikaStudio', 'BrokenArrow 2')
  ];
  let base = candidates.find((c) => fs.existsSync(path.join(c, 'Decks'))) || candidates[0];
  const decks = path.join(base, 'Decks');
  const backups = path.join(base, 'DeckBackups');
  try { fs.mkdirSync(backups, { recursive: true }); } catch (e) {}
  return { decks, backups, base, found: fs.existsSync(decks) };
}

// 文件名安全校验：只允许纯文件名（不含路径分隔符/上级目录）
function safeFileName(name) {
  if (typeof name !== 'string' || !name) return null;
  const base = path.basename(name);
  if (base !== name || name.includes('..') || /[\\/]/.test(name)) return null;
  return base;
}

function listFiles(dir, ext) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => {
        const full = path.join(dir, f);
        let size = 0, mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
        return { name: f, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

function registerDeckIpc() {
  ipcMain.handle('deck:paths', () => deckPaths());

  ipcMain.handle('deck:list', () => {
    const { decks, backups, base, found } = deckPaths();
    return {
      decks: listFiles(decks, '.dek'),
      backups: listFiles(backups, '.zip'),
      decksDir: decks,
      backupsDir: backups,
      base,
      found
    };
  });

  ipcMain.handle('deck:backup', (e, { names, packageName } = {}) => {
    const { decks, backups } = deckPaths();
    const list = Array.isArray(names) ? names : [];
    if (!list.length) return { ok: false, message: '未选择任何卡组' };
    let pkg = safeFileName(String(packageName || ''));
    if (!pkg) return { ok: false, message: '备份包名称无效' };
    if (!pkg.toLowerCase().endsWith('.zip')) pkg += '.zip';
    const files = [];
    for (const n of list) {
      const fn = safeFileName(n);
      if (!fn) continue;
      const full = path.join(decks, fn);
      if (fs.existsSync(full)) files.push({ name: fn, data: fs.readFileSync(full) });
    }
    if (!files.length) return { ok: false, message: '没有可备份的文件' };
    const zipPath = path.join(backups, pkg);
    fs.writeFileSync(zipPath, zipCreate(files));
    return { ok: true, message: `已备份 ${files.length} 个卡组 → ${pkg}`, file: pkg };
  });

  ipcMain.handle('deck:deploy', (e, packageName) => {
    const { decks, backups } = deckPaths();
    const pkg = safeFileName(String(packageName || ''));
    if (!pkg) return { ok: false, message: '备份包名称无效' };
    const zipPath = path.join(backups, pkg);
    if (!fs.existsSync(zipPath)) return { ok: false, message: '备份包不存在' };
    const entries = zipExtract(fs.readFileSync(zipPath));
    let count = 0;
    for (const en of entries) {
      const fn = safeFileName(en.name);
      if (!fn) continue;
      fs.writeFileSync(path.join(decks, fn), en.data);
      count++;
    }
    return { ok: true, message: `已部署 ${count} 个卡组到前线（同名已覆盖）`, count };
  });

  ipcMain.handle('deck:delete', (e, { kind, names } = {}) => {
    const { decks, backups } = deckPaths();
    const dir = kind === 'backups' ? backups : decks;
    const list = Array.isArray(names) ? names : [];
    let count = 0;
    for (const n of list) {
      const fn = safeFileName(n);
      if (!fn) continue;
      const full = path.join(dir, fn);
      try { if (fs.existsSync(full)) { fs.unlinkSync(full); count++; } } catch (err) {}
    }
    return { ok: true, message: `已删除 ${count} 个文件` };
  });

  ipcMain.handle('deck:openFolder', (e, kind) => {
    const { decks, backups } = deckPaths();
    const dir = kind === 'backups' ? backups : decks;
    shell.openPath(dir);
    return true;
  });
}
registerIpc();
registerDeckIpc();




