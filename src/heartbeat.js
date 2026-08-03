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
    this.uid = this._loadUid();
    this.stats = null;
    this.lastPing = 0;
    this.lastError = ''; // 最近一次上报的错误信息（用于诊断）
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
    // 1) 上报心跳
    try {
      const res = await fetch(base + '/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.uid, v: this.version }),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        this.lastPing = Date.now();
        this.lastError = '';
      } else {
        this.lastError = '上报失败：HTTP ' + res.status;
      }
    } catch (e) {
      this.lastError = '上报失败：' + (e && e.message || e);
    }
    // 2) 拉取在线人数
    try {
      const r = await fetch(base + '/online-count', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        this.stats = normalizeStats(await r.json());
        if (this.stats && this.onStats) this.onStats({ ...this.stats, lastError: this.lastError, lastPing: this.lastPing });
      } else {
        this.lastError = '在线人数获取失败：HTTP ' + r.status;
      }
    } catch (e) {
      this.lastError = '在线人数获取失败：' + (e && e.message || e);
    }
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
      lastPing: this.lastPing ? new Date(this.lastPing).toLocaleTimeString('zh-CN') : null
    };
  }
}

module.exports = { Heartbeat };
