// ================= 卡组「上一局卡组包」唯一自动备份（v5） =================
// v5 与 v4 的核心差异：
//   - 不再按账号分文件夹镜像归档（DeckSync/<账号>/ 不再写入；旧文件夹保留磁盘，
//     仅「删除账号数据」时按需清理）。
//   - 只有唯一一个旋转包 DeckBackups/上一局卡组包.zip：每局游戏开始（matchStart，
//     非回放）自动用当前前线卡组覆盖它；换号后即使不点替换，打一把也会覆盖成新号卡组。
//   - 替换提醒：当「上一局卡组包」属于换号前的账号且本局尚未覆盖时，提醒一次/对，
//     文案「是否替换成换号前（ID：XXX）的上一局的卡组包？」；对局开始覆盖包后自然不再提醒。
const fs = require('fs');
const path = require('path');
const { zipCreate, zipExtract } = require('./zip');

const PKG_NAME = '上一局卡组包.zip';

function isDeck(f) { return typeof f === 'string' && f.toLowerCase().endsWith('.dek'); }

function listDeckNames(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(isDeck);
  } catch (e) { return []; }
}

// 纯文件名安全校验（与 main.js 一致：不允许路径分隔符/上级目录）
function safeFileName(name) {
  if (typeof name !== 'string' || !name) return null;
  const base = path.basename(name);
  if (base !== name || name.includes('..') || /[\\/]/.test(name)) return null;
  return base;
}

// 玩家名 → 安全文件夹名（去路径分隔符/保留字，限长，空则 unknown）
function sanitizeAccount(name) {
  const s = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  return s || 'unknown';
}

function setKey(names) { return Array.from(names).sort().join('|'); }
function sigKey(dir) {
  return listDeckNames(dir)
    .map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return f + ':' + st.size + ':' + st.mtimeMs;
      } catch (e) { return f + ':err'; }
    })
    .sort()
    .join('|');
}

// createDeckSync({ getDirs, getSession, getStateFile })
//   getDirs:       () => ({ decks, backups, sync, found })
//   getSession:    () => ({ key, name, loginSeen })  key = 账号身份（persona:<玩家名>）或 null
//   getStateFile:  () => 状态文件路径（持久化“上一局卡组包”归属与提醒对）
function createDeckSync({ getDirs, getSession, getStateFile } = {}) {
  if (typeof getDirs !== 'function') throw new Error('deckSync: getDirs required');
  const state = { pkgKey: '', pkgName: '', pkgFid: null, pkgUpdatedAt: 0, alertedPairs: [] };

  function loadState() {
    try {
      if (typeof getStateFile !== 'function') return;
      const f = getStateFile();
      if (f && fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (raw.pkgKey != null) state.pkgKey = raw.pkgKey;
          if (raw.pkgName != null) state.pkgName = raw.pkgName;
          if (raw.pkgFid != null) state.pkgFid = raw.pkgFid;
          if (raw.pkgUpdatedAt != null) state.pkgUpdatedAt = raw.pkgUpdatedAt;
          if (Array.isArray(raw.alertedPairs)) state.alertedPairs = raw.alertedPairs;
        }
      }
    } catch (e) {}
  }
  function saveState() {
    try {
      if (typeof getStateFile !== 'function') return;
      const f = getStateFile();
      if (!f) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ pkgKey: state.pkgKey, pkgName: state.pkgName, pkgFid: state.pkgFid, pkgUpdatedAt: state.pkgUpdatedAt, alertedPairs: state.alertedPairs }, null, 2), 'utf8');
    } catch (e) {}
  }

  function pkgPath() {
    const { backups } = getDirs();
    return path.join(backups, PKG_NAME);
  }

  // 包内 .dek 名单（读 zip；只在一对提醒时调用一次，频率很低）
  function pkgEntries() {
    try {
      const p = pkgPath();
      if (!fs.existsSync(p)) return [];
      return zipExtract(fs.readFileSync(p))
        .map((en) => safeFileName(en.name))
        .filter((f) => f && isDeck(f));
    } catch (e) { return []; }
  }

  function init() { loadState(); }

  // 每局开始：用当前前线卡组覆盖唯一「上一局卡组包」；Decks 缺失/为空则跳过
  function onMatchStart({ fid } = {}) {
    const { decks, backups, found } = getDirs();
    if (!found) return { ok: false, reason: 'nodecks' };
    const names = listDeckNames(decks);
    if (!names.length) return { ok: false, reason: 'empty' };
    try {
      fs.mkdirSync(backups, { recursive: true });
      const files = names.map((f) => ({ name: f, data: fs.readFileSync(path.join(decks, f)) }));
      fs.writeFileSync(pkgPath(), zipCreate(files));
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    const session = typeof getSession === 'function' ? getSession() : null;
    state.pkgKey = (session && session.key) || state.pkgKey;
    state.pkgName = (session && session.name) || state.pkgName;
    state.pkgFid = fid != null ? String(fid) : state.pkgFid;
    state.pkgUpdatedAt = Date.now();
    state.alertedPairs = []; // 新基线：换号前的包已被本局覆盖，不再提醒
    saveState();
    return { ok: true, count: names.length };
  }

  // 周期检测：包属于换号前账号且本局尚未覆盖 → 提醒一次/对
  function check() {
    const { found } = getDirs();
    if (!found) return null;
    const session = typeof getSession === 'function' ? getSession() : null;
    const k = session && session.key;
    if (!k) return null; // 无可识别的账号会话（游戏未运行/日志无玩家名）→ 不动
    if (!state.pkgKey || state.pkgKey === k) return null; // 无包 / 包属于当前账号 → 不提醒
    if (!fs.existsSync(pkgPath())) return null; // 包已被删除 → 无从替换
    const pair = state.pkgKey + '>' + k;
    if (state.alertedPairs.includes(pair)) return null; // 同一对只提醒一次
    state.alertedPairs.push(pair);
    const names = pkgEntries();
    saveState();
    return { count: names.length, names: names.slice(0, 40), from: state.pkgName || state.pkgKey, to: session.name || '', pkgFid: state.pkgFid, pair };
  }

  // 替换：把「上一局卡组包」写回前线（同名覆盖）；不更新包本身
  function replaceAll() {
    const { decks, found } = getDirs();
    if (!found) return 0;
    const p = pkgPath();
    if (!fs.existsSync(p)) return 0;
    let count = 0;
    try {
      const entries = zipExtract(fs.readFileSync(p));
      for (const en of entries) {
        const fn = safeFileName(en.name);
        if (!fn || !isDeck(fn)) continue;
        fs.writeFileSync(path.join(decks, fn), en.data);
        count++;
      }
    } catch (e) { return count; }
    return count;
  }

  // 忽略/关闭提醒：仅保证同一对不再提醒（check 已记录 pair，无需额外动作）
  function ignore() { return true; }
  function dismiss() { return true; }

  return { state, init, check, onMatchStart, replaceAll, ignore, dismiss, pkgName: () => PKG_NAME, syncFileNames: listDeckNames };
}

module.exports = { createDeckSync, listDeckNames, setKey, sigKey, sanitizeAccount };
