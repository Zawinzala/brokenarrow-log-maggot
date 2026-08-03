// ================= 断箭蛆工具 · 心跳统计服务（Cloudflare Workers 参考实现） =================
// 与客户端 src/heartbeat.js 的接口约定一致：
//   POST /heartbeat  body: { userId, v }  → 上报一次心跳（5 分钟内算在线）
//   GET  /online-count                    → 返回 { online, today }
// 上报内容只有匿名 UUID + 软件版本号，不含任何玩家数据。
//
// 部署（约 3 分钟）：
//   1. 注册 Cloudflare 账号并安装 wrangler：npm i -g wrangler && wrangler login
//   2. 在 Cloudflare 控制台创建一个 KV 命名空间，把 ID 填进 wrangler.toml 的 kv_namespaces.id
//   3. 在 server 目录执行：wrangler deploy
//   4. 把得到的 https://xxx.workers.dev/ 填进软件「设置 → 统计服务地址」
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.STATS_KV;
    const now = Date.now();
    const FIVE_MIN = 5 * 60 * 1000;

    if (path === '/heartbeat' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const uid = String(body.userId || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64);
      if (!uid) return json({ error: 'missing userId' }, 400);
      const v = String(body.v || '').slice(0, 32);
      await kv.put('hb:' + uid, JSON.stringify({ t: now, v }));
      return json({ ok: true });
    }

    if (path === '/online-count') {
      const d = new Date();
      const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const list = await kv.list({ prefix: 'hb:' });
      let online = 0;
      let today = 0;
      const stale = [];
      for (const key of list.keys) {
        try {
          const rec = JSON.parse(await kv.get(key.name));
          if (now - rec.t > FIVE_MIN) { stale.push(key.name); continue; }
          online += 1;
          if (rec.t >= todayStart) today += 1;
        } catch (e) { stale.push(key.name); }
      }
      for (const k of stale) await kv.delete(k); // 清理 5 分钟没心跳的旧记录
      return json({ online, today });
    }

    return json({ ok: true, service: 'broken-arrow-heartbeat', endpoints: ['POST /heartbeat', 'GET /online-count'] });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
