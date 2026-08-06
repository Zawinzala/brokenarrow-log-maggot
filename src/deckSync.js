// ================= 卡组自动同步（v4，按登录玩家名） =================
// v3 用日志里的“storage 哈希”当账号身份，实测该哈希对同一台机器恒定、
// 不随 Steam 账号变化，导致换号永不触发。v4 改用日志里的登录玩家名：
//   - 玩家名变 = 切换了 Steam 账号 → 提醒（与卡组内容无关）。
//   - 快照按账号分文件夹归档 DeckSync/<玩家名>/，来回切号互不覆盖。
//   - 同一账号会话内持续滚动镜像，游戏内改卡组也能跟上。
const fs = require('fs');
const path = require('path');

function isDeck(f) { return typeof f === 'string' && f.toLowerCase().endsWith('.dek'); }

function listDeckNames(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(isDeck);
  } catch (e) { return []; }
}

function setKey(names) { return Array.from(names).sort().join('|'); }

// 目录内容指纹（文件名+大小+修改时间），用于避免每次都做镜像
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

// 玩家名 → 安全文件夹名（去路径分隔符/保留字，限长，空则 unknown）
function sanitizeAccount(name) {
  const s = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  return s || 'unknown';
}

// createDeckSync({ getDirs, getSession, getStateFile })
//   getDirs:       () => ({ decks, sync, found })
//   getSession:    () => ({ key, name, loginSeen })  key = 账号身份（persona:<玩家名>）或 null
//   getStateFile:  () => 状态文件路径（持久化“当前账号”）
function createDeckSync({ getDirs, getSession, getStateFile } = {}) {
  if (typeof getDirs !== 'function') throw new Error('deckSync: getDirs required');
  const state = { key: '', name: '', alertedKey: '', lastMirrorKey: '' };

  function loadState() {
    try {
      if (typeof getStateFile !== 'function') return;
      const f = getStateFile();
      if (f && fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (raw && typeof raw.key === 'string') {
          // v4 迁移：只接受 persona: 前缀的 key，旧的哈希 key 直接丢弃（首启采纳当前账号）
          if (raw.key.startsWith('persona:')) { state.key = raw.key; state.name = raw.name || ''; }
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
      fs.writeFileSync(f, JSON.stringify({ key: state.key, name: state.name, savedAt: Date.now() }), 'utf8');
    } catch (e) {}
  }

  // 某账号的归档目录 = DeckSync/<安全玩家名>
  function archiveDir(sync, key) {
    const persona = String(key || '').replace(/^persona:/, '');
    return path.join(sync, sanitizeAccount(persona));
  }

  // 把 Decks 完整镜像到指定归档（清空旧的，复制当前的）
  function mirror(decks, archive) {
    try { fs.mkdirSync(archive, { recursive: true }); } catch (e) { return; }
    for (const f of listDeckNames(archive)) {
      try { fs.unlinkSync(path.join(archive, f)); } catch (e) {}
    }
    let n = 0;
    for (const f of listDeckNames(decks)) {
      try { fs.copyFileSync(path.join(decks, f), path.join(archive, f)); n++; } catch (e) {}
    }
    state.lastMirrorKey = sigKey(decks);
    return n;
  }

  function init() {
    loadState();
    state.alertedKey = '';
    state.lastMirrorKey = '';
  }

  // 周期检测：返回提醒数据或 null
  function check() {
    const { decks, sync, found } = getDirs();
    if (!found) return null;
    const session = typeof getSession === 'function' ? getSession() : null;
    const k = session && session.key;
    if (!k) return null; // 无可识别的账号会话（游戏未运行/日志无玩家名）→ 不动

    const archive = archiveDir(sync, k);

    if (!state.key) {
      // 首启/升级迁移：采纳当前账号，建立该账号归档
      mirror(decks, archive);
      state.key = k;
      state.name = session.name || '';
      saveState();
      return null;
    }

    if (state.key !== k) {
      // 账号切换：冻结并提醒一次（同一对账号只提醒一次）
      const pair = state.key + '>' + k;
      if (state.alertedKey !== pair) {
        state.alertedKey = pair;
        const prevArchive = archiveDir(sync, state.key);
        const names = listDeckNames(prevArchive);
        return { count: names.length, names: names.slice(0, 40), from: state.name, to: session.name || '' };
      }
      return null;
    }

    // 同一账号会话：滚动镜像（内容变化才写）
    if (state.lastMirrorKey !== sigKey(decks)) {
      mirror(decks, archive);
    }
    state.name = session.name || '';
    saveState();
    state.alertedKey = '';
    return null;
  }

  // 一键同步回来：把上一账号归档全部复制回前线（同名覆盖），随后采纳当前账号
  function restoreAll() {
    const { decks, sync } = getDirs();
    const session = typeof getSession === 'function' ? getSession() : null;
    const k = session && session.key;
    if (!k) return 0;
    let count = 0;
    if (state.key && state.key !== k) {
      const prevArchive = archiveDir(sync, state.key);
      for (const f of listDeckNames(prevArchive)) {
        try { fs.copyFileSync(path.join(prevArchive, f), path.join(decks, f)); count++; } catch (e) {}
      }
    }
    const archive = archiveDir(sync, k);
    mirror(decks, archive);
    state.key = k;
    state.name = session.name || '';
    saveState();
    state.alertedKey = '';
    return count;
  }

  // 忽略本次切换：采纳当前账号为基线（上一账号归档保留在磁盘，不删除）
  function ignore() {
    const { decks, sync } = getDirs();
    const session = typeof getSession === 'function' ? getSession() : null;
    const k = session && session.key;
    if (!k) return;
    mirror(decks, archiveDir(sync, k));
    state.key = k;
    state.name = session.name || '';
    saveState();
    state.alertedKey = '';
  }

  // 仅关闭提醒：不动任何归档
  function dismiss() {
    const session = typeof getSession === 'function' ? getSession() : null;
    const k = session && session.key;
    if (state.key && k) state.alertedKey = state.key + '>' + k;
  }

  return { state, init, check, restoreAll, ignore, dismiss, syncFileNames: listDeckNames };
}

module.exports = { createDeckSync, listDeckNames, setKey, sigKey, sanitizeAccount };