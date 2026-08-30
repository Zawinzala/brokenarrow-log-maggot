// ================= 对局录像录制（只抓游戏窗口，隐私铁律） =================
// 对局开始（非回放）时创建一个移出屏幕的窗口，用 getUserMedia 抓主屏（每局结束后由用户确认是否保存并上传），
// 每 5 秒把当前画面画到 720p canvas，captureStream(1) + MediaRecorder 产出 1fps WebM；
// 对局结束由主进程发 stop，页面把 Blob 经 IPC 交回主进程落盘并入上传队列。
const path = require('path');
const fs = require('fs');

let electronMod = null;
try { electronMod = require('electron'); } catch (e) { electronMod = null; }

// 标题匹配游戏窗口（保留供单测/定位参考；录制源实际用鼠标所在显示器）
function matchGameSource(sources) {
  const arr = Array.isArray(sources) ? sources : [];
  const self = /断箭蛆工具|broken-arrow-log-assistant/i;
  const hit = arr.find((s) => s.id.startsWith('window:') && !self.test(s.name || '') && /^(broken\s*arrow|brokenarrow|断箭)/i.test(String(s.name || '').trim()));
  if (hit) return hit;
  return null;
}

// 录制源：优先「鼠标所在的显示器」（玩游戏时鼠标就在游戏屏上；纯 Electron 原生，不执行任何命令行，避免杀毒告警）
async function findCaptureSource(sources, displayId) {
  const arr = Array.isArray(sources) ? sources : [];
  const screens = arr.filter((s) => /^screen:/.test(s.id || ''));
  // 用户在多屏选择器里指定的显示器优先：先按源 ID（screen:N:0，最可靠），再按 display_id（旧版兼容）
  if (displayId) {
    const bySource = screens.find((s) => String(s.id) === String(displayId));
    if (bySource) return bySource;
    const byDisplay = screens.find((s) => s.display_id != null && String(s.display_id) === String(displayId));
    if (byDisplay) return byDisplay;
  }
  const primary = screens.find((s) => /^screen:0:/i.test(s.id || '')) || screens[0] || null;
  if (electronMod && electronMod.screen && typeof electronMod.screen.getCursorScreenPoint === 'function') {
    try {
      const pt = electronMod.screen.getCursorScreenPoint();
      const disp = electronMod.screen.getDisplayNearestPoint(pt);
      const hit = screens.find((s) => s.display_id != null && String(s.display_id) === String(disp.id));
      if (hit) return hit;
    } catch (e) {}
  }
  return primary;
}

// 参数归一化（非法值回落默认；与 config.js / 渲染层一致）
const REPLAY_QUALITIES = [240, 360, 480, 720, 1080];
function normQuality(q) {
  const n = Number(q);
  return REPLAY_QUALITIES.includes(n) ? n : 720;
}
function normFps(f) {
  const n = Number(f);
  return Number.isFinite(n) ? Math.min(60, Math.max(30, Math.round(n))) : 30;
}
function normBitrate(b) {
  const n = Number(b);
  return Number.isFinite(n) ? Math.min(10, Math.max(3, Math.round(n))) : 5;
}
function normAudio(a) {
  return a === 'off' ? 'off' : 'default';
}

// 画布尺寸单一来源：按画质档计算画布尺寸（保持画面比例，目标高；支持裁剪区域）
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
// 兼容旧导出
function scaleForQuality(quality, vw, vh) {
  const { width, height } = computeCanvasSize(quality, vw, vh, null);
  return { width, height };
}

class ReplayRecorder {
  constructor({ onStatus, onError, onLog }) {
    this.onStatus = onStatus || null;
    this.onError = onError || null;
    this.onLog = onLog || null;
    this.win = null;
    this.active = false;
    this.current = null;
    this.lastError = null;
    this._forceTimer = null;
    this.partPath = null; // 录制分片临时文件（主进程边收边写，避免大文件整段进内存）
  }

  status() {
    return { active: this.active, current: this.current ? { fid: this.current.fid, map: this.current.map, startedAt: this.current.startedAt, sourceId: this.current.sourceId || '' } : null };
  }

  async start({ fid, map, quality, fps, bitrateMbps, audio, testMode, testUploaderId, displayId, saveDir }) {
    this.abort();
    const desktopCapturer = electronMod && electronMod.desktopCapturer;
    const BrowserWindow = electronMod && electronMod.BrowserWindow;
    if (!desktopCapturer || !BrowserWindow) { this._error('Electron 桌面捕获组件不可用'); return { ok: false, message: 'no electron' }; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1, height: 1 } });
      this._log('桌面源共 ' + sources.length + ' 个: ' + sources.slice(0, 12).map((x) => x.id + '=' + (x.name || '').slice(0, 30)).join(' | '));
      const src = await findCaptureSource(sources, displayId);
      if (!src) { this._log('桌面源: ' + sources.map((x) => x.id + '=' + (x.name || '')).join(' | ')); this._error('未找到游戏窗口或屏幕源'); return { ok: false, message: 'no source' }; }
      const q = normQuality(quality);
      const f = normFps(fps);
      const br = normBitrate(bitrateMbps);
      const au = normAudio(audio);
      const cfgJson = JSON.stringify({ sourceId: src.id, fid: fid != null ? String(fid) : '', map: map || '', quality: q, fps: f, bitrateMbps: br, audio: au, testMode: !!testMode, testUploaderId: testUploaderId != null ? String(testUploaderId) : '' });
      // Windows WGC 采集在「隐藏窗口」里会 Failed to start capture（E_INVALIDARG）；
      // 改为「显示但移出屏幕」（不抢焦点、不进任务栏、关后台节流），确保采集会话能启动
      const win = new BrowserWindow({
        show: true,
        x: -32000, y: -32000,
        width: 8, height: 8,
        frame: false,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          preload: path.join(__dirname, '..', 'renderer', 'replayRecorderPreload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          additionalArguments: ['--rec-cfg=' + cfgJson]
        }
      });
      win.webContents.on('console-message', (e, level, message) => { if (level >= 2) this._error('录制窗口: ' + String(message || '').slice(0, 300)); });
      win.webContents.on('did-fail-load', (e, code, desc) => this._error('录制窗口加载失败: ' + code + ' ' + String(desc || '').slice(0, 200)));
      win.webContents.on('render-process-gone', (e, d) => this._error('录制窗口进程退出: ' + ((d && d.reason) || 'unknown')));
      win.on('closed', () => { if (this.win === win) this.win = null; });
      // 本局录制分片临时文件（主进程 replay:recorder:chunk 边收边写）
      try {
        if (this.partPath && fs.existsSync(this.partPath)) fs.unlinkSync(this.partPath);
      } catch (e) {}
      const partDir = String(saveDir || '').trim();
      this.partPath = path.join(partDir || require('os').tmpdir(), '.rec-part-' + Date.now() + '-' + String(fid != null ? fid : 'nofid') + '.webm');
      await win.loadFile(path.join(__dirname, '..', 'renderer', 'replayRecorder.html'));
      this.win = win;
      this.active = true;
      this.current = { fid: fid != null ? String(fid) : '', map: map || '', sourceId: src.id, quality: q, fps: f, bitrateMbps: br, audio: au, startedAt: Date.now(), testMode: !!testMode, displayId: displayId || null };
      this._log('录制窗口已创建，捕获源=' + src.id);
      this._emitStatus();
      return { ok: true };
    } catch (e) {
      this._log('start throw: ' + String((e && e.message) || e));
      this._error('启动录制失败: ' + String((e && e.message) || e));
      return { ok: false, message: String((e && e.message) || e) };
    }
  }

  // 正常结束：通知页面停止并交回数据（不关窗，等 save 后再关）
  // fid/map 可覆盖：matchStart 时常拿不到对局ID，matchEnd 时已确定，必须把真实 fid 传下来（否则存成 nofid_*.webm）
  stop(fid, map) {
    const win = this.win;
    const cur = this.current;
    if (!win) { this.active = false; this.current = null; this._emitStatus(); return; }
    try {
      win.webContents.send('replay:recorder:stop', {
        discard: false,
        fid: (fid != null && String(fid) !== '') ? String(fid) : (cur && cur.fid) || '',
        map: (map != null && String(map) !== '') ? String(map) : (cur && cur.map) || '',
        endTime: Date.now(),
        durationSec: cur ? Math.round((Date.now() - cur.startedAt) / 1000) : 0
      });
    } catch (e) {}
    this.active = false;
    this.current = null;
    this._emitStatus();
    // 兜底：30 秒内页面没保存成功就强制关窗（防泄漏）
    this._forceTimer = setTimeout(() => this.closeWindow(), 30000);
  }

  // 丢弃：本局无数字 fid / 回放等，不保存
  abort() {
    const win = this.win;
    if (win) {
      try { win.webContents.send('replay:recorder:stop', { discard: true, fid: this.current && this.current.fid, map: this.current && this.current.map }); } catch (e) {}
      const w = win;
      setTimeout(() => { try { w.destroy(); } catch (e) {} }, 2000);
    }
    if (this._forceTimer) { clearTimeout(this._forceTimer); this._forceTimer = null; }
    this._deletePart();
    this.win = null;
    this.active = false;
    this.current = null;
    this._emitStatus();
  }

  _deletePart() {
    if (this.partPath) { try { if (fs.existsSync(this.partPath)) fs.unlinkSync(this.partPath); } catch (e) {} this.partPath = null; }
  }

  closeWindow() {
    if (this._forceTimer) { clearTimeout(this._forceTimer); this._forceTimer = null; }
    if (this.win) { try { this.win.destroy(); } catch (e) {} this.win = null; }
    this.active = false;
    this.current = null;
    this._deletePart();
    this._emitStatus();
  }

  _emitStatus() { if (this.onStatus) { try { this.onStatus(this.status()); } catch (e) {} } }
  _log(msg) { if (this.onLog) { try { this.onLog(msg); } catch (e) {} } }
  _error(msg) { this.lastError = msg; if (this.onError) { try { this.onError(msg); } catch (e) {} } }
}

module.exports = { ReplayRecorder, matchGameSource, findCaptureSource, scaleForQuality, computeCanvasSize, normQuality, normFps, normBitrate, normAudio };
