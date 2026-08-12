// ================= 渲染进程逻辑 =================
const BA = window.api;

// ---------- 小工具 ----------
const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDuration(sec) {
  if (sec == null) return '-';
  return `${Math.floor(sec / 60)}分${sec % 60}秒`;
}
function fmtDelta(d) { return d == null ? '-' : (d > 0 ? '+' : '') + (Math.round(d * 100) / 100).toFixed(2); }
function fmtElo(v) { return v == null ? '-' : (Math.round(v * 100) / 100).toFixed(2); }
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setStatus(text, ok) {
  $('statusText').textContent = text;
  $('listenDot').className = 'dot ' + (ok ? 'on' : 'off');
}
// 顶栏：24h API 配额显示（缓存命中不计入）
function renderBudget(d) {
  if (!d) return;
  const t = $('budgetText');
  if (!t) return;
  const used = d.used24h || 0;
  const limit = d.limit24h || 0;
  let text = limit > 0 ? `API 已用 ${used} / ${limit}（24h）` : `API 已用 ${used}（不限）`;
  if (d.skipped) text += '｜跳过 ' + d.skipped;
  if (d.finished) text += ' ✓';
  t.textContent = text;
  const exhausted = limit > 0 && used >= limit;
  t.classList.toggle('warn', exhausted);
  t.title = exhausted ? '今日 API 配额已用尽，查询将暂停，明天 24 小时窗口自动恢复' : '';
}
// 顶栏：心跳统计（在线人数）
function renderHeartbeat(h) {
  const el = $('onlineText');
  if (!el) return;
  if (h && h.online != null) {
    el.classList.add('ok'); el.classList.remove('err');
    el.textContent = '● ' + h.online + ' 人正在使用';
    el.title = h.lastError
      ? '上次心跳：' + h.lastError + '（自己可能没计入）'
      : '上次心跳成功于 ' + (h.lastPing ? new Date(h.lastPing).toLocaleTimeString('zh-CN') : '-');
  } else if (h && h.lastError) {
    el.classList.remove('ok'); el.classList.add('err');
    el.textContent = '● 心跳连接失败';
    el.title = h.lastError;
  } else {
    el.classList.remove('ok', 'err');
    el.textContent = '● 0 人正在使用';
    el.title = '统计服务返回的当前在线用户数（可在设置里关闭）';
  }
}
// 顶栏：BATrace API 稳定性灯（绿=全通 / 黄=部分 / 红=全挂 / 灰=未检测）
function renderApiHealth(d) {
  const el = $('apiHealth');
  if (!el) return;
  if (!d || !d.state) { el.className = 'api-health unknown'; el.title = 'BATrace API 稳定性尚未检测（每小时自动检测一次）'; el.textContent = 'BATrace ●'; return; }
  const map = { ok: ['ok', '🟢 API 全部可用'], partial: ['warn', '🟡 API 部分可用'], down: ['down', '🔴 API 全部不可用'] };
  const pair = map[d.state] || ['unknown', 'API 状态未知'];
  el.className = 'api-health ' + pair[0];
  const detail = (d.checks || []).map((c) => (c.ok ? '✅ ' + c.label + '（' + c.ms + 'ms）' : '❌ ' + c.label + '（' + (c.status ? 'HTTP ' + c.status : '超时') + '）')).join('\n');
  el.title = pair[1] + '（' + d.okCount + '/' + d.total + '）\n' + detail + '\n检测时间：' + (d.at ? fmtTime(d.at) : '-') + '\n每小时自动检测一次';
  el.textContent = 'BATrace ●';
}
// 单选/多选增强：单击单选，Ctrl+单击多选
// 多选增强：单击单选，Ctrl+单击多选，Shift+单击区间选择，Ctrl+A 全选
function enableToggleSelect(sel) {
  let anchor = -1;
  sel.addEventListener('mousedown', (e) => {
    if (e.target && e.target.tagName === 'OPTION') {
      e.preventDefault();
      const i = e.target.index;
      if (e.shiftKey && anchor >= 0) {
        const a = Math.min(anchor, i), b = Math.max(anchor, i);
        for (let j = 0; j < sel.options.length; j++) sel.options[j].selected = j >= a && j <= b;
      } else if (e.ctrlKey || e.metaKey) {
        e.target.selected = !e.target.selected;
        anchor = i;
      } else {
        for (let j = 0; j < sel.options.length; j++) sel.options[j].selected = j === i;
        anchor = i;
      }
    }
  });
  sel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      for (let j = 0; j < sel.options.length; j++) sel.options[j].selected = true;
    }
  });
}

function selectedOptions(sel) {
  return Array.from(sel.selectedOptions || []).map((o) => o.value);
}
function copyText(text, btn, doneText) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = doneText || '✅';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    }
  }).catch(() => {});
}
// 单玩家一行情报（与油猴脚本同格式）
function playerInfoText(p) {
  const info = p.info;
  const elo = info && info.elo != null ? Math.round(info.elo) : '无';
  const cat = info && info.category ? catLabel(info.category) : '暂无数据';
  const top = info && info.topUnits ? info.topUnits : '暂无数据';
  return `玩家 ${p.name} (ID: ${p.id}) | ELO: ${elo} | 偏好: ${cat} | 最爱: ${top}`;
}
function copyPlayerRow(row, btn) { copyText(playerInfoText(row), btn, '✅'); }
// 单队一行：名字+ELO（油猴脚本同格式）
function copyTeamRow(team, btn, rows) {
  const src = rows || matchRows;
  const teamVal = team === 'alpha' ? 'Alpha' : team === 'bravo' ? 'Bravo' : null;
  const players = Object.values(src).filter((p) => teamVal ? p.team === teamVal : !p.team);
  const line = players.map((p) => {
    const elo = p.info && p.info.elo != null ? Math.round(p.info.elo) : '无';
    return p.name + ' ' + elo;
  }).join(', ');
  copyText(line, btn, '✅');
}

// ---------- 预加载健康检查 ----------
if (!window.api) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#5a1f1f;color:#ffd7d7;padding:10px 16px;font-size:13px;';
  banner.textContent = '预加载脚本未注入（window.api 不存在），按钮将全部失效。请检查 preload.js 是否被安全软件拦截，或查看 userData/renderer.log。';
  document.body.prepend(banner);
}

// ---------- 全局状态 ----------
let session = { localName: null, current: null, currentDeck: '' };
let matchRows = {};
let querying = false;
let confirmResolve = null;
let archiveList = [];       // 对局档案缓存（上一局取 archiveList[0]）
let viewMode = 'current';  // 'current' | 'prev'
let prevMatch = null;      // 正在查看的上一局
let prevRows = {};         // 上一局玩家行
let prevQueriedKey = null; // 上一局自动粗查去重
let currentTheme = 'dark';
let savedTheme = 'dark';
let invId = null;          // 调查弹窗当前玩家
let invName = null;

// ---------- 确认弹窗 ----------
function askConfirm(text) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirmText').textContent = text;
    $('confirmModal').classList.remove('hidden');
  });
}
function closeConfirm(result) {
  $('confirmModal').classList.add('hidden');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

// ---------- 房间内也在用本工具的人（服务端比对，保护隐私） ----------
let toolUserIds = new Set();
// ---------- 当前对局渲染 ----------
function renderSession(s) {
  resetPrevIfViewing();
  session = s;
  const cur = s.current;
  // 标题随状态切换：房间 / 对局
  const titleEl = $('currentCardTitle');
  if (titleEl) titleEl.textContent = cur ? '当前对局' : '当前房间';
  const lobby = Object.entries(s.lobbyPlayers || {}).map(([id, name]) => ({ id, name, team: null }));
  const keep = matchRows; // 保留已查询/加载中的状态，避免会话事件把结果清成“未查询”
  matchRows = {};
  if (!cur) {
    for (const p of lobby) {
      const prev = keep[p.id];
      matchRows[p.id] = (prev && (prev.info || prev.error || prev.status === 'loading' || prev.status === 'done'))
        ? { ...prev, name: p.name, team: null }
        : { id: p.id, name: p.name, team: null, status: 'idle' };
    }
    if (lobby.length) {
      $('matchInfo').innerHTML = `<span>状态：<b>未开战（房间内 ${lobby.length} 人）</b></span><span class="dim">已自动粗查，结果直接显示在下方</span>`;
    } else {
      $('matchInfo').innerHTML = '<span class="dim">等待对局开始（大厅中或无日志）…</span>';
    }
    renderMatchGrid();
    $('queryStatus').textContent = '';
    return;
  }
  $('matchInfo').innerHTML = `
    <span>地图：<b>${esc(cur.map || '未知')}</b></span>
    <span>对局ID：<b>${esc(cur.fid || '-')}</b></span>
    <span>本机玩家：<b>${esc(s.localName || '-')}</b></span>
    <span>本局卡组：<b>${esc(cur.localDeck || '-')}</b></span>`;
  for (const p of cur.players || []) {
    const prev = keep[p.id];
    if (!matchRows[p.id]) {
      matchRows[p.id] = (prev && (prev.info || prev.error || prev.status === 'loading' || prev.status === 'done'))
        ? { ...prev, name: p.name, team: p.team }
        : { id: p.id, name: p.name, team: p.team, status: 'idle' };
    }
  }
  renderMatchGrid();
}

const CAT_LABELS = { aircrafts: '战机', helicopters: '直升机', tanks: '坦克', ifvs: '步战车', apcs: '装甲车', artillery: '火炮', airdefense: '防空', infantry: '步兵', recon: '侦察', ships: '战舰', transports: '运输', drones: '无人机', missiles: '导弹', naval: '海军', vehicles: '载具', support: '支援', planes: '战机', armor: '装甲' };
function catLabel(key) { if (!key) return '-'; return CAT_LABELS[String(key).toLowerCase()] || String(key); }

function playerCard(p) {
  const selfName = session.localName;
  const selfTag = selfName && p.name === selfName ? '<span class="pself">(我)</span>' : '';
  const toolTag = toolUserIds.has(String(p.id)) ? '<span class="ptool" title="也在使用本工具">🎮</span>' : '';
  let statHtml = '';
  if (p.status === 'loading') statHtml = '<span class="loading">查询中…</span>';
  else if (p.error) {
    if (p.localSnapshot) statHtml = `<span class="dim">本地 ELO ${p.localSnapshot.elo ?? '-'}${p.localSnapshot.winRate != null ? ` · 胜率 ${p.localSnapshot.winRate}%` : ''}（离线，${fmtTime(p.localSnapshot.at)}）</span>`;
    else statHtml = `<span class="err">${esc(p.error)}</span>`;
  }
  else if (p.info) {
    const units = p.info.topUnits ? (p.info.topUnits.length > 18 ? p.info.topUnits.slice(0, 18) + '…' : p.info.topUnits) : '';
    statHtml = `
      <span class="elo">ELO ${p.info.elo ?? '-'}</span>
      ${p.info.kd != null ? `<span>K/D ${p.info.kd}</span>` : ''}
      ${p.info.winRate != null ? `<span class="wr">胜率 ${p.info.winRate}%</span>` : ''}
      ${p.info.matchCount ? `<span>样本 ${p.info.matchCount}</span>` : ''}
      ${p.info.category ? `<span class="cat">${esc(catLabel(p.info.category))}</span>` : ''}
      ${units ? `<span class="topu" title="最爱：${esc(p.info.topUnits)}">${esc(units)}</span>` : ''}`;
  }
  return `<div class="player-card" data-id="${p.id}" data-name="${esc(p.name)}" data-link="${PLAYER_URL(p.id)}" title="左键：完整报告；右键：在 BATrace 打开">
    <div class="prow"><span class="pname">${esc(p.name)}${selfTag}${toolTag}</span><span class="pid">ID ${esc(p.id)}</span><button class="p-copy" data-id="${p.id}" title="复制该玩家一行情报">📋</button><span class="pmark">›</span></div>
    <div class="pstats">${statHtml || '<span class="dim">未查询</span>'}</div>
  </div>`;
}

function renderMatchGrid() {
  const players = Object.values(matchRows);
  if (!players.length) { $('teamGrid').innerHTML = '<span class="dim">暂无名单</span>'; return; }
  const copyLabel = (cls) => cls === 'lobby' ? '复制全部' : '复制单队';
  const col = (title, cls, list, wide) => `
    <div class="team-col ${cls}${wide ? ' wide' : ''}">
      <h3>${title}（${list.length}）${list.length ? `<button class="team-copy ghost" data-team="${cls}" title="复制本队 名字+ELO 一行">📋 ${copyLabel(cls)}</button>` : ''}</h3>
      ${list.map(playerCard).join('') || '<span class="dim">-</span>'}
    </div>`;
  if (!session.current) {
    $('teamGrid').innerHTML = col('房间内玩家（未开战，点击卡片可粗查）', 'lobby', players, true);
    return;
  }
  const alpha = players.filter((p) => p.team === 'Alpha');
  const bravo = players.filter((p) => p.team === 'Bravo');
  const other = players.filter((p) => p.team !== 'Alpha' && p.team !== 'Bravo');
  let html = col('Alpha 队', 'alpha', alpha) + col('Bravo 队', 'bravo', bravo);
  if (other.length) html += col('观战 / 其他', '', other);
  $('teamGrid').innerHTML = html;
}

// ---------- 上一局视图 ----------
let prevLoading = false;
function togglePrevView() {
  if (viewMode === 'prev') { exitPrevView(); return; }
  if (prevLoading) return;
  const m = archiveList[0];
  if (!m || !m.fid) {
    $('matchInfo').innerHTML = '<span class="dim">暂无上一局记录（还没有完成的对局）。</span>';
    $('teamGrid').innerHTML = '<span class="dim">-</span>';
    return;
  }
  prevLoading = true;
  BA.getMatchDetail(m.fid).then((d) => {
    prevLoading = false;
    if (!d || !d.players || !d.players.length) {
      $('matchInfo').innerHTML = '<span class="dim">暂无上一局记录（还没有完成的对局）。</span>';
      $('teamGrid').innerHTML = '<span class="dim">-</span>';
      return;
    }
    viewMode = 'prev';
    prevMatch = d;
    prevRows = {};
    for (const p of d.players) prevRows[p.id] = { id: p.id, name: p.name, team: p.team, status: 'idle' };
    $('currentCardTitle').textContent = '上一局';
    const b = $('btnPrevMatch'); if (b) b.textContent = '🔄 返回当前';
    $('matchInfo').innerHTML = `<span>地图：<b>${esc(d.map || '未知')}</b></span><span>对局ID：<b>${esc(d.fid || '-')}</b></span><span>结束时间：<b>${fmtTime(d.endTime)}</b></span><span>共 ${d.players.length} 人</span>`;
    $('queryStatus').textContent = '';
    renderPrevGrid();
    // 打开即自动粗查一次（同一局去重）
    const key = d.fid || ('t:' + (d.startTime || 0));
    if (prevQueriedKey !== key) {
      prevQueriedKey = key;
      const players = d.players.filter((p) => p.id != null).map((p) => ({ id: p.id, name: p.name, team: p.team }));
      BA.queryRoster(players).catch(() => {});
    }
  }).catch(() => {
    prevLoading = false;
    $('matchInfo').innerHTML = '<span class="dim">加载上一局失败，请重试。</span>';
  });
}
function exitPrevView() {
  if (viewMode !== 'prev') return;
  viewMode = 'current';
  prevMatch = null;
  prevRows = {};
  const b = $('btnPrevMatch'); if (b) b.textContent = '🕘 上一局';
  renderSession(session);
}
function resetPrevIfViewing() {
  if (viewMode !== 'prev') return;
  viewMode = 'current';
  prevMatch = null;
  prevRows = {};
  const b = $('btnPrevMatch'); if (b) b.textContent = '🕘 上一局';
  const t = $('currentCardTitle');
  if (t) t.textContent = session.current ? '当前对局' : '当前房间';
}
function renderPrevGrid() {
  const players = Object.values(prevRows);
  if (!players.length) { $('teamGrid').innerHTML = '<span class="dim">暂无名单</span>'; return; }
  const col = (title, cls, list, wide) => `
    <div class="team-col ${cls}${wide ? ' wide' : ''}">
      <h3>${title}（${list.length}）</h3>
      ${list.map(playerCard).join('') || '<span class="dim">-</span>'}
    </div>`;
  const alpha = players.filter((p) => p.team === 'Alpha');
  const bravo = players.filter((p) => p.team === 'Bravo');
  const other = players.filter((p) => p.team !== 'Alpha' && p.team !== 'Bravo');
  let html = col('Alpha 队', 'alpha', alpha) + col('Bravo 队', 'bravo', bravo);
  if (other.length) html += col('观战 / 其他', '', other);
  $('teamGrid').innerHTML = html;
}

async function loadReport(stbid, name) {
  const area = $('reportArea');
  area.innerHTML = '<div class="dim">正在生成报告（一次 API 调用，稍候）…</div>';
  area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await BA.playerReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; area.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    lastReport = { id: stbid, name: name || stbid };
    renderReport(r, name);
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    area.innerHTML = `<div class="loss">报告生成失败：${esc(e.message)}</div>`;
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderReport(r, name) {
  if (r.fallback) {
    $('reportArea').innerHTML = `
      <div class="report">
        <div class="report-head">
          <span class="rname">${esc(name || r.name || r.stbid)}</span>
          <span class="dim">ID ${r.stbid}</span>
          <span class="dim">Lv.${r.level ?? '-'}</span>
          <span class="tag" style="color:var(--warn)">仅有基础档案，无排位分析</span>
        </div>
        <div class="kv">
          <div class="item"><b>${r.elo ?? '-'}</b><span>ELO</span></div>
          <div class="item"><b>${r.winRate != null ? r.winRate + '%' : '-'}</b><span>天梯胜率（${r.matchCount ?? 0} 场）</span></div>
          <div class="item"><b>${r.wins ?? '-'} / ${r.losses ?? '-'}</b><span>胜 / 负</span></div>
        </div>
        <div class="dim" style="margin-top:8px">该玩家没有可用的排位分析数据（可能未打天梯、场次太少或数据未收录），无法生成详细报告与蛆指数。</div>
      </div>`;
    return;
  }
  const cats = (r.categories || []).map((c) =>
    `<span class="tag">${esc(catLabel(c.key))}${c.pct != null ? ' ' + c.pct + '%' : ''}</span>`).join('');
  const fav = (r.favUnits || []).map((u) =>
    `<span class="tag" title="出场 ${u.spawn ?? '-'} 次">${esc(u.name)}${u.val ? '（输出 ' + Math.round(u.val) + '）' : ''}</span>`).join('');
  const maps = (r.mapStats || []).map((m) =>
    `<span class="tag" title="场次 ${m.matchCount ?? '-'}">${esc(m.name)}${m.winRate != null ? ' ' + m.winRate + '%' : ''}</span>`).join('');
  const style = styleLabel(r.playStyle && r.playStyle.primaryStyle);
  const rows = (r.recentMatches || []).map((m) => `
    <tr>
      <td class="${m.win == null ? 'unk' : m.win ? 'win' : 'loss'}">${m.win == null ? '未知' : m.win ? '胜' : '负'}</td>
      <td>${fmtDelta(m.eloDelta)}</td>
      <td>${m.kd ?? '-'}</td>
      <td>${m.dmr ?? '-'}</td>
      <td>${m.destruction ?? '-'}</td>
      <td>${m.losses ?? '-'}</td>
      <td>${m.objectives ?? '-'}</td>
      <td class="dim" data-link="${MATCH_URL(m.matchId)}" title="右键：在 BATrace 打开">${esc(m.matchId ?? '-')}</td>
    </tr>`).join('');
  const catText = (r.categories || []).map((c) => catLabel(c.key)).join('/') || '无';
  const favText = (r.favUnits || []).map((u) => u.name).join('/') || '无';
  const copyText = `玩家 ${name || r.stbid} (ID: ${r.stbid}) | ELO: ${r.elo ?? '无'} | 偏好: ${catText} | 最爱: ${favText}`;
  $('reportArea').innerHTML = `
    <div class="report">
      <div class="report-head">
        <span class="rname" data-link="${PLAYER_URL(r.stbid)}" title="右键：在 BATrace 打开">${esc(name || r.stbid)}</span>
        <span class="dim">ID ${r.stbid}</span>
        <span class="dim">样本 ${r.matchCount ?? '-'} 场</span>
        <button id="btnCopyReport" class="ghost" style="margin-left:auto">📋 复制单行</button>
        <button id="btnMaggotFromReport" class="accent">🐛 查蛆指数</button>
      </div>
      <div class="kv">
        <div class="item"><b>${r.elo ?? '-'}</b><span>ELO</span></div>
        <div class="item"><b>${r.winRate != null ? r.winRate + '%' : '-'}</b><span>胜率（${r.matchCount ?? 0} 场）</span></div>
        <div class="item"><b>${r.wins ?? '-'} / ${r.losses ?? '-'}</b><span>胜 / 负</span></div>
        <div class="item"><b>${r.kd ?? '-'}</b><span>最新 K/D</span></div>
        <div class="item"><b>${r.dmr ?? '-'}</b><span>最新 DMR</span></div>
        <div class="item"><b>${esc(style)}</b><span>打法</span></div>
      </div>
      ${cats ? `<div class="tags"><span class="dim">偏好：</span>${cats}</div>` : ''}
      ${fav ? `<div class="favunits"><span class="dim">最爱单位：</span>${fav}</div>` : ''}
      ${maps ? `<div class="favunits"><span class="dim">地图表现：</span>${maps}</div>` : ''}
      <table class="matches">
        <thead><tr><th>结果</th><th>ELO变化</th><th>K/D</th><th>DMR</th><th>摧毁</th><th>损失</th><th>占点</th><th>对局ID</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="dim">无近期对局</td></tr>'}</tbody>
      </table>
      <div class="dim" style="margin-top:8px">提示：蛆指数需要最近 12 场对局明细，请点上方「🐛 查蛆指数」按钮单独查询（约 13 次调用，24 小时缓存后仅 1 次）。</div>
    </div>`;
  const copyBtn = $('btnCopyReport');
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard.writeText(copyText).then(() => {
      copyBtn.textContent = '✅ 已复制';
      setTimeout(() => { copyBtn.textContent = '📋 复制单行'; }, 1500);
    }).catch(() => {});
  };
  const mgBtn = $('btnMaggotFromReport');
  if (mgBtn) mgBtn.onclick = () => runMaggot(r.stbid, name || r.stbid);
}

const STYLE_LABELS = {
  team_player: '团队型', combat_focused: '作战型', balanced_combat: '均衡作战',
  balanced_economy: '均衡经济', economy_focused: '经济型', aggressive: '激进型',
  defensive: '防守型', support: '支援型'
};
function styleLabel(key) { if (!key) return '-'; return STYLE_LABELS[String(key).toLowerCase()] || String(key); }

// ---- 对局档案（本地 matches 表，最近 500 局） ----------
// 对局状态（本机视角）：观战 / 胜 / 负 / 未知
function matchState(m) {
  if (m.localSpectator) return { text: '观战', cls: 'spec' };
  if (m.localWon === true) return { text: '胜', cls: 'win' };
  if (m.localWon === false) return { text: '负', cls: 'loss' };
  return { text: '未知', cls: 'unk' };
}
function renderArchive(list) {
  archiveList = Array.isArray(list) ? list : [];
  const el = $('archiveList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<span class="dim">暂无对局记录（本地 matches 表为空）。</span>';
    return;
  }
  const modeBadge = (m) => m.mode === 'custom' ? '<span class="mode-tag custom">自定义</span>' : m.mode === 'ranked' ? '<span class="mode-tag ranked">排位</span>' : (m.custom === true ? '<span class="mode-tag custom">自定义</span>' : m.custom === false ? '<span class="mode-tag ranked">排位</span>' : '<span class="dim">未知</span>');
  el.innerHTML = `
    <table class="archive-table">
      <thead><tr><th>状态</th><th>模式</th><th>地图</th><th>ELO</th><th>时间</th><th>账号</th></tr></thead>
      <tbody>${list.map((m) => {
        const fid = m.fid || '';
        const link = fid ? ` data-link="${MATCH_URL(fid)}"` : '';
        const st = matchState(m);
        const hasReplay = !!(m.fid && replayFids.has(String(m.fid)));
        const elo = m.localEloDelta != null ? fmtDelta(m.localEloDelta) + ' / ' + fmtElo(m.localEloAfter) : '-';
        const who = m.localPersona || m.localName || '';
        return `<tr class="archive-row"${link} data-fid="${fid}" title="左键：详情；右键：在 BATrace 打开对局">
          <td class="${st.cls}">${st.text}</td>
          <td>${modeBadge(m)}</td>
          <td>${esc(m.map || '未知地图')}${hasReplay ? ' <span class="replay-mark" title="该对局有录像，点击播放" role="button">📹</span>' : ''}</td>
          <td class="${m.localEloDelta == null ? 'dim' : m.localEloDelta > 0 ? 'win' : 'loss'}">${elo}</td>
          <td class="dim">${fmtTime(m.endTime)}</td>
          <td class="dim">${who ? '[' + esc(who) + ']' : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  el.querySelectorAll('.archive-row[data-fid]').forEach((item) => {
    item.addEventListener('click', (e) => { e.preventDefault(); openMatchDetail(item.dataset.fid); });
  });
  // 点 📹 直接打开该对局的本地录像
  el.querySelectorAll('.replay-mark').forEach((mk) => {
    mk.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const row = mk.closest('.archive-row');
      if (row && row.dataset.fid) openReplayForFid(row.dataset.fid);
    });
  });
}

// 从对局档案的 📹 打开录像：单个直接播；多个本地文件弹列表选择
async function openReplayForFid(fid) {
  try {
    const items = await collectReplayItemsForFid(fid);
    if (!items.length) { setStatus('该对局暂无录像可播放', false); return; }
    let chosen = items[0];
    if (items.length > 1) {
      chosen = await pickReplay(items);
      if (!chosen) return;
    }
    await playReplayItem(chosen);
  } catch (e) { setStatus('打开录像失败：' + e.message, false); }
}

// 收集某对局所有本地录像视角（无云端；同一对局可能有多份本地文件）
async function collectReplayItemsForFid(fid) {
  const q = String(fid);
  const lr = await BA.listLocalReplays().catch(() => null);
  const locals = ((lr && lr.list) || []).filter((x) => String(x.fid) === q);
  return locals.map((it) => ({
    fid: q,
    local: it,
    source: 'local',
    name: it.uploaderName || '',
    map: it.map || '',
    team: it.team != null && it.team !== '' ? it.team : it.teamId,
    teamId: it.teamId,
    createdAt: it.createdAt || it.endTime,
    size: it.size,
    durationSec: it.durationSec
  }));
}

// 播放本地视角（离线可看）
async function playReplayItem(item) {
  if (item.local) {
    const r = await BA.readLocalReplay(item.local.id);
    if (r && r.ok) {
      const url = URL.createObjectURL(new Blob([r.data], { type: 'video/webm' }));
      openReplayPlayer({ id: item.local.id, videoUrl: url, fid: item.fid, name: item.name, map: item.map, isBlob: true });
      return;
    }
  }
  setStatus('该对局暂无录像可播放', false);
}

let replayPickResolve = null;
let lastVersionInfo = null; // 最近一次版本信息（下载按钮用）
function pickReplay(items) {
  return new Promise((resolve) => {
    replayPickResolve = resolve;
    const wrap = $('replayPickerList');
    if (!wrap) { resolve(null); return; }
    wrap.innerHTML = (items || []).map((it, i) => `
      <div class="inv-item replay-pick-item" data-idx="${i}" title="点击播放">
        <span class="r-name">${esc(it.name || '未知')}</span>
        <span class="r-src local">📁 本地</span>
        ${replayTeamTag(it.team != null && it.team !== '' ? it.team : it.teamId)}
        <span class="dim">${it.durationSec ? fmtDuration(it.durationSec) : '-'}</span>
        <span class="dim">${fmtSize(it.size)}</span>
        <span class="dim">${fmtTime(it.createdAt)}</span>
      </div>`).join('');
    $('replayPickerModal').classList.remove('hidden');
    wrap.querySelectorAll('.replay-pick-item').forEach((el) => el.addEventListener('click', () => {
      $('replayPickerModal').classList.add('hidden');
      const idx = Number(el.dataset.idx);
      if (replayPickResolve) { replayPickResolve(items[idx] || null); replayPickResolve = null; }
    }));
  });
}
// ---------- 对局详情弹窗 ----------
async function openMatchDetail(fid) {
  $('matchModal').classList.remove('hidden');
  $('matchTitle').textContent = '对局详情';
  $('matchFid').textContent = '对局 ID ' + fid;
  $('matchDetailBody').innerHTML = '<div class="dim">载入中…</div>';
  clearInvGameTimer();
  stopRadarLoading();
  // 250ms 内未返回（即真实请求）再显示雷达加载动画；本地/缓存命中不闪
  let radarTimer = setTimeout(() => { radarTimer = null; startRadarLoading($('matchGameWrap'), $('matchGame')); }, 250);
  try {
    const d = await BA.getMatchDetail(fid);
    if (radarTimer) { clearTimeout(radarTimer); radarTimer = null; }
    stopRadarLoading();
    renderMatchDetail(d);
  } catch (e) {
    if (radarTimer) { clearTimeout(radarTimer); radarTimer = null; }
    stopRadarLoading();
    $('matchDetailBody').innerHTML = '<div class="loss">加载失败：' + esc(e.message) + '</div>';
  }
}
function renderMatchDetail(d) {
  if (!d) { $('matchDetailBody').innerHTML = '<div class="dim">本地无此对局记录。</div>'; return; }
  $('matchTitle').textContent = d.map || '未知地图';
  $('matchFid').textContent = '对局 ID ' + d.fid;
  const modeTxt = d.mode === 'custom' ? '自定义' : d.mode === 'ranked' ? '排位' : (d.custom === true ? '自定义' : d.custom === false ? '排位' : '未知');
  const st = matchState(d);
  const elo = d.localEloDelta != null ? fmtDelta(d.localEloDelta) : '-';
  const settle = d.localEloAfter != null ? fmtElo(d.localEloAfter) : '-';
  const sc = d.localScores ? (d.localScores.destruction ?? '-') + '/' + (d.localScores.losses ?? '-') : '-';
  const account = d.localPersona || d.localName || '';
  const fetchNote = d.fetched ? '<div class="dim">（已从 API 补齐）</div>' : (d.fetchError ? `<div class="dim">（API 补齐失败：${esc(d.fetchError)}）</div>` : '');
  const groups = { 0: [], 1: [], 100: [], other: [] };
  for (const p of d.players || []) {
    let g;
    if (p.teamId === 0 || p.teamId === 1 || p.teamId === 100) g = p.teamId;
    else if (p.team === 'Alpha') g = 0;
    else if (p.team === 'Bravo') g = 1;
    else if (p.team === 'Spectators') g = 100;
    else g = 'other';
    groups[g].push(p);
  }
  const playerRow = (p) => {
    const delta = (p.oldRating != null && p.newRating != null) ? fmtDelta(p.newRating - p.oldRating) : '-';
    const score = p.destructionScore != null ? p.destructionScore + '/' + (p.lossesScore ?? '-') : '-';
    const obj = p.objectivesCaptured != null ? p.objectivesCaptured : '-';
    const k = p.killed != null ? p.killed : '-';
    const dmg = p.damageDealt != null ? p.damageDealt : '-';
    const taken = p.damageReceived != null ? p.damageReceived : '-';
    const dlr = p.dlRatio != null ? p.dlRatio : '-';
    const sp = p.supplyPoints != null ? p.supplyPoints : '-';
    const ex = p.exp != null ? p.exp : '-';
    const md = p.medals != null ? p.medals : '-';
    return `<tr data-id="${esc(p.id)}" data-name="${esc(p.name || '')}" data-link="${PLAYER_URL(p.id)}" title="右键：调查羁绊 / BATrace">
      <td><b>${esc(p.name || '未知')}</b></td>
      <td class="dim md-id-cell"><span class="md-id">${esc(p.id)}</span></td>
      <td>${delta}</td>
      <td class="dim">${score}</td>
      <td class="dim">${obj}</td>
      <td class="dim">${k}</td>
      <td class="dim">${dmg}</td>
      <td class="dim">${taken}</td>
      <td class="dim">${dlr}</td>
      <td class="dim">${sp}</td>
      <td class="dim">${ex}</td>
      <td class="dim">${md}</td>
    </tr>`;
  };
  const group = (title, list) => list.length ? `
    <div class="inv-section"><b>${title}（${list.length}）</b>
      <table class="md-table">
        <colgroup>
          <col style="width:13%"><col style="width:11%"><col style="width:8%"><col style="width:10%">
          <col style="width:7%"><col style="width:7%"><col style="width:9%"><col style="width:9%">
          <col style="width:6%"><col style="width:7%"><col style="width:7%"><col style="width:6%">
        </colgroup>
        <thead><tr><th>玩家</th><th>ID</th><th>ELO变化</th><th>评分</th><th>占点</th><th>击杀</th><th>伤害</th><th>承伤</th><th>K/D</th><th>补给</th><th>经验</th><th>奖牌</th></tr></thead>
        <tbody>${list.map(playerRow).join('')}</tbody>
      </table>
    </div>` : '';
  let body = '';
  if (d.winnerTeam === 0 || d.winnerTeam === 1) {
    const w = d.winnerTeam, l = d.winnerTeam === 0 ? 1 : 0;
    body = group('🏆 胜方 ' + (w === 0 ? 'Alpha' : 'Bravo'), groups[w]) + group('💀 败方 ' + (l === 0 ? 'Alpha' : 'Bravo'), groups[l]);
  } else {
    body = group('Alpha 队', groups[0]) + group('Bravo 队', groups[1]);
  }
  body += group('👁 观战', groups[100]) + group('其他', groups.other);
  $('matchDetailBody').innerHTML = `
    <div class="inv-stats">
      <div class="inv-stat"><b>${esc(d.fid)}</b><span>对局 ID</span></div>
      <div class="inv-stat"><b>${esc(d.map || '未知地图')}</b><span>地图</span></div>
      <div class="inv-stat"><b>${fmtTime(d.endTime)}</b><span>时间</span></div>
      <div class="inv-stat"><b>${fmtDuration(d.durationSec)}</b><span>时长</span></div>
      <div class="inv-stat"><b>${modeTxt}</b><span>模式</span></div>
      <div class="inv-stat"><b class="${st.cls}">${st.text}</b><span>结果</span></div>
      <div class="inv-stat"><b>${elo}</b><span>ELO变化</span></div>
      <div class="inv-stat"><b>${settle}</b><span>结算ELO</span></div>
      <div class="inv-stat"><b>${sc}</b><span>评分</span></div>
      <div class="inv-stat"><b>${account ? esc(account) : '-'}</b><span>本机账号</span></div>
    </div>
    ${fetchNote}
    ${body}`;
}

// ---------- 卡组工具 ----------
async function refreshDecks() {
  try {
    const d = await BA.listDecks();
    const fmt = (s) => s ? (s.length > 70 ? '…' + s.slice(-70) : s) : '';
    $('deckPaths').textContent = `前线 ${fmt(d.decksDir)} ｜ 后勤 ${fmt(d.backupsDir)} `;
    const front = $('deckFront');
    const back = $('deckBack');
    if (!d.found) {
      front.innerHTML = '<option disabled>未找到卡组目录（游戏未安装 / 未运行过）</option>';
      back.innerHTML = '<option disabled>（无备份）</option>';
      deckMsg('未找到游戏卡组目录：' + d.decksDir + '。请确认《断箭》已安装并至少运行过一次。', true);
      return;
    }
    front.innerHTML = d.decks.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') || '<option disabled>（空）</option>';
    back.innerHTML = d.backups.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') || '<option disabled>（空）</option>';
  } catch (e) {
    deckMsg('卡组列表加载失败：' + e.message, true);
  }
}

function deckMsg(text, isError) {
  const el = $('deckMsg');
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : '';
}

let backupAllPending = false;
function showBackupRow() {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('backupName').value = `Backup-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  $('backupRow').classList.remove('hidden');
  $('backupName').focus();
}
function allDeckNames() {
  return Array.from($('deckFront').options || []).filter((o) => !o.disabled).map((o) => o.value);
}
async function doBackup() {
  const names = selectedOptions($('deckFront'));
  if (!names.length) { deckMsg('请先在前线卡组选择要备份的卡组（Ctrl+单击可多选）', true); return; }
  backupAllPending = false;
  showBackupRow();
}
async function doBackupAll() {
  const names = allDeckNames();
  if (!names.length) { deckMsg('左侧没有可备份的卡组', true); return; }
  backupAllPending = true;
  for (const o of $('deckFront').options) if (!o.disabled) o.selected = true;
  showBackupRow();
}
async function confirmBackup() {
  const names = backupAllPending ? allDeckNames() : selectedOptions($('deckFront'));
  const pkg = $('backupName').value.trim();
  if (!names.length || !pkg) { deckMsg('名称不能为空', true); return; }
  backupAllPending = false;
  try {
    const r = await BA.backupDecks(names, pkg);
    deckMsg(r.message, !r.ok);
    $('backupRow').classList.add('hidden');
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg('备份失败：' + e.message, true);
  }
}
async function doSyncRestore() {
  const ok = await askConfirm('是否替换成换号前的上一局卡组包？\n同名卡组将被覆盖，原包仍保留在后勤仓库（上一局卡组包.zip）');
  if (!ok) return;
  try {
    const r = await BA.syncRestore();
    deckMsg(r.message, !r.ok);
    $('deckSyncAlert').classList.add('hidden');
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg('同步失败：' + e.message, true);
  }
}
async function doSyncIgnore() {
  const ok = await askConfirm('忽略后，将以当前账号的卡组为基线，上一账号的归档仍保留在本地。确定忽略吗？');
  if (!ok) return;
  try {
    const r = await BA.syncIgnore();
    deckMsg(r.message, !r.ok);
    $('deckSyncAlert').classList.add('hidden');
    refreshDecks();
  } catch (e) {
    deckMsg('操作失败：' + e.message, true);
  }
}
function dismissSyncAlert() {
  BA.syncDismiss();
  const el = $('deckSyncAlert');
  if (el) el.classList.add('hidden');
}
function renderDeckSyncAlert(d) {
  if (!d) return;
  const el = $('deckSyncAlert');
  if (!el) return;
  const f = $('syncFrom');
  if (f) f.textContent = d.from || '';
  const ai = $('syncAccountInfo');
  if (ai) {
    if (d.to) ai.textContent = '（当前账号：' + d.to + '）';
    else ai.textContent = '';
  }
  el.classList.remove('hidden');
}

async function doDeploy() {
  const names = selectedOptions($('deckBack'));
  if (!names.length) { deckMsg('请先在后勤仓库选择要部署的备份包', true); return; }
  const pkg = names[0];
  const ok = await askConfirm(`确定要从 ${pkg} 部署卡组吗？\n同名文件将被覆盖！`);
  if (!ok) return;
  try {
    const r = await BA.deployDecks(pkg);
    deckMsg(r.message, !r.ok);
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg('部署失败：' + e.message, true);
  }
}
async function doDelete(kind, label) {
  const sel = kind === 'backups' ? $('deckBack') : $('deckFront');
  const names = selectedOptions(sel);
  if (!names.length) { deckMsg(`请先选择要删除的${label}`, true); return; }
  const ok = await askConfirm(`确定删除选中的 ${names.length} 个文件吗？`);
  if (!ok) return;
  try {
    const r = await BA.deleteDecks(kind, names);
    deckMsg(r.message, !r.ok);
    refreshDecks();
  } catch (e) {
    deckMsg('删除失败：' + e.message, true);
  }
}

// ---------- 设置 ----------
// ---------- APM 统计 ----------
let apmRunning = false;
function renderApmStart(d) {
  const meta = $('apmMeta');
  const body = $('apmBody');
  if (!d || !d.available) {
    apmRunning = false;
    const reason = !d ? 'APM 无法打开'
      : d.reason === 'disabled' ? '未开启 APM 监测功能（请在「设置」中开启，默认关闭）'
      : d.reason === 'replay' ? '当前为回放/历史日志，APM 无法统计'
      : d.reason === 'hook' ? '输入钩子初始化失败，APM 无法打开'
      : 'APM 无法打开';
    if (meta) meta.textContent = 'APM 不可用';
    if (body) body.innerHTML = `<div class="apm-empty loss">⚠️ ${reason}</div>`;
    return;
  }
  apmRunning = true;
  if (meta) meta.textContent = d.map ? `对局进行中｜${esc(d.map)}` : '对局进行中';
  if (body) body.innerHTML = `<div class="apm-live"><div class="apm-bignum" id="apmNow">0</div><div class="apm-live-label">当前 APM（每分钟操作数 = 鼠标点击 + 键盘按键）</div><div class="dim" id="apmLiveSub">统计中…</div></div>`;
}
function renderApmLive(d) {
  if (!apmRunning || !d) return;
  const now = $('apmNow');
  if (now) now.textContent = d.apm;
  const sub = $('apmLiveSub');
  if (sub) sub.textContent = `已进行 ${fmtDuration(d.durationSec)}｜总操作 ${d.totalActions}`;
}
function renderApmResult(r) {
  if (!r) return;
  apmRunning = false;
  const focusNote = r.focusFilter ? '' : '<span class="dim">（未启用前台过滤，可能混入其他窗口输入）</span>';
  const max = Math.max(1, ...(r.perMinute || [1]));
  const bars = (r.minutes || []).map((m) => {
    const pct = Math.max(3, Math.round((m.actions / max) * 100));
    return `<div class="apm-bar-wrap" title="第 ${m.m + 1} 分钟：${m.actions} 次操作"><div class="apm-bar" style="height:${pct}%"></div>${m.m % 5 === 0 ? '<span class="apm-min">' + (m.m + 1) + '</span>' : ''}</div>`;
  }).join('');
  const noData = r.totalActions <= 0 ? '<div class="dim">本局未统计到操作（可能整局游戏窗口未在前台）。</div>' : '';
  const meta = $('apmMeta');
  if (meta) meta.textContent = `已结束：${fmtDuration(r.durationSec)}｜总操作 ${r.totalActions}｜平均 APM ${r.avg}｜峰值 ${r.peak}/分钟`;
  const body = $('apmBody');
  if (body) body.innerHTML = `
    <div class="apm-summary">
      <span class="apm-stat"><b>${r.totalActions}</b>总操作</span>
      <span class="apm-stat"><b>${r.avg}</b>平均 APM</span>
      <span class="apm-stat"><b>${r.peak}</b>峰值 APM</span>
      <span class="apm-stat"><b>${fmtDuration(r.durationSec)}</b>时长</span>
    </div>
    <div class="apm-chart">${bars}</div>
    <div class="dim note">数据来源：真实输入钩子（鼠标点击 + 键盘按键）${focusNote}</div>
    ${noData}
  `;
}
function renderApmIdle() {
  apmRunning = false;
  const meta = $('apmMeta');
  if (meta) meta.textContent = '等待对局…';
  const body = $('apmBody');
  if (body) body.innerHTML = '<div class="apm-empty dim">对局开始后自动统计：仅记录游戏窗口在前台时的鼠标点击与键盘按键（全局只读钩子，不模拟、不拦截任何输入）。默认关闭，需在「设置」中开启「APM 监测功能」。对局结束自动生成每分钟操作图。</div>';
}

function setApmCollapsed(collapsed) {
  const card = $('apmCard');
  if (!card) return;
  card.classList.toggle('collapsed', !!collapsed);
  const btn = $('btnApmToggle');
  if (btn) btn.title = collapsed ? '展开 APM 统计' : '收起 APM 统计';
}
function setApmVisible(visible) {
  const card = $('apmCard');
  if (!card) return;
  card.classList.toggle('hidden', !visible);
  if (visible) setApmCollapsed(false);
}

function openSettings() {
  // 先立刻显示弹窗，再异步填充，避免“点了没反应”
  $('settingsModal').classList.remove('hidden');
  BA.getConfig().then((cfg) => {
    $('setLogDir').value = cfg.logDir || '';
    $('setAuto').checked = !!cfg.autoQueryCurrentMatch;
    $('setInputHook').checked = !!cfg.inputHookEnabled;
    $('setBanPoll').checked = !!cfg.banPollEnabled;
    $('setMatchSync').checked = !!cfg.matchSyncEnabled;
    $('setBanCard').checked = !!cfg.banCardVisible;
    $('setMultiBond').checked = !!cfg.multiAccountBond;
    refreshAccountList();
    refreshLocalReplayList();
    savedTheme = cfg.theme || 'dark';
    setThemePicker(savedTheme);
    $('dirHint').textContent = '';
  }).catch((e) => setStatus('读取设置失败：' + e.message, false));
}

// 容错绑定：元素缺失只提示，不中断后续按钮
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.error('缺少界面元素: ' + id);
}

// ---------- 绑定所有按钮（同步执行，不依赖异步初始化） ----------
// ---------- 蛆查（单人触发，算法与网站同步） ----------
let lastReport = null;
const GITHUB_URL = 'https://github.com/Zawinzala/brokenarrow-log-maggot';
const BATRACE_URL = 'https://app.batrace.top/';
const MAGGOT_SITE_URL = 'https://github.com/Zawinzala/Broken-Arrow-Maggot';

function openLink(url) { if (url) BA.openExternal(url); }

const PLAYER_URL = (id) => `https://app.batrace.top/player/${id}`;
const MATCH_URL = (id) => `https://app.batrace.top/match/${id}`;

// ---------- 右键菜单：调查 / 跳转 BATrace ----------
let ctxEl = null;
function ensureCtxMenu() {
  if (ctxEl) return ctxEl;
  ctxEl = document.createElement('div');
  ctxEl.id = 'ctxMenu';
  ctxEl.className = 'ctx-menu hidden';
  document.body.appendChild(ctxEl);
  ctxEl.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const actions = ctxEl._actions || [];
    const fn = actions[Number(item.dataset.idx)];
    hideCtx();
    if (fn) fn();
  });
  return ctxEl;
}
function hideCtx() { if (ctxEl) ctxEl.classList.add('hidden'); }
function showCtx(x, y, items) {
  const el = ensureCtxMenu();
  el.innerHTML = '';
  el._actions = (items || []).map((it) => it.action);
  (items || []).forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.dataset.idx = String(i);
    d.textContent = it.label;
    el.appendChild(d);
  });
  el.classList.remove('hidden');
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - 190)) + 'px';
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - 40 * items.length - 12)) + 'px';
}
async function refreshMatchRow(fid) {
  try {
    const r = await BA.refreshMatch(fid);
    setStatus((r && r.message) || '已刷新对局信息', !!(r && r.ok));
  } catch (e) { setStatus('刷新失败：' + e.message, false); }
}
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.replay-row');
  if (row) {
    e.preventDefault();
    const fid = row.dataset.fid || '';
    const src = row.dataset.source;
    const items = [];
    if (src === 'local' || src === 'both') {
      items.push({ label: '📂 打开本地位置', action: () => BA.openLocalReplayFolder() });
    }

    if (fid) {
      items.push({ label: '📊 打开对局详情', action: () => openMatchDetail(fid) });
      items.push({ label: '🌐 在 BATrace 打开对局', action: () => openLink(MATCH_URL(fid)) });
    }
    if (src === 'both') {
    items.push({ label: '🗑 删除本地录像', action: () => deleteReplayRow(row) });
    } else {
      items.push({ label: '🗑 删除录像', action: () => deleteReplayRow(row) });
    }
    showCtx(e.clientX, e.clientY, items);
    return;
  }
  const t = e.target.closest('[data-link]');
  if (!t || !t.dataset.link) { hideCtx(); return; }
  e.preventDefault();
  const items = [];
  if (t.dataset.id) {
    items.push({ label: '🔍 调查羁绊', action: () => openInvestigate(t.dataset.id, t.dataset.name) });
  }
  if (t.dataset.fid) {
    items.push({ label: '🔄 刷新对局信息', action: () => refreshMatchRow(t.dataset.fid) });
  }
  items.push({ label: '🌐 在 BATrace 打开', action: () => openLink(t.dataset.link) });
  showCtx(e.clientX, e.clientY, items);
});
document.addEventListener('click', () => hideCtx());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtx(); clearInvGameTimer(); stopRadarLoading(); if (window.BAGame && BAGame.isOpen()) BAGame.close(); const bm = $('banAlertModal'); if (bm) bm.classList.add('hidden'); const m = $('investigateModal'); if (m) m.classList.add('hidden'); const mm = $('matchModal'); if (mm) mm.classList.add('hidden'); const rp = $('replayModal'); if (rp) closeReplayPlayer(); const pk = $('replayPickerModal'); if (pk) { pk.classList.add('hidden'); if (replayPickResolve) { replayPickResolve(null); replayPickResolve = null; } } } });
  const anm = $('announcementModal'); if (anm) anm.classList.add('hidden');

﻿﻿﻿// ---------- 调查加载雷达动画（纯视觉，不可交互） ----------
let radarLoading = null;
let invGameTimer = null;
function clearInvGameTimer() { if (invGameTimer) { clearTimeout(invGameTimer); invGameTimer = null; } }
function showInvContent() { const c = $('invContent'); if (c) c.classList.remove('hidden'); }
// 可复用的雷达扫描加载动画（调查弹窗 / 对局详情弹窗共用）
// 效果：旋转扫线 + 拖尾扇形；随机移动目标，扫线扫过才点亮，随后缓慢熄灭
function startRadarLoading(wrap, canvas) {
  stopRadarLoading();
  if (!wrap || !canvas) return;
  wrap.classList.remove('hidden');
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(240, Math.round(rect.width));
  canvas.height = Math.max(180, Math.round(rect.height));
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.42;
  // 固定位置目标（真实雷达接触点风格：位置静止，扫到才点亮、随后缓慢熄灭）
  const targets = [];
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.18 + Math.random() * 0.72;
    targets.push({
      x: cx + Math.cos(a) * r * R,
      y: cy + Math.sin(a) * r * R,
      bright: 0
    });
  }
  const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  let sweep = Math.random() * Math.PI * 2, raf = 0, last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const speed = 1.7; // 扫线角速度 rad/s
    const prev = sweep;
    sweep += dt * speed;
    for (const t of targets) {
      const ta = Math.atan2(t.y - cy, t.x - cx);
      if (Math.abs(angDiff(sweep, ta)) < speed * dt * 1.4 + 0.06) t.bright = 1; // 被扫到 → 点亮
      t.bright = Math.max(0, t.bright - dt * 0.34); // 缓慢熄灭
    }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#06120c'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(76,217,138,.16)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // 拖尾扇形（扫线后方渐变）
    const wedge = 0.55;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(76,217,138,.28)');
    grad.addColorStop(1, 'rgba(76,217,138,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, sweep - wedge, sweep, false); ctx.closePath(); ctx.fill();
    // 扫线
    ctx.strokeStyle = 'rgba(120,255,180,.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R); ctx.stroke();
    // 目标点：亮度高则亮、缓慢熄灭
    for (const t of targets) {
      ctx.globalAlpha = Math.max(0, Math.min(1, t.bright)) * 0.95;
      ctx.fillStyle = t.bright > 0.5 ? '#d9ffe8' : '#6ee7a0';
      ctx.beginPath(); ctx.arc(t.x, t.y, t.bright > 0.5 ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  radarLoading = {
    stop() {
      cancelAnimationFrame(raf);
      wrap.classList.add('hidden');
    }
  };
}
function stopRadarLoading() { if (radarLoading) { radarLoading.stop(); radarLoading = null; } }

// ---------- 玩家调查弹窗 ----------
function encounterRelLabel(e) {
  if (e.rel === 'spec') return '观战' + (e.won != null ? (e.won ? ' · 我方胜利' : ' · 我方落败') : (e.custom ? ' · 自定义' : ''));
  const base = e.rel === 'same' ? '队友' : e.rel === 'opp' ? '敌人' : null;
  if (!base) return '未知';
  if (e.won != null) {
    if (e.rel === 'same') return base + (e.won ? ' · 一起胜利' : ' · 一起落败');
    return base + (e.won ? ' · 我方胜利' : ' · 对方胜利');
  }
  return base + (e.custom ? ' · 自定义' : '');
}
function openInvestigate(id, name) {
  invId = id; invName = name || id;
  $('investigateModal').classList.remove('hidden');
  $('invName').textContent = invName;
  $('invId').textContent = 'ID ' + id;
  $('invBanBadge').classList.add('hidden');
  $('invStats').innerHTML = '<div class="inv-stat"><b>…</b><span>载入中</span></div>';
  $('invEncounters').innerHTML = '<span class="dim">载入中…</span>';
  $('invNames').innerHTML = '<span class="dim">载入中…</span>';
  $('invInfo').textContent = '载入中…';
  const content = $('invContent');
  if (content) content.classList.add('hidden');
  clearInvGameTimer();
  stopRadarLoading();
  // 250ms 内未返回（即真实请求）再显示雷达加载动画；缓存命中不闪
  invGameTimer = setTimeout(() => { invGameTimer = null; startRadarLoading($('invGameWrap'), $('invGame')); }, 250);
  loadInvestigate(id);
}
async function loadInvestigate(id) {
  try {
    const p = await BA.getPlayerProfile(id);
    // 数据返回即切换内容（无硬延迟；缓存命中时雷达动画甚至来不及显示）
    clearInvGameTimer();
    stopRadarLoading();
    showInvContent();
    renderInvestigate(p);
  } catch (e) {
    clearInvGameTimer();
    stopRadarLoading();
    showInvContent();
    $('invStats').innerHTML = '<div class="loss">加载失败：' + esc(e.message) + '</div>';
  }
}
function renderInvestigate(p) {
  if (!p) return;
  stopRadarLoading();
  const last = p.player && p.player.names && p.player.names.length ? p.player.names[p.player.names.length - 1].name : null;
  $('invName').textContent = last || invName || p.id;
  $('invId').textContent = 'ID ' + p.id;
  const ban = $('invBanBadge');
  if (p.banned) {
    ban.classList.remove('hidden');
    ban.textContent = '🛡 已封禁' + (p.banInfo && p.banInfo.firstSeenAt ? '（' + fmtTime(p.banInfo.firstSeenAt) + ' 首次发现）' : '');
  } else {
    ban.classList.add('hidden');
  }
  const st = p.stats || {};
  $('invStats').innerHTML = `
    <div class="inv-stat"><b>${st.count ?? 0}</b><span>相遇次数</span></div>
    <div class="inv-stat"><b>${st.sameTeam ?? 0}</b><span>队友</span></div>
    <div class="inv-stat"><b>${st.oppTeam ?? 0}</b><span>敌人</span></div>
    <div class="inv-stat"><b>${st.sameWins ?? 0} / ${st.sameLosses ?? 0}</b><span>队友胜/负</span></div>
    <div class="inv-stat"><b>${st.oppWins ?? 0} / ${st.oppLosses ?? 0}</b><span>敌人胜/负</span></div>
    <div class="inv-stat"><b>${st.spectator ?? 0}</b><span>观战</span></div>
    <div class="inv-stat"><b>${st.custom ?? 0}</b><span>自定义</span></div>
    <div class="inv-stat"><b>${st.lastAt ? fmtTime(st.lastAt) : '-'}</b><span>最近相遇</span></div>`;
  const eloHtml = p.latestElo != null
    ? (() => { const src = p.latestEloMatch || {}; return `<b class="elo">最新 ELO ${p.latestElo}</b><span class="dim">（${src.fid || '-'}${src.map ? ' · ' + esc(src.map) : ''}${src.endTime ? ' · ' + fmtTime(src.endTime) : ''}）</span>`; })()
    : '<span class="dim">暂无排位数据（最近都是自定义/未收录局）</span>';
﻿  const rec = p.recentMatches || [];
  $('invRecent').innerHTML = rec.length
    ? rec.slice(0, 10).map((m) => `
      <div class="inv-item"${m.fid && /^\d+$/.test(m.fid) ? ` data-link="${MATCH_URL(m.fid)}" title="右键：在 BATrace 打开"` : ''}>
        <span class="${m.won == null ? 'unk' : m.won ? 'win' : 'loss'}">${m.won != null ? (m.won ? '胜' : '负') : (m.custom ? '自定义' : '未知')}</span>
        ${m.custom ? '<span class="mode-tag custom">自定义</span>' : '<span class="mode-tag ranked">排位</span>'}
        <span class="dim">${m.fid}</span>
        <span>${esc(m.map || '未知地图')}</span>
        <span class="dim">${m.endTime ? fmtTime(m.endTime) : ''}</span>
        ${m.eloDelta != null ? `<span class="dim">${fmtDelta(m.eloDelta)}</span>` : ''}
      </div>`).join('')
    : '<span class="dim">无近期对局</span>';

  const enc = p.encounters || [];
  $('invEncounters').innerHTML = enc.length
    ? enc.slice(0, 50).map((e) => `
      <div class="inv-item"${e.fid && /^\d+$/.test(e.fid) ? ` data-link="${MATCH_URL(e.fid)}" title="右键：在 BATrace 打开"` : ''}>
        <span class="${e.rel === 'spec' ? 'spec' : (e.won == null ? 'unk' : e.won ? 'win' : 'loss')}">${encounterRelLabel(e)}</span>
        ${e.custom === true ? '<span class="mode-tag custom">自定义</span>' : e.custom === false ? '<span class="mode-tag ranked">排位</span>' : ''}
        <span class="dim">${e.fid}</span>
        <span>${esc(e.map || '未知地图')}</span>
        <span class="dim">${e.at ? fmtTime(e.at) : ''}</span>
      </div>`).join('')
    : '<span class="dim">暂无相遇记录（开启「每小时同步我的对局记录」后会回填）。</span>';
  const nh = p.nameHistory || [];
  $('invNames').innerHTML = nh.length
    ? nh.slice(0, 20).map((n) => `
      <div class="inv-item"><b>${esc(n.name)}</b><span class="dim">${fmtTime(n.firstSeen)} → ${fmtTime(n.lastSeen)}</span></div>`).join('')
    : '<span class="dim">暂无改名记录</span>';
  const info = p.info;
  const snap = p.localSnapshot || null;
  let infoHtml = eloHtml;
  if (info) {
    infoHtml = eloHtml + '<br>' +
      (info.kd != null ? ` <span>K/D ${info.kd}</span>` : '') +
      (info.winRate != null ? ` <span>胜率 ${info.winRate}%</span>` : '') +
      (info.category ? ` <span>偏好 ${esc(catLabel(info.category))}</span>` : '') +
      (info.topUnits ? ` <span>最爱 ${esc(info.topUnits)}</span>` : '');
  } else if (snap) {
    const bits = [];
    if (snap.elo != null) bits.push('ELO <span class="elo">' + Math.round(snap.elo) + '</span>');
    if (snap.winRate != null) bits.push('胜率 ' + snap.winRate + '%');
    if (snap.matchCount != null) bits.push('样本 ' + snap.matchCount);
    if (snap.category) bits.push('偏好 ' + esc(catLabel(snap.category)));
    infoHtml = eloHtml + '<br><span class="dim">本地快照 · ' + fmtTime(snap.at) + '：</span> ' + (bits.length ? bits.join(' ') : '暂无');
  }
  $('invInfo').innerHTML = infoHtml;
}

// ---------- 封禁追踪 ----------
function setBanCardVisible(visible) {
  const card = $('banCard');
  if (card) card.classList.toggle('hidden', !visible);
}
function renderBans(d) {
  const list = (d && d.list) || [];
  const info = $('banSyncInfo');
  if (info) info.textContent = (d && d.lastSync) ? ('上次同步 ' + fmtTime(d.lastSync) + '｜共 ' + list.length + ' 人') : '尚未同步';
  const el = $('banList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<span class="dim">暂无封禁记录。开启「封禁监控」后每小时自动检查，也可点「同步」立即检查。</span>';
    return;
  }
  el.innerHTML = list.slice(0, 100).map((b) => `
    <div class="ban-item" data-id="${b.id}" data-name="${esc(b.name || '')}" data-link="${PLAYER_URL(b.id)}" title="右键：调查 / 在 BATrace 打开">
      <b>${esc(b.name || '未知')}</b>
      <span class="dim">ID ${esc(b.id)}</span>
      ${b.rating != null ? `<span class="dim">ELO ${Math.round(b.rating)}</span>` : ''}
      <span class="dim">${fmtTime(b.firstSeenAt)}</span>
      ${b.encountered ? '<span class="ban-tag met">你遇到过</span>' : ''}
    </div>`).join('');
}

// 封禁提醒对话框：遇到过的玩家被新封时弹出
function renderBanAlert(d) {
  const list = (d && d.players) || [];
  if (!list.length) return;
  const el = $('banAlertList');
  el.innerHTML = list.map((b) => `
    <div class="ban-item" data-id="${b.id}" data-name="${esc(b.name || '')}" data-link="${PLAYER_URL(b.id)}" title="右键：调查羁绊 / 在 BATrace 打开">
      <b>${esc(b.name || '未知')}</b>
      <span class="dim">ID ${esc(b.id)}</span>
      ${b.rating != null ? `<span class="dim">ELO ${Math.round(b.rating)}</span>` : ''}
      <span class="ban-tag met">你遇到过</span>
    </div>`).join('');
  $('banAlertModal').classList.remove('hidden');
}
// ---------- 对局录像（对象存储直传） ----------
let replayFids = new Set(); // 有本地录像的对局 ID
let replayRecordingActive = false; // 当前是否在录制：预览框只允许在录制时显示
function renderReplayStatus(s) {
  const el = $('replayStatus');
  if (!el) return;
  if (!s) { el.textContent = ''; return; }
  const rec = s.recording || {};
  const bits = [];
  if (rec && rec.active) bits.push('🔴 正在录制' + (rec.current && rec.current.fid ? ' #' + rec.current.fid : ''));
  el.textContent = bits.join(' ｜ ');
}
// 录制小预览（对局录像模块内置，录制时每秒刷新，确认录的是哪块屏）
function setReplayPreview(active, status) {
  const w = $('replayPreviewWrap');
  if (!w) return;
  w.classList.toggle('hidden', !active);
  if (!active) return;
  const cur = (status && status.current) || (status && status.recording && status.recording.current) || null;
  const lab = $('replayPreviewLabel');
  if (lab) lab.textContent = '🔴 正在录制' + (cur && cur.sourceId ? ' · ' + cur.sourceId : '');
}
function updateReplayFids(list, status) {
  replayFids = new Set();
  for (const it of (list || [])) if (it && it.fid) replayFids.add(String(it.fid));
  if (archiveList && archiveList.length) renderArchive(archiveList); // 刷新对局档案的 📹 标记
}

async function refreshReplayList(fid, opts) {
  const el = $('replayList');
  if (!el) return;
  const q = (fid != null && fid !== '') ? String(fid) : '';
  if (!(opts && opts.silent)) el.innerHTML = '<span class="dim">载入录像列表…</span>'; // silent 时不清空，避免上传中列表闪烁
  try {
    const lr = await BA.listLocalReplays().catch(() => null);
    const localList = (lr && lr.list) || [];
    const list = [];
    for (const it of localList) { if (q && String(it.fid) !== String(q)) continue; list.push({ ...it, source: 'local' }); }
    renderReplayList(list);
    updateReplayFids(list);
  } catch (e) {
    el.innerHTML = '<div class="replay-error">载入失败：' + esc(e.message) + '</div>';
    updateReplayFids([]);
  }
}
function replayTeamTag(t) {
  if (t === 0) return '<span class="r-team alpha">A 队</span>';
  if (t === 1) return '<span class="r-team bravo">B 队</span>';
  if (t === 100) return '<span class="r-team spec">观战</span>';
  const team = String(t || '').toLowerCase();
  if (team === 'alpha') return '<span class="r-team alpha">A 队</span>';
  if (team === 'bravo') return '<span class="r-team bravo">B 队</span>';
  if (team === 'spectators' || team === 'spec') return '<span class="r-team spec">观战</span>';
  return '';
}
function fmtSize(n) {
  if (n == null) return '';
  const m = n / (1024 * 1024);
  if (m >= 1) return m.toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
function renderReplayList(list) {
  const el = $('replayList');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<div class="replay-empty">暂无录像。开启「自动录制」后打一局，局结束会自动保存到本地。</div>'; return; }
  const byFid = {};
  for (const it of list) {
    const k = String(it.fid || '未知');
    (byFid[k] = byFid[k] || []).push(it);
  }
  // 按每组里最新一条录像的时间倒序（不能按对局ID数字排：测试录像ID是负数，数字排序会错乱）
  const groupTime = (items) => items.reduce((m, it) => Math.max(m, Number(it.createdAt || it.endTime) || 0), 0);
  const fids = Object.keys(byFid).sort((a, b) => groupTime(byFid[b]) - groupTime(byFid[a]));
  el.innerHTML = fids.map((fid) => {
    const items = byFid[fid];
    const first = items[0] || {};
    const rows = mergeReplayRows(items);
    return `
      <div class="replay-group">
        <div class="replay-group-title">对局 ${esc(fid)} <span class="dim">${esc(first.map || '')} · ${fmtTime(first.createdAt || first.endTime)}</span></div>
        ${rows.map((r) => replayRowHtml(r)).join('')}
      </div>`;
  }).join('');
  bindReplayRows(el);
}

// 每个本地文件一行（无云端；同一对局多份本地文件各自成行）
function mergeReplayRows(items) {
  return (items || []).map((it) => ({
    fid: it.fid,
    name: it.uploaderName || '',
    map: it.map || '',
    team: it.team != null && it.team !== '' ? it.team : it.teamId,
    teamId: it.teamId,
    durationSec: it.durationSec,
    size: it.size,
    createdAt: it.createdAt || it.endTime,
    source: 'local',
    localId: it.id || '',
    cloudId: '',
    video: ''
  }));
}

function replayRowHtml(r) {
  const negative = String(r.fid || '').startsWith('-');
  const badge = negative ? '<span class="r-src test">🧪 测试</span>' : '<span class="r-src local">📁 本地</span>';
  return `
    <div class="replay-row" data-fid="${esc(r.fid)}" data-name="${esc(r.name)}" data-map="${esc(r.map)}" data-source="local" data-local="${esc(r.localId)}" data-cloud="" data-video="" title="右键：打开位置 / 对局详情 / BATrace / 删除">
      <span class="r-name">${esc(r.name || '未知')}</span>
      ${badge}
      ${replayTeamTag(r.team != null && r.team !== '' ? r.team : r.teamId)}
      <span class="dim">${r.durationSec ? fmtDuration(r.durationSec) : '-'}</span>
      <span class="dim">${fmtSize(r.size)}</span>
      <span class="dim">${fmtTime(r.createdAt)}</span>
      <button class="btn btn-ghost r-play">▶ 播放</button>
      <button class="r-del" title="删除这条录像">🗑</button>
    </div>`;
}

function bindReplayRows(el) {
  el.querySelectorAll('.replay-row').forEach((row) => {
    const localId = row.dataset.local;
    row.querySelector('.r-play').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (localId) {
        try {
          const r = await BA.readLocalReplay(localId);
          if (r && r.ok) {
            const blob = new Blob([r.data], { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            openReplayPlayer({ id: localId, videoUrl: url, fid: row.dataset.fid, name: row.dataset.name, map: row.dataset.map, isBlob: true });
          } else { setStatus(((r && r.message) || '本地文件读取失败'), false); }
        } catch (err) { setStatus('播放失败：' + err.message, false); }
      }
    });
    row.querySelector('.r-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteReplayRow(row);
    });
  });
}

async function deleteReplayRow(row) {
  const localId = row.dataset.local;
  if (!localId) return;
  const ok = await askConfirm('确定删除这条本地录像吗？');
  if (!ok) return;
  try {
    const r = await BA.deleteLocalReplay(localId);
    setStatus((r && r.message) || '已删除', !!(r && r.ok));
    refreshReplayList($('replaySearch').value.trim());
  } catch (err) { setStatus('删除失败：' + err.message, false); }
}


let replayBlobUrl = null;
function openReplayPlayer(item) {
  if (replayBlobUrl) { URL.revokeObjectURL(replayBlobUrl); replayBlobUrl = null; }
  $('replayPlayTitle').textContent = '对局录像 #' + (item.fid || '');
  $('replayPlayMeta').textContent = (item.name ? esc(item.name) + ' · ' : '') + esc(item.map || '');
  const v = $('replayVideo');
  v.src = item.videoUrl || '';
  if (item.isBlob) replayBlobUrl = item.videoUrl;
  $('replayModal').classList.remove('hidden');
  const btns = document.querySelectorAll('.replay-speed-btn');
  // 倍速档位：1 秒/帧，1x=实时、2x=2 倍、3x=3 倍
  const setRate = (r) => { v.playbackRate = r; btns.forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === r)); };
  btns.forEach((b) => { b.onclick = () => setRate(Number(b.dataset.rate)); });
  setRate(1);
  if (v.src) v.play().catch(() => {});
}
let displayPickResolve = null;
function pickDisplay(list) {
  return new Promise((resolve) => {
    displayPickResolve = resolve;
    const wrap = $('displayThumbs');
    if (!wrap) { resolve(null); return; }
    wrap.innerHTML = (list || []).map((d) => `
      <div class="display-thumb" data-id="${esc(d.id)}">
        ${d.thumb ? `<img src="${d.thumb}" alt=""/>` : '<div class="dim">（无缩略图）</div>'}
        <div class="dim">${esc(d.label || d.id)}</div>
      </div>`).join('');
    $('displayPickerModal').classList.remove('hidden');
    wrap.querySelectorAll('.display-thumb').forEach((el2) => el2.addEventListener('click', () => {
      const id = el2.dataset.id;
      $('displayPickerModal').classList.add('hidden');
      if (displayPickResolve) { displayPickResolve(id); displayPickResolve = null; }
    }));
  });
}



function closeReplayPlayer() {
  const v = $('replayVideo');
  if (v) { v.pause(); v.src = ''; }
  if (replayBlobUrl) { URL.revokeObjectURL(replayBlobUrl); replayBlobUrl = null; }
  const rp = $('replayModal');
  if (rp) rp.classList.add('hidden');
}
// 设置内：本地录像管理
async function refreshLocalReplayList() {
  const el = $('localReplayList');
  const info = $('localReplayInfo');
  try {
    const r = await BA.listLocalReplays();
    const list = (r && r.list) || [];
    let total = 0;
    for (const it of list) total += it.size || 0;
    if (info) info.textContent = '共 ' + list.length + ' 条，' + fmtSize(total);
    if (!el) return;
    if (!list.length) { el.innerHTML = '<span class="dim">暂无本地录像。</span>'; return; }
    el.innerHTML = list.slice(0, 100).map((it) => `
      <div class="inv-item local-replay-item">
        <span class="dim">${esc(it.fid)}</span>
        <span>${esc(it.map || '未知地图')}</span>
        <span class="dim">${fmtTime(it.createdAt)}</span>
        <span class="dim">${fmtSize(it.size)}</span>
        <button class="r-del" data-key="${esc(it.id)}" title="删除这条本地录像">🗑</button>
      </div>`).join('');
    el.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', async () => {
      const ok = await askConfirm('确定删除这条本地录像吗？');
      if (!ok) return;
      try {
        const r = await BA.deleteLocalReplay(b.dataset.key);
        $('localReplayResult').textContent = (r && r.message) || '已删除';
        refreshLocalReplayList();
        refreshReplayList($('replaySearch').value.trim());
      } catch (e) { $('localReplayResult').textContent = '删除失败：' + e.message; }
    }));
  } catch (e) {
    if (el) el.innerHTML = '<span class="dim">加载失败：' + esc(e.message) + '</span>';
  }
}

// 封禁区：切换「我遇到过的作弊者」视图
let banView = 'all';
async function toggleBanCheaters() {
  const btn = $('btnBanCheaters');
  if (banView === 'all') {
    banView = 'met';
    if (btn) btn.textContent = '🔍 全部封禁';
    const r = await BA.getCheaters();
    renderCheaters((r && r.list) || []);
  } else {
    banView = 'all';
    if (btn) btn.textContent = '🔍 我遇到过的作弊者';
    BA.getBans().then(renderBans).catch(() => {});
  }
}
function renderCheaters(list) {
  const el = $('banList');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<span class="dim">还没有遇到过被封的玩家。</span>'; return; }
  el.innerHTML = list.map((c) => `
    <div class="ban-item" data-id="${c.id}" data-name="${esc(c.name || '')}" data-link="${PLAYER_URL(c.id)}" data-matches="${encodeURIComponent(JSON.stringify(c.matches || []))}" title="左键：展开相遇对局；右键：调查羁绊 / BATrace">
      <b>${esc(c.name || '未知')}</b>
      <span class="dim">ID ${esc(c.id)}</span>
      ${c.rating != null ? `<span class="dim">ELO ${Math.round(c.rating)}</span>` : ''}
      <span class="ban-tag met">遇到过 ${c.matchCount || 0} 局</span>
    </div>`).join('');
  el.querySelectorAll('.ban-item[data-matches]').forEach((item) => {
    item.addEventListener('click', () => {
      const existing = item.querySelector('.cheater-matches');
      if (existing) { existing.remove(); return; }
      let matches = [];
      try { matches = JSON.parse(decodeURIComponent(item.dataset.matches || '[]')); } catch (e) {}
      const div = document.createElement('div');
      div.className = 'cheater-matches inv-list';
      div.innerHTML = matches.length
        ? matches.map((m) => `
          <div class="cheater-match" data-link="${MATCH_URL(m.fid)}" title="右键：在 BATrace 打开">
            <span class="${m.localWon == null ? 'unk' : m.localWon ? 'win' : 'loss'}">${m.localWon == null ? (m.custom ? '自定义' : '未知') : m.localWon ? '胜' : '负'}</span>
            <span>${esc(m.map || '未知地图')}</span>
            <span class="dim">${fmtTime(m.endTime)}</span>
            <span class="dim">${m.fid}</span>
          </div>`).join('')
        : '<span class="dim">无对局记录</span>';
      item.appendChild(div);
    });
  });
}

// ---------- 账号数据管理（多账号联动） ----------
async function refreshAccountList() {
  const el = $('accountList');
  if (!el) return;
  try {
    const r = await BA.listAccounts();
    const list = (r && r.list) || [];
    if (!list.length) { el.innerHTML = '<span class="dim">暂无本机账号记录（打过对局后自动出现）。</span>'; return; }
    el.innerHTML = list.map((a) =>
      '<div class="account-item">' +
      '<b>' + esc(a.persona || a.name || ('账号 ' + a.id)) + '</b>' +
      '<span class="dim">ID ' + esc(a.id) + '</span>' +
      '<span class="dim">' + a.matchCount + ' 场</span>' +
      '<button class="btn btn-danger btn-xs" data-del="' + esc(a.id) + '">🗑 删除</button>' +
      '</div>').join('');
    el.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        const ok = await askConfirm('确定删除账号 ' + id + ' 的全部数据吗？\n将删除该账号的对局/相遇记录，并清理其卡组归档文件夹。此操作不可恢复。');
        if (!ok) return;
        try {
          const r = await BA.deleteAccount(id);
          setStatus((r && r.message) || '已删除', !!(r && r.ok));
          refreshAccountList();
        } catch (e) { setStatus('删除失败：' + e.message, false); }
      });
    });
  } catch (e) {
    el.innerHTML = '<span class="dim">读取账号列表失败：' + esc(e.message) + '</span>';
  }
}

// ---------- 主题 ----------
function applyTheme(name) {
  const t = ['dark', 'light', 'cyan', 'orange', 'violet', 'forest', 'ocean'].includes(name) ? name : 'dark';
  document.documentElement.dataset.theme = t;
  currentTheme = t;
}
function setThemePicker(name) {
  applyTheme(name);
  document.querySelectorAll('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === name));
}

async function runMaggot(stbid, name) {
  const area = $('maggotArea');
  $('maggotCalls').textContent = '';
  setMaggotBusy(true);
  setMaggotProgress('查蛆指数中：拉取最近 12 场有效对局明细（冷查约 13 次调用，24 小时缓存后仅 1 次）…', 0);
  try {
    const r = await BA.maggotReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; return; }
    renderMaggot(r, name);
  } catch (e) {
    area.innerHTML = `<div class="loss">蛆查失败：${esc(e.message)}</div>`;
  } finally {
    setMaggotBusy(false);
    hideMaggotProgress();
  }
}

// 查询期间禁用所有「查蛆指数」入口按钮；结束后恢复
function setMaggotBusy(busy) {
  ['btnMaggot', 'btnMaggotFromReport', 'btnInvMaggot'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !!busy;
  });
}
// 进度行：显示并更新文字/百分比
function setMaggotProgress(text, pct) {
  const row = $('maggotProgressRow');
  if (row) row.classList.remove('hidden');
  const t = $('maggotProgressText'); if (t) t.textContent = text || '';
  const b = $('maggotProgressBar'); if (b) b.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
  const p = $('maggotProgressPct'); if (p) p.textContent = (pct != null ? Math.round(pct) + '%' : '');
}
function hideMaggotProgress() {
  const row = $('maggotProgressRow');
  if (row) row.classList.add('hidden');
}

function renderMaggot(r, name) {
  const trendMap = { up: '🚀 最近变强', down: '📉 最近变蛆', flat: '➡️ 实力平稳' };
  const color = r.color === 'green' ? '#4ade80' : r.color === 'yellow' ? '#facc15' : '#f87171';
  const pct = r.maggotIndex != null ? Math.max(0, Math.min(100, ((r.maggotIndex - 1) / 9) * 100)) : 50;
  const rows = (r.rows || []).map((m) => `
    <tr>
      <td class="${m.win ? 'win' : 'loss'}">${m.win ? '胜' : '负'}</td>
      <td class="dim" data-link="${MATCH_URL(m.matchId)}" title="右键：在 BATrace 打开">${esc(m.matchId ?? '-')}</td>
      <td>#${m.myRank}</td>
      <td>#${m.kRank}</td>
      <td>#${m.oRank}</td>
      <td>#${m.kdRank}</td>
      <td>#${m.lossRank}</td>
      <td>${fmtDelta(m.eloDelta)}</td>
    </tr>`).join('');
  $('maggotCalls').textContent = `本次蛆查 API 调用 ${r.calls} 次`;
  $('maggotArea').innerHTML = `
    <div class="maggot-panel">
      <div class="mg-head">
        <div class="mg-score">
          <span class="mg-num" style="color:${color}">${r.maggotIndex}</span>
          <span class="mg-label" style="border-color:${color};color:${color}">${esc(r.label)}</span>
          <span class="mg-trend">${trendMap[r.trend] || ''}</span>
        </div>
        <div class="mg-meta">
          <span class="mg-name" data-link="${PLAYER_URL(r.stbid)}" title="右键：在 BATrace 打开">${esc(name || r.stbid)}</span>
          <span class="dim">12 局平均队内名次 #${r.avgRank}（1=队内最强）</span>
        </div>
      </div>
      <div class="mg-meter">
        <div class="mg-track" style="position:relative"><div class="mg-ind" style="left:${pct}%;transform:translateX(-50%)"></div></div>
        <div class="mg-scale"><span>👑 神</span><span>🐛 蛆</span></div>
      </div>
      <div class="mg-refs">
        <div class="item"><b>#${r.refs.kdr}</b><span>平均KD排名</span></div>
        <div class="item"><b>#${r.refs.kr}</b><span>平均击杀排名</span></div>
        <div class="item"><b>#${r.refs.dr}</b><span>生存/经济排名</span></div>
        <div class="item"><b>#${r.refs.or}</b><span>MVP得分排名</span></div>
        <div class="item"><b>${r.refs.wr}%</b><span>近12局胜率</span></div>
      </div>
      <table class="matches">
        <thead><tr><th>结果</th><th>对局ID</th><th>队内名次</th><th>击杀</th><th>MVP</th><th>KD</th><th>损失</th><th>ELO变化</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="dim note">算法与断箭蛆指数网站同步：最近 12 场有效对局（带 ELO 变动）的队内 MVP 名次平均 → 余弦平滑映射 1~10。数据全部来自公开接口。</div>
    </div>`;
}

// ---------- 版本提醒 ----------
// 开发者隐秘提示：BATrace 专属 bypass 状态（设置 → 开发者测试区）
function renderBypassHint(s) {
  const el = $('bypassHint');
  if (!el) return;
  if (s && s.enabled) {
    el.textContent = '⚡ 开发者：BATrace 专属提速已启用（间隔 ' + (s.delayMs || 300) + 'ms）';
    el.style.color = '#4ade80';
  } else {
    el.textContent = 'BATrace 请求间隔 1200ms（无专属提速）';
    el.style.color = '';
  }
}
function renderVersion(v) {
  if (!v) return;
  lastVersionInfo = v;
  const av = $('aboutVer');
  if (av) av.textContent = `当前版本 v${v.current}`;
  const verEl = $('ver');
  if (verEl && v.current) verEl.textContent = 'v' + v.current;
  const banner = $('updateBanner');
  if (v.hasUpdate) {
    $('updateText').textContent = `发现新版本 ${v.latest}${v.announcement ? '：' + v.announcement : ''}`;
    if (banner) banner.classList.remove('hidden');
  }
  const info = $('updateInfo');
  if (info) {
    info.innerHTML = `<p class="dim">最新版本 <b>${esc(v.latest)}</b>${v.hasUpdate ? '（有新版本，见上方横幅）' : '（已是最新）'}${v.announcement ? '｜公告：' + esc(v.announcement) : ''}｜<a href="#" class="link" id="linkVersion">GitHub 页面</a></p>`;
    const lv = $('linkVersion');
    if (lv) lv.addEventListener('click', (e) => { e.preventDefault(); openLink(GITHUB_URL); });
  }
}

function bindUI() {
  on('btnGame', 'click', () => { if (window.BAGame) BAGame.open(); });
  on('btnSettings', 'click', openSettings);
  on('btnApmToggle', 'click', () => setApmCollapsed(!$('apmCard').classList.contains('collapsed')));
  on('btnCancel', 'click', () => { setThemePicker(savedTheme); $('settingsModal').classList.add('hidden'); });
  on('btnSave', 'click', saveSettings);
  on('btnBrowse', 'click', async () => {
    const dir = await BA.selectDir();
    if (dir) $('setLogDir').value = dir;
  });
  on('btnHeartbeatTest', 'click', async () => {
    const cfg = await BA.getConfig().catch(() => null);
    const url = (cfg && cfg.heartbeatUrl) || '';
    const el = $('heartbeatTest');
    el.textContent = '测试中…';
    try {
      const r = await BA.pingHeartbeat(url);
      if (!r) { el.textContent = '心跳未初始化'; return; }
      if (r.ok && r.stats) el.textContent = `✅ 上报成功（${r.lastPing}），服务端当前在线 ${r.stats.online} 人`;
      else el.textContent = '❌ ' + (r.lastError || '上报失败（请检查地址与服务器）');
    } catch (e) {
      el.textContent = '❌ 测试失败：' + e.message;
    }
  });
  on('btnDetect', 'click', async () => {
    const dir = await BA.detectDir();
    if (dir) { $('setLogDir').value = dir; $('dirHint').textContent = '检测到：' + dir; }
    else $('dirHint').textContent = '未检测到，请手动选择';
  });

  on('btnConfirmYes', 'click', () => closeConfirm(true));
  on('btnConfirmNo', 'click', () => closeConfirm(false));

  on('btnPrevMatch', 'click', togglePrevView);
  on('btnReQuery', 'click', () => {
    if (querying) return;
    if (viewMode === 'prev' && prevMatch && prevMatch.players && prevMatch.players.length) {
      // 上一局视图：重新粗查上一局名单（保持上一局视图，不跳回当前）
      querying = true;
      const players = prevMatch.players.filter((p) => p.id != null).map((p) => ({ id: p.id, name: p.name, team: p.team }));
      BA.queryRoster(players).catch(() => { querying = false; });
      return;
    }
    querying = true;
    BA.queryCurrentMatch().catch(() => { querying = false; });
  });

  on('btnMaggot', 'click', () => {
    if (!lastReport) { setStatus('请先搜索并点选一位玩家（粗查）再查蛆指数', false); return; }
    runMaggot(lastReport.id, lastReport.name);
  });
  on('btnUpdateClose', 'click', () => $('updateBanner').classList.add('hidden'));
  on('btnUpdateDownload', 'click', () => { if (lastVersionInfo && lastVersionInfo.url) openLink(lastVersionInfo.url); });
  on('btnAnnouncementClose', 'click', () => $('announcementModal').classList.add('hidden'));
  const link = (id, url) => { const el = $(id); if (el) el.addEventListener('click', (e) => { e.preventDefault(); openLink(url); }); };
  link('linkBatrace', BATRACE_URL);
  link('linkMaggotSite', MAGGOT_SITE_URL);

  // 搜索
  const doSearch = async () => {
    const q = $('searchInput').value.trim();
    if (!q) return;
    try {
      const data = await BA.searchPlayers(q);
      const list = data.players || [];
      const offlineNote = data.offline ? '<div class="dim">⚠ 离线：以下为本地见过的玩家匹配（API 不可用）</div>' : '';
      $('searchResults').innerHTML = offlineNote + (list.length
        ? list.map((p) => `<span class="chip" data-id="${p.id}" data-name="${esc(p.name)}" data-link="${PLAYER_URL(p.id)}">${esc(p.name)}<span class="s-id">ID ${esc(p.id)}</span><span class="s-lv">Lv.${p.level ?? '?'}</span><span class="s-elo">${p.rating != null ? Math.round(p.rating) : '?'}</span></span>`).join('')
        : (data.offline ? '<span class="dim">本地未找到见过该玩家</span>' : '<span class="dim">未找到玩家</span>'));
      document.querySelectorAll('.chip').forEach((el) => {
        el.addEventListener('click', () => loadReport(el.dataset.id, el.dataset.name));
      });
    } catch (e) {
      $('searchResults').innerHTML = '<span class="loss">搜索失败：' + esc(e.message) + '</span>';
    }
  };
  on('btnSearch', 'click', doSearch);
  on('searchInput', 'keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // 对局详情弹窗
  on('btnMatchClose', 'click', () => { clearInvGameTimer(); stopRadarLoading(); $('matchModal').classList.add('hidden'); });
  const matchModal = $('matchModal');
  if (matchModal) matchModal.addEventListener('click', (e) => { if (e.target === matchModal) { clearInvGameTimer(); stopRadarLoading(); matchModal.classList.add('hidden'); } });

  // 玩家调查弹窗 / 封禁 / 主题
  on('btnInvClose', 'click', () => { clearInvGameTimer(); stopRadarLoading(); $('investigateModal').classList.add('hidden'); });
  on('btnInvRefresh', 'click', () => { if (invId) { $('invInfo').textContent = '载入中…'; loadInvestigate(invId); } });
  on('btnInvMaggot', 'click', () => { if (invId) { $('investigateModal').classList.add('hidden'); runMaggot(invId, invName); } });
  on('btnInvOpen', 'click', () => { if (invId) openLink(PLAYER_URL(invId)); });
  on('btnBanCheaters', 'click', toggleBanCheaters);
  on('btnBanAlertClose', 'click', () => $('banAlertModal').classList.add('hidden'));
  const bam = $('banAlertModal');
  if (bam) bam.addEventListener('click', (e) => { if (e.target === bam) bam.classList.add('hidden'); });
  on('themePicker', 'click', (e) => { const b = e.target.closest('.theme-swatch'); if (b) setThemePicker(b.dataset.theme); });
  const invModal = $('investigateModal');
  if (invModal) invModal.addEventListener('click', (e) => { if (e.target === invModal) { clearInvGameTimer(); stopRadarLoading(); invModal.classList.add('hidden'); } });

  // 开发者测试（设置内）
  on('btnTestBanNotify', 'click', () => {
    // 关掉设置，3 秒后触发系统弹窗模拟提醒
    $('settingsModal').classList.add('hidden');
    setStatus('3 秒后模拟封禁提醒…', true);
    setTimeout(async () => {
      const r = await BA.testBanNotify();
      setStatus((r && r.message) || '模拟失败', !!(r && r.ok));
    }, 3000);
  });
  on('btnTestMatchSync', 'click', async () => { const r = await BA.syncMyMatchesNow(); $('testResult').textContent = (r && r.message) || '未知'; });
  on('btnTestBanSync', 'click', async () => { const r = await BA.syncBans(); $('testResult').textContent = (r && r.newly != null) ? ('封禁检查完成，本次新增 ' + r.newly + ' 人') : '封禁检查完成'; });
  on('btnTestVersion', 'click', async () => { const r = await BA.testVersionUpdate(); $('testResult').textContent = (r && r.message) || '未知'; });
  on('btnTestRecord', 'click', async () => {
    $('testResult').textContent = '🎥 开始录制 60 秒（只存本地不上传），请切到游戏窗口…';
    const r = await BA.testRecord();
    if (!r || !r.ok) { $('testResult').textContent = '录制测试失败：' + ((r && r.message) || '未知'); return; }
  });

  // 卡组工具
  on('btnDeckRefresh', 'click', refreshDecks);
  on('btnDeckBackup', 'click', doBackup);
  on('btnDeckBackupAll', 'click', doBackupAll);
  on('btnBackupOk', 'click', confirmBackup);
  on('btnBackupCancel', 'click', () => { backupAllPending = false; $('backupRow').classList.add('hidden'); });
  on('btnDeckDeploy', 'click', doDeploy);
  on('btnDeckDelFront', 'click', () => doDelete('decks', '卡组'));
  on('btnDeckDelBack', 'click', () => doDelete('backups', '备份包'));
  on('btnSyncRestore', 'click', doSyncRestore);
  on('btnSyncIgnore', 'click', doSyncIgnore);
  on('btnSyncDismiss', 'click', dismissSyncAlert);
  on('btnOpenFront', 'click', () => BA.openDeckFolder('decks'));
  on('btnOpenBack', 'click', () => BA.openDeckFolder('backups'));
  enableToggleSelect($('deckFront'));
  enableToggleSelect($('deckBack'));

  // 对局录像
  on('btnReplayRefresh', 'click', () => refreshReplayList($('replaySearch').value.trim()));
  on('btnReplaySearch', 'click', () => refreshReplayList($('replaySearch').value.trim()));
  on('replaySearch', 'keydown', (e) => { if (e.key === 'Enter') refreshReplayList($('replaySearch').value.trim()); });
  on('setReplayEnabled', 'change', async () => {
    const el = $('setReplayEnabled');
    if (el && el.checked) {
      const ok = await askConfirm('开启后，每局会自动录制屏幕画面并保存到本地。确定开启吗？');
      if (!ok) { el.checked = false; return; }
      // 每次开启都让用户选/确认游戏所在显示器（多屏时）
      const list = await BA.listDisplays().catch(() => []);
      if (list.length > 1) {
        const picked = await pickDisplay(list);
        if (!picked) { el.checked = false; return; } // 取消选择 → 不开启
        await BA.setReplayDisplay(picked);
      }
    }
    BA.setConfig({ replayEnabled: !!(el && el.checked) });
    if (el && el.checked) refreshReplayList($('replaySearch').value.trim());
  });
  on('btnDisplayPickClose', 'click', () => { $('displayPickerModal').classList.add('hidden'); if (displayPickResolve) { displayPickResolve(null); displayPickResolve = null; } });
  on('btnReplayClose', 'click', closeReplayPlayer);
  on('btnReplayPickerClose', 'click', () => { $('replayPickerModal').classList.add('hidden'); if (replayPickResolve) { replayPickResolve(null); replayPickResolve = null; } });
  on('btnLocalClean30', 'click', async () => {
    const ok = await askConfirm('删除 30 天前的本地录像？');
    if (!ok) return;
    try {
      const r = await BA.cleanLocalReplays(30);
      $('localReplayResult').textContent = '已删除 ' + ((r && r.removed) || 0) + ' 条 30 天前的本地录像';
      refreshLocalReplayList();
      refreshReplayList($('replaySearch').value.trim());
    } catch (e) { $('localReplayResult').textContent = '删除失败：' + e.message; }
  });
  on('btnOpenLocalReplay', 'click', () => { BA.openLocalReplayFolder(); });
  on('btnLocalCleanAll', 'click', async () => {
    const ok = await askConfirm('确定删除全部本地录像吗？');
    if (!ok) return;
    try {
      const r = await BA.cleanLocalReplays(0);
      $('localReplayResult').textContent = '已删除 ' + ((r && r.removed) || 0) + ' 条本地录像';
      refreshLocalReplayList();
      refreshReplayList($('replaySearch').value.trim());
    } catch (e) { $('localReplayResult').textContent = '删除失败：' + e.message; }
  });
}

async function saveSettings() {
  const dir = $('setLogDir').value.trim();
  const v = await BA.validateDir(dir);
  if (!v.ok) { $('dirHint').textContent = '目录无效：' + (v.reason || ''); return; }
  await BA.setConfig({
    logDir: dir,
    autoQueryCurrentMatch: $('setAuto').checked,
    inputHookEnabled: $('setInputHook').checked,
    banPollEnabled: $('setBanPoll').checked,
    matchSyncEnabled: $('setMatchSync').checked,
    banCardVisible: $('setBanCard').checked,
    multiAccountBond: $('setMultiBond').checked,
    theme: currentTheme
  });
  savedTheme = currentTheme;
  setApmVisible($('setInputHook').checked);
  setBanCardVisible($('setBanCard').checked);
  applyTheme(currentTheme);
  $('settingsModal').classList.add('hidden');
  setStatus('监听中', true);
  $('fileText').textContent = dir;
}

// ---------- 主流程 ----------
async function init() {
  const cfg = await BA.getConfig();
  savedTheme = cfg.theme || 'dark';
  applyTheme(savedTheme);
  setApmVisible(!!cfg.inputHookEnabled);
  setBanCardVisible(!!cfg.banCardVisible);
  const repSw = $('setReplayEnabled'); if (repSw) repSw.checked = !!cfg.replayEnabled;
  refreshReplayList('');
  if (cfg.logDir) {
    const v = await BA.validateDir(cfg.logDir);
    setStatus(v.ok ? '监听中' : '目录无效：' + (v.reason || ''), v.ok);
    if (v.ok) $('fileText').textContent = cfg.logDir;
  } else {
    setStatus('未设置日志目录（点设置）', false);
  }

  const st = await BA.getWatcherStatus();
  if (st.file) $('fileText').textContent = st.file;

  renderSession(await BA.getSession());
  { const mm = await BA.getTrackerMatches(); renderArchive(mm && mm.list); }
  refreshDecks();

  BA.onSession((d) => renderSession(d));
  BA.onWatcher((d) => {
    if (d.file) $('fileText').textContent = d.file;
    if (!d.file) setStatus('未找到日志文件', false);
  });
  BA.onMatchQuerying((d) => {
    if (d.prev) {
      prevRows = {};
      for (const p of d.players) prevRows[p.id] = { ...p, status: 'loading' };
      renderPrevGrid();
      $('queryStatus').textContent = `正在查询上一局 ${d.players.length} 位玩家…`;
      return;
    }
    resetPrevIfViewing();
    matchRows = {};
    for (const p of d.players) matchRows[p.id] = { ...p, status: 'loading' };
    renderMatchGrid();
    $('queryStatus').textContent = `正在查询 ${d.players.length} 位玩家…`;
  });
  BA.onMatchPlayer((row) => {
    if (row.prev) {
      prevRows[row.id] = { ...row, status: 'done' };
      renderPrevGrid();
      return;
    }
    matchRows[row.id] = { ...row, status: 'done' };
    renderMatchGrid();
  });
  BA.onMatchDone((d) => {
    querying = false;
    if (d.prev) {
      const done = Object.values(prevRows).filter((r) => r.status === 'done').length;
      $('queryStatus').textContent = `上一局查询完成：${done} 位玩家`;
      return;
    }
    const done = Object.values(matchRows).filter((r) => r.status === 'done').length;
    $('queryStatus').textContent = `查询完成：${done} 位玩家（${d.fid ? '对局 ' + d.fid : '房间'}）`;
  });
  BA.onMatchesChanged((d) => renderArchive(d && d.list));
  BA.onDeckChanged(() => refreshDecks());
  BA.onDeckSyncAlert(renderDeckSyncAlert);
  BA.onApmStart(renderApmStart);
  BA.onApmLive(renderApmLive);
  BA.onApmResult(renderApmResult);
  BA.onApmIdle(renderApmIdle);
  BA.onBudget(renderBudget);
  BA.getUsage().then(renderBudget).catch(() => {});
  BA.onHeartbeat(renderHeartbeat);
  BA.getHeartbeat().then(renderHeartbeat).catch(() => {});
  BA.onApiHealth(renderApiHealth);
  BA.getApiHealth().then(renderApiHealth).catch(() => {});
  BA.getBans().then(renderBans).catch(() => {});
  BA.onBansChanged((d) => { if (banView === 'met') { banView = 'all'; const btn = $('btnBanCheaters'); if (btn) btn.textContent = '🔍 我遇到过的作弊者'; } renderBans(d && d.list); });
  BA.onBanAlert(renderBanAlert);
  BA.onTestResult((d) => {
    if (!d) return;
    const el = $('testResult');
    if (!el) return;
    if (d.ok) { el.textContent = '✅ 录制测试完成：' + d.file + '（' + fmtSize(d.size) + '），已存本地，可在「本地录像管理」查看/删除'; refreshLocalReplayList(); }
    else { el.textContent = '❌ 录制测试失败：' + (d.error || '未知'); }
  });
  BA.onRoomToolUsers((ids) => { toolUserIds = new Set((ids || []).map(String)); const cur = session && session.current; if (cur) renderMatchGrid(); else renderMatchGrid(); });
  BA.onReplayRecording((d) => {
    replayRecordingActive = !!(d && d.active && !d.error);
    if (d && d.error) { const el = $('replayStatus'); if (el) { el.textContent = '⚠ 录制异常：' + d.error; el.title = '录制失败详情见 %APPDATA%/broken-arrow-log-assistant/replay.log'; } setReplayPreview(false); return; }
    renderReplayStatus(d);
    if (d && d.active) {
      const cur = d.current || null;
      const lab = $('replayPreviewLabel');
      if (lab) lab.textContent = '🔴 正在录制' + (cur && cur.sourceId ? ' · ' + cur.sourceId : '');
    } else {
      setReplayPreview(false);
    }
  });
  BA.onReplayProgress(() => { BA.getReplayStatus().then(renderReplayStatus).catch(() => {}); });
  BA.onReplayChanged(() => { BA.getReplayStatus().then(renderReplayStatus).catch(() => {}); refreshReplayList($('replaySearch').value.trim(), { silent: true }); });
  // 预览帧持续更新图片；只有确实在录制时才显示（防止停止后残留帧把它重新点亮）
  BA.onReplayPreview((d) => {
    const img = $('replayPreviewImg');
    if (!img || !d || !d.dataUrl) return;
    img.src = d.dataUrl;
    setReplayPreview(replayRecordingActive);
  });
  // 点击玩家卡片 → 打开完整报告；📋 按钮 → 复制（上一局视图用 prevRows）
  $('teamGrid').addEventListener('click', (e) => {
    const rows = viewMode === 'prev' ? prevRows : matchRows;
    const copyBtn = e.target.closest('.p-copy');
    if (copyBtn) { e.stopPropagation(); const row = rows[copyBtn.dataset.id]; if (row) copyPlayerRow(row, copyBtn); return; }
    const teamBtn = e.target.closest('.team-copy');
    if (teamBtn) { copyTeamRow(teamBtn.dataset.team, teamBtn, rows); return; }
    const card = e.target.closest('.player-card');
    if (card && card.dataset.id) loadReport(card.dataset.id, card.dataset.name);
  });
  BA.onMaggotProgress((d) => {
    const pct = d.total ? (d.done / d.total) * 100 : 0;
    setMaggotProgress(`查蛆指数中：已解析 ${d.done}/${d.total} 场有效对局（扫描 ${d.scanned}/${d.of}）…`, pct);
  });
  BA.getVersion().then(renderVersion).catch(() => {});
  BA.onVersion(renderVersion);
  BA.onBypassState(renderBypassHint);
  BA.onAnnouncement((d) => { if (d && d.text) { const el = $('announcementText'); if (el) el.textContent = d.text; $('announcementModal').classList.remove('hidden'); } });
}

// 兜底：任何异步错误都显示出来，而不是“点了没反应”
window.addEventListener('error', (e) => setStatus('脚本错误：' + (e.message || '未知'), false));
window.addEventListener('unhandledrejection', (e) => setStatus('异步错误：' + (e.reason && e.reason.message || e.reason || '未知'), false));

bindUI();
init().catch((e) => setStatus('初始化失败：' + (e.message || e), false));

