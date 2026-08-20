// ================= 玩家分析引擎 =================
// 核心数据源：GET /api/analysis/player?stbid=xxx（一次返回 ELO 趋势/胜负/最爱单位/偏好/地图表现/打法）
// 蛆指数：与断箭蛆指数网站（Zawinzala/broken-arrow-maggot）V4 算法完全一致——
//   取最近 12 场“带 ELO 变动的有效对局”，按每局在己方队伍内的 MVP 名次（1=队内最强）求平均，
//   经余弦平滑曲线映射到 1.0–10.0。详见 buildMaggotReport。
const path = require('path');

// 地图名注册表：从 analysis 响应的 mapPerformance 免费收集真实地图名
const MAP_NAMES = { 3: 'Baltiisk', 4: 'Coast', 6: 'River', 7: 'Dam', 9: 'Airport', 10: 'Frontiers', 11: 'Central Village', 12: 'Oil refinery', 13: 'Suwalki', 16: 'Klaipeda', 17: 'Ruda', 20: 'Parnu', 21: 'Chernyakhovsk', 22: 'Ignalina Powerplant' };
function registerMapNames(mapPerformance) {
  if (!Array.isArray(mapPerformance)) return;
  let added = false;
  for (const m of mapPerformance) {
    if (m && m.mapId != null && m.mapName && MAP_NAMES[m.mapId] !== m.mapName) {
      MAP_NAMES[m.mapId] = m.mapName;
      added = true;
    }
  }
  if (added) _mapNameIndex = null; // 新地图名注册后重建反查索引
}
function mapName(id) {
  return MAP_NAMES[id] || `地图#${id}`;
}

// 地图名 → 地图ID（MAP_NAMES 反查，用于本地录像文件名编码；注册新名时重建索引）
let _mapNameIndex = null;
function mapIdFromName(name) {
  if (name == null) return null;
  const n = String(name).trim().toLowerCase();
  if (!n) return null;
  if (!_mapNameIndex) {
    _mapNameIndex = {};
    for (const id of Object.keys(MAP_NAMES)) {
      const nm = String(MAP_NAMES[id] || '').toLowerCase();
      if (nm) _mapNameIndex[nm] = Number(id);
    }
  }
  return _mapNameIndex[n] != null ? _mapNameIndex[n] : null;
}

// 蛆指数等级（与网站 DICT.zh.levels 一致）
const MAGGOT_LEVELS = ['👑 神', '🦁 团队支柱', '😐 平平淡淡', '🐛 有点蛆', '💩 蛆！'];

class Analyzer {
  constructor(client) {
    this.client = client;
  }

  /**
   * 生成玩家粗查报告（只发 1 次 API 调用，不含蛆指数）
   * @param {string|number} stbid
   */
  async buildReport(stbid) {
    const sid = String(stbid);
    let a = null;
    try {
      a = await this.client.analysisPlayer(sid);
    } catch (e) {
      // analysis 404/失败 → 用 info 接口兜底（有档案但没排位分析的玩家）
      return this._fallbackInfo(sid);
    }
    if (!a || typeof a !== 'object' || (a.matchCount == null && !Array.isArray(a.trend))) {
      return this._fallbackInfo(sid);
    }

    registerMapNames(a.mapPerformance);

    const points = Array.isArray(a.trend?.points) ? a.trend.points : [];
    const latest = points[points.length - 1] || {};
    const wins = points.filter((p) => p.won).length;

    return {
      stbid: sid,
      matchCount: a.matchCount || points.length,
      elo: latest.ratingAfter != null ? Math.round(latest.ratingAfter * 100) / 100 : null,
      kd: latest.kdRatio != null ? Math.round(latest.kdRatio * 100) / 100 : null,
      dmr: latest.dmr != null ? Math.round(latest.dmr * 100) / 100 : null,
      winRate: points.length ? Math.round((wins / points.length) * 100) : 0,
      wins,
      losses: points.length - wins,
      recentMatches: points.slice(-12).reverse().map((p) => ({
        matchId: p.matchId,
        win: p.won,
        eloDelta: p.ratingAfter != null && p.ratingBefore != null ? Math.round((p.ratingAfter - p.ratingBefore) * 10) / 10 : null,
        kd: p.kdRatio,
        dmr: p.dmr,
        destruction: p.destructionScore,
        losses: p.lossesScore,
        objectives: p.objectivesCaptured,
        endTime: p.endTime
      })),
      favUnits: (a.highlightUnits || []).slice(0, 3).map((u) => ({
        name: u.unitName || `单位#${u.unitId}`,
        val: Math.round(u.totalDamage || 0),
        spawn: u.spawnCount || 0,
        roi: u.avgRoi != null ? Math.round(u.avgRoi * 100) / 100 : null
      })),
      categories: (a.categoryPreferences || []).slice(0, 3).map((c) => ({
        key: c.categoryKey,
        pct: c.percentage
      })),
      mapStats: (a.mapPerformance || []).slice(0, 5).map((m) => ({
        mapId: m.mapId,
        name: m.mapName || mapName(m.mapId),
        matchCount: m.matchCount,
        winRate: m.winRate
      })),
      playStyle: a.playStyle || null
    };
  }

  /**
   * 蛆查（单人触发）：与网站算法同步。
   * 数据：analysis 的 trend 提供“带 ELO 变动的有效对局”候选（最近 30 场，最新在前），
   *   逐局拉 /api/analysis/match 直到凑满 12 场（每场数据 24 小时缓存）。
   * 公式：avgRank = 12 局 myRank 平均；s = (1-cos((avgRank-1)/4*π))/2；指数 = 1 + s*9。
   * @param {string|number} stbid
   * @param {(p: object) => void} onProgress
   */
  async buildMaggotReport(stbid, onProgress = () => {}) {
    const sid = String(stbid);
    const MATCH_GOAL = 12, MIN_PLAYERS = 10, CANDIDATES = 30;

    let analysis = null;
    try {
      analysis = await this.client.analysisPlayer(sid);
    } catch (e) {
      return { error: '该玩家暂无排位数据，无法蛆查（未打天梯或未被收录）', stbid: sid };
    }
    if (!analysis || typeof analysis !== 'object') {
      return { error: '该玩家暂无排位数据，无法蛆查（未打天梯或未被收录）', stbid: sid };
    }

    const points = Array.isArray(analysis.trend?.points) ? analysis.trend.points : [];
    // 与网站校验一致：必须能对上 trend 且 ELO 有实际变动（|Δ| >= 0.01）
    const valid = points
      .filter((p) => p.matchId && Math.abs((p.ratingAfter || 0) - (p.ratingBefore || 0)) >= 0.01)
      .slice(-CANDIDATES)
      .reverse(); // 最新在前（网站 last_fights_data 同样最新在前）

    if (!valid.length) {
      return { error: '近期没有带 ELO 变动的有效对局，无法计算蛆指数', stbid: sid };
    }

    const matches = [];
    for (let i = 0; i < valid.length && matches.length < MATCH_GOAL; i++) {
      const p = valid[i];
      let raw = null;
      try {
        raw = await this.client.analysisMatch(p.matchId);
      } catch (e) { /* 单局失败跳过 */ }
      if (!raw || !Array.isArray(raw.mvpRanking) || raw.mvpRanking.length < MIN_PLAYERS) {
        onProgress({ done: matches.length, total: MATCH_GOAL, scanned: i + 1, of: valid.length, matchId: p.matchId, ok: false });
        continue;
      }
      const fm = this._formatMatch(p.matchId, raw, sid, p);
      if (fm) {
        matches.push(fm);
        onProgress({ done: matches.length, total: MATCH_GOAL, scanned: i + 1, of: valid.length, matchId: p.matchId, ok: true });
      }
    }

    if (matches.length < MATCH_GOAL) {
      return {
        error: `有效对局不足 ${MATCH_GOAL} 场（只凑到 ${matches.length} 场完整数据）`,
        stbid: sid, partial: matches.length, rows: this._summarize(matches)
      };
    }

    return this._summarize(matches, sid, true);
  }

  // 与网站 processFinalData 一致的计算汇总
  _summarize(matches, sid, full) {
    let kRankSum = 0, oRankSum = 0, kdRankSum = 0, lossRankSum = 0, wins = 0;
    const rows = matches.map((m) => {
      if (m.isWin) wins++;
      kRankSum += m.kRank; oRankSum += m.oRank; kdRankSum += m.kdRank; lossRankSum += m.lossRank;
      return { matchId: m.matchId, win: m.isWin, myRank: m.myRank, kRank: m.kRank, oRank: m.oRank, kdRank: m.kdRank, lossRank: m.lossRank, eloDelta: m.eloDelta };
    });
    const avgRank = matches.reduce((s, m) => s + m.myRank, 0) / matches.length;
    const normalizedRank = (avgRank - 1) / 4;
    const sCurveValue = (1 - Math.cos(normalizedRank * Math.PI)) / 2;
    const maggotIndex = 1 + (sCurveValue * 9);

    const label = MAGGOT_LEVELS[maggotIndex <= 2 ? 0 : (maggotIndex <= 4 ? 1 : (maggotIndex <= 6 ? 2 : (maggotIndex <= 8 ? 3 : 4)))];
    const color = maggotIndex <= 3.5 ? 'green' : (maggotIndex <= 7 ? 'yellow' : 'red');

    // 趋势：最近 3 局 vs 前 9 局（网站 recent3 / older9）
    const recent3 = matches.slice(0, 3);
    const older9 = matches.slice(3, 12);
    const recentAvg = recent3.reduce((s, m) => s + m.myRank, 0) / (recent3.length || 1);
    const olderAvg = older9.reduce((s, m) => s + m.myRank, 0) / (older9.length || 1);
    let trend = 'flat';
    if (recentAvg < olderAvg - 0.4) trend = 'up';
    else if (recentAvg > olderAvg + 0.4) trend = 'down';

    const out = {
      stbid: sid,
      maggotIndex: Math.round(maggotIndex * 10) / 10,
      label,
      color,
      avgRank: Math.round(avgRank * 100) / 100,
      normalizedRank: Math.round(normalizedRank * 1000) / 1000,
      refs: {
        kdr: (kdRankSum / matches.length).toFixed(1),
        kr: (kRankSum / matches.length).toFixed(1),
        dr: (lossRankSum / matches.length).toFixed(1),
        or: (oRankSum / matches.length).toFixed(1),
        wr: Math.round((wins / matches.length) * 100)
      },
      trend,
      rows,
      calls: this.client.networkCalls || 0
    };
    if (!full) delete out.refs;
    return out;
  }

  // 单局格式化（对齐网站 formatNewMatchData + calcR）
  _formatMatch(matchId, matchRaw, myUid, trendPoint) {
    const mvp = Array.isArray(matchRaw.mvpRanking) ? matchRaw.mvpRanking : [];
    const mapped = [];
    let myTeamId = null;
    for (const p of mvp) {
      const isMe = String(p.playerId) === String(myUid);
      if (isMe) myTeamId = p.teamId;
      mapped.push({
        id: p.playerId,
        teamId: p.teamId,
        isMe,
        mvpScore: p.score || 0,
        kScore: 0,
        lScore: 0
      });
    }
    if (myTeamId === null && mapped.length) myTeamId = mapped[0].teamId; // 网站兜底
    if (myTeamId === null) return null;

    if (matchRaw.economy && Array.isArray(matchRaw.economy.players)) {
      for (const ep of matchRaw.economy.players) {
        const mp = mapped.find((q) => q.id === ep.playerId);
        if (mp) {
          mp.kScore = ep.returnValue || 0;
          mp.lScore = Math.max(0, (ep.investment || 0) - (ep.refunded || 0));
        }
      }
    }

    const ally = mapped.filter((p) => p.teamId === myTeamId);
    const rankOf = (list, sortFn) => {
      const r = [...list].sort(sortFn).findIndex((p) => p.isMe) + 1;
      return r === 0 ? 5 : r;
    };
    const kdOf = (p) => p.kScore / (p.lScore || 1);

    return {
      matchId,
      isWin: !!trendPoint.won,
      myRank: rankOf(ally, (a, b) => b.mvpScore - a.mvpScore),
      kRank: rankOf(ally, (a, b) => b.kScore - a.kScore),
      oRank: rankOf(ally, (a, b) => b.mvpScore - a.mvpScore),
      kdRank: rankOf(ally, (a, b) => kdOf(b) - kdOf(a)),
      lossRank: rankOf(ally, (a, b) => a.lScore - b.lScore),
      eloDelta: trendPoint.ratingAfter != null && trendPoint.ratingBefore != null
        ? Math.round((trendPoint.ratingAfter - trendPoint.ratingBefore) * 10) / 10
        : null
    };
  }

  // analysis 404 时的兜底：用 /api/players/info 的基础档案
  async _fallbackInfo(sid) {
    try {
      const info = await this.client.playerInfo(sid);
      const i = info && info.info;
      if (!i || !i.name) return { error: '未找到该玩家（可能未收录或无排位数据）', stbid: sid };
      const st = info.statInfo || {};
      const wins = st.winCountRt || 0, losses = st.lossCountRt || 0;
      return {
        stbid: sid,
        name: i.name,
        level: i.level,
        elo: i.rating != null ? Math.round(i.rating * 100) / 100 : null,
        matchCount: st.fightsCountRt || (wins + losses),
        wins,
        losses,
        winRate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : null,
        kd: null, dmr: null,
        recentMatches: [], favUnits: [], categories: [], mapStats: [], playStyle: null,
        fallback: true
      };
    } catch (e2) {
      return { error: '未找到该玩家（可能未收录或无排位数据）', stbid: sid };
    }
  }

  // 当前对局玩家卡片的“轻量情报”（也从同一次 analysis 调用里取，免费附带）
  extractMini(a) {
    if (!a || typeof a !== 'object' || (a.matchCount == null && !Array.isArray(a.trend))) return null;
    const points = Array.isArray(a?.trend?.points) ? a.trend.points : [];
    const latest = points[points.length - 1] || {};
    const wins = points.filter((p) => p.won).length;
    return {
      elo: latest.ratingAfter != null ? Math.round(latest.ratingAfter) : null,
      kd: latest.kdRatio != null ? Math.round(latest.kdRatio * 100) / 100 : null,
      matchCount: a.matchCount || points.length,
      winRate: points.length ? Math.round((wins / points.length) * 100) : null,
      topUnits: (a.highlightUnits || []).slice(0, 3).map((u) => u.unitName).filter(Boolean).join('、'),
      category: (a.categoryPreferences || [])[0]?.categoryKey || null
    };
  }
}

module.exports = { Analyzer, mapName, mapIdFromName, registerMapNames, MAP_NAMES, MAGGOT_LEVELS };
