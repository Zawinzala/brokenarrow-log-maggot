// ================= 本地录像管理（userData/replays/*.webm） =================
// 云端录像上传后保留本地副本（不怕桶到期）；本模块只动本地文件，绝不碰云端。
const fs = require('fs');
const path = require('path');
const { parseReplayKey } = require('./s3Client');

const NAME_RE = /^[A-Za-z0-9_.-]+\.webm$/i;

function safeName(key) {
  const name = String(key || '').split(/[\\/]/).pop() || '';
  return NAME_RE.test(name) ? name : null;
}

// 扫描目录：返回 [{ id, fid, mapId, map, uploaderId, uploaderName, teamId, size, createdAt, localPath }]，时间倒序
function localReplayList(dir, mapName) {
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.webm')) continue;
      const meta = parseReplayKey(f);
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
      out.push({
        id: f,
        fid: meta ? meta.fid : f.replace(/\.webm$/i, ''),
        mapId: meta ? meta.mapId : null,
        map: meta && meta.mapId != null && mapName ? mapName(meta.mapId) : '',
        uploaderId: meta ? meta.uploaderId : '',
        uploaderName: meta ? meta.uploaderName : '',
        teamId: meta ? meta.teamId : null,
        size,
        createdAt: mtime || 0,
        localPath: full,
        source: 'local'
      });
    }
  } catch (e) {}
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function localReplayDelete(dir, key) {
  const name = safeName(key);
  if (!name) return { ok: false, message: '无效文件名' };
  const full = path.join(dir, name);
  try {
    if (!fs.existsSync(full)) return { ok: false, message: '文件不存在' };
    fs.unlinkSync(full);
    return { ok: true, message: '已删除本地录像' };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

// days>0 删 N 天前；days=0 全部删除。返回删除条数。
function localReplayClean(dir, days) {
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return removed;
    const cutoff = days > 0 ? Date.now() - days * 24 * 3600 * 1000 : Infinity;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.webm')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (days > 0 && st.mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
        removed++;
      } catch (e) {}
    }
  } catch (e) {}
  return removed;
}

function localReplayRead(dir, key) {
  const name = safeName(key);
  if (!name) return { ok: false, message: '无效文件名' };
  const full = path.join(dir, name);
  try {
    if (!fs.existsSync(full)) return { ok: false, message: '文件不存在' };
    const buf = fs.readFileSync(full);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { ok: true, data: ab, size: buf.length };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

module.exports = { localReplayList, localReplayDelete, localReplayClean, localReplayRead };
