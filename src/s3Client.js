// ================= 录像对象名编解码（对局录像用） =================
// 上传/列表/删除现在全部走 Cloudflare Worker（R2 binding），App 不再直连 S3，这里只保留对象名编解码。

// 录像对象名：replays/{fid}__{uploaderId}__{teamId}__{mapId}__{ts}__{nameHex}.webm
// nameHex = 上传者名字 UTF-8 的 hex（避免分隔符/特殊字符冲突）
function encodeReplayKey({ fid, uploaderId, uploaderName, teamId, mapId, ts }) {
  const nameHex = Buffer.from(String(uploaderName || ''), 'utf8').toString('hex');
  return 'replays/' + String(fid) + '__' + String(uploaderId) + '__' + (teamId == null ? '' : teamId) + '__' + (mapId == null ? '' : mapId) + '__' + (ts || Date.now()) + '__' + nameHex + '.webm';
}

function parseReplayKey(key) {
  const base = String(key || '').split('/').pop() || '';
  if (!base.endsWith('.webm')) return null;
  const parts = base.slice(0, -5).split('__');
  if (parts.length < 6) return null;
  const [fid, uploaderId, teamId, mapId, ts, nameHex] = parts;
  let uploaderName = '';
  try { uploaderName = Buffer.from(nameHex, 'hex').toString('utf8'); } catch (e) {}
  return {
    key,
    fid,
    uploaderId,
    teamId: teamId === '' ? null : Number(teamId),
    mapId: mapId === '' ? null : Number(mapId),
    ts: Number(ts) || 0,
    uploaderName
  };
}

module.exports = { encodeReplayKey, parseReplayKey };
