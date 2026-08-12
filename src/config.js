// ================= 配置管理 =================
// 负责读写用户设置（日志目录、轮询间隔、API 限流间隔、缓存时长等）
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 游戏日志目录（用户可自行设置，空字符串 = 未设置）
  logDir: '',
  // 监听轮询间隔（毫秒）
  pollMs: 1500,
  // batrace 请求最小间隔（毫秒），避免请求过快
  apiDelayMs: 1200, // 无 bypass 时的全局 BATrace 间隔（≈1 次/秒，避开 Eero 1 req/s 限流）；有 bypass 由 main.js 动态降到 300
  batraceExtraHeaders: {}, // 本地私有：BATrace 自定义请求头（如 Eero 给的 bypass 白名单头）。默认空、不写死、不进设置界面
  // 是否在检测到对局后自动查询所有玩家
  autoQueryCurrentMatch: true,
  // 真实输入统计（全局鼠标+键盘钩子，默认关闭，反作弊风险自担）
  inputHookEnabled: false,
  // 24 小时 API 调用配额上限（超过后当天不再请求）
  apiDailyLimit: 240,
  // 心跳统计（匿名 ID + 版本号；作者自建服务器，可在设置里关闭）
  heartbeatEnabled: true,
  // 界面主题：dark / light / cyan / orange
  theme: 'dark',
  // 封禁监控：每小时检查封禁名单并提醒新增
  banPollEnabled: true,
  // 每小时同步本机最近对局（用于玩家追踪回填）
  matchSyncEnabled: true,
  // 封禁追踪卡片默认隐藏（设置里勾选才显示）
  banCardVisible: false,
  // 多账号联动羁绊检查：换号也视为同一人，所有本机账号的对局都计入调查统计（默认开）
  multiAccountBond: true,
  heartbeatUrl: 'https://brokenarrow.zolahere.top',
  // 玩家报告使用的近期对局页数（每页 5 局）
  reportMatchPages: 4,
  // 最爱单位统计使用的最新对局数
  favUnitMatchCount: 5,
  // 对局录像：每 5 秒截一帧游戏画面合成 1fps WebM，结束后直接 S3 预签名上传（默认关闭）
  replayEnabled: false, // 对局录像默认关闭，用户在「对局录像」卡片右上角开启（开启时若多屏会让用户选游戏所在显示器）
  replayDisplayId: '',   // 用户选择的游戏所在显示器 display_id

  replayQuality: 1080,     // 480 / 720 / 1080（默认 1080p）
  // 云端录像存储：滚动 5GB（固定值，不暴露）：超过 rollGb 自动删最旧；warnGb=接近上限提醒

  // 缓存时长（毫秒）
  cacheTtl: {
    info: 6 * 3600 * 1000,      // 玩家信息 6 小时
    matches: 24 * 3600 * 1000,  // 对局数据 24 小时
    units: 7 * 24 * 3600 * 1000 // 单位库 7 天
  }
};

// 常见默认 Steam 安装路径（用于“自动检测”）
const COMMON_STEAM_ROOTS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'E:\\Steam',
  'F:\\Steam'
];

// 从 steam 库配置文件中读取所有库路径
function readSteamLibraryPaths(steamRoot) {
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = fs.readFileSync(vdf, 'utf8');
    const paths = [];
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      paths.push(m[1].replace(/\\\\/g, '\\'));
    }
    return paths;
  } catch (e) {
    return [];
  }
}

// 自动探测断箭的 GameLogs 目录
function detectSteamLogDir() {
  const candidates = [];
  const roots = new Set();
  for (const r of COMMON_STEAM_ROOTS) {
    if (fs.existsSync(r)) roots.add(r);
  }
  // 顺带把注册表里的 Steam 路径也找出来（若存在）
  for (const root of [...roots]) {
    for (const lib of readSteamLibraryPaths(root)) {
      roots.add(lib);
    }
  }
  for (const root of roots) {
    candidates.push(path.join(root, 'steamapps', 'common', 'broken_arrow', 'GameLogs'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

class Config {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...DEFAULTS, ...raw, cacheTtl: { ...DEFAULTS.cacheTtl, ...(raw.cacheTtl || {}) } };
        this.data.apiDailyLimit = DEFAULTS.apiDailyLimit; // 24h 配额为固定值，不随旧配置残留
      }
    } catch (e) {
      // 配置损坏时回退默认值
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  get() {
    return { ...this.data };
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.data.apiDailyLimit = DEFAULTS.apiDailyLimit; // 固定配额
    this.data.pollMs = DEFAULTS.pollMs;
    this.data.apiDelayMs = DEFAULTS.apiDelayMs;
    this.data.heartbeatUrl = DEFAULTS.heartbeatUrl;
    this.data.heartbeatEnabled = true;
    this.data.replayQuality = DEFAULTS.replayQuality;
    this.save();
    return this.get();
  }

  // 校验目录是否包含 Gamelog 文件
  validateLogDir(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return { ok: false, reason: '目录不存在' };
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return { ok: false, reason: '不是目录' };
      const files = fs.readdirSync(dir);
      const logFiles = files.filter((f) => /\.(log|txt)$/i.test(f));
      return { ok: true, files: logFiles.length, sample: logFiles.slice(0, 3) };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }
}

module.exports = { Config, detectSteamLogDir, DEFAULTS };
