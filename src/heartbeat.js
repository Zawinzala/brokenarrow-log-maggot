// ================= 心跳统计（可选） =================
// 向作者自建的统计服务定期上报“在线”，并拉取全局在线人数。
// 上报内容只有匿名 UUID + 软件版本号，不含任何玩家数据。
// 接口约定（与服务端 server/worker.js 一致）：
//   POST {url}/heartbeat  body: { userId, v }   → 上报一次心跳
//   GET  {url}/online-count                     → 返回 { online, today } 等形状
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 兼容多种在线人数返回形状：数字 / {online} / {online_count} / {count} / {data:{...}}

// 免费 CORS/转发代理链：直连失败时按顺序尝试（2026-08 实测 allorigins/raw 与 allorigins/get 可用；corsproxy.io 时常 403，仅作末位兜底）
// unwrap=true 表示该代理返回 { contents: "<原始响应>" } 包装，需要解包
const PROXIES = [
  { name: 'allorigins/raw', wrap: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u), unwrap: false },
  { name: 'allorigins/get', wrap: (u) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u), unwrap: true },
  { name: 'corsproxy.io', wrap: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u), unwrap: false }
];
function normalizeStats(d) {
  if (d == null) return null;
  if (typeof d === 'number') return { online: d };
  if (typeof d === 'string' && !isNaN(Number(d))) return { online: Number(d) };
  if (typeof d !== 'object') return null;
  const src = d.data && typeof d.data === 'object' ? d.data : d;
  const online = src.online ?? src.onlineCount ?? src.online_count ?? src.count;
  const today = src.today ?? src.todayCount ?? src.today_count;
  if (online == null) return null;
  return { online, today: today ?? undefined };
}

// 通用「直连 + 免费代理兜底」：直连失败（或 skipDirect）后并行试所有代理，首个 2xx 即用。
// 供心跳上报/在线人数/版本检查共用。注意：代理只转发 GET（服务端已支持 GET /heartbeat）。
async function fetchViaProxy(fetchImpl, url, { skipDirect = false, timeoutMs = 8000 } = {}) {
  const doFetch = (target) => {
    const init = { signal: AbortSignal.timeout(timeoutMs) };
    return fetchImpl(target, init);
  };
  if (!skipDirect) {
    try {
      const r = await doFetch(url);
      if (r.ok) return { ok: true, text: await r.text(), via: null };
    } catch (e) {}
  }
  const results = await Promise.all(PROXIES.map(async (p) => {
    try {
      const r = await doFetch(p.wrap(url));
      if (!r.ok) return null;
      let text = await r.text();
      if (p.unwrap) {
        try { const w = JSON.parse(text); if (w && typeof w.contents === 'string') text = w.contents; } catch (e) {}
      }
      return { ok: true, text, via: p.name };
    } catch (e) { return null; }
  }));
  return results.find((r) => r) || { ok: false, text: '', via: null };
}

class Heartbeat {
  /**
   * @param {object} opts
   * @param {string} opts.url        统计服务根地址（如 https://xxx.workers.dev）
   * @param {string} opts.uidFile    匿名 UUID 持久化文件
   * @param {string} opts.version    软件版本号
   * @param {number} opts.intervalMs 心跳间隔（默认 2 分钟）
   * @param {Function} opts.onStats  拿到在线人数后的回调 ({online, today})
   */
  constructor(opts = {}) {
    this.url = (opts.url || '').replace(/\/+$/, '');
    this.uidFile = opts.uidFile || '';
    this.version = opts.version || '';
    this.intervalMs = opts.intervalMs || 2 * 60 * 1000;
    this.onStats = typeof opts.onStats === 'function' ? opts.onStats : null;
    this.timer = null;
    // 可注入 fetch 实现（主进程传 Electron net.fetch 以走系统代理；测试可换 stub）
    this.fetchImpl = opts.fetchImpl || ((u, o) => globalThis.fetch(u, o));
    this.uid = this._loadUid();
    this.stats = null;
    this.lastPing = 0;
    this.lastError = ''; // 最近一次上报的错误信息（用于诊断）
    this.viaProxy = null;   // 最近一次在线人数是直连还是经代理（代理名）
  }

  _loadUid() {
    try {
      if (this.uidFile && fs.existsSync(this.uidFile)) {
        const v = fs.readFileSync(this.uidFile, 'utf8').trim();
        if (v) return v;
      }
    } catch (e) {}
    const uid = crypto.randomUUID();
    try {
      if (this.uidFile) {
        fs.mkdirSync(path.dirname(this.uidFile), { recursive: true });
        fs.writeFileSync(this.uidFile, uid, 'utf8');
      }
    } catch (e) {}
    return uid;
  }

  start() {
    this.stop();
    this._tick();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async _tick(urlOverride) {
    const base = urlOverride ? String(urlOverride).trim().replace(/\/+$/, '') : this.url;
    if (!base) { this.lastError = '未配置统计服务地址'; return; }
    this.viaProxy = null; // 每轮重置：本轮 POST 或 GET 任一走了代理则记录
    // 1) 上报心跳：直连 POST；失败后走代理 GET 兜底（服务端已支持 GET /heartbeat?userId=&v=）
    let posted = false;
    try {
      const res = await this.fetchImpl(base + '/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.uid, v: this.version }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        posted = true;
        this.lastPing = Date.now();
        this.lastError = '';
      } else {
        this.lastError = '上报失败：HTTP ' + res.status;
      }
    } catch (e) {
      this.lastError = '上报失败：' + (e && e.message || e);
    }
    if (!posted) {
      // 直连 POST 失败 → 代理 GET 兜底（GET 编码 userId/v，免费代理都能转发；不影响计数——计数按匿名 userId 去重）
      const hbGet = base + '/heartbeat?userId=' + encodeURIComponent(this.uid) + '&v=' + encodeURIComponent(this.version);
      const via = await fetchViaProxy(this.fetchImpl, hbGet, { skipDirect: true });
      if (via.ok) {
        this.lastPing = Date.now();
        this.lastError = '';
        this.viaProxy = via.via || this.viaProxy;
      }
    }
    // 2) 拉取在线人数（直连失败自动走免费代理）；无论成败都推送状态，界面据此显示绿灯/红灯
    const stats = await this._fetchOnlineCount(base);
    if (stats) this.stats = stats;
    if (this.onStats) this.onStats(this.status());
  }

  // 当前状态（含错误与代理信息），供界面/诊断读取
  status() {
    return {
      online: this.stats ? this.stats.online : null,
      today: this.stats ? this.stats.today : undefined,
      lastError: this.lastError || '',
      lastPing: this.lastPing,
      viaProxy: this.viaProxy
    };
  }

  // 拉取在线人数：先直连（8s），失败按 PROXIES 依次走代理（各 8s），首个成功即用
  async _fetchOnlineCount(base) {
    const url = base + '/online-count';
    try {
      const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const s = normalizeStats(await r.json());
        if (s) { this.lastError = ''; return s; }
      } else {
        this.lastError = '在线人数获取失败：HTTP ' + r.status;
      }
    } catch (e) {
      this.lastError = '在线人数获取失败（直连）：' + (e && e.message || e);
    }
    // 直连失败 → 并行尝试所有代理，首个 2xx 即用（最坏约等于单次超时）
    const via = await fetchViaProxy(this.fetchImpl, url, { skipDirect: true });
    if (via.ok) {
      const st = normalizeStats(JSON.parse(via.text));
      if (st) { this.viaProxy = via.via; this.lastError = ''; return st; }
    }
    if (!this.lastError) this.lastError = '在线人数获取失败（直连与代理均失败）';
    return null;
  }

  // 手动触发一次完整心跳（设置里的「测试心跳」用），返回诊断结果
  // url 可选：传入则用该地址临时测一次（不改动已保存的配置）
  async pingNow(url) {
    const before = this.lastPing;
    await this._tick(url);
    const base = url ? String(url).trim().replace(/\/+$/, '') : this.url;
    return {
      ok: this.lastPing > before, // 仅代表“这一次”上报是否成功
      stats: this.stats,
      url: base,
      lastError: this.lastError || '',
      lastPing: this.lastPing ? new Date(this.lastPing).toLocaleTimeString('zh-CN') : null,
      viaProxy: this.viaProxy,
      proxies: PROXIES.map((p) => p.name)
    };
  }
}

module.exports = { Heartbeat, fetchViaProxy };
