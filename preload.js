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
  pingHeartbeat: () => ipcRenderer.invoke('heartbeat:ping'),
  onHeartbeat: (cb) => ipcRenderer.on('heartbeat', (e, d) => cb(d)),

  // 档案
  getArchive: () => ipcRenderer.invoke('archive:list'),
  clearArchive: () => ipcRenderer.invoke('archive:clear'),
  onArchiveChanged: (cb) => ipcRenderer.on('archive:changed', (e, d) => cb(d)),

  // 外部链接
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // 卡组工具
  getDeckPaths: () => ipcRenderer.invoke('deck:paths'),
  listDecks: () => ipcRenderer.invoke('deck:list'),
  backupDecks: (names, packageName) => ipcRenderer.invoke('deck:backup', { names, packageName }),
  deployDecks: (packageName) => ipcRenderer.invoke('deck:deploy', packageName),
  deleteDecks: (kind, names) => ipcRenderer.invoke('deck:delete', { kind, names }),
  openDeckFolder: (kind) => ipcRenderer.invoke('deck:openFolder', kind)
});

