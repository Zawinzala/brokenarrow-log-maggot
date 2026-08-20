// ================= 本地录像管理（userData/replays/*.webm） =================
// 本地录像管理（userData/replays/*.webm）：本模块只动本地文件。
const fs = require('fs');
const path = require('path');
const { parseReplayKey } = require('./s3Client');
const { mapIdFromName } = require('./analyzer');

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


// 上传者身份 = 该局 tracker 记录的 localPlayerId + 名字 + 队伍 + 地图；用于本地录像文件名编码（无则返回空）
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
    mapId: mm.mapId != null ? mm.mapId : mapIdFromName(mm.map),
    endTime: mm.endTime || Date.now(),
    durationSec: mm.durationSec || 0
  };
}

// 与对局档案/追踪库联动：按 fid 反查地图名等，避免录像文件 mapId 缺失时显示"未知地图"
function enrichReplayMaps(list, tracker, archive, mapName) {
  const archMap = {};
  try {
    const arr = (archive && typeof archive.list === 'function') ? archive.list() : (Array.isArray(archive) ? archive : []);
    for (const a of arr) { if (a && a.fid && archMap[String(a.fid)] == null) archMap[String(a.fid)] = a.map || ''; }
  } catch (e) {}
  return (list || []).map((it) => {
    const rec = tracker && tracker.data && tracker.data.matches ? tracker.data.matches[String(it.fid)] : null;
    const archMapName = archMap[String(it.fid)] || '';
    const trkMap = rec && rec.map && !/^map:\d+$/.test(rec.map) ? rec.map : '';
    const map = archMapName || trkMap || (it.mapId != null ? mapName(it.mapId) : it.map || '') || '';
    return Object.assign({}, it, {
      map,
      endTime: (rec && (rec.endTime || rec.firstSeenAt)) || it.createdAt || 0,
      mode: rec ? (rec.mode || null) : null,
      restarted: !!(rec && rec.restarted),
      localWon: rec && rec.localWon != null ? !!rec.localWon : null
    });
  });
}

module.exports = { localReplayList, localReplayDelete, localReplayClean, localReplayRead, uploaderMetaFor, enrichReplayMaps };
