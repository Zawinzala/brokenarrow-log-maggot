// ================= 对局录像上传队列（走 Cloudflare Worker，App 无 R2 密钥） =================
// 上传：POST {heartbeatUrl}/replay/upload?me=<uid>&key=<对象名>，body=WebM 字节；Worker 用 R2 binding 写桶并滚动 5GB。
// 失败进本地队列 replay-queue.json，下次启动 / 每小时重试（指数退避，最长 1 小时）。上传成功保留本地副本。
const fs = require('fs');
const { encodeReplayKey } = require('./s3Client');
const REPLAY_MAX_BYTES = 20 * 1024 * 1024; // 单文件上限 20MB（与 Worker 一致）

// 从本地录像文件名解析时间戳（fid__uid__teamId__mapId__ts__nameHex.webm），复用同一 ts 让重复上传同键幂等覆盖
function tsFromFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const parts = base.replace(/\.webm$/i, '').split('__');
  const ts = Number(parts[4]);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

class ReplayUploader {
  constructor({ dir, queueFile, getConfig, onChanged, httpImpl }) {
    this.dir = dir;
    this.queueFile = queueFile;
    this.getConfig = getConfig || (() => ({}));
    this.onChanged = onChanged || null;
    this.httpImpl = httpImpl || ((u, o) => fetch(u, o));
    this.queue = [];
    this.uploading = new Set();
    this.lastError = null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.queueFile)) {
        const raw = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
        this.queue = Array.isArray(raw) ? raw : [];
      }
    } catch (e) { this.queue = []; }
  }

  save() {
    try { fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2), 'utf8'); } catch (e) {}
  }

  _base() {
    return String(this.getConfig().heartbeatUrl || '').replace(/\/+$/, '');
  }

  // 入队：同一 (fid, uploaderId) 去重——重复上传时替换旧条目，不会产生两份
  enqueue(entry) {
    if (!entry || entry.fid == null || entry.uploaderId == null) return { ok: false, message: '缺少 fid/uploaderId' };
    if (!/^\d+$/.test(String(entry.fid))) return { ok: false, message: '非正数对局ID，禁止上传（测试/无效录像）' };
    if (Number(entry.size || 0) > REPLAY_MAX_BYTES) return { ok: false, message: '文件超过 20MB，禁止上传' };
    const key = String(entry.fid) + '|' + String(entry.uploaderId);
    const item = {
      fid: String(entry.fid),
      mapId: entry.mapId == null ? null : Number(entry.mapId),
      uploaderId: String(entry.uploaderId),
      uploaderName: entry.uploaderName || '',
      teamId: entry.teamId == null ? null : Number(entry.teamId),
      filename: entry.filename || (String(entry.fid) + '_' + Date.now() + '.webm'),
      localPath: entry.localPath || '',
      size: entry.size || 0,
      attempts: 0,
      nextTry: 0,
      lastError: null,
      _key: key
    };
    const idx = this.queue.findIndex((q) => q._key === key);
    const dedupe = idx >= 0;
    if (dedupe) this.queue[idx] = item; else this.queue.push(item);
    this.save();
    this.emit();
    return { ok: true, dedupe };
  }

  remove(fid, uploaderId) {
    const before = this.queue.length;
    if (uploaderId != null) {
      const key = String(fid) + '|' + String(uploaderId);
      this.queue = this.queue.filter((q) => q._key !== key);
    } else {
      this.queue = this.queue.filter((q) => String(q.fid) !== String(fid));
    }
    this.save();
    this.emit();
    return before - this.queue.length;
  }

  status() {
    return {
      pending: this.queue.length,
      uploading: this.uploading.size,
      lastError: this.lastError,
      queue: this.queue.map((q) => ({ fid: q.fid, uploaderId: q.uploaderId, uploaderName: q.uploaderName, size: q.size, attempts: q.attempts, nextTry: q.nextTry, lastError: q.lastError }))
    };
  }

  emit() { if (this.onChanged) { try { this.onChanged(this.status()); } catch (e) {} } }

  async flush() {
    const base = this._base();
    if (!base) {
      this.lastError = '未配置统计服务地址（Worker）';
      return { ok: false, message: this.lastError };
    }
    let done = 0;
    for (const item of this.queue.slice()) {
      if (this.uploading.has(item._key)) continue;
      if (item.nextTry && item.nextTry > Date.now()) continue;
      if (!item.localPath || !fs.existsSync(item.localPath)) {
        this.queue = this.queue.filter((q) => q._key !== item._key);
        this.save();
        continue;
      }
      this.uploading.add(item._key);
      try {
        const ok = await this.uploadOne(base, item);
        if (ok) {
          this.queue = this.queue.filter((q) => q._key !== item._key);
          this.save();
          done++;
        } else {
          this.bumpRetry(item, this.lastError || '上传失败');
        }
      } catch (e) {
        this.bumpRetry(item, String((e && e.message) || e));
      } finally {
        this.uploading.delete(item._key);
      }
    }
    if (done) this.emit();
    return { ok: done > 0, done, pending: this.queue.length };
  }

  bumpRetry(item, err) {
    item.attempts = (item.attempts || 0) + 1;
    item.lastError = err;
    item.nextTry = Date.now() + Math.min(60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, Math.min(4, item.attempts - 1)));
    this.save();
  }

  async uploadOne(base, item) {
    const objectKey = encodeReplayKey({
      fid: item.fid,
      uploaderId: item.uploaderId,
      uploaderName: item.uploaderName,
      teamId: item.teamId,
      mapId: item.mapId,
      ts: tsFromFilename(item.filename) || Date.now()
    });
    const data = fs.readFileSync(item.localPath);
    const url = base + '/replay/upload?me=' + encodeURIComponent(item.uploaderId) + '&key=' + encodeURIComponent(objectKey);
    const resp = await this.httpImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'video/webm', 'Content-Length': String(data.length) },
      body: data,
      signal: AbortSignal.timeout(120000)
    });
    let j = null;
    try { j = await resp.json(); } catch (e) {}
    if (!resp.ok || !j || !j.ok) {
      this.lastError = '上传失败: HTTP ' + resp.status + ((j && j.error) ? ' ' + j.error : '');
      return false;
    }
    // 成功：保留本地副本（断网也能看），不删除
    return true;
  }
}

// 上传者身份 = 该局 tracker 记录的 localPlayerId + 名字 + 队伍 + 地图；没有则不上传
function uploaderMetaFor(fid, tracker) {
  const mm = tracker && tracker.data && tracker.data.matches ? tracker.data.matches[String(fid)] : null;
  if (!mm) return { uploaderId: null, uploaderName: '', teamId: null, team: '', mapId: null, endTime: Date.now(), durationSec: 0 };
  const localPl = mm.localPlayerId != null && mm.players ? mm.players.find((p) => String(p.id) === String(mm.localPlayerId)) : null;
  const name = (localPl && localPl.name) || mm.localName || mm.localPersona || '';
  return {
    uploaderId: mm.localPlayerId != null ? String(mm.localPlayerId) : null,
    uploaderName: name || '',
    teamId: mm.localTeamId != null ? mm.localTeamId : null,
    team: mm.localTeam || (mm.localSpectator ? 'Spectators' : ''),
    mapId: mm.mapId != null ? mm.mapId : null,
    endTime: mm.endTime || Date.now(),
    durationSec: mm.durationSec || 0
  };
}

module.exports = { ReplayUploader, uploaderMetaFor, tsFromFilename, REPLAY_MAX_BYTES };
