// ================= 预加载脚本（渲染进程安全桥接） =================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  selectDir: () => ipcRenderer.invoke('config:selectDir'),
  detectDir: () => ipcRenderer.invoke('config:detectDir'),
  validateDir: (dir) => ipcRenderer.invoke('config:validateDir', dir),

  // 日志/会话
  getWatcherStatus: () => ipcRenderer.invoke('watcher:status'),
  getSession: () => ipcRenderer.invoke('session:get'),
  onSession: (cb) => ipcRenderer.on('session', (e, d) => cb(d)),
  onWatcher: (cb) => ipcRenderer.on('watcher', (e, d) => cb(d)),

  // 当前对局查询
  queryCurrentMatch: () => ipcRenderer.invoke('match:queryCurrent'),
  queryRoster: (players) => ipcRenderer.invoke('match:queryRoster', players),
  onMatchQuerying: (cb) => ipcRenderer.on('match:querying', (e, d) => cb(d)),
  onMatchPlayer: (cb) => ipcRenderer.on('match:player', (e, d) => cb(d)),
  onMatchDone: (cb) => ipcRenderer.on('match:done', (e, d) => cb(d)),
  onBudget: (cb) => ipcRenderer.on('budget', (e, d) => cb(d)),

  // 查询
  searchPlayers: (q) => ipcRenderer.invoke('search:players', q),
  playerReport: (stbid) => ipcRenderer.invoke('report:player', stbid),
  maggotReport: (stbid) => ipcRenderer.invoke('report:maggot', stbid),
  onMaggotProgress: (cb) => ipcRenderer.on('maggot:progress', (e, d) => cb(d)),

  // 版本
  getVersion: () => ipcRenderer.invoke('app:version'),
  onVersion: (cb) => ipcRenderer.on('version', (e, d) => cb(d)),

  // API 用量 + 心跳
  getUsage: () => ipcRenderer.invoke('usage:get'),
  getHeartbeat: () => ipcRenderer.invoke('heartbeat:get'),
  pingHeartbeat: (url) => ipcRenderer.invoke('heartbeat:ping', url),
  onHeartbeat: (cb) => ipcRenderer.on('heartbeat', (e, d) => cb(d)),
  getApiHealth: () => ipcRenderer.invoke('api:health'),
  onApiHealth: (cb) => ipcRenderer.on('api:health', (e, d) => cb(d)),

  // 档案
  getArchive: () => ipcRenderer.invoke('archive:list'),
  clearArchive: () => ipcRenderer.invoke('archive:clear'),
  onArchiveChanged: (cb) => ipcRenderer.on('archive:changed', (e, d) => cb(d)),

  // 玩家追踪
  getPlayerProfile: (id) => ipcRenderer.invoke('tracker:profile', id),
  getBans: () => ipcRenderer.invoke('tracker:getBans'),
  syncBans: () => ipcRenderer.invoke('tracker:syncBans'),
  testBanNotify: () => ipcRenderer.invoke('test:banNotify'),
  testVersionUpdate: () => ipcRenderer.invoke('test:versionUpdate'),
  syncMyMatchesNow: () => ipcRenderer.invoke('match:syncNow'),
  getTrackerMatches: () => ipcRenderer.invoke('tracker:matches'),
  getMatchDetail: (fid) => ipcRenderer.invoke('tracker:matchDetail', fid),
  refreshMatch: (fid) => ipcRenderer.invoke('tracker:refreshMatch', fid),
  onBansChanged: (cb) => ipcRenderer.on('bans:changed', (e, d) => cb(d)),
  onBanAlert: (cb) => ipcRenderer.on('bans:alert', (e, d) => cb(d)),
  getCheaters: () => ipcRenderer.invoke('tracker:cheaters'),
  listAccounts: () => ipcRenderer.invoke('tracker:listAccounts'),
  deleteAccount: (id) => ipcRenderer.invoke('tracker:deleteAccount', id),
  onMatchesChanged: (cb) => ipcRenderer.on('matches:changed', (e, d) => cb(d)),

  // 外部链接
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // 卡组工具
  getDeckPaths: () => ipcRenderer.invoke('deck:paths'),
  listDecks: () => ipcRenderer.invoke('deck:list'),
  backupDecks: (names, packageName) => ipcRenderer.invoke('deck:backup', { names, packageName }),
  deployDecks: (packageName) => ipcRenderer.invoke('deck:deploy', packageName),
  deleteDecks: (kind, names) => ipcRenderer.invoke('deck:delete', { kind, names }),
  syncRestore: () => ipcRenderer.invoke('deck:syncRestore'),
  syncIgnore: () => ipcRenderer.invoke('deck:syncIgnore'),
  syncDismiss: () => ipcRenderer.invoke('deck:syncDismiss'),
  openDeckFolder: (kind) => ipcRenderer.invoke('deck:openFolder', kind),
  onDeckChanged: (cb) => ipcRenderer.on('deck:changed', (e, d) => cb(d)),
  onDeckSyncAlert: (cb) => ipcRenderer.on('deck:syncAlert', (e, d) => cb(d)),

  // APM 统计
  onApmStart: (cb) => ipcRenderer.on('apm:start', (e, d) => cb(d)),
  onApmLive: (cb) => ipcRenderer.on('apm:live', (e, d) => cb(d)),
  onApmResult: (cb) => ipcRenderer.on('apm:result', (e, d) => cb(d)),
  onApmIdle: (cb) => ipcRenderer.on('apm:idle', (e, d) => cb(d))
});

