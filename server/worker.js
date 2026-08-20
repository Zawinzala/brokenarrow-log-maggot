// ================= 断箭蛆工具 · 心跳统计服务（Cloudflare Workers） =================
// 在线（live）存 ONLINE_KV 的 live: 前缀（TTL 300s）；历史（hist）存 hist: 前缀（不设 TTL，累计所有连接过的人）。
// 接口：
//   POST /heartbeat  body: { userId(匿名), v(版本), name(游戏名), uid(游戏数字ID) } → 上报心跳（IP 由 CF-Connecting-IP 自动取；地理位置由 request.cf 自动采集：国家/地区/城市/经纬度）
//   GET  /heartbeat  ?userId=..&v=..&name=..&uid=..  → 上报心跳（GET 版，免费代理只转发 GET 时兜底用）
//   GET  /online-count                              → 返回 { onlineCount }（当前在线人数）
//   GET  /users?token=..                            → 开发者（合二为一）：{ ok, onlineCount, online:[...], historyCount, history:[...] }（token 读环境变量 HEARTBEAT_DEV_TOKEN；每条含 geo:{country,region,city,lat,lon}）
//   GET  /room-users?ids=1,2,3&me=<我的游戏ID>       → 房间内谁也在用本工具：仅当 me 是活跃工具用户时返回 { ok, users:[{id,online}] }（只含匹配到的，保护隐私）
//   GET  /update-meta                                 → 公开：{ version, notes, announcement, exeUrl, publishedAt }（App 启动检查更新/公告）
//   POST /admin/update?token=..   body: {version,notes,announcement} → 发布版本元数据（管理端；主存 R2 meta/update.json）
//   POST /admin/upload-exe?token=&name=<原始文件名> body: exe 字节 → 流式存 R2 dist/<原名>（保留版本号；单文件 ≤100MB）；最新上传记录在 R2 meta/exe.json
// 注意：R2 binding（名 REPLAY）用于托管 exe + 版本/exe 元数据（meta/*.json，主存储，不受 KV 每日写入配额限制）；App 不持有任何 R2 密钥。管理 token 用 ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN。
// 部署：Cloudflare 控制台 Workers 编辑页整段粘贴（KV 绑定名 ONLINE_KV、R2 绑定名 REPLAY）；并在「设置 → 变量和机密」加 HEARTBEAT_DEV_TOKEN（开发者查询密钥）。

// 开发者查询接口密钥：从环境变量 HEARTBEAT_DEV_TOKEN 读取（不写死在代码里，防止开源仓库泄露）。
// 部署后在 Cloudflare Workers「设置 → 变量和机密」添加 HEARTBEAT_DEV_TOKEN，查询时 ?token= 填它。

function cleanId(s) { return String(s || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64); }

// 从 request.cf 采集地理位置（Cloudflare 根据连接 IP 自动给出；没有时返回 null）
function cfGeo(request) {
  const cf = (request && request.cf) || {};
  const lat = typeof cf.latitude === 'number' && isFinite(cf.latitude) ? Number(cf.latitude.toFixed(2)) : null;
  const lon = typeof cf.longitude === 'number' && isFinite(cf.longitude) ? Number(cf.longitude.toFixed(2)) : null;
  const country = String(cf.country || '').slice(0, 2).toUpperCase();
  if (!country && lat == null && lon == null) return null;
  return {
    country,
    region: String(cf.region || '').slice(0, 64),
    city: String(cf.city || '').slice(0, 64),
    lat,
    lon
  };
}

// 按前缀列出 KV 并读取每个值（自动翻页，最多 20 页 x 1000 条）
async function listKV(env, prefix) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const opts = { prefix };
    if (cursor) opts.cursor = cursor;
    const res = await env.ONLINE_KV.list(opts);
    for (const k of (res.keys || [])) {
      let val = null;
      try { const raw = await env.ONLINE_KV.get(k.name); if (raw) val = JSON.parse(raw); } catch (e) {}
      out.push({ key: k.name.slice(prefix.length), ...(val || {}) });
    }
    if (!res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

const R2_PUBLIC_BASE = 'https://brokenarrowreplay.zolahere.top';

// 管理端鉴权：ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN
function isAdmin(url, env) {
  const adminToken = env.ADMIN_TOKEN || env.HEARTBEAT_DEV_TOKEN || '';
  return !!adminToken && url.searchParams.get('token') === adminToken;
}

// 读取版本/exe 元数据：主存 R2（meta/*.json），R2 缺失时回退旧 KV（迁移兼容）
async function readMetaJson(env, r2Key, kvKey) {
  try {
    const obj = await env.REPLAY.get(r2Key);
    if (obj) {
      const raw = await obj.text();
      if (raw) { const parsed = JSON.parse(raw); if (parsed) return parsed; }
    }
  } catch (e) {}
  try {
    const raw = await env.ONLINE_KV.get(kvKey);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

// 写元数据：主存 R2（不受 KV 每日写入配额限制），KV 尽力同步（配额满静默忽略，不影响发布）
async function writeMetaJson(env, r2Key, kvKey, obj) {
  const raw = JSON.stringify(obj);
  await env.REPLAY.put(r2Key, raw, { httpMetadata: { contentType: 'application/json' } });
  try { await env.ONLINE_KV.put(kvKey, raw); } catch (e) {}
  return obj;
}

// 清洗 exe 文件名：去路径、禁字符、保证 .exe 后缀、≤120 字符
function sanitizeExeName(name) {
  let fname = String(name || '').split(/[\\/]/).pop().trim().slice(0, 120);
  fname = fname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  if (!fname) fname = 'broken-arrow-log-assistant.exe';
  if (!/\.exe$/i.test(fname)) fname += '.exe';
  return fname;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- 开发者查询（合二为一：当前在线 + 历史连接，需 token） ----
    if (path === '/users' && request.method === 'GET') {
      const devToken = env.HEARTBEAT_DEV_TOKEN || '';
      if (!devToken) return json({ error: 'HEARTBEAT_DEV_TOKEN not configured' }, 503);
      if (url.searchParams.get('token') !== devToken) return json({ error: 'forbidden' }, 403);
      const [online, history] = await Promise.all([listKV(env, 'live:'), listKV(env, 'hist:')]);
      online.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      history.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return json({ ok: true, onlineCount: online.length, online, historyCount: history.length, history });
    }

    // ---- 房间内工具用户（隐私：要求 me 是活跃工具用户，且只返回查询到的匹配） ----
    if (path === '/room-users' && request.method === 'GET') {
      const me = cleanId(url.searchParams.get('me'));
      if (!me) return json({ error: 'missing me' }, 400);
      const liveMe = await env.ONLINE_KV.get('live:' + me).catch(() => null);
      if (!liveMe) return json({ error: 'not_active' }, 403); // 本机不是活跃工具用户，不给查
      const rawIds = String(url.searchParams.get('ids') || '').split(',').map((x) => cleanId(x)).filter(Boolean);
      const ids = [...new Set(rawIds)].slice(0, 32);
      const users = [];
      for (const id of ids) {
        const [hist, live] = await Promise.all([
          env.ONLINE_KV.get('hist:' + id).catch(() => null),
          env.ONLINE_KV.get('live:' + id).catch(() => null)
        ]);
        if (hist) users.push({ id, online: !!live });
      }
      return json({ ok: true, users });
    }

    // ---- 软件更新 / 公告（版本元数据主存 R2 meta/*.json，exe 托管 R2 dist/） ----
    if (path === '/update-meta' && request.method === 'GET') {
      const m = await readMetaJson(env, 'meta/update.json', 'meta:update');
      if (!m) return json({ ok: false, error: 'no meta' }, 404);
      return json({ ok: true, version: m.version, notes: m.notes, announcement: m.announcement, exeUrl: m.exeUrl, publishedAt: m.publishedAt, bypassUA: String(env.BATRACE_BYPASS_UA || '') });
    }
    // 管理端 token：ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN（你现有的 token 直接可用）
    if (path === '/admin/update' && request.method === 'POST') {
      if (!isAdmin(url, env)) return json({ error: 'forbidden' }, 403);
      let b = null;
      try { b = await request.json(); } catch (e) {}
      if (!b) return json({ error: 'bad body' }, 400);
      const old = await readMetaJson(env, 'meta/update.json', 'meta:update');
      const latestExe = await readMetaJson(env, 'meta/exe.json', 'meta:exe');
      const version = String(b.version || '').trim();
      if (!version && !old) return json({ error: 'missing version（首次发布必须填版本号）' }, 400);
      const meta = {
        version: version || (old && old.version) || '',
        notes: String(b.notes != null ? b.notes : (old && old.notes) || '').trim(),
        announcement: String(b.announcement != null ? b.announcement : (old && old.announcement) || '').trim(),
        exeUrl: String(b.exeUrl || '').trim() || (latestExe && latestExe.url) || (old && old.exeUrl) || '',
        publishedAt: Date.now()
      };
      await writeMetaJson(env, 'meta/update.json', 'meta:update', meta);
      return json({ ok: true, meta });
    }
    if (path === '/admin/upload-exe' && request.method === 'POST') {
      if (!isAdmin(url, env)) return json({ error: 'forbidden' }, 403);
      // 流式上传：直接把 request.body 原样交给 R2 put（R2 只认可 request/response body 或 FixedLengthStream，
      // 不能包一层 TransformStream，否则报 'must have a known length'）。100MB 上限用 Content-Length 预检 + 落盘后超限删除兜底。
      const fname = sanitizeExeName(url.searchParams.get('name'));
      const key = 'dist/' + fname;
      const MAX = 100 * 1024 * 1024;
      const contentLength = Number(request.headers.get('Content-Length') || 0);
      if (contentLength > MAX) return json({ error: 'too large (>100MB)' }, 413);
      if (!request.body) return json({ error: 'empty' }, 400);
      let obj = null;
      try {
        obj = await env.REPLAY.put(key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
      } catch (e) {
        return json({ error: 'upload failed: ' + String((e && e.message) || e) }, 500);
      }
      const size = (obj && obj.size) || 0;
      if (size > MAX) {
        try { await env.REPLAY.delete(key); } catch (e2) {}
        return json({ error: 'too large (>100MB)' }, 413);
      }
      const exeUrl = R2_PUBLIC_BASE + '/' + key.split('/').map(encodeURIComponent).join('/');
      const metaExe = { filename: fname, url: exeUrl, size, uploadedAt: Date.now() };
      await writeMetaJson(env, 'meta/exe.json', 'meta:exe', metaExe);
      return json({ ok: true, url: exeUrl, filename: fname, size });
    }

    // ---- 心跳上报 ----
    if (path === '/heartbeat' && (request.method === 'POST' || request.method === 'GET')) {
      let anon = '', v = '', name = '', gameId = '';
      if (request.method === 'POST') {
        try {
          const b = await request.json();
          anon = b.userId; v = b.v; name = b.name; gameId = b.uid;
        } catch (err) { return json({ error: 'Invalid JSON' }, 400); }
      } else {
        anon = url.searchParams.get('userId'); v = url.searchParams.get('v'); name = url.searchParams.get('name'); gameId = url.searchParams.get('uid');
      }
      anon = cleanId(anon);
      gameId = cleanId(gameId);
      if (!anon && !gameId) return json({ error: 'Missing userId' }, 400);
      v = String(v || '').slice(0, 32);
      name = String(name || '').slice(0, 64);
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const now = Date.now();
      const geo = cfGeo(request);
      const key = gameId || anon;
      const nowMin = 60 * 1000;
      const LIVE_TTL_S = 3600;         // 在线 TTL 60 分钟（心跳 10 分钟，容忍丢包；几十人规模按分钟级看在线）
      const LIVE_THROTTLE_MS = 20 * nowMin;   // 同一用户 20 分钟内只写一次 live（心跳 10 分钟 → 每 20 分钟 1 次写）
      const HIST_THROTTLE_MS = 30 * nowMin;  // hist 每 30 分钟才写一次（省 KV 写入配额）
      const lkey = 'live:' + key;
      let live = null;
      try { const raw = await env.ONLINE_KV.get(lkey); if (raw) live = JSON.parse(raw); } catch (e) {}
      const writeLive = !live || !live.lastSeen || (now - live.lastSeen) >= LIVE_THROTTLE_MS;
      if (writeLive) {
        try { await env.ONLINE_KV.put(lkey, JSON.stringify({ name, gameId, anon, ip, version: v, lastSeen: now, geo }), { expirationTtl: LIVE_TTL_S }); } catch (e) {} // KV 配额满时跳过写（避免 500）
      }
      // 历史（累计，不设 TTL：firstSeen 保留、count 累加；节流写入省配额）
      const hkey = 'hist:' + key;
      let h = null;
      try { const raw = await env.ONLINE_KV.get(hkey); if (raw) h = JSON.parse(raw); } catch (e) {}
      const prevHistSeen = h ? (h.lastSeen || 0) : 0;
      const isNew = !h;
      if (!h) h = { name: '', gameId: '', anon: '', firstSeen: now, lastSeen: now, count: 0, lastIp: '', lastVersion: '', geo: null };
      if (name) h.name = name;
      if (gameId) h.gameId = gameId;
      if (anon) h.anon = anon;
      h.lastSeen = now;
      h.count = (h.count || 0) + 1;
      if (ip) h.lastIp = ip;
      if (v) h.lastVersion = v;
      if (geo) h.geo = geo;
      if (isNew || (now - prevHistSeen) >= HIST_THROTTLE_MS) {
        try { await env.ONLINE_KV.put(hkey, JSON.stringify(h)); } catch (e) {} // KV 配额满时跳过写（避免 500）
      }
      return json({ status: 'ok' });
    }

    // ---- 在线人数 ----
    if (path === '/online-count' && request.method === 'GET') {
      const list = await env.ONLINE_KV.list({ prefix: 'live:' });
      return json({ onlineCount: list.keys.length });
    }

    return new Response('Heartbeat Server is running', { status: 200, headers: cors });
  }
};
