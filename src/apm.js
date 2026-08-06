// ================= APM 统计模块 =================
// 完整 APM：鼠标点击 + 键盘按键（Windows 全局输入钩子，见 inputHook.js）。
// 仅在输入钩子可用且对局进行中计数，按“距离开始的分钟”分桶，对局结束产出统计图数据。
// 不再做“日志指令兜底统计”：钩子不可用 / 未开启 / 回放日志时由主进程直接提示不可用。
class ApmTracker {
  constructor() {
    this.active = false;
    this.startMs = 0;
    this.total = 0;
    this.buckets = [];
    this.last = null;
  }

  start() {
    this.active = true;
    this.startMs = Date.now();
    this.total = 0;
    this.buckets = [];
  }

  // 输入钩子事件（鼠标点击/键盘按键）
  feedInput() {
    if (!this.active) return;
    const idx = Math.max(0, Math.floor((Date.now() - this.startMs) / 60000));
    this.total++;
    if (idx >= this.buckets.length) this.buckets.length = idx + 1;
    this.buckets[idx] = (this.buckets[idx] || 0) + 1;
  }

  // 对局进行中实时快照
  live() {
    if (!this.active) return null;
    const durationSec = Math.round((Date.now() - this.startMs) / 1000);
    const liveMin = Math.max(1, Math.ceil(durationSec / 60));
    return { active: true, totalActions: this.total, durationSec, apm: Math.round((this.total / liveMin) * 10) / 10 };
  }

  // 对局结束结算
  stop() {
    if (!this.active) return null;
    this.active = false;
    const durationSec = Math.round((Date.now() - this.startMs) / 1000);
    // 用 0 填充空档分钟（避免稀疏数组对 peak/图表出现 NaN）
    const perMinute = Array.from({ length: this.buckets.length }, (_, i) => this.buckets[i] || 0);
    const minutes = perMinute.map((actions, m) => ({ m, actions }));
    const liveMin = Math.max(1, Math.ceil(durationSec / 60));
    const avg = this.total / liveMin;
    const peak = perMinute.length ? Math.max.apply(null, perMinute) : 0;
    this.last = {
      durationSec,
      totalActions: this.total,
      minutes,
      perMinute,
      avg: Math.round(avg * 10) / 10,
      peak
    };
    return this.last;
  }
}

module.exports = { ApmTracker };