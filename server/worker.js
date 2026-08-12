// ================= 断箭蛆工具 · 心跳统计服务（Cloudflare Workers） =================
// 在线（live）存 ONLINE_KV 的 live: 前缀（TTL 300s）；历史（hist）存 hist: 前缀（不设 TTL，累计所有连接过的人）。
// 接口：
//   POST /heartbeat  body: { userId(匿名), v(版本), name(游戏名), uid(游戏数字ID) } → 上报心跳（IP 由 CF-Connecting-IP 自动取；地理位置由 request.cf 自动采集：国家/地区/城市/经纬度）
//   GET  /heartbeat  ?userId=..&v=..&name=..&uid=..  → 上报心跳（GET 版，免费代理只转发 GET 时兜底用）
//   GET  /online-count                              → 返回 { onlineCount }（当前在线人数）
//   GET  /users?token=..                            → 开发者（合二为一）：{ ok, onlineCount, online:[...], historyCount, history:[...] }（token 读环境变量 HEARTBEAT_DEV_TOKEN；每条含 geo:{country,region,city,lat,lon}）
//   GET  /room-users?ids=1,2,3&me=<我的游戏ID>       → 房间内谁也在用本工具：仅当 me 是活跃工具用户时返回 { ok, users:[{id,online}] }（只含匹配到的，保护隐私）
//   GET  /update-meta                                 → 公开：{ version, notes, announcement, exeUrl, publishedAt }（App 启动检查更新/公告）
//   POST /admin/update?token=..   body: {version,notes,announcement} → 发布版本元数据（管理端）
//   POST /admin/upload-exe?token=&name=<原始文件名> body: exe 字节 → 存 R2 dist/<原名>（保留版本号；单文件 ≤100MB）；最新上传记录在 KV meta:exe
// 注意：R2 binding（名 REPLAY）仅用于托管 exe（admin/upload-exe）；App 不持有任何 R2 密钥。管理 token 用 ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN。
// 部署：Cloudflare 控制台 Workers 编辑页整段粘贴（KV 绑定名 ONLINE_KV）；并在「设置 → 变量和机密」加 HEARTBEAT_DEV_TOKEN（开发者查询密钥）。

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

    // ---- 软件更新 / 公告（Cloudflare：版本元数据 + exe 托管） ----
    // 管理端 token：ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN（你现有的 token 直接可用）
    if (path === '/update-meta' && request.method === 'GET') {
      const raw = await env.ONLINE_KV.get('meta:update').catch(() => null);
      if (!raw) return json({ ok: false, error: 'no meta' }, 404);
      let m = null;
      try { m = JSON.parse(raw); } catch (e) {}
      if (!m) return json({ ok: false, error: 'bad meta' }, 500);
      return json({ ok: true, version: m.version, notes: m.notes, announcement: m.announcement, exeUrl: m.exeUrl, publishedAt: m.publishedAt, bypassUA: String(env.BATRACE_BYPASS_UA || '') });
    }
    if ((path === '/admin/update' || path === '/admin/upload-exe') && request.method === 'POST') {
      const adminToken = env.ADMIN_TOKEN || env.HEARTBEAT_DEV_TOKEN || '';
      if (!adminToken || url.searchParams.get('token') !== adminToken) return json({ error: 'forbidden' }, 403);
      if (path === '/admin/update') {
        let b = null;
        try { b = await request.json(); } catch (e) {}
        if (!b) return json({ error: 'bad body' }, 400);
        // 支持只更新公告：版本号可留空，保留已发布的版本/更新内容
        const raw = await env.ONLINE_KV.get('meta:update').catch(() => null);
        let old = null;
        try { old = raw ? JSON.parse(raw) : null; } catch (e) {}
        const version = String(b.version || '').trim();
        if (!version && !old) return json({ error: 'missing version（首次发布必须填版本号）' }, 400);
        const exeRaw = await env.ONLINE_KV.get('meta:exe').catch(() => null);
        let latestExe = null;
        try { latestExe = exeRaw ? JSON.parse(exeRaw) : null; } catch (e) {}
        const meta = {
          version: version || (old && old.version) || '',
          notes: String(b.notes != null ? b.notes : (old && old.notes) || '').trim(),
          announcement: String(b.announcement != null ? b.announcement : (old && old.announcement) || '').trim(),
          exeUrl: String(b.exeUrl || '').trim() || (latestExe && latestExe.url) || (old && old.exeUrl) || '',
          publishedAt: Date.now()
        };
        await env.ONLINE_KV.put('meta:update', JSON.stringify(meta));
        return json({ ok: true, meta });
      }
      // upload-exe：按原始文件名存 R2 dist/<原名>（保留版本号等），并记录到 KV meta:exe 供发布用
      const body = await request.arrayBuffer();
      if (!body || !body.byteLength) return json({ error: 'empty' }, 400);
      if (body.byteLength > 100 * 1024 * 1024) return json({ error: 'too large (>100MB)' }, 413);
      let fname = String(url.searchParams.get('name') || '').split(/[\\/]/).pop().trim().slice(0, 120);
      fname = fname.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      if (!fname) fname = 'broken-arrow-log-assistant.exe';
      if (!/\.exe$/i.test(fname)) fname += '.exe';
      const key = 'dist/' + fname;
      await env.REPLAY.put(key, body, { httpMetadata: { contentType: 'application/octet-stream' } });
      const exeUrl = 'https://brokenarrowreplay.zolahere.top/' + key.split('/').map(encodeURIComponent).join('/');
      await env.ONLINE_KV.put('meta:exe', JSON.stringify({ filename: fname, url: exeUrl, size: body.byteLength, uploadedAt: Date.now() }));
      return json({ ok: true, url: exeUrl, filename: fname, size: body.byteLength });
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
        await env.ONLINE_KV.put(lkey, JSON.stringify({ name, gameId, anon, ip, version: v, lastSeen: now, geo }), { expirationTtl: LIVE_TTL_S });
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
        await env.ONLINE_KV.put(hkey, JSON.stringify(h));
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
