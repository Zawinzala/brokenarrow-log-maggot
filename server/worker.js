// ================= 断箭蛆工具 · 心跳统计服务（Cloudflare Workers） =================
// 与线上部署保持一致（ONLINE_KV + user: 前缀 + onlineCount）。
// 接口：
//   POST /heartbeat  body: { userId, v }   → 上报心跳（直连）
//   GET  /heartbeat  ?userId=..&v=..       → 上报心跳（GET 版，免费代理只转发 GET 时兜底用）
//   GET  /online-count                     → 返回 { onlineCount }
// 部署：在 Cloudflare 控制台 Workers 编辑页整段粘贴，或 cd server && wrangler deploy。
export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 1. 心跳上报：POST /heartbeat（body）或 GET /heartbeat（query，代理兜底）
    if (url.pathname === '/heartbeat' && (request.method === 'POST' || request.method === 'GET')) {
      let userId = '', v = '';
      try {
        if (request.method === 'POST') {
          const body = await request.json();
          userId = body.userId;
          v = body.v;
        } else {
          userId = url.searchParams.get('userId') || '';
          v = url.searchParams.get('v') || '';
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      userId = String(userId || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Missing userId' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // TTL 建议 >= 客户端心跳间隔（客户端默认每 2 分钟一次心跳）。
      // 90 秒会在两次心跳之间掉出在线列表约 30 秒；改 300（5 分钟）更稳。
      await env.ONLINE_KV.put('user:' + userId, Date.now().toString(), { expirationTtl: 300 });

      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. 在线人数：GET /online-count
    if (url.pathname === '/online-count' && request.method === 'GET') {
      const list = await env.ONLINE_KV.list({ prefix: 'user:' });
      return new Response(JSON.stringify({ onlineCount: list.keys.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Heartbeat Server is running', { status: 200, headers: corsHeaders });
  }
};
