// ================= BATrace API 客户端 =================
// 说明：batrace 的接口没有 CORS 头，浏览器页面里无法跨域调用；
// 但 Electron 主进程是 Node 环境，发 HTTP 请求不受 CORS 限制，直接调用即可。
// 本模块负责：限流（排队）、磁盘缓存、错误兜底。
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.batrace.top';

// 24 小时滚动 API 配额（持久化到磁盘，重启不丢）
class ApiUsage {
  constructor(file, limit = 120) {
    this.file = file;
    this.limit = limit;
    this.calls = [];
    try {
      if (fs.existsSync(file)) {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(arr)) this.calls = arr.filter((t) => typeof t === 'number');
      }
    } catch (e) { this.calls = []; }
    this.prune();
  }
  prune() {
    const cut = Date.now() - 24 * 3600 * 1000;
    if (this.calls.some((t) => t <= cut)) {
      this.calls = this.calls.filter((t) => t > cut);
      this.save();
    }
  }
  count() { this.prune(); return this.calls.length; }
  left() { if (this.limit <= 0) return Infinity; return Math.max(0, this.limit - this.count()); }
  record() { this.prune(); this.calls.push(Date.now()); this.save(); }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.calls), 'utf8'); } catch (e) {} }
}
// 注意：不发送自定义 User-Agent。腾讯 EdgeOne 会把「自定义 UA」判为机器人并返回验证页（实测锁定），
// 让 Chromium net.fetch 使用默认 UA 才能通过人机验证。

// 是否为真正的腾讯 EdgeOne 人机验证页：只认验证页标记（普通 5xx/429/维护页等 HTML 不算，避免误弹验证窗）
function isCaptchaHtml(text) {
  if (typeof text !== 'string' || !text) return false;
  return text.indexOf('TencentEOCaptchaWidget') >= 0
    || text.indexOf('EO-Bot-Captcha-Token') >= 0
    || text.indexOf('Security Verification') >= 0
    || text.indexOf('__tst_status') >= 0;
}

class Cache {
  constructor(file) {
    this.file = file;
    this.data = {}; // key -> { t, value }
    try {
      if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { this.data = {}; }
  }
  get(key, ttl) {
    const it = this.data[key];
    if (!it) return null;
    if (Date.now() - it.t > ttl) return null;
    return it.value;
  }
  set(key, value) {
    this.data[key] = { t: Date.now(), value };
    this.flush();
  }
  flush() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8'); } catch (e) {}
  }
}

class BatraceClient {
  constructor(opts = {}) {
    this.base = opts.base || BASE;
    this.delayMs = opts.delayMs || 350;
    this.cache = opts.cache || null; // Cache 实例
    this.usage = opts.usage || null; // ApiUsage 实例（24h 配额）
    this.onUsage = typeof opts.onUsage === 'function' ? opts.onUsage : null; // 每次真实请求后的回调（用于实时刷新用量）
    this.extraHeaders = (opts.extraHeaders && typeof opts.extraHeaders === 'object') ? opts.extraHeaders : {}; // 自定义请求头（本地私有，如 bypass 白名单头）
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null; // 自定义请求实现（Electron net.fetch，与验证窗口共享 session cookie）
    this.onChallenge = typeof opts.onChallenge === 'function' ? opts.onChallenge : null; // BATrace 人机验证解锁回调（检测到验证页时触发）
    this._queue = Promise.resolve();
  }

  // 串行限流：每次请求之间至少间隔 delayMs
  _throttle() {
    const next = this._queue.then(() => new Promise((r) => setTimeout(r, this.delayMs)));
    this._queue = next.catch(() => {});
    return next;
  }

  async _get(p, { ttl, cacheKey, retries = 2, countUsage = true } = {}) {
    const key = cacheKey || p;
    if (ttl && this.cache) {
      const hit = this.cache.get(key, ttl);
      if (hit) return hit;
    }
    // 24h 配额检查：命中缓存不算调用，但真正请求要先过配额；后台轻量同步接口（封禁/本机对局）不计配额
    if (this.usage && countUsage && this.usage.left() <= 0) {
      throw new Error('API 配额已用尽（24 小时内最多 ' + this.usage.limit + ' 次），请明天再试');
    }
    const fetchImpl = this.fetchImpl || ((u, o) => fetch(u, o));
    this.networkCalls = (this.networkCalls || 0) + 1; // 真正打到 batrace 的请求数（缓存命中不计）
    if (this.onUsage) this.onUsage(); // 实时通知用量变化（配额/次数）
    await this._throttle();
    let lastErr = null;
    let challengeTried = false; // 本次调用是否已触发过人机验证
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetchImpl(this.base + p, {
          // 合并自定义头但强制剔除 User-Agent（防止旧 bypassUA/手动 UA 触发 EdgeOne 验证页）
          headers: (() => { const h = Object.assign({ Accept: 'application/json' }, this.extraHeaders); delete h['User-Agent']; return h; })(),
          signal: AbortSignal.timeout(15000)
        });
        // 只把「真正的 EdgeOne 人机验证页」当验证处理（读响应体看标记）；5xx/429/维护页等普通 HTML 一律按错误处理，绝不误弹验证窗
        const ctype = res && res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
        if (ctype.toLowerCase().includes('text/html')) {
          const text = await res.text();
          if (isCaptchaHtml(text)) {
            if (!challengeTried && this.onChallenge) {
              challengeTried = true;
              await this.onChallenge();
            }
            throw new Error('BATrace 人机验证未完成，请稍后重试');
          }
          throw new Error(res.ok ? 'BATrace 返回了非 JSON 响应' : `HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (this.usage && countUsage) this.usage.record(); // 真实 API 成功响应才计 24h 配额
        if (ttl && this.cache) this.cache.set(key, json);
        return json;
      } catch (e) {
        // 人机验证被取消/超时/出错/冷却：直接透传，不再无谓重试（下次查询会重新弹窗）
        if (e && (e.code === 'BATRACE_VERIFY_CANCELLED' || e.code === 'BATRACE_VERIFY_TIMEOUT' || e.code === 'BATRACE_VERIFY_ERROR' || e.code === 'BATRACE_VERIFY_COOLDOWN')) throw e;
        lastErr = e;
        if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
    // 失败时尝试返回旧缓存
    if (this.cache) {
      const old = this.cache.data[key];
      if (old) return old.value;
    }
    throw lastErr || new Error('请求失败');
  }

  searchPlayers(q, limit = 20) {
    return this._get(`/api/players/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
      ttl: 10 * 60 * 1000, cacheKey: `search:${q}:${limit}`
    });
  }

  // ★ 核心接口：一次调用返回玩家完整分析（ELO趋势/胜负/最爱单位/偏好/地图表现/打法）
  // 用于当前对局查询与玩家报告，是控制调用次数的主力（带 6 小时磁盘缓存）
  analysisPlayer(stbid) {
    return this._get('/api/analysis/player?stbid=' + encodeURIComponent(stbid), {
      ttl: 6 * 3600 * 1000, cacheKey: 'analysis:' + stbid
    });
  }

  playerInfo(stbid) {
    return this._get(`/api/players/info?stbid=${encodeURIComponent(stbid)}`, {
      ttl: 6 * 3600 * 1000, cacheKey: `info:${stbid}`
    });
  }

  playerMatches(stbid, offset = 0) {
    return this._get(`/api/players/matches?stbid=${encodeURIComponent(stbid)}&offset=${offset}`, {
      ttl: 6 * 3600 * 1000, cacheKey: `pmatches:${stbid}:${offset}`
    });
  }

  // 本机最近对局（后台同步用，不计 24h 配额；TTL 30 分钟保证每小时真拉取）
  playerMatchesRecent(stbid, limit = 10) {
    return this._get(`/api/players/matches?stbid=${encodeURIComponent(stbid)}&limit=${limit}`, {
      ttl: 30 * 60 * 1000, cacheKey: `myMatches:${stbid}:${limit}`
    });
  }

  // 封禁名单（后台同步用，不计 24h 配额；TTL 1 小时）
  leaderboardBan(limit = 500, offset = 0) {
    return this._get(`/api/leaderboard/ban?limit=${limit}&offset=${offset}`, {
      ttl: 3600 * 1000, cacheKey: `ban:${limit}:${offset}`
    });
  }

  matchById(matchId) {
    return this._get(`/api/match?matchid=${encodeURIComponent(matchId)}`, {
      ttl: 24 * 3600 * 1000, cacheKey: `match:${matchId}`
    });
  }

  // 蛆查专用：带 mvpRanking（playerId/playerName/teamId/score/breakdown）+ economy 的单局完整数据
  analysisMatch(matchId) {
    return this._get(`/api/analysis/match?matchid=${encodeURIComponent(matchId)}`, {
      ttl: 24 * 3600 * 1000, cacheKey: `amatch:${matchId}`
    });
  }

  // 单局数据（后台补胜负用：与 analysisMatch 同缓存，但不计 24h 配额）
  analysisMatchNoCount(matchId) {
    return this._get(`/api/analysis/match?matchid=${encodeURIComponent(matchId)}`, {
      ttl: 24 * 3600 * 1000, cacheKey: `amatch:${matchId}`
    });
  }


  // BATrace 人机验证页判断：只认验证页标记（供外部调用方/测试使用）
  _isCaptchaHtml(text) {
    return isCaptchaHtml(text);
  }

  usageLeft() {
    return this.usage ? this.usage.left() : null;
  }

  units() {
    return this._get('/api/units', {
      ttl: 7 * 24 * 3600 * 1000, cacheKey: 'units'
    });
  }
}

module.exports = { BatraceClient, Cache, ApiUsage, isCaptchaHtml };

