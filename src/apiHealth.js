// ================= API 稳定性健康检查 =================
// 每小时探测几个轻量常用 BATrace 接口（只选小响应端点，避免像 units 这种大返回拖慢检测），给顶栏「稳定性灯」供状态：
//   全通=绿 / 部分=黄 / 全挂=红 / 尚未检测=灰
// 注意：探针是轻量健康检查，**不计入 24h 配额**，但计入 healthCalls 展示计数。
const fs = require('fs');
const path = require('path');


const PROBES = [
  { path: '/api/players/search?q=test&limit=1', label: '搜索' },
  { path: '/api/players/info?stbid=8863', label: '玩家信息' },
  { path: '/api/leaderboard/ban?limit=1', label: '封禁榜' },
  { path: '/api/players/matches?stbid=8863&limit=1', label: '最近对局' }
];

class ApiHealth {
  constructor(opts = {}) {
    const { base = 'https://app.batrace.top', file = '', timeoutMs = 8000 } = opts;
    this.base = String(base || '').replace(/\/+$/, '');
    this.file = file;
    this.timeoutMs = timeoutMs || 8000;
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null; // 自定义请求实现（Electron net.fetch，带 session cookie）
    this.healthCalls = 0;
    this.last = null; // { state:'ok'|'partial'|'down', checks:[{path,label,ok,ms,status,err}], at, okCount, total }
    this._load();
  }

  _load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && raw.state && Array.isArray(raw.checks)) this.last = raw;
      }
    } catch (e) {}
  }

  _save() {
    try {
      if (!this.file) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.last), 'utf8');
    } catch (e) {}
  }

  // 并行探测全部端点（并发小请求，最慢约等于单个超时）
  async probe() {
    const run = async (p) => {
      const t0 = Date.now();
      let ok = false, status = 0, err = '';
      try {
        const res = await (this.fetchImpl || fetch)(this.base + p.path, {
          // 不发送自定义 UA：EdgeOne 会把自定义 UA 当机器人（实测锁定），探针与真实请求保持一致
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        status = res.status;
        // 人机验证页返回 HTTP 200 但内容是 HTML：按不可用计，稳定性灯才准确
        const ctype = String((res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '');
        ok = res.ok && !ctype.toLowerCase().includes('text/html');
        if (res.ok && !ok) err = '人机验证未完成';
      } catch (e) {
        err = String((e && e.message) || e).slice(0, 60);
      }
      this.healthCalls++;
      return { path: p.path, label: p.label, ok, ms: Date.now() - t0, status, err };
    };
    const checks = await Promise.all(PROBES.map(run));
    const okCount = checks.filter((c) => c.ok).length;
    const state = okCount === checks.length ? 'ok' : okCount === 0 ? 'down' : 'partial';
    this.last = { state, checks, at: Date.now(), okCount, total: checks.length };
    this._save();
    return this.last;
  }
}

module.exports = { ApiHealth, PROBES };
