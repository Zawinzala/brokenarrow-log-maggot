// ================= 心跳统计（可选） =================
// 向作者自建的统计服务定期上报“在线”，并拉取全局在线人数。
// 上报内容只有匿名 UUID + 软件版本号，不含任何玩家数据。
// 接口约定（与服务端 server/worker.js 一致）：
//   POST {url}/heartbeat  body: { userId(匿名), v(版本), name(游戏名), uid(游戏数字ID) }   → 上报一次心跳（默认 10 分钟一次；服务端已对 live/hist 写入节流）
//   GET  {url}/online-count                     → 返回 { online, today } 等形状
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 兼容多种在线人数返回形状：数字 / {online} / {online_count} / {count} / {data:{...}}

// 心跳已使用自定义域名（brokenarrow.zolahere.top）直连，全链路不走任何免费代理（2026-08 按作者要求移除）。
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

class Heartbeat {
  /**
   * @param {object} opts
   * @param {string} opts.url        统计服务根地址（如 https://xxx.workers.dev）
   * @param {string} opts.uidFile    匿名 UUID 持久化文件
   * @param {string} opts.version    软件版本号
   * @param {number} opts.intervalMs 心跳间隔（默认 1 分钟）
   * @param {Function} opts.onStats  拿到在线人数后的回调 ({online, today})
   */
  constructor(opts = {}) {
    this.url = (opts.url || '').replace(/\/+$/, '');
    this.uidFile = opts.uidFile || '';
    this.version = opts.version || '';
    this.intervalMs = opts.intervalMs || 10 * 60 * 1000; // 默认 10 分钟一次心跳（免费 KV 写入配额有限，几十人规模必须省写）
    this.onStats = typeof opts.onStats === 'function' ? opts.onStats : null;
    // 可选：返回 { name: 游戏内用户名, uid: 游戏数字ID } 附带上报（取不到就空）
    this.getExtra = typeof opts.getExtra === 'function' ? opts.getExtra : () => ({});
    this.timer = null;
    // 可注入 fetch 实现（主进程传 Electron net.fetch 以走系统代理；测试可换 stub）
    this.fetchImpl = opts.fetchImpl || ((u, o) => globalThis.fetch(u, o));
    this.uid = this._loadUid();
    this.stats = null;
    this.lastPing = 0;
    this.lastError = ''; // 最近一次上报的错误信息（用于诊断）
    this.viaProxy = null;   // 兼容旧字段：已无代理，恒为 null
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
    this.viaProxy = null; // 兼容旧字段：已无代理，恒为 null
    // 1) 上报心跳：直连 POST；失败后走代理 GET 兜底（服务端已支持 GET /heartbeat?userId=&v=）
    let posted = false;
    try {
      const extra = this.getExtra() || {};
      const name = String(extra.name || '').slice(0, 64);
      const uid = String(extra.uid || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64);
      const res = await this.fetchImpl(base + '/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.uid, v: this.version, name, uid }),
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
      // 自定义域名直连失败 = 服务不可达：不再走代理兜底（按作者要求，心跳服务不用自动代理）
      if (!this.lastError) this.lastError = '上报失败：直连不可达';
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

  // 拉取在线人数：直连（8s），失败即报错（无代理）
  async _fetchOnlineCount(base) {
    const url = base + '/online-count';
    try {
      const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const s = normalizeStats(await r.json());
        if (s) { if (!this.lastError) this.lastError = ''; return s; }
      } else {
        this.lastError = '在线人数获取失败：HTTP ' + r.status;
      }
    } catch (e) {
      this.lastError = '在线人数获取失败（直连）：' + (e && e.message || e);
    }
    // 直连失败 = 服务不可达：不再走代理兜底（按作者要求，心跳服务不用自动代理）
    if (!this.lastError) this.lastError = '在线人数获取失败（直连不可达）';
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
      viaProxy: null
    };
  }
}

module.exports = { Heartbeat };
