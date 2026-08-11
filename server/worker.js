// ================= 断箭蛆工具 · 心跳统计服务（Cloudflare Workers） =================
// 在线（live）存 ONLINE_KV 的 live: 前缀（TTL 300s）；历史（hist）存 hist: 前缀（不设 TTL，累计所有连接过的人）。
// 接口：
//   POST /heartbeat  body: { userId(匿名), v(版本), name(游戏名), uid(游戏数字ID) } → 上报心跳（IP 由 CF-Connecting-IP 自动取）
//   GET  /heartbeat  ?userId=..&v=..&name=..&uid=..  → 上报心跳（GET 版，免费代理只转发 GET 时兜底用）
//   GET  /online-count                              → 返回 { onlineCount }（当前在线人数）
//   GET  /users?token=..                            → 开发者（合二为一）：{ ok, onlineCount, online:[...], historyCount, history:[...] }（token 读环境变量 HEARTBEAT_DEV_TOKEN）
//   GET  /room-users?ids=1,2,3&me=<我的游戏ID>       → 房间内谁也在用本工具：仅当 me 是活跃工具用户时返回 { ok, users:[{id,online}] }（只含匹配到的，保护隐私）
//   POST /replay/upload?me=<uid>&key=<replays/...webm> body=WebM → 上传自己的录像（任何人，me 须活跃工具用户；总量超 5GB 自动删最旧）
//   GET  /replay/list                                 → 公开列出录像（元数据；播放走 R2 自定义域）
//   DELETE /replay/delete?key=..&me=<uid>             → 删除（仅限删除 key 中 uid 与自己相同者）
//   GET  /update-meta                                 → 公开：{ version, notes, announcement, exeUrl, publishedAt }（App 启动检查更新/公告）
//   POST /admin/update?token=..   body: {version,notes,announcement} → 发布版本元数据（管理端）
//   POST /admin/upload-exe?token= body: exe 字节 → 存 R2 dist/ 固定名（管理端；单文件 ≤100MB，免费计划请求体上限）
// 注意：录像不在这里存文件，直接写 R2 binding（名 REPLAY，绑定桶 brokenarrow-replay）；App 不持有任何 R2 密钥。管理 token 用 ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN。
// 部署：Cloudflare 控制台 Workers 编辑页整段粘贴（KV 绑定名 ONLINE_KV）；并在「设置 → 变量和机密」加 HEARTBEAT_DEV_TOKEN（开发者查询密钥）。

// 开发者查询接口密钥：从环境变量 HEARTBEAT_DEV_TOKEN 读取（不写死在代码里，防止开源仓库泄露）。
// 部署后在 Cloudflare Workers「设置 → 变量和机密」添加 HEARTBEAT_DEV_TOKEN，查询时 ?token= 填它。

function cleanId(s) { return String(s || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64); }

// 录像：滚动上限 5GB、单文件上限 50MB、对象名白名单
const REPLAY_ROLL_GB = 5;
const REPLAY_MAX_BYTES = 50 * 1024 * 1024; // 单文件上限 50MB
const REPLAY_KEY_RE = /^replays\/[A-Za-z0-9_.-]+\.webm$/;

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

    // ---- 对局录像（R2 binding，公开上传/查看，删除限本人） ----

    if (path === '/replay/upload' && request.method === 'POST') {
      const me = cleanId(url.searchParams.get('me'));
      const key = String(url.searchParams.get('key') || '');
      if (!me) return json({ error: 'missing me' }, 400);
      if (!REPLAY_KEY_RE.test(key)) return json({ error: 'bad key' }, 400);
      const liveMe = await env.ONLINE_KV.get('live:' + me).catch(() => null);
      if (!liveMe) return json({ error: 'not_active' }, 403); // 防滥用：须是活跃工具用户
      const len = Number(request.headers.get('content-length') || 0);
      if (len > REPLAY_MAX_BYTES) return json({ error: 'too large' }, 413);
      const body = await request.arrayBuffer();
      if (body.byteLength > REPLAY_MAX_BYTES) return json({ error: 'too large' }, 413);
      await env.REPLAY.put(key, body, { httpMetadata: { contentType: 'video/webm' } });
      // 防重复上传：同一 (对局ID, 上传者ID) 只保留一份（重新上传覆盖旧对象，不产生重复）
      try {
        const kname = String(key).split('/').pop() || '';
        const kp = kname.slice(0, -5).split('__');
        if (kp.length >= 2) {
          const dupPrefix = 'replays/' + kp[0] + '__' + kp[1] + '__';
          const existing = await env.REPLAY.list({ prefix: dupPrefix });
          for (const o of (existing.objects || [])) { if (o.key !== key) await env.REPLAY.delete(o.key); }
        }
      } catch (e) { console.log('replayDedupe error:', e && e.message || e); }
      try { await replayRoll(env); } catch (e) { console.log('replayRoll error:', e && e.message || e); }
      return json({ ok: true, key, size: body.byteLength });
    }

    if (path === '/replay/list' && request.method === 'GET') {
      const out = [];
      let cursor = '';
      do {
        const opts = { prefix: 'replays/' };
        if (cursor) opts.cursor = cursor;
        const res = await env.REPLAY.list(opts);
        for (const obj of (res.objects || [])) {
          const lm = obj.uploaded ? (obj.uploaded instanceof Date ? obj.uploaded.getTime() : new Date(obj.uploaded).getTime() || 0) : 0;
          out.push({ key: obj.key, size: obj.size || 0, lastModified: lm });
        }
        cursor = res.cursor || '';
        if (!res.truncated) break;
      } while (cursor);
      out.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
      return json({ ok: true, count: out.length, list: out });
    }

    if ((path === '/replay/delete') && (request.method === 'DELETE' || request.method === 'POST')) {
      const me = cleanId(url.searchParams.get('me'));
      const key = String(url.searchParams.get('key') || '');
      if (!me) return json({ error: 'missing me' }, 400);
      if (!REPLAY_KEY_RE.test(key)) return json({ error: 'bad key' }, 400);
      const uid = String(key).split('/').pop().split('__')[1] || '';
      if (!uid || uid !== me) return json({ error: 'forbidden: 只能删除自己上传的录像' }, 403);
      await env.REPLAY.delete(key);
      return json({ ok: true });
    }

    // ---- 软件更新 / 公告（Cloudflare：版本元数据 + exe 托管） ----
    // 管理端 token：ADMIN_TOKEN，未设置则回退 HEARTBEAT_DEV_TOKEN（你现有的 token 直接可用）
    if (path === '/update-meta' && request.method === 'GET') {
      const raw = await env.ONLINE_KV.get('meta:update').catch(() => null);
      if (!raw) return json({ ok: false, error: 'no meta' }, 404);
      let m = null;
      try { m = JSON.parse(raw); } catch (e) {}
      if (!m) return json({ ok: false, error: 'bad meta' }, 500);
      return json({ ok: true, version: m.version, notes: m.notes, announcement: m.announcement, exeUrl: m.exeUrl, publishedAt: m.publishedAt });
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
        const meta = {
          version: version || (old && old.version) || '',
          notes: String(b.notes != null ? b.notes : (old && old.notes) || '').trim(),
          announcement: String(b.announcement != null ? b.announcement : (old && old.announcement) || '').trim(),
          exeUrl: 'https://brokenarrowreplay.zolahere.top/dist/broken-arrow-log-assistant-setup.exe',
          publishedAt: Date.now()
        };
        await env.ONLINE_KV.put('meta:update', JSON.stringify(meta));
        return json({ ok: true, meta });
      }
      // upload-exe：存 R2 dist/ 固定名（公开读，下载地址固定）
      const body = await request.arrayBuffer();
      if (!body || !body.byteLength) return json({ error: 'empty' }, 400);
      if (body.byteLength > 100 * 1024 * 1024) return json({ error: 'too large (>100MB)' }, 413);
      await env.REPLAY.put('dist/broken-arrow-log-assistant-setup.exe', body, { httpMetadata: { contentType: 'application/octet-stream' } });
      return json({ ok: true, url: 'https://brokenarrowreplay.zolahere.top/dist/broken-arrow-log-assistant-setup.exe', size: body.byteLength });
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
      const key = gameId || anon;
      // 在线（TTL 300s = 5 分钟；客户端每 2 分钟一次心跳）
      await env.ONLINE_KV.put('live:' + key, JSON.stringify({ name, gameId, anon, ip, version: v, lastSeen: now }), { expirationTtl: 300 });
      // 历史（累计，不设 TTL：firstSeen 保留、count 累加）
      const hkey = 'hist:' + key;
      let h = null;
      try { const raw = await env.ONLINE_KV.get(hkey); if (raw) h = JSON.parse(raw); } catch (e) {}
      if (!h) h = { name: '', gameId: '', anon: '', firstSeen: now, lastSeen: now, count: 0, lastIp: '', lastVersion: '' };
      if (name) h.name = name;
      if (gameId) h.gameId = gameId;
      if (anon) h.anon = anon;
      h.lastSeen = now;
      h.count = (h.count || 0) + 1;
      if (ip) h.lastIp = ip;
      if (v) h.lastVersion = v;
      await env.ONLINE_KV.put(hkey, JSON.stringify(h));
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

// 录像滚动：总量超 5GB 按上传时间从旧到新删（尽力而为，失败不影响上传）
async function replayRoll(env) {
  try {
    const GB = 1024 * 1024 * 1024;
    const limit = REPLAY_ROLL_GB * GB;
    let total = 0;
    const objs = [];
    let cursor = '';
    do {
      const opts = { prefix: 'replays/' };
      if (cursor) opts.cursor = cursor;
      const res = await env.REPLAY.list(opts);
      for (const o of (res.objects || [])) { total += Number(o.size || 0); objs.push(o); }
      cursor = res.cursor || '';
      if (!res.truncated) break;
    } while (cursor);
    if (total <= limit) return 0;
    objs.sort((a, b) => { const at = a.uploaded ? new Date(a.uploaded).getTime() : 0; const bt = b.uploaded ? new Date(b.uploaded).getTime() : 0; return at - bt; });
    let freed = 0;
    for (const o of objs) { if (total - freed <= limit) break; try { await env.REPLAY.delete(o.key); freed += Number(o.size || 0); } catch (e) {} }
    return freed;
  } catch (e) {
    console.log('replayRoll error:', e && e.message || e);
    return 0;
  }
}
