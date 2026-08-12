// 录制窗口逻辑：抓桌面流 → 每 5 秒抽一帧画到 canvas → captureStream(1) + MediaRecorder 产出 1fps WebM
// 主进程发 stop 后把 Blob 转 ArrayBuffer 交回主进程落盘并入上传队列
(async () => {
  const rec = window.rec;
  const cfg = rec.getConfig();
  let stream = null;
  let mr = null;
  let drawTimer = null;
  let previewTimer = null;
  let frameCount = 0;
  let discarded = false;
  let finalFid = cfg ? (cfg.fid || '') : '';
  let finalMap = cfg ? (cfg.map || '') : '';
  const video = document.getElementById('v');
  let started = false;
  const SAMPLE_MS = 1000;   // 采样间隔：每 1 秒抓一帧（1 秒 1 帧）
  const SAMPLE_SEC = SAMPLE_MS / 1000;

  function fail(msg) {
    try { rec.save({ ok: false, error: String(msg) }); } catch (e) {}
  }

  // 先注册结束监听（无论采集是否成功，收到 stop 都能收尾，避免漏掉导致文件丢失）
  rec.onStop((d) => {
    if (d && d.fid) finalFid = String(d.fid);
    if (d && d.map) finalMap = String(d.map);
    if (drawTimer) clearInterval(drawTimer);
    if (previewTimer) clearInterval(previewTimer);
    if (d && d.discard) {
      discarded = true;
      try { if (mr && mr.state !== 'inactive') mr.stop(); } catch (e) {}
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      return;
    }
    if (!started) { try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {} return; }
    try { if (mr && mr.state !== 'inactive') mr.stop(); } catch (e) {}
  });

  async function start() {
    try {
      if (!cfg || !cfg.sourceId) { fail('no source'); return; }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId } }
      });
      video.srcObject = stream;
      await video.play();
      const q = cfg.quality === 1080 ? 1080 : cfg.quality === 480 ? 480 : 720;
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      // 裁剪：抓屏后只保留游戏窗口区域（隐私）；无裁剪则整屏
      const crop = cfg.crop || null;
      const sx = crop ? Math.max(0, Number(crop.x) || 0) : 0;
      const sy = crop ? Math.max(0, Number(crop.y) || 0) : 0;
      const sw = crop ? Math.max(1, Math.min(Number(crop.width) || vw, vw - sx)) : vw;
      const sh = crop ? Math.max(1, Math.min(Number(crop.height) || vh, vh - sy)) : vh;
      const targetH = q;
      const s = targetH / sh;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw * s);
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      // 立即画第一帧，避免视频开头黑屏
      try { ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height); frameCount++; } catch (e) {}
      const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) ? 'video/webm;codecs=vp8' : 'video/webm';
      const cstream = canvas.captureStream(1);
      // 码率：1fps 下 8Mbps，1080p 单帧清晰
      mr = new MediaRecorder(cstream, { mimeType: mime, videoBitsPerSecond: 8000000 });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        if (discarded) return; // 丢弃时只清理，不交回数据
        try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        const blob = new Blob(chunks, { type: mime });
        const buf = await blob.arrayBuffer();
        try {
          await rec.save({ ok: true, fid: finalFid, map: finalMap, mime, data: buf, frames: frameCount, durationSec: Math.round(frameCount * SAMPLE_SEC), testMode: !!(cfg && cfg.testMode), uploaderId: (cfg && cfg.testUploaderId) || '' });
        } catch (e) { fail('save fail ' + String(e)); }
      };
      mr.start(1000);
      started = true;
      // 每 1 秒抽一帧（游戏画面），1fps 视频每秒一帧
      drawTimer = setInterval(() => {
        try {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          frameCount++;
          rec.progress({ fid: cfg.fid, seconds: frameCount * SAMPLE_SEC, frames: frameCount });
        } catch (e) {}
      }, SAMPLE_MS);

      // 录制预览：每秒把当前画面缩略图发给主界面（对局录像模块内置小预览，确认录的是哪块屏）
      const pvMaxW = 320, pvMaxH = 180;
      const pvCanvas = document.createElement('canvas');
      const pctx = pvCanvas.getContext('2d');
      previewTimer = setInterval(() => {
        try {
          if (!stream || !video || !video.videoWidth) return;
          const vw3 = video.videoWidth, vh3 = video.videoHeight;
          const sc = Math.min(pvMaxW / vw3, pvMaxH / vh3);
          pvCanvas.width = Math.max(1, Math.round(vw3 * sc));
          pvCanvas.height = Math.max(1, Math.round(vh3 * sc));
          pctx.drawImage(video, 0, 0, pvCanvas.width, pvCanvas.height);
          rec.preview(pvCanvas.toDataURL('image/jpeg', 0.5));
        } catch (e) {}
      }, 1000);

    } catch (e) {
      fail('start fail ' + String((e && e.message) || e));
    }
  }

  start();
})();
