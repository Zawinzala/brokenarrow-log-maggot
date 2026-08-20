const fs = require('fs');
const path = require('path');

const MAX_MATCHES = 500;      // matches 表上限（按对局时间淘汰）
const MAX_PLAYERS = 5000;     // players 表上限（按最近出现淘汰）
const NUM_FID = /^\d+$/;

// 本地玩家追踪库 v2：以「对局」为中心，对局 ID 为唯一键。
// matches: fid -> { fid, mapId, map, endTime, durationSec, winnerTeam(0|1|null), localWon(bool|null), localTeam, custom(bool|null), players:[{id,name,teamId,team,oldRating,newRating}], source, firstSeenAt, syncedAt }
// players: id -> { id, names:[{name,firstSeen,lastSeen}], firstSeen, lastSeen, lobbySeen }
// knownBans: id -> { id, name, steamId, rating, firstSeenAt, lastSeenAt, encountered }
class PlayerTracker {
  constructor(file) {
    this.file = file;
    this.data = {
      version: 2,
      matches: {},
      players: {},
      knownBans: {},
      playerSnapshots: {}, // id -> { id, name, elo, winRate, category, matchCount, kd, at }（离线兜底用）
      localAccounts: {}, // 本机所有账号：id -> { id, name, persona, firstSeen, lastSeen }
      localId: null,     // 最近活跃主账号
      lastBanSync: 0,
      lastMatchSync: 0
    };
    this._localName = null;
    this._multiAccountBond = true; // 多账号联动羁绊检查（换号也视为同一人），默认开
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (raw.matches && typeof raw.matches === 'object') {
            this.data.matches = raw.matches || {};
            this.data.players = raw.players || {};
            this.data.knownBans = raw.knownBans || {};
            this.data.playerSnapshots = raw.playerSnapshots || {};
            this.data.localAccounts = raw.localAccounts || {};
            this.data.localId = raw.localId || null;
            this.data.lastBanSync = raw.lastBanSync || 0;
            this.data.lastMatchSync = raw.lastMatchSync || 0;
          } else {
            this._migrateV1(raw); // 旧版（按玩家的 encounters）→ v2
          }
        }
      }
    } catch (e) { /* 损坏用默认空库 */ }
    this._evict();
    this._migrateLocalAccounts();
    this._recomputeLocalWon(); // 修复旧数据：排位局以 ELO 增减为权威
  }

  // v1 → v2：只保留数字对局 ID 的局，按 fid 聚合玩家；t: 无 ID 记录丢弃
  _migrateV1(raw) {
    const matches = {};
    const players = {};
    const v1 = raw.players || {};
    for (const [id, p] of Object.entries(v1)) {
      players[id] = { id, names: Array.isArray(p.names) ? p.names : [], firstSeen: p.firstSeen || null, lastSeen: p.lastSeen || null, lobbySeen: p.lobbySeen || 0 };
      for (const e of Array.isArray(p.encounters) ? p.encounters : []) {
        if (!e || e.fid == null || !NUM_FID.test(String(e.fid))) continue;
        const fid = String(e.fid);
        let m = matches[fid];
        if (!m) {
          m = {
            fid, mapId: null, map: '', endTime: e.at || null, durationSec: null,
            winnerTeam: null, localWon: e.won != null ? !!e.won : null,
            localTeam: e.myTeam || null, custom: null,
            mode: null, localTeamId: null, localSpectator: false, localEloDelta: null, localEloAfter: null, localScores: null,
            players: [], source: 'log', firstSeenAt: e.at || null, syncedAt: null, restarted: false, detailTriedAt: 0
          };
          matches[fid] = m;
        } else {
          if (m.localWon == null && e.won != null) m.localWon = !!e.won;
          if (!m.localTeam && e.myTeam) m.localTeam = e.myTeam;
          if (!m.endTime && e.at) m.endTime = e.at;
          if (!m.firstSeenAt && e.at) m.firstSeenAt = e.at;
        }
        const mapM = /^map:(\d+)$/.exec(e.map || '');
        if (mapM && m.mapId == null) m.mapId = Number(mapM[1]);
        else if (e.map && !m.map) m.map = e.map;
        if (!m.players.some((pl) => pl.id === id)) {
          const last = Array.isArray(p.names) && p.names.length ? p.names[p.names.length - 1].name : '';
          m.players.push({ id, name: last || '', teamId: null, team: e.spectator ? 'Spectators' : (e.theirTeam || null), oldRating: null, newRating: null });
        }
      }
    }
    const seeded = raw.localId != null ? { [String(raw.localId)]: { id: String(raw.localId), name: '', persona: '', firstSeen: null, lastSeen: null } } : {};
    this.data = {
      version: 2,
      matches, players,
      knownBans: raw.knownBans || {},
      playerSnapshots: raw.playerSnapshots || {},
      localAccounts: raw.localAccounts || seeded,
      localId: raw.localId || null,
      lastBanSync: raw.lastBanSync || 0,
      lastMatchSync: raw.lastMatchSync || 0
    };
    this._migrateLocalAccounts();
    this._flush();
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch (e) {}
  }

  _evict() {
    // matches 上限：按 endTime 保留最新
    const mkeys = Object.keys(this.data.matches);
    if (mkeys.length > MAX_MATCHES) {
      const sorted = mkeys.sort((a, b) => (this.data.matches[b].endTime || this.data.matches[b].firstSeenAt || 0) - (this.data.matches[a].endTime || this.data.matches[a].firstSeenAt || 0));
      for (const k of sorted.slice(MAX_MATCHES)) delete this.data.matches[k];
    }
    // players 上限：按 lastSeen 保留最近
    const pkeys = Object.keys(this.data.players);
    if (pkeys.length > MAX_PLAYERS) {
      const sorted = pkeys.sort((a, b) => (this.data.players[b].lastSeen || 0) - (this.data.players[a].lastSeen || 0));
      for (const k of sorted.slice(MAX_PLAYERS)) delete this.data.players[k];
    }
  }

  _player(id) {
    const k = String(id);
    let p = this.data.players[k];
    if (!p) { p = { id: k, names: [], firstSeen: null, lastSeen: null, lobbySeen: 0 }; this.data.players[k] = p; }
    return p;
  }

  _observeName(p, name, at) {
    name = String(name || '').trim();
    if (!name) return;
    const entry = p.names.find((n) => n.name === name);
    if (entry) {
      if (!entry.firstSeen) entry.firstSeen = at;
      entry.lastSeen = Math.max(entry.lastSeen || 0, at);
    } else {
      p.names.push({ name, firstSeen: at, lastSeen: at });
    }
  }

  setLocalName(name) { this._localName = name ? String(name) : null; }

  setLocalId(id, name, at = Date.now()) {
    if (id == null || id === '') return;
    this.data.localId = String(id);
    this._noteLocalAccount(String(id), name, null, at);
    if (name) this.observe(id, name, { at });
    this._flush();
  }

  setMultiAccountBond(v) { this._multiAccountBond = v !== false; }

  // 所有“本机账号”的玩家 ID；关闭多账号联动时只返回主账号
  localIds() {
    if (!this._multiAccountBond) {
      return this.data.localId ? [String(this.data.localId)] : [];
    }
    const ids = Object.keys(this.data.localAccounts || {});
    if (this.data.localId && !ids.includes(String(this.data.localId))) ids.push(String(this.data.localId));
    return ids;
  }

  _noteLocalAccount(id, name, persona, at = Date.now()) {
    const k = String(id);
    const a = this.data.localAccounts[k] || { id: k, name: '', persona: '', firstSeen: null, lastSeen: null };
    if (name && !a.name) a.name = String(name);
    if (persona && !a.persona) a.persona = String(persona);
    if (!a.firstSeen) a.firstSeen = at;
    a.lastSeen = Math.max(a.lastSeen || 0, at);
    this.data.localAccounts[k] = a;
  }

  // 在一场对局里找到“本机玩家”（优先队伍信息完整者）
  _pickLocalForMatch(m) {
    const ids = this.localIds();
    if (!ids.length || !m || !Array.isArray(m.players)) return null;
    const inMatch = m.players.filter((p) => p.id != null && ids.includes(String(p.id)));
    if (!inMatch.length) return null;
    return inMatch.find((p) => p.teamId != null || p.team) || inMatch[0];
  }

  _migrateLocalAccounts() {
    try {
      if (!this.data.localAccounts || typeof this.data.localAccounts !== 'object') this.data.localAccounts = {};
      let changed = false;
      if (this.data.localId && !this.data.localAccounts[String(this.data.localId)]) {
        this.data.localAccounts[String(this.data.localId)] = { id: String(this.data.localId), name: '', persona: '', firstSeen: null, lastSeen: null };
        changed = true;
      }
      const ids = new Set(Object.keys(this.data.localAccounts));
      for (const m of Object.values(this.data.matches)) {
        if (m.localPlayerId == null) {
          const cands = (m.players || []).filter((p) => p.id != null && ids.has(String(p.id)));
          if (cands.length === 1) { m.localPlayerId = String(cands[0].id); changed = true; }
        }
      }
      if (changed) this._flush();
    } catch (e) {}
  }

  // 启动迁移：修复旧数据——排位局以 ELO 增减为权威（旧「占领分判定」可能留下错误 winnerTeam/localWon）
  _recomputeLocalWon() {
    let changed = false;
    for (const m of Object.values(this.data.matches)) {
      if (m.localSpectator) {
        if (m.localWon != null) { m.localWon = null; changed = true; }
        continue;
      }
      const delta = m.localEloDelta;
      if (m.mode === 'ranked' && delta != null && delta !== 0 && m.localTeamId != null) {
        const won = delta > 0;
        const wt = won ? m.localTeamId : (m.localTeamId === 0 ? 1 : 0);
        if (m.localWon !== won || m.winnerTeam !== wt) { m.localWon = won; m.winnerTeam = wt; changed = true; }
      }
    }
    if (changed) this._flush();
  }

  // 账号数据管理：列出本机账号（含各自场次）
  listAccounts() {
    const ids = new Set(this.localIds());
    const out = [];
    for (const a of Object.values(this.data.localAccounts || {})) {
      let matchCount = 0;
      for (const m of Object.values(this.data.matches)) {
        if (m.localPlayerId != null) {
          if (String(m.localPlayerId) === String(a.id)) matchCount++;
        } else if (ids.has(String(a.id)) && (m.players || []).some((p) => p.id != null && String(p.id) === String(a.id))) {
          matchCount++;
        }
      }
      out.push({ id: a.id, name: a.name || '', persona: a.persona || '', firstSeen: a.firstSeen || null, lastSeen: a.lastSeen || null, matchCount });
    }
    out.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
    return out;
  }

  // 删除指定账号：移除账号记录 + 该账号为“本机玩家”的对局 + 玩家表里该 id 的记录
  deleteAccount(id) {
    const k = String(id);
    const acc = this.data.localAccounts[k] || null;
    delete this.data.localAccounts[k];
    const ids = this.localIds(); // 删除后的本机账号集合
    const removed = [];
    for (const [fid, m] of Object.entries(this.data.matches)) {
      const isLocal = m.localPlayerId != null
        ? String(m.localPlayerId) === k
        : (m.players || []).some((p) => p.id != null && String(p.id) === k)
          && !(m.players || []).some((p) => p.id != null && ids.includes(String(p.id)));
      if (isLocal) { delete this.data.matches[fid]; removed.push(fid); }
    }
    delete this.data.players[k];
    if (this.data.localId != null && String(this.data.localId) === k) {
      const rest = Object.values(this.data.localAccounts).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
      this.data.localId = rest.length ? rest[0].id : null;
    }
    this._evict();
    this._flush();
    return { removedMatches: removed.length, removedAccount: !!acc, persona: acc ? acc.persona || '' : '' };
  }

  // 轻量“见过”：只更新名字史与最近出现（房间/大厅/搜索/报告）
  observe(id, name, { at = Date.now(), countLobby = false } = {}) {
    if (id == null || id === '') return;
    const p = this._player(id);
    if (!p.firstSeen) p.firstSeen = at;
    p.lastSeen = Math.max(p.lastSeen || 0, at);
    if (name) this._observeName(p, name, at);
    if (countLobby) p.lobbySeen = (p.lobbySeen || 0) + 1;
    this._evict();
    this._flush();
  }

  // 日志即时记录：只收带数字对局 ID 的局；同 fid 重复触发只补空缺
  recordLogMatch(m, { at = Date.now() } = {}) {
    if (!m || !Array.isArray(m.players) || !m.players.length) return;
    const fid = m.fid != null ? String(m.fid) : '';
    if (!NUM_FID.test(fid)) return; // 无对局 ID 的局不纳入统计
    const localName = m.localName || this._localName || null;
    const me = localName ? m.players.find((pl) => pl.name === localName) : null;
    const persona = m.accountKey ? String(m.accountKey).replace(/^persona:/, '') : null;
    if (me && me.id != null) {
      this.data.localId = String(me.id);
      this._noteLocalAccount(String(me.id), me.name, persona, at);
    }
    const localTeam = me ? (me.team === 'Spectators' ? null : (me.team || null)) : null;
    const localTeamId = me ? (me.team === 'Spectators' ? 100 : me.team === 'Bravo' ? 1 : me.team === 'Alpha' ? 0 : null) : null;
    const localSpectator = !!(me && me.team === 'Spectators');
    let rec = this.data.matches[fid];
    if (!rec) {
      rec = {
        fid, mapId: null, map: m.map || '', endTime: m.endTime || at, durationSec: m.durationSec || null,
        winnerTeam: null, localWon: null, localTeam, custom: null,
        mode: null, localTeamId, localSpectator, localEloDelta: null, localEloAfter: null, localScores: null,
        localPlayerId: me && me.id != null ? String(me.id) : null, localPersona: persona || null,
        players: [], source: 'log', firstSeenAt: at, syncedAt: null, restarted: false, detailTriedAt: 0
      };
      this.data.matches[fid] = rec;
    } else {
      // 重放：只补空缺
      if (!rec.map && m.map) rec.map = m.map;
      if (!rec.endTime && m.endTime) rec.endTime = m.endTime;
      if (rec.durationSec == null && m.durationSec != null) rec.durationSec = m.durationSec;
      if (!rec.localTeam && localTeam) rec.localTeam = localTeam;
      if (rec.localTeamId == null && localTeamId != null) rec.localTeamId = localTeamId;
      if (!rec.localSpectator && localSpectator) rec.localSpectator = true;
      if (!rec.firstSeenAt) rec.firstSeenAt = at;
      if (me && me.id != null && rec.localPlayerId == null) rec.localPlayerId = String(me.id);
      if (persona && !rec.localPersona) rec.localPersona = persona;
    }
    for (const pl of m.players) {
      if (pl.id == null) continue;
      const pid = String(pl.id);
      const p = this._player(pid);
      if (pl.name) this._observeName(p, pl.name, at);
      let existing = rec.players.find((q) => q.id === pid);
      if (existing) {
        if (!existing.name && pl.name) existing.name = pl.name;
        if (!existing.team && pl.team) existing.team = pl.team === 'Spectators' ? 'Spectators' : pl.team;
        continue;
      }
      rec.players.push({ id: pid, name: pl.name || '', teamId: null, team: pl.team === 'Spectators' ? 'Spectators' : (pl.team || null), oldRating: null, newRating: null });
    }
    this._evict();
    this._flush();
  }

  // API 每小时刷新：players/matches → 按 fid upsert（API 字段优先，日志补空）
  // 返回 { added:[fid], updated:[fid] }
  upsertApiMatches(list, { at = Date.now() } = {}) {
    const added = [], updated = [];
    if (!Array.isArray(list)) return { added, updated };
    for (const raw of list) {
      const fid = raw && raw.matchId != null ? String(raw.matchId) : '';
      if (!NUM_FID.test(fid)) continue;
      const d = (raw && raw.data) || {};
      const data = (d.Data && typeof d.Data === 'object') ? d.Data : {};
      const existed = !!this.data.matches[fid];
      const recPrev = existed ? this.data.matches[fid] : null;
      const lid = this.data.localId;
      // 本机玩家：优先用该局已记录的本机 ID（旧账号对局换号后仍按旧账号算 ELO/胜负/评分），再当前主账号，再本地玩家名
      const recLocalId = recPrev && recPrev.localPlayerId != null ? String(recPrev.localPlayerId) : null;
      let me = recLocalId != null ? (data[recLocalId] || null) : null;
      if (!me && lid != null && String(lid) !== recLocalId) me = data[lid] || null;
      if (!me) {
        const localName = this._localName || null;
        me = localName ? (Object.values(data).find((x) => x.Name === localName) || null) : null;
      }
      // 仅「新记录」或「命中当前主账号」才允许更新主账号（避免旧账号对局把主账号改写）
      if (me && me.Id != null && (!recPrev || String(me.Id) === String(lid))) {
        this.data.localId = String(me.Id);
      }
      if (me && me.Id != null) {
        this._noteLocalAccount(String(me.Id), me.Name, null, at);
      }
      // 队伍编码：players/matches 的 TeamId —— 缺失=队伍A(0)、1=队伍B(1)、100=观战
      const normalizeTeam = (tid) => {
        if (tid === 100) return { teamId: 100, team: 'Spectators' };
        if (tid === 1) return { teamId: 1, team: 'Bravo' };
        return { teamId: 0, team: 'Alpha' };
      };
      const localNorm = me ? normalizeTeam(me.TeamId) : { teamId: null, team: null };
      const localTeamId = localNorm.teamId;           // 0|1|100（观战=100）
      const localSpectator = localTeamId === 100;
      const mode = d.Type != null ? 'custom' : 'ranked'; // Type 无=排位、有(1/3)=自定义
      const winnerTeam = (d.WinnerTeam === 0 || d.WinnerTeam === 1) ? d.WinnerTeam : null;
      const oldR = me && typeof me.OldRating === 'number' ? me.OldRating : null;
      const newR = me && typeof me.NewRating === 'number' ? me.NewRating : null;
      const delta = (oldR != null && newR != null) ? (newR - oldR) : null;
      let localWon = null;
      if (!localSpectator && localTeamId != null) {
        if (mode === 'ranked' && delta != null && delta !== 0) localWon = delta > 0;      // 排位以 ELO 增减为权威（旧占领分留的错胜方可被纠正）
        else if (winnerTeam != null) localWon = (localTeamId === winnerTeam);             // 其余用 WinnerTeam
      }
      const mapId = d.MapId != null ? d.MapId : null;
      const endTime = d.EndTime ? d.EndTime * 1000 : null;
      const durationSec = d.TotalPlayTimeInSec != null ? d.TotalPlayTimeInSec : null;

      const players = Object.values(data).map((x) => {
        const n = normalizeTeam(x.TeamId);
        return {
          id: String(x.Id),
          name: x.Name != null ? String(x.Name) : '',
          teamId: n.teamId,
          team: n.team,
          oldRating: typeof x.OldRating === 'number' ? x.OldRating : null,
          newRating: typeof x.NewRating === 'number' ? x.NewRating : null,
          destructionScore: typeof x.DestructionScore === 'number' ? x.DestructionScore : null,
          lossesScore: typeof x.LossesScore === 'number' ? x.LossesScore : null,
          objectivesCaptured: typeof x.ObjectivesCaptured === 'number' ? x.ObjectivesCaptured : null,
          killed: typeof x.KilledCount === 'number' ? x.KilledCount : null,
          damageDealt: typeof x.DamageDealt === 'number' ? Math.round(x.DamageDealt) : null,
          damageReceived: null, dlRatio: null, supplyPoints: null, exp: null, medals: null
        };
      });

      const rec = this.data.matches[fid] || {
        fid, mapId: null, map: '', endTime: null, durationSec: null,
        winnerTeam: null, localWon: null, localTeam: null, custom: null,
        mode: null, localTeamId: null, localSpectator: false, localEloDelta: null, localEloAfter: null, localScores: null,
        localPlayerId: me && me.Id != null ? String(me.Id) : null, localPersona: null,
        players: [], source: 'api', firstSeenAt: at, syncedAt: null, restarted: false, detailTriedAt: 0
      };
      if (me && me.Id != null && rec.localPlayerId == null) rec.localPlayerId = String(me.Id);
      rec.mapId = mapId != null ? mapId : rec.mapId;
      if (!rec.map) rec.map = mapId != null ? ('map:' + mapId) : '';
      if (endTime) rec.endTime = endTime;
      if (durationSec != null) rec.durationSec = durationSec;
      if (mode === 'ranked' && delta != null && delta !== 0 && localTeamId != null) {
        rec.localWon = delta > 0;
        rec.winnerTeam = rec.localWon ? localTeamId : (localTeamId === 0 ? 1 : 0);
      } else {
        if (winnerTeam != null) rec.winnerTeam = winnerTeam;
        if (localWon != null) rec.localWon = localWon;
      }
      if (mode) { rec.mode = mode; rec.custom = mode === 'custom'; }
      if (localTeamId != null) {
        rec.localTeamId = localTeamId;
        rec.localSpectator = localSpectator;
        rec.localTeam = localTeamId === 100 ? 'Spectators' : (localTeamId === 1 ? 'Bravo' : 'Alpha');
      }
      if (me && me.Id != null) {
        rec.localEloDelta = delta;
        rec.localEloAfter = typeof newR === 'number' ? newR : rec.localEloAfter;
        rec.localScores = {
          destruction: typeof me.DestructionScore === 'number' ? me.DestructionScore : null,
          losses: typeof me.LossesScore === 'number' ? me.LossesScore : null,
          objectives: typeof me.ObjectivesCaptured === 'number' ? me.ObjectivesCaptured : null
        };
      }
      rec.source = 'api';
      rec.syncedAt = at;
      // 玩家合并：API 优先，日志补空
      for (const pl of players) {
        const existing = rec.players.find((q) => q.id === pl.id);
        if (existing) {
          if (pl.name) existing.name = pl.name;
          if (pl.teamId != null) existing.teamId = pl.teamId;
          if (pl.team) existing.team = pl.team; // API 归一化队伍为准，覆盖旧版残留错误标签
          if (pl.oldRating != null) existing.oldRating = pl.oldRating;
          if (pl.newRating != null) existing.newRating = pl.newRating;
          if (pl.destructionScore != null) existing.destructionScore = pl.destructionScore;
          if (pl.lossesScore != null) existing.lossesScore = pl.lossesScore;
          if (pl.objectivesCaptured != null) existing.objectivesCaptured = pl.objectivesCaptured;
          if (pl.killed != null) existing.killed = pl.killed;
          if (pl.damageDealt != null) existing.damageDealt = pl.damageDealt;
        } else {
          rec.players.push(pl);
        }
      }
      this.data.matches[fid] = rec;
      if (existed) updated.push(fid); else added.push(fid);
    }
    this.data.lastMatchSync = at;
    this._evict();
    this._flush();
    return { added, updated };
  }

  // 从 /api/analysis/match 的 teamComparison 推导胜方 teamId（0=队伍A/1=队伍B）：
  // 用 destructionScore（摧毁分），高者胜；相等→null。（占领分不可靠：8049993 占点多仍输）
  // 仅作 WinnerTeam 缺失时的兜底。
  static winnerTeamFromMatch(raw) {
    const tc = raw && raw.teamComparison;
    if (!tc || !tc.teamATotals || !tc.teamBTotals) return null;
    const a = tc.teamATotals.destructionScore;
    const b = tc.teamBTotals.destructionScore;
    if (a == null || b == null || a === b) return null;
    return a > b ? 0 : 1;
  }

  // 用推导出的胜方 teamId（0=队伍A/1=队伍B）补某场我方胜负；只补 localWon==null 的场次，返回新 localWon
  setMatchWinner(fid, winnerTeamId) {
    if (fid == null || winnerTeamId == null) return null;
    fid = String(fid);
    const rec = this.data.matches[fid];
    if (!rec || rec.localWon != null) return null;
    const local = this._pickLocalForMatch(rec);
    // 优先级：本机玩家 teamId（API 局）→ 本机玩家 team 文本 → rec.localTeam 标签
    let tid = null;
    if (local && local.teamId != null) tid = local.teamId;
    if (tid == null && local && local.team === 'Bravo') tid = 1;
    if (tid == null && local && local.team === 'Alpha') tid = 0;
    if (tid == null && rec.localTeam === 'Bravo') tid = 1;
    if (tid == null && rec.localTeam === 'Alpha') tid = 0;
    if (tid == null) return null;
    rec.localWon = (tid === winnerTeamId);
    rec.winnerTeam = winnerTeamId;
    this._flush();
    return rec.localWon;
  }

  // 保存玩家「上次已知情报」快照（仅在有真实成功数据时调用，离线不回写脏数据）
  savePlayerSnapshot(id, info) {
    if (id == null || !info || typeof info !== 'object') return;
    const k = String(id);
    const prev = this.data.playerSnapshots[k] || { id: k, name: '', elo: null, winRate: null, category: null, matchCount: null, kd: null, at: 0 };
    if (info.elo != null) prev.elo = info.elo;
    if (info.winRate != null) prev.winRate = info.winRate;
    if (info.category != null) prev.category = info.category;
    if (info.matchCount != null) prev.matchCount = info.matchCount;
    if (info.kd != null) prev.kd = info.kd;
    const p = this.data.players[k];
    if (p && p.names && p.names.length) prev.name = p.names[p.names.length - 1].name || prev.name;
    else if (info.name) prev.name = String(info.name);
    prev.at = Date.now();
    this.data.playerSnapshots[k] = prev;
    this._flush();
  }

  // 批量保存（一次 flush，供对局粗查循环用）
  savePlayerSnapshots(list) {
    if (!Array.isArray(list)) return;
    let changed = false;
    for (const it of list) {
      if (!it || it.id == null || !it.info) continue;
      const k = String(it.id);
      const info = it.info;
      const prev = this.data.playerSnapshots[k] || { id: k, name: '', elo: null, winRate: null, category: null, matchCount: null, kd: null, at: 0 };
      if (info.elo != null) prev.elo = info.elo;
      if (info.winRate != null) prev.winRate = info.winRate;
      if (info.category != null) prev.category = info.category;
      if (info.matchCount != null) prev.matchCount = info.matchCount;
      if (info.kd != null) prev.kd = info.kd;
      const p = this.data.players[k];
      if (p && p.names && p.names.length) prev.name = p.names[p.names.length - 1].name || prev.name;
      prev.at = Date.now();
      this.data.playerSnapshots[k] = prev;
      changed = true;
    }
    if (changed) this._flush();
  }

  // 读取某玩家的本地快照（可能为 null）
  playerSnapshot(id) {
    return this.data.playerSnapshots[String(id)] || null;
  }

  // 离线搜索：在「本地见过的玩家」里按 ID 前缀或任意名字子串匹配（不调用任何 API）
  searchLocal(q, limit = 20) {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    const out = [];
    const isNum = /^\d+$/.test(query);
    for (const p of Object.values(this.data.players)) {
      if (!p) continue;
      if (isNum && String(p.id).startsWith(query)) {
        const last = p.names && p.names.length ? p.names[p.names.length - 1].name : '';
        out.push({ id: p.id, name: last || '', level: null, rating: null });
        if (out.length >= limit) break;
        continue;
      }
      const nameHit = (p.names || []).some((n) => String(n.name || '').toLowerCase().includes(query));
      if (nameHit) {
        const last = p.names[p.names.length - 1].name || '';
        out.push({ id: p.id, name: last, level: null, rating: null });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // 用 /api/match 的 matchInfo 补齐/回写某局（惰性详情用；有则覆盖、无则保留）
  fillMatchFromMatchInfo(fid, mi) {
    if (fid == null || !mi || typeof mi !== 'object') return null;
    fid = String(fid);
    let rec = this.data.matches[fid];
    const isNew = !rec;
    if (!rec) {
      rec = {
        fid, mapId: null, map: '', endTime: null, durationSec: null,
        winnerTeam: null, localWon: null, localTeam: null, custom: null,
        mode: null, localTeamId: null, localSpectator: false, localEloDelta: null, localEloAfter: null, localScores: null,
        localPlayerId: null, localPersona: null,
        players: [], source: 'api', firstSeenAt: Date.now(), syncedAt: null, restarted: false, detailTriedAt: 0
      };
      this.data.matches[fid] = rec;
    }
    const mode = mi.Type != null ? 'custom' : 'ranked';
    if (mode) { rec.mode = mode; rec.custom = mode === 'custom'; }
    if (mi.MapId != null) rec.mapId = mi.MapId;
    if (!rec.map || /^map:\d+$/.test(rec.map)) rec.map = mi.MapId != null ? ('map:' + mi.MapId) : rec.map;
    if (mi.EndTime) rec.endTime = mi.EndTime * 1000;
    if (mi.TotalPlayTimeInSec != null) rec.durationSec = mi.TotalPlayTimeInSec;
    if (mi.WinnerTeam === 0 || mi.WinnerTeam === 1) rec.winnerTeam = mi.WinnerTeam;
    const data = (mi.Data && typeof mi.Data === 'object') ? mi.Data : {};
    const norm = (tid) => (tid === 100 ? 100 : tid === 1 ? 1 : 0);
    for (const x of Object.values(data)) {
      if (x == null || x.Id == null) continue;
      const tid = norm(x.TeamId);
      const pid = String(x.Id);
      let pl = rec.players.find((p) => p.id === pid);
      if (!pl) {
        pl = { id: pid, name: '', teamId: null, team: null, oldRating: null, newRating: null, destructionScore: null, lossesScore: null, objectivesCaptured: null, killed: null, damageDealt: null, damageReceived: null, dlRatio: null, supplyPoints: null, exp: null, medals: null };
        rec.players.push(pl);
      }
      if (x.Name != null && x.Name !== '') pl.name = String(x.Name);
      pl.teamId = tid;
      pl.team = tid === 100 ? 'Spectators' : tid === 1 ? 'Bravo' : 'Alpha';
      if (typeof x.OldRating === 'number') pl.oldRating = x.OldRating;
      if (typeof x.NewRating === 'number') pl.newRating = x.NewRating;
      if (typeof x.DestructionScore === 'number') pl.destructionScore = x.DestructionScore;
      if (typeof x.LossesScore === 'number') pl.lossesScore = x.LossesScore;
      if (typeof x.ObjectivesCaptured === 'number') pl.objectivesCaptured = x.ObjectivesCaptured;
      if (typeof x.Destruction === 'number') pl.killed = x.Destruction; // 击毁数（玩家级字段，非 KilledCount）
      if (typeof x.DamageDealt === 'number') pl.damageDealt = Math.round(x.DamageDealt);
      if (typeof x.DamageReceived === 'number') pl.damageReceived = Math.round(x.DamageReceived);
      if (typeof x.DLRatio === 'number') pl.dlRatio = Math.round(x.DLRatio * 100) / 100;
      if (typeof x.SupplyPointsConsumed === 'number') pl.supplyPoints = x.SupplyPointsConsumed;
      if (typeof x.TotalExp === 'number') pl.exp = x.TotalExp;
      if (Array.isArray(x.Medals)) pl.medals = x.Medals.length;
    }
    // 本机字段：优先用该局已记录的本机 ID（旧账号对局换号后仍按旧账号算 ELO/胜负/评分），再当前主账号，再本地玩家名
    const recLid = rec.localPlayerId != null ? String(rec.localPlayerId) : null;
    const lid = this.data.localId;
    let me2 = recLid != null ? Object.values(data).find((x) => x && String(x.Id) === String(recLid)) : null;
    if (!me2 && lid != null && String(lid) !== recLid) me2 = Object.values(data).find((x) => x && String(x.Id) === String(lid)) || null;
    if (!me2 && this._localName) me2 = Object.values(data).find((x) => x && x.Name === this._localName) || null;
    if (me2 && me2.Id != null) {
      const tid = norm(me2.TeamId);
      rec.localTeamId = tid;
      rec.localSpectator = tid === 100;
      rec.localTeam = tid === 100 ? 'Spectators' : tid === 1 ? 'Bravo' : 'Alpha';
      if (typeof me2.OldRating === 'number' && typeof me2.NewRating === 'number') { rec.localEloDelta = me2.NewRating - me2.OldRating; rec.localEloAfter = me2.NewRating; }
      rec.localScores = {
        destruction: typeof me2.DestructionScore === 'number' ? me2.DestructionScore : null,
        losses: typeof me2.LossesScore === 'number' ? me2.LossesScore : null,
        objectives: typeof me2.ObjectivesCaptured === 'number' ? me2.ObjectivesCaptured : null
      };
      if (rec.localPlayerId == null) rec.localPlayerId = String(me2.Id);
    }
    // 胜负：观战→null；排位且 ELO 增减→权威（同时校正 winnerTeam）；其余用 WinnerTeam
    if (rec.localSpectator) rec.localWon = null;
    else if (rec.localTeamId != null) {
      if (rec.mode === 'ranked' && rec.localEloDelta != null && rec.localEloDelta !== 0) {
        rec.localWon = rec.localEloDelta > 0;
        rec.winnerTeam = rec.localWon ? rec.localTeamId : (rec.localTeamId === 0 ? 1 : 0);
      } else if (rec.winnerTeam === 0 || rec.winnerTeam === 1) {
        rec.localWon = (rec.localTeamId === rec.winnerTeam);
      }
    }
    if (isNew) this.data.lastMatchSync = rec.syncedAt || this.data.lastMatchSync;
    this._evict();
    this._flush();
    return rec;
  }

  _matchesForPlayer(id) {
    const pid = String(id);
    const out = [];
    for (const m of Object.values(this.data.matches)) {
      if (m.players && m.players.some((p) => p.id != null && String(p.id) === pid)) out.push(m);
    }
    out.sort((a, b) => (b.endTime || b.firstSeenAt || 0) - (a.endTime || a.firstSeenAt || 0));
    return out;
  }

  // 单场相遇（相对本机玩家）
  _encounter(m, targetId) {
    const target = m.players.find((p) => p.id != null && String(p.id) === String(targetId));
    if (!target) return null;
    const local = this._pickLocalForMatch(m);
    if (!local) return null; // 本局没有可识别的本机账号（如关闭联动后的旧账号局）→ 不计为相遇
    let rel = null;
    if (target.team === 'Spectators') rel = 'spec';
    else if (local && local.teamId != null && target.teamId != null) rel = (local.teamId === target.teamId) ? 'same' : 'opp';
    else if (local && local.team && target.team && local.team !== 'Spectators' && target.team !== 'Spectators') rel = (local.team === target.team) ? 'same' : 'opp';
    return {
      at: m.endTime || m.firstSeenAt,
      fid: m.fid,
      map: m.map || (m.mapId != null ? 'map:' + m.mapId : ''),
      rel,
      won: m.localWon != null ? !!m.localWon : null,
      custom: m.custom === true
    };
  }

  encountersFor(id) {
    return this._matchesForPlayer(id).map((m) => this._encounter(m, id)).filter(Boolean);
  }

  // 该玩家参与过的对局摘要（时间倒序，供封禁区「我遇到过的作弊者」使用）
  matchesFor(id) {
    return this._matchesForPlayer(id).map((m) => ({
      fid: m.fid,
      map: (m.map && !/^map:\d+$/.test(m.map)) ? m.map : (m.mapId != null ? ('map:' + m.mapId) : ''),
      endTime: m.endTime || m.firstSeenAt,
      localWon: m.localWon != null ? !!m.localWon : null,
      custom: m.custom === true
    }));
  }

  statsFor(id) {
    const pid = String(id);
    const p = this.data.players[pid];
    let count = 0, sameTeam = 0, oppTeam = 0, sameWins = 0, sameLosses = 0, oppWins = 0, oppLosses = 0, unknown = 0, spectator = 0, custom = 0;
    for (const m of this._matchesForPlayer(pid)) {
      const e = this._encounter(m, pid);
      if (!e) continue;
      count++;
      if (e.custom) custom++;
      if (e.rel === 'spec') { spectator++; continue; }
      if (e.rel === null) { unknown++; continue; }
      if (e.rel === 'same') { sameTeam++; if (e.won === true) sameWins++; else if (e.won === false) sameLosses++; else unknown++; }
      else { oppTeam++; if (e.won === true) oppWins++; else if (e.won === false) oppLosses++; else unknown++; }
    }
    return {
      count,
      firstAt: p ? p.firstSeen : null,
      lastAt: p ? p.lastSeen : null,
      sameTeam, oppTeam, sameWins, sameLosses, oppWins, oppLosses, unknown, spectator, custom
    };
  }

  nameHistory(id) { return this.data.players[String(id)] ? this.data.players[String(id)].names : []; }
  player(id) { return this.data.players[String(id)] || null; }
  hasPlayer(id) { return !!this.data.players[String(id)]; }
  isBanned(id) { return !!this.data.knownBans[String(id)]; }
  banInfo(id) { return this.data.knownBans[String(id)] || null; }
  listBans() { return Object.values(this.data.knownBans).sort((a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0)); }

  // 封禁快照：entries = [{ id, name, steam_id, rating }] → 返回本次新增 id 列表
  applyBanSnapshot(entries, { at = Date.now() } = {}) {
    const newly = [];
    if (!Array.isArray(entries)) return newly;
    for (const e of entries) {
      if (!e || e.id == null) continue;
      const k = String(e.id);
      const prev = this.data.knownBans[k];
      if (!prev) {
        newly.push(k);
        this.data.knownBans[k] = {
          id: k,
          name: e.name != null ? String(e.name) : '',
          steamId: e.steam_id != null ? String(e.steam_id) : '',
          rating: typeof e.rating === 'number' ? e.rating : null,
          firstSeenAt: at,
          lastSeenAt: at,
          encountered: !!this.data.players[k]
        };
      } else {
        prev.lastSeenAt = at;
        if (e.name != null && e.name !== '') prev.name = String(e.name);
        if (typeof e.rating === 'number') prev.rating = e.rating;
        prev.encountered = prev.encountered || !!this.data.players[k];
      }
    }
    this.data.lastBanSync = at;
    this._flush();
    return newly;
  }
  // 重开局识别：只用本局数据——时长极短（≤5 分钟）、没有任何结果/评分（被打断/重开）、且从未被 API 收录。
  // 这类局 BATrace 通常无数据；标记后详情不再反复向 API 拉取。不依赖"下一局"是否存在。
  detectRestarts() {
    let changed = 0;
    for (const m of Object.values(this.data.matches || {})) {
      if (!m || !m.fid || m.restarted) continue;
      const dur = m.durationSec != null ? Number(m.durationSec) : null;
      if (dur == null || dur > 300) continue; // 时长未知或超过 5 分钟不算
      if (m.winnerTeam != null || m.localWon != null || m.localEloDelta != null) continue; // 有结果不算
      if (m.mode != null || m.localScores != null) continue; // 被 API 收录 = 真实完成的局，不算
      m.restarted = true;
      changed++;
    }
    if (changed) this._flush();
    return changed;
  }

  // 记录某局详情最近一次尝试向 API 拉取的时间（成功/失败都记），避免每次打开都重复同步
  markDetailTried(fid, at) {
    if (fid == null) return;
    const rec = this.data.matches[String(fid)];
    if (!rec) return;
    rec.detailTriedAt = at || Date.now();
    this._flush();
  }
}

module.exports = { PlayerTracker, MAX_MATCHES, MAX_PLAYERS, winnerTeamFromMatch: PlayerTracker.winnerTeamFromMatch };
