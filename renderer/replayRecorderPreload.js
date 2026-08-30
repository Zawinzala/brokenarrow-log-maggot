// 录制窗口专用 preload：只暴露录制相关的最小接口
const { contextBridge, ipcRenderer } = require('electron');
let cfg = null;
try {
  const i = process.argv.findIndex((a) => a.startsWith('--rec-cfg='));
  if (i >= 0) cfg = JSON.parse(process.argv[i].slice('--rec-cfg='.length));
} catch (e) { cfg = null; }
// 画布尺寸计算纯函数：与 src/replayRecorder.js 保持一致，但避免在沙箱 preload 里 require 外部文件。
function normQuality(q) {
  const n = Number(q);
  return [240, 360, 480, 720, 1080].includes(n) ? n : 720;
}
function computeCanvasSize(quality, vw, vh, crop) {
  const targetH = normQuality(quality);
  const W = Number(vw) || 1280;
  const H = Number(vh) || 720;
  const c = crop || null;
  const sx = c ? Math.max(0, Number(c.x) || 0) : 0;
  const sy = c ? Math.max(0, Number(c.y) || 0) : 0;
  const sw = c ? Math.max(1, Math.min(Number(c.width) || W, W - sx)) : W;
  const sh = c ? Math.max(1, Math.min(Number(c.height) || H, H - sy)) : H;
  const scale = targetH / sh;
  return { width: Math.round(sw * scale), height: targetH, sx, sy, sw, sh };
}

contextBridge.exposeInMainWorld('rec', {
  getConfig: () => cfg,
  computeCanvasSize: (q, vw, vh, crop) => computeCanvasSize(q, vw, vh, crop),
  onStop: (cb) => ipcRenderer.on('replay:recorder:stop', (e, d) => cb(d)),
  save: (payload) => ipcRenderer.invoke('replay:recorder:save', payload),
  chunk: (data) => ipcRenderer.send('replay:recorder:chunk', data),
  progress: (p) => ipcRenderer.send('replay:recorder:progress', p),
  preview: (payload) => ipcRenderer.send('replay:recorder:preview', payload)
});
