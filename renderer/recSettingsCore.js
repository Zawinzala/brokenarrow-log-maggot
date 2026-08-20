// ================= 录像设置纯函数（浏览器与单测共用） =================
// 浏览器：window.recCore；Node 单测：require('./renderer/recSettingsCore')
(function (root) {
  const QUALITIES = [240, 360, 480, 720, 1080];
  const core = {
    normQuality(q) { const n = Number(q); return QUALITIES.includes(n) ? n : 720; },
    normFps(f) { const n = Number(f); return Number.isFinite(n) ? Math.min(60, Math.max(30, Math.round(n))) : 30; },
    normBitrate(b) { const n = Number(b); return Number.isFinite(n) ? Math.min(10, Math.max(3, Math.round(n))) : 5; },
    normAudio(a) { return a === 'off' ? 'off' : 'default'; },
    // 采样间隔：30fps → 33ms、60fps → 17ms
    sampleMs(fps) { return Math.max(1, Math.round(1000 / core.normFps(fps))); },
    // 编码码率：直接按画质档（无 fps 特殊分支）
    videoBps(fps, bitrateMbps) { return core.normBitrate(bitrateMbps) * 1000000; },
    // 预计 45 分钟（2700s）文件大小：实测实际占用约为码率理论值的 1/2（×0.5）；
    // 声音约 128kbps → +43MB（实测接近，保留原值）
    estSize45(fps, bitrateMbps, audioOn) {
      const bps = core.normBitrate(bitrateMbps);
      const mb = bps / 8 * 2700 * 0.5;
      const audioMb = audioOn ? Math.round((128 / 8 * 2700) / 1000) : 0;
      return { mb: Math.round(mb), audioMb, bps };
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.recCore = core;
})(typeof window !== 'undefined' ? window : globalThis);
