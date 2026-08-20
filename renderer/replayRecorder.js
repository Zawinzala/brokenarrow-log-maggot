// 录制窗口逻辑：抓桌面流（视频 + 可选系统声音）→ 按设定帧率抽帧画到 canvas → captureStream(fps) + MediaRecorder 产出 WebM
// 画布尺寸用 rec.computeCanvasSize（单一来源，来自 src/replayRecorder.js），绝不硬编码分辨率；
// 主进程发 stop 后把 Blob 转 ArrayBuffer 交回主进程落盘
(async () => {
  const rec = window.rec;
  const cfg = rec.getConfig() || {};
  let stream = null;
  let mr = null;
  let drawTimer = null;
  let previewTimer = null;
  let frameCount = 0;
  let discarded = false;
  let finalFid = cfg.fid || '';
  let finalMap = cfg.map || '';
  const video = document.getElementById('v');
  let started = false;

  // 参数归一化（与 config.js / src/replayRecorder.js 一致）
  const q = [240, 360, 480, 720, 1080].includes(Number(cfg.quality)) ? Number(cfg.quality) : 720;
  const fps = Math.min(60, Math.max(30, Math.round(Number(cfg.fps) || 30)));
  const bitrateMbps = Math.min(10, Math.max(3, Math.round(Number(cfg.bitrateMbps) || 5)));
  const audioMode = cfg.audio === 'off' ? 'off' : 'default';
  const SAMPLE_MS = Math.max(1, Math.round(1000 / fps)); // 采样间隔：30fps→33ms、60fps→17ms
  const VIDEO_BPS = bitrateMbps * 1000000;

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
      const videoConstraint = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId } };
      // 声音：'default' 时请求桌面音频回环（系统默认声卡输出）；失败自动降级纯视频
      let gotAudio = false;
      if (audioMode === 'default') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: videoConstraint
          });
          gotAudio = stream.getAudioTracks().length > 0;
        } catch (e) {
          try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
          stream = null;
        }
      }
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint });
      }
      video.srcObject = stream;
      await video.play();
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      // 画布尺寸单一来源：由传入 quality 计算（无硬编码分辨率）
      const size = rec.computeCanvasSize
        ? rec.computeCanvasSize(q, vw, vh, cfg.crop || null)
        : { width: Math.round(vw * q / vh), height: q, sx: 0, sy: 0, sw: vw, sh: vh };
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      try { ctx.drawImage(video, size.sx, size.sy, size.sw, size.sh, 0, 0, canvas.width, canvas.height); frameCount++; } catch (e) {}
      const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) ? 'video/webm;codecs=vp8' : 'video/webm';
      const cstream = canvas.captureStream(fps);
      // 关键修复：captureStream 只含视频轨道，必须把采集到的系统声音轨道接进去，否则 MediaRecorder 永远无声
      let hasAudio = false;
      if (gotAudio && stream.getAudioTracks().length) {
        try { cstream.addTrack(stream.getAudioTracks()[0]); hasAudio = cstream.getAudioTracks().length > 0; } catch (e) {}
      }
      mr = new MediaRecorder(cstream, { mimeType: mime, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: 128000 });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        if (discarded) return; // 丢弃时只清理，不交回数据
        try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        const blob = new Blob(chunks, { type: mime });
        const buf = await blob.arrayBuffer();
        try {
          await rec.save({ ok: true, fid: finalFid, map: finalMap, mime, data: buf, frames: frameCount, durationSec: Math.round(frameCount / fps), hasAudio, testMode: !!(cfg.testMode), uploaderId: (cfg && cfg.testUploaderId) || '' });
        } catch (e) { fail('save fail ' + String(e)); }
      };
      mr.start(1000);
      started = true;
      // 按设定帧率抽帧（30fps → 33ms、60fps → 17ms）
      drawTimer = setInterval(() => {
        try {
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, size.sx, size.sy, size.sw, size.sh, 0, 0, canvas.width, canvas.height);
          frameCount++;
          rec.progress({ fid: cfg.fid, seconds: frameCount / fps, frames: frameCount });
        } catch (e) {}
      }, SAMPLE_MS);

      // 录制预览：每秒把当前画面缩略图发给主界面（附声音状态，确认录的是哪块屏、有无声音）
      const pvMaxW = 320, pvMaxH = 180;
      const pvCanvas = document.createElement('canvas');
      previewTimer = setInterval(() => {
        try {
          if (!stream || !video || !video.videoWidth) return;
          const vw3 = video.videoWidth, vh3 = video.videoHeight;
          const sc = Math.min(pvMaxW / vw3, pvMaxH / vh3);
          pvCanvas.width = Math.max(1, Math.round(vw3 * sc));
          pvCanvas.height = Math.max(1, Math.round(vh3 * sc));
          const pctx = pvCanvas.getContext('2d');
          pctx.drawImage(video, 0, 0, pvCanvas.width, pvCanvas.height);
          rec.preview({ dataUrl: pvCanvas.toDataURL('image/jpeg', 0.5), hasAudio });
        } catch (e) {}
      }, 1000);

    } catch (e) {
      fail('start fail ' + String((e && e.message) || e));
    }
  }

  start();
})();
