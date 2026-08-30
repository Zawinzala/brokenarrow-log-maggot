// ================= BATrace 人机验证门（腾讯 EdgeOne）=================
// BATrace 上线了腾讯 EdgeOne 人机验证：Chromium 网络栈（net.fetch）首次请求会直接返回
// 「Security Verification」验证码页（非浏览器客户端才会先吃一道 JS cookie 挑战）。
// 勾选「我不是机器人」后服务端下发 EO-Bot-Captcha-Token（30 天有效），之后 API 即可正常调用。
// 本模块用一个真实可见的小窗口跑验证，把 token 写进 Electron 默认 session；
// src/batrace.js 经 net.fetch（同一 session）自动携带 cookie。
const { BrowserWindow, session, net } = require('electron');
const { isCaptchaHtml } = require('./batrace');

const GATE_URL = 'https://app.batrace.top/';
const TOKEN_COOKIE = 'EO-Bot-Captcha-Token';
const POLL_MS = 1000;
const VISIBLE_TIMEOUT_MS = 5 * 60 * 1000; // 可见验证窗口上限（一般勾一下就完）
const GATE_COOLDOWN_MS = 60 * 1000;      // 弹窗冷却：上次弹窗后 60s 内不再重复弹（防止连弹）
const TOKEN_VALIDATE_URL = 'https://app.batrace.top/api/players/search?q=test&limit=1'; // 校验 token 是否真被接受的轻量端点

let gateWin = null;       // 可见验证窗口
let gateTimer = null;
let gatePoll = null;
let gatePromise = null;   // 单飞：多个并发调用共享同一个解锁流程
let gateResolve = null;
let gateReject = null;
let onState = null;       // 状态回调：open / done / cancel
let wasOpen = false;      // 是否已弹出过可见窗口（决定 done/cancel 是否通知渲染层）
let lastGateAt = 0;        // 上次弹窗时间（冷却期内不再重复弹）
let lastToken = null;      // 最近一次校验过的 token（避免重复校验同一 token）
let validFails = 0;        // 同一 token 连续校验失败次数

async function getToken() {
  try {
    const list = await session.defaultSession.cookies.get({ url: GATE_URL });
    const c = list.find((x) => x.name === TOKEN_COOKIE);
    return c && c.value ? c.value : null;
  } catch (e) { return null; }
}

function isBatraceUnlocked() {
  return getToken().then((t) => !!t);
}

// 校验 token 真的被服务端接受：轻量 API 返回 JSON 且非验证页才算通过（不计 App 24h 配额）
async function tokenWorks() {
  try {
    const res = await net.fetch(TOKEN_VALIDATE_URL, { signal: AbortSignal.timeout(10000) });
    const ctype = String((res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '');
    if (!ctype.toLowerCase().includes('application/json')) return false;
    const text = await res.text();
    return !isCaptchaHtml(text);
  } catch (e) { return false; }
}

function notify(state) {
  if (onState) { try { onState(state); } catch (e) {} }
}

function _cleanup() {
  if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
  if (gatePoll) { clearInterval(gatePoll); gatePoll = null; }
  if (gateWin && !gateWin.isDestroyed()) { try { gateWin.destroy(); } catch (e) {} }
  gateWin = null;
  gatePromise = null;
  lastToken = null;
  validFails = 0;
}

function _finishOk() {
  const res = gateResolve;
  gateResolve = null;
  gateReject = null;
  _cleanup();
  if (wasOpen) notify('done');
  wasOpen = false;
  if (res) res();
}

function _finishFail(code, msg) {
  const rej = gateReject;
  gateResolve = null;
  gateReject = null;
  _cleanup();
  if (wasOpen) notify('cancel');
  wasOpen = false;
  if (rej) { const e = new Error(msg); e.code = code; rej(e); }
}

function openVisibleWindow() {
  wasOpen = true;
  lastGateAt = Date.now(); // 冷却计时：本次弹窗后 60s 内不再重复弹
  try {
    gateWin = new BrowserWindow({
      width: 480,
      height: 400,
      title: 'BATrace 人机验证',
      autoHideMenuBar: true,
      resizable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    gateWin.setMenuBarVisibility(false);
    gateWin.on('closed', () => {
      if (gateReject) _finishFail('BATRACE_VERIFY_CANCELLED', 'BATrace 人机验证窗口已关闭，未完成验证');
      else _cleanup();
    });
    gateWin.loadURL(GATE_URL);
    gateWin.show();
    gateWin.focus();
    notify('open');
    gatePoll = setInterval(async () => {
      const tok = await getToken();
      if (!tok) return;
      if (tok === lastToken) {
        if (validFails >= 3) return; // 同一 token 试 3 次仍不被接受 → 停，等用户重新勾选（换新 token）
        validFails++;
      } else {
        lastToken = tok;
        validFails = 1;
      }
      // 只有 token 真被服务端接受才关窗，避免「弹了也白弹」
      if (await tokenWorks()) _finishOk();
    }, POLL_MS);
    gateTimer = setTimeout(() => {
      if (gateReject) _finishFail('BATRACE_VERIFY_TIMEOUT', 'BATrace 人机验证超时，请重新触发查询');
      else _cleanup();
    }, VISIBLE_TIMEOUT_MS);
  } catch (e) {
    if (gateReject) _finishFail('BATRACE_VERIFY_ERROR', 'BATrace 人机验证窗口打开失败：' + String((e && e.message) || e));
    else _cleanup();
  }
}

// force=true：客户端已实际吃到验证页（现有 token 失效/缺失），必须重新走可见窗口验证
function ensureBatraceAccess(opts = {}) {
  if (opts && typeof opts.onState === 'function') onState = opts.onState;
  const force = !!(opts && opts.force);
  if (gatePromise) return gatePromise;
  // 冷却：force 且距上次弹窗 < 60s → 不弹窗，快速失败（防止连弹）；请求方会显示明确错误
  if (force && lastGateAt && Date.now() - lastGateAt < GATE_COOLDOWN_MS) {
    const e = new Error('BATrace 人机验证冷却中，请稍后再试');
    e.code = 'BATRACE_VERIFY_COOLDOWN';
    return Promise.reject(e);
  }
  gatePromise = new Promise((res, rej) => { gateResolve = res; gateReject = rej; });
  wasOpen = false;
  (async () => {
    // 非强制且已有有效 token → 直接放行
    if (!force && (await getToken())) { _finishOk(); return; }
    openVisibleWindow();
  })().catch((e) => {
    _finishFail('BATRACE_VERIFY_ERROR', 'BATrace 人机验证失败：' + String((e && e.message) || e));
  });
  return gatePromise;
}

function closeBatraceGate() {
  if (gateReject) _finishFail('BATRACE_VERIFY_CANCELLED', 'BATrace 人机验证已取消');
  else _cleanup();
}

module.exports = { ensureBatraceAccess, closeBatraceGate, isBatraceUnlocked };
