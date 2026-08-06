// ================= Windows 全局输入钩子 =================
// 用 uiohook-napi 捕获鼠标点击 + 键盘按键，用于统计“完整 APM”。
// - 只读取、不拦截、不模拟任何输入，不影响游戏与反作弊。
// - 键盘长按自动重复只计一次（按下到松开算一次）。
// - 钩子加载失败时静默降级（APM 退回日志指令统计）。
let uiohook = null;
let hookStarted = false;
const pressedKeys = new Set();
const listeners = [];

function load() {
  if (uiohook) return true;
  try {
    uiohook = require('uiohook-napi').uIOhook;
    return true;
  } catch (e) {
    return false;
  }
}

function start() {
  if (!load()) return false;
  if (hookStarted) return true;
  uiohook.on('mousedown', (e) => {
    if (e && e.button) emit('click');
  });
  uiohook.on('keydown', (e) => {
    if (!e || e.keycode == null) return;
    if (pressedKeys.has(e.keycode)) return; // 长按重复
    pressedKeys.add(e.keycode);
    emit('key');
  });
  uiohook.on('keyup', (e) => {
    if (e) pressedKeys.delete(e.keycode);
  });
  try {
    uiohook.start();
    hookStarted = true;
  } catch (e) {
    return false;
  }
  return true;
}

function stop() {
  if (uiohook && hookStarted) {
    try { uiohook.stop(); } catch (e) {}
  }
  hookStarted = false;
  pressedKeys.clear();
}

function onEvent(cb) {
  if (typeof cb === 'function') listeners.push(cb);
}

function emit(kind) {
  for (const cb of listeners) {
    try { cb(kind); } catch (e) {}
  }
}

module.exports = { start, stop, onEvent, available: load };
