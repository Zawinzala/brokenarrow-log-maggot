// ================= 对局录像云端配置（非机密，App 不持有任何存储密钥） =================
// 上传/列表/删除全部走 Cloudflare Worker（与心跳同一 worker：https://brokenarrow.zolahere.top），
// R2 令牌只存在于 Worker 的 R2 binding（名 REPLAY，绑定桶 brokenarrow-replay），任何人可上传自己的录像、只能删除自己的。
// 播放走 R2 自定义域（公开读）。
const REPLAY_PUBLIC_BASE = 'https://brokenarrowreplay.zolahere.top';

module.exports = { REPLAY_PUBLIC_BASE };
