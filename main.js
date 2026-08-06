// ================= Electron 主进程 =================
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Config, detectSteamLogDir } = require('./src/config');
const { LogParser } = require('./src/logParser');
const { LogWatcher } = require('./src/logWatcher');
const { BatraceClient, Cache, ApiUsage } = require('./src/batrace');
const { Heartbeat } = require('./src/heartbeat');
const { ApmTracker } = require('./src/apm');
const inputHook = require('./src/inputHook');
const { createDeckSync } = require('./src/deckSync');
const { spawn } = require('child_process');
const { Analyzer, mapName } = require('./src/analyzer');
const { MatchArchive } = require('./src/storage');
const { PlayerTracker } = require('./src/tracker');
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
let apm = null;          // 对局 APM 统计
let apmTimer = null;     // APM 实时推送定时器
let focusWatcher = null; // 游戏窗口前台监视（过滤非游戏输入）
let inputHookOk = false; // 输入钩子是否可用
let tracker = null;      // 玩家追踪库
let banTimer = null;     // 封禁检查定时器
let matchTimer = null;   // 本机对局同步定时器

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
  tracker = new PlayerTracker(path.join(app.getPath('userData'), 'players-db.json'));
  apm = new ApmTracker();
  focusWatcher = new FocusWatcher();
  inputHook.onEvent(() => {
    // 只统计“对局进行中 + 游戏窗口在前台”的输入；钩子按需在 matchStart 时启动
    if (apm && apm.active && focusWatcher.isFocused()) apm.feedInput();
  });
  heartbeat = new Heartbeat({
    url: config.get().heartbeatUrl || '',
    uidFile: path.join(app.getPath('userData'), 'heartbeat-uid.txt'),
    version: app.getVersion(),
    onStats: (stats) => send('heartbeat', stats)
  });
  if (config.get().heartbeatEnabled && heartbeat.url) heartbeat.start();

  deckSync = createDeckSync({
    getDirs: deckPaths,
    getSession: () => {
      const snap = parser.snapshot();
      return { key: snap.accountKey || null, name: snap.localName || '', loginSeen: !!snap.loginSeen };
    },
    getStateFile: () => path.join(app.getPath('userData'), 'deck-sync.json')
  });
  deckSync.init();
  setInterval(() => {
    const alert = deckSync.check();
    if (alert) send('deck:syncAlert', alert);
  }, 4000);
  createWindow();
  watcher.start();
  applyAutoQuery();
  checkVersion();
  startSyncTimers();
  send('budget', budgetPayload({}));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- APM / 焦点 / 卡组历史辅助 ----------------
function startApmTimer() {
  stopApmTimer();
  apmTimer = setInterval(() => {
    if (apm && apm.active) send('apm:live', apm.live());
  }, 5000);
}
function stopApmTimer() {
  if (apmTimer) { clearInterval(apmTimer); apmTimer = null; }
}

// 判断是否在回放历史日志（回放/历史日志时 APM 无法统计真实输入，直接提示不可用）
function isReplayLog() {
  try {
    const st = watcher.status();
    if (!st.file || !config.get().logDir) return false;
    const full = path.join(config.get().logDir, st.file);
    if (!fs.existsSync(full)) return false;
    return Date.now() - fs.statSync(full).mtimeMs > 120 * 1000;
  } catch (e) { return false; }
}

// 游戏窗口前台监视：常驻一个 PowerShell 进程，每 1s 输出前台窗口进程名
class FocusWatcher {
  constructor() {
    this.child = null;
    this.focused = false;
    this.ok = false;
    this._buf = '';
  }
  start() {
    this.stop();
    const script = "$s=@'\nusing System;\nusing System.Runtime.InteropServices;\npublic class W { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }\n'@\nAdd-Type $s; while($true){ [uint32]$p=0; $h=[W]::GetForegroundWindow(); [void][W]::GetWindowThreadProcessId($h,[ref]$p); $n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; if(-not $n){$n=''}; [Console]::Out.WriteLine($n); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1000 }";
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true });
    this.child.stdout.on('data', (d) => {
      this._buf += d.toString('utf8');
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const name = this._buf.slice(0, i).trim().toLowerCase();
        this._buf = this._buf.slice(i + 1);
        this.ok = true;
        this.focused = /broken.?arrow|broken_arrow/.test(name);
      }
    });
    this.child.on('error', () => { this.ok = false; });
    this.child.on('exit', () => { this.child = null; });
  }
  stop() {
    if (this.child) { try { this.child.kill(); } catch (e) {} this.child = null; }
  }
  isFocused() {
    // 监视未就绪时宽松放行（避免误杀真实输入）；就绪后严格过滤
    return this.ok ? this.focused : true;
  }
}

// 对局结束：自动把本局卡组备份进「历史使用卡组」
// ---------------- 解析器事件 ----------------
function onParserEvent(type, data) {
  if (type === 'matchStart') {
    // APM：仅当设置开启 + 输入钩子可用 + 非回放日志时才统计真实输入；
    // 其余情况直接提示“不可用”，不再降级为日志指令统计。
    const hookEnabled = !!(config.get().inputHookEnabled);
    if (!hookEnabled) {
      send('apm:start', { available: false, reason: 'disabled' });
    } else if (isReplayLog()) {
      send('apm:start', { available: false, reason: 'replay' });
    } else {
      if (!inputHookOk) inputHookOk = inputHook.start();
      if (!inputHookOk) {
        send('apm:start', { available: false, reason: 'hook' });
      } else {
        if (apm) apm.start();
        if (focusWatcher) focusWatcher.start();
        startApmTimer();
        send('apm:start', { available: true, map: data.map, fid: data.fid });
      }
    }
  } else if (type === 'matchEnd') {
    stopApmTimer();
    if (focusWatcher) focusWatcher.stop();
    if (apm && apm.active) {
      const r = apm.stop();
      if (r) {
        r.map = data.map;
        r.fid = data.fid;
        r.localDeck = data.localDeck;
        r.inputHook = true;
        r.focusFilter = !!(focusWatcher && focusWatcher.ok);
        send('apm:result', r);
      } else {
        send('apm:idle', {});
      }
    } else {
      send('apm:idle', {});
    }
    archive.add(data);
    tracker.recordLogMatch({ ...data, localName: parser.snapshot().localName });
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
    if (type === 'lobbyPlayers') {
      for (const [id, name] of Object.entries(data)) tracker.observe(id, name);
      applyLobbyAutoQuery();
    } else if (type === 'localName') {
      tracker.setLocalName(data);
    }
    send('session', parser.snapshot());
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
    for (const p of data.players || []) tracker.observe(p.id, p.name);
    const snap = parser.snapshot();
    if (snap.localName) {
      const me = (data.players || []).find((pl) => pl.name === snap.localName);
      if (me && me.id != null) tracker.setLocalId(me.id, me.name);
    }
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

// 查询对局玩家（每人 1 次 /api/analysis/player，跳过机器人/观战，去重）
// rosterOverride：传入显式名单（上一局）时查询该名单，否则查询当前对局/房间；prev 标记用于界面路由
async function queryCurrentMatch(rosterOverride) {
  const snap = parser.snapshot();
  const cur = snap.current;
  const isPrev = Array.isArray(rosterOverride);
  // 名单来源：显式名单（上一局）→ 已开战对局名单 → 未开战房间内玩家（Incoming client，ID 即 batrace ID）
  let roster = isPrev ? rosterOverride.slice() : ((cur && cur.players.length) ? cur.players : []);
  if (!roster.length && !isPrev) {
    for (const [uid, name] of Object.entries(snap.lobbyPlayers || {})) {
      roster.push({ id: uid, name, team: null });
    }
  }
  if (!roster.length) return;
  const fid = isPrev ? null : (cur ? cur.fid : null);
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
  const skipped = roster.length - capped.length;
  send('match:querying', { fid, players: capped, skipped, prev: isPrev });
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
    send('match:player', { ...row, prev: isPrev });
    send('budget', budgetPayload({ done, total: capped.length, skipped }));
  }
  send('match:done', { fid, count: capped.length, prev: isPrev });
  send('budget', budgetPayload({ done: capped.length, total: capped.length, skipped, finished: true }));
}


// ---------------- 玩家追踪：后台同步（封禁 + 本机对局） ----------------
function startSyncTimers() {
  stopSyncTimers();
  const cfg = config.get();
  if (cfg.banPollEnabled) {
    banTimer = setInterval(() => { syncBanList().catch(() => {}); }, 3600 * 1000);
    syncBanList().catch(() => {});
  }
  if (cfg.matchSyncEnabled) {
    matchTimer = setInterval(() => { syncMyMatches().catch(() => {}); }, 3600 * 1000);
    syncMyMatches().catch(() => {});
  }
}
function stopSyncTimers() {
  if (banTimer) { clearInterval(banTimer); banTimer = null; }
  if (matchTimer) { clearInterval(matchTimer); matchTimer = null; }
}

async function syncBanList() {
  if (!client || !tracker) return 0;
  try {
    const res = await client.leaderboardBan(500);
    const entries = (res && Array.isArray(res.leaderboard)) ? res.leaderboard : [];
    const newly = tracker.applyBanSnapshot(entries);
    const met = newly.filter((k) => tracker.hasPlayer(k)); // 只提醒之前遇到过的
    if (met.length) {
      showBanNotification(met); // 系统弹窗
      send('bans:alert', { players: met.map((k) => { const b = tracker.banInfo(k); return { id: k, name: (b && b.name) || k, rating: b ? b.rating : null }; }) }); // 醒目对话框
    }
    send('bans:changed', { list: tracker.listBans(), lastSync: tracker.data.lastBanSync, newly: newly.length });
    return newly.length;
  } catch (e) { /* 离线/失败静默，不打扰使用 */ return 0; }
}

function showBanNotification(newIds, namesMap) {
  try {
    const get = (k) => (namesMap && namesMap[k]) || (tracker.banInfo(k) && tracker.banInfo(k).name) || k;
    const names = newIds.map(get);
    let body = `检测到 ${newIds.length} 位你遇到过的新被封玩家：${names.slice(0, 6).join('、')}${names.length > 6 ? ' 等' : ''}`;
    if (Notification.isSupported()) {
      new Notification({ title: '🛡 封禁提醒', body }).show();
    }
  } catch (e) {}
}

// 我遇到过的被封玩家（含相遇对局摘要）
function cheatersList() {
  if (!tracker) return [];
  const out = [];
  for (const b of tracker.listBans()) {
    if (!tracker.hasPlayer(b.id)) continue;
    const ms = tracker.matchesFor(b.id);
    out.push({ id: b.id, name: b.name, rating: b.rating, firstSeenAt: b.firstSeenAt, matchCount: ms.length, matches: ms.slice(0, 30) });
  }
  return out;
}

// 取最近一场对局里的某个非本机玩家（测试封禁提醒模拟用）
function pickEncounteredPlayer() {
  if (!tracker) return null;
  const lid = tracker.data.localId;
  const matches = Object.values(tracker.data.matches).sort((a, b) => (b.endTime || b.firstSeenAt || 0) - (a.endTime || a.firstSeenAt || 0));
  for (const m of matches) {
    for (const p of m.players || []) {
      if (lid && String(p.id) === String(lid)) continue;
      if (p.id != null) return { id: String(p.id), name: p.name || '' };
    }
  }
  return null;
}

async function syncMyMatches() {
  if (!client || !tracker) return { ok: false, message: '未初始化' };
  const lid = tracker.data.localId;
  if (!lid) return { ok: false, message: '尚未检测到本机玩家 ID（未打对局），跳过同步' };
  try {
    const res = await client.playerMatchesRecent(lid, 10);
    const list = (res && Array.isArray(res.matches)) ? res.matches : [];
    if (list.length) {
      const r = tracker.upsertApiMatches(list);
      await backfillMissingWinners(list);
      send('matches:changed', { list: matchSummary() });
      return { ok: true, message: `同步完成：新增 ${r.added.length} 局、更新 ${r.updated.length} 局` };
    }
    return { ok: true, message: '同步完成（没有新对局）' };
  } catch (e) {
    return { ok: false, message: '同步失败：' + (e && e.message || e) };
  }
}

// 从 analysis/match 的 teamComparison 推导胜方 teamId（0=队伍A/1=队伍B）：
// 只认占点数（与网站一致；摧毁分不可靠，勿用）；占点相同则未知。
function winnerTeamFromMatch(raw) {
  const tc = raw && raw.teamComparison;
  if (!tc || !tc.teamATotals || !tc.teamBTotals) return null;
  const aObj = tc.teamATotals.objectivesCaptured;
  const bObj = tc.teamBTotals.objectivesCaptured;
  if (aObj == null || bObj == null || aObj === bObj) return null;
  return aObj > bObj ? 0 : 1;
}

// 对「players/matches 缺 WinnerTeam」的场次（多为自定义局），用 analysis/match 推导胜方并回填
async function backfillMissingWinners(matchList) {
  if (!Array.isArray(matchList) || !tracker) return;
  for (const raw of matchList) {
    const d = (raw && raw.data) || {};
    if (d.WinnerTeam != null) continue;
    const mid = raw && raw.matchId != null ? String(raw.matchId) : '';
    if (!mid || !/^\d+$/.test(mid)) continue;
    try {
      const am = await client.analysisMatchNoCount(mid);
      const wt = winnerTeamFromMatch(am);
      if (wt != null) tracker.setMatchWinner(mid, wt);
    } catch (e) { /* 单局失败跳过 */ }
  }
}

// 本地 matches 摘要（最近 500 局，不含 players，时间倒序）——对局档案卡片用
function matchSummary() {
  if (!tracker) return [];
  const out = [];
  for (const m of Object.values(tracker.data.matches)) {
    out.push({
      fid: m.fid,
      map: (m.map && !/^map:\d+$/.test(m.map)) ? m.map : (m.mapId != null ? mapName(m.mapId) : ''),
      endTime: m.endTime || m.firstSeenAt,
      durationSec: m.durationSec,
      localWon: m.localWon != null ? !!m.localWon : null,
      winnerTeam: m.winnerTeam != null ? m.winnerTeam : null,
      custom: m.custom,
      playerCount: m.players ? m.players.length : 0
    });
  }
  out.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  return out.slice(0, 500);
}

// 单局详情（含 players 与评分）——对局档案详情 / 上一局用
function matchDetail(fid) {
  const m = tracker && tracker.data.matches[String(fid)];
  if (!m) return null;
  return {
    fid: m.fid,
    map: (m.map && !/^map:\d+$/.test(m.map)) ? m.map : (m.mapId != null ? mapName(m.mapId) : ''),
    mapId: m.mapId,
    endTime: m.endTime || m.firstSeenAt,
    durationSec: m.durationSec,
    localWon: m.localWon != null ? !!m.localWon : null,
    winnerTeam: m.winnerTeam != null ? m.winnerTeam : null,
    localTeam: m.localTeam,
    custom: m.custom,
    players: (m.players || []).map((p) => ({ id: p.id, name: p.name, team: p.team, teamId: p.teamId, oldRating: p.oldRating, newRating: p.newRating }))
  };
}

// 玩家调查档案（相遇/胜负/改名史/封禁 + 最新 ELO + 最近 10 局 + 情报）
async function buildProfile(pid) {
  const id = String(pid);
  const beforeCalls = client ? (client.networkCalls || 0) : 0;
  const out = {
    id,
    player: (() => { const p = tracker.player(id); return p ? { id: p.id, names: p.names, firstSeen: p.firstSeen, lastSeen: p.lastSeen } : null; })(),
    stats: tracker.statsFor(id),
    encounters: tracker.encountersFor(id).slice(0, 50).map((e) => ({ ...e })),
    nameHistory: tracker.nameHistory(id).slice().reverse(),
    banned: tracker.isBanned(id),
    banInfo: tracker.banInfo(id),
    localId: tracker.data.localId,
    latestElo: null,
    latestEloMatch: null,
    recentMatches: [],
    info: null
  };
  for (const e of out.encounters) {
    const mm = /^map:(\d+)$/.exec(e.map || '');
    if (mm) e.map = mapName(Number(mm[1]));
  }
  // 最新 ELO + 最近 10 局：players/matches（30 分钟缓存、不计配额）；自定义局无评分 → 向前推
  try {
    const res = await client.playerMatchesRecent(id, 10);
    const list = (res && Array.isArray(res.matches)) ? res.matches : [];
    const recent = [];
    for (const raw of list) {
      const d = (raw && raw.data) || {};
      const data = (d.Data && typeof d.Data === 'object') ? d.Data : {};
      const me = data[id] || Object.values(data).find((x) => String(x.Id) === String(id));
      if (!me) continue;
      const oldR = typeof me.OldRating === 'number' ? me.OldRating : null;
      const newR = typeof me.NewRating === 'number' ? me.NewRating : null;
      const hasRating = oldR != null && newR != null;
      let won = null;
      if (hasRating) { if (newR > oldR) won = true; else if (newR < oldR) won = false; }
      const meTid = me.TeamId === 1 ? 1 : (me.TeamId === 100 ? null : 0); // 缺失 TeamId = 队伍A(0)
      if (won == null && d.WinnerTeam != null && meTid != null) won = (meTid === d.WinnerTeam);
      const mapId = d.MapId != null ? d.MapId : null;
      recent.push({
        fid: String(raw.matchId || ''),
        map: mapId != null ? mapName(mapId) : '',
        endTime: d.EndTime ? d.EndTime * 1000 : null,
        eloDelta: hasRating ? Math.round((newR - oldR) * 10) / 10 : null,
        won,
        teamId: meTid,
        custom: !hasRating
      });
    }
    out.recentMatches = recent;
    // 自定义/未知局补胜负：占点数推导（24h 缓存、不计配额）
    for (const m of out.recentMatches) {
      if (m.won != null || m.teamId == null || !m.fid || !/^\d+$/.test(m.fid)) continue;
      try {
        const am = await client.analysisMatchNoCount(m.fid);
        const wt = winnerTeamFromMatch(am);
        if (wt != null) m.won = (m.teamId === wt);
      } catch (e2) {}
    }
    for (const raw of list) {
      const d = (raw && raw.data) || {};
      const data = (d.Data && typeof d.Data === 'object') ? d.Data : {};
      const me = data[id] || Object.values(data).find((x) => String(x.Id) === String(id));
      if (me && typeof me.NewRating === 'number') {
        out.latestElo = Math.round(me.NewRating * 100) / 100;
        const mapId = d.MapId != null ? d.MapId : null;
        out.latestEloMatch = { fid: String(raw.matchId || ''), map: mapId != null ? mapName(mapId) : '', endTime: d.EndTime ? d.EndTime * 1000 : null };
        break;
      }
    }
  } catch (e) {}
  // 仍未知胜负的相遇（最多 5 场，最近优先）：拉 analysis/match 用占点数推导并持久化
  const pending = out.encounters.filter((e) => e.won == null && e.fid && /^\d+$/.test(e.fid));
  for (const e of pending.slice(0, 5)) {
    try {
      const am = await client.analysisMatchNoCount(e.fid);
      const wt = winnerTeamFromMatch(am);
      if (wt != null) {
        const won = tracker.setMatchWinner(e.fid, wt);
        if (won != null) e.won = won;
      }
    } catch (e2) {}
  }
  // 情报（胜率/偏好/最爱等，不含 ELO；ELO 以 players/matches 为准）
  try {
    const a = await client.analysisPlayer(id);
    const mini = analyzer.extractMini(a);
    if (mini) {
      out.info = { kd: mini.kd, winRate: mini.winRate, matchCount: mini.matchCount, category: mini.category, topUnits: mini.topUnits };
    }
  } catch (e) { out.info = null; }
  const afterCalls = client ? (client.networkCalls || 0) : 0;
  out.fromCache = (afterCalls === beforeCalls); // 本次调查是否纯缓存命中
  return out;
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
    // 输入钩子开关：关闭时立即停止全局钩子（反作弊最稳妥）
    if (next.inputHookEnabled !== before.inputHookEnabled) {
      if (!next.inputHookEnabled && inputHook) inputHook.stop();
      inputHookOk = false;
    }
    if (next.banPollEnabled !== before.banPollEnabled || next.matchSyncEnabled !== before.matchSyncEnabled) {
      startSyncTimers();
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

  ipcMain.handle('search:players', (e, q) => {
    return client.searchPlayers(q || '', 20).then((res) => {
      const list = (res && res.players) || [];
      for (const p of list) if (p && p.id != null) tracker.observe(p.id, p.name);
      return res;
    });
  });
  ipcMain.handle('report:player', async (e, stbid) => {
    const r = await analyzer.buildReport(stbid);
    if (r && r.stbid != null) tracker.observe(r.stbid, r.name || null);
    return r;
  });
  ipcMain.handle('report:maggot', async (e, stbid) => {
    const r = await analyzer.buildMaggotReport(stbid, (p) => send('maggot:progress', p));
    if (r && r.stbid != null) tracker.observe(r.stbid, null);
    return r;
  });
  ipcMain.handle('app:version', () => versionInfo || null);
  ipcMain.handle('usage:get', () => (usage ? { used24h: usage.count(), limit24h: usage.limit, calls: client ? client.networkCalls || 0 : 0 } : null));
  ipcMain.handle('heartbeat:get', () => (heartbeat ? heartbeat.stats : null));
  ipcMain.handle('heartbeat:ping', (e, url) => (heartbeat ? heartbeat.pingNow(url) : null));
  ipcMain.handle('match:queryCurrent', () => queryCurrentMatch());
  ipcMain.handle('match:queryRoster', (e, players) => queryCurrentMatch(players));
  ipcMain.handle('match:syncNow', () => syncMyMatches());

  ipcMain.handle('archive:list', () => archive.list().slice(0, 50));
  ipcMain.handle('archive:clear', () => { archive.clear(); return true; });

  // 玩家追踪
  ipcMain.handle('tracker:profile', (e, id) => buildProfile(String(id)));
  ipcMain.handle('tracker:getBans', () => (tracker ? { list: tracker.listBans(), lastSync: tracker.data.lastBanSync } : { list: [], lastSync: 0 }));
  ipcMain.handle('tracker:matches', () => ({ list: matchSummary() }));
  ipcMain.handle('tracker:cheaters', () => ({ list: cheatersList() }));
  ipcMain.handle('tracker:matchDetail', (e, fid) => matchDetail(fid));
  ipcMain.handle('tracker:syncBans', async () => {
    const newly = await syncBanList();
    return { list: tracker.listBans(), lastSync: tracker.data.lastBanSync, newly };
  });
  ipcMain.handle('test:banNotify', () => {
    const p = pickEncounteredPlayer();
    if (!p) return { ok: false, message: '本地还没有遇到过任何玩家，无法模拟' };
    showBanNotification([p.id], { [p.id]: p.name || ('玩家 ' + p.id) }); // 系统通知（尽力而为）
    send('bans:alert', { players: [{ id: p.id, name: p.name || ('玩家 ' + p.id), rating: null }] }); // 应用内对话框（一定可见）
    return { ok: true, message: `已模拟提醒：${p.name || p.id}（ID ${p.id}）被封` };
  });

  ipcMain.handle('shell:open', (e, url) => {
    if (/^https?:\/\//.test(url || '')) shell.openExternal(url);
    return true;
  });
}


// ---------------- 卡组工具 ----------------
// 卡组目录兼容性：不同用户机器上目录名/位置可能有差异，按候选顺序自动检测；
// Decks 是游戏数据目录，绝不自动创建（只在不存在时提示用户）。
let deckSync = null; // 在 whenReady 中创建（需要 parser 提供账号会话）

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
  const sync = path.join(base, 'DeckSync');
  try { fs.mkdirSync(backups, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(sync, { recursive: true }); } catch (e) {}
  return { decks, backups, sync, base, found: fs.existsSync(decks) };
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
    const { decks, backups, sync, base, found } = deckPaths();
    return {
      decks: listFiles(decks, '.dek'),
      backups: listFiles(backups, '.zip'),
      sync: listFiles(sync, '.dek'),
      decksDir: decks,
      backupsDir: backups,
      syncDir: sync,
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
    const { decks, backups, sync } = deckPaths();
    const dir = kind === 'backups' ? backups : kind === 'sync' ? sync : decks;
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

  // 把同步快照（上次账号卡组）全部同步回前线，同名覆盖
  ipcMain.handle('deck:syncRestore', () => {
    const count = deckSync.restoreAll();
    if (count > 0) send('deck:changed', { reason: 'sync-restore' });
    return { ok: count > 0, message: count > 0 ? `已同步 ${count} 个卡组到前线（同名已覆盖）` : '上一账号没有可同步的卡组', count };
  });

  // 忽略本次切换：把当前账号卡组存为新的同步快照（覆盖旧快照）
  ipcMain.handle('deck:syncIgnore', () => {
    deckSync.ignore();
    return { ok: true, message: '已忽略，以当前账号卡组为新基线（旧账号归档已保留）' };
  });

  // 关闭提醒：同一份快照不再重复提醒（不改动快照）
  ipcMain.handle('deck:syncDismiss', () => {
    deckSync.dismiss();
    return { ok: true };
  });

  ipcMain.handle('deck:openFolder', (e, kind) => {
    const { decks, backups, sync } = deckPaths();
    const dir = kind === 'backups' ? backups : kind === 'sync' ? sync : decks;
    shell.openPath(dir);
    return true;
  });
}
registerIpc();
registerDeckIpc();




