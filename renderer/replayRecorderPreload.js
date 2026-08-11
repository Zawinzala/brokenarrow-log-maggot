// 录制窗口专用 preload：只暴露录制相关的最小接口
const { contextBridge, ipcRenderer } = require('electron');
let cfg = null;
try {
  const i = process.argv.findIndex((a) => a.startsWith('--rec-cfg='));
  if (i >= 0) cfg = JSON.parse(process.argv[i].slice('--rec-cfg='.length));
} catch (e) { cfg = null; }
contextBridge.exposeInMainWorld('rec', {
  getConfig: () => cfg,
  onStop: (cb) => ipcRenderer.on('replay:recorder:stop', (e, d) => cb(d)),
  save: (payload) => ipcRenderer.invoke('replay:recorder:save', payload),
  progress: (p) => ipcRenderer.send('replay:recorder:progress', p),
  preview: (dataUrl) => ipcRenderer.send('replay:recorder:preview', dataUrl)
});
