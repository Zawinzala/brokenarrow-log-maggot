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
function fmtDelta(d) { return d == null ? '-' : (d > 0 ? '+' : '') + d; }
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
    el.textContent = `🟢 在线 ${h.online} 人`;
    el.title = h.lastError
      ? `上次心跳：${h.lastError}（自己可能没计入）`
      : `上次心跳成功于 ${h.lastPing ? new Date(h.lastPing).toLocaleTimeString('zh-CN') : '-'}`;
  } else if (h && h.lastError) {
    el.textContent = '🟡 心跳异常';
    el.title = h.lastError;
  } else {
    el.textContent = '';
    el.title = '';
  }
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
function copyTeamRow(team, btn) {
  const teamVal = team === 'alpha' ? 'Alpha' : team === 'bravo' ? 'Bravo' : null;
  const players = Object.values(matchRows).filter((p) => teamVal ? p.team === teamVal : !p.team);
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

// ---------- 当前对局渲染 ----------
function renderSession(s) {
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

const CAT_LABELS = { aircrafts: '战机', helicopters: '直升机', tanks: '坦克', ifvs: '步战车', apcs: '装甲车', artillery: '火炮', airdefense: '防空', infantry: '步兵', recon: '侦察', ships: '战舰', transports: '运输', drones: '无人机', missiles: '导弹', naval: '海军' };
function catLabel(key) { return key ? (CAT_LABELS[key] || String(key)) : '-'; }

function playerCard(p) {
  const selfName = session.localName;
  const selfTag = selfName && p.name === selfName ? '<span class="pself">(我)</span>' : '';
  let statHtml = '';
  if (p.status === 'loading') statHtml = '<span class="loading">查询中…</span>';
  else if (p.error) statHtml = `<span class="err">${esc(p.error)}</span>`;
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
    <div class="prow"><span class="pname">${esc(p.name)}${selfTag}</span><button class="p-copy" data-id="${p.id}" title="复制该玩家一行情报">📋</button><span class="pmark">›</span></div>
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

async function loadReport(stbid, name) {
  const area = $('reportArea');
  area.innerHTML = '<div class="dim">正在生成报告（一次 API 调用，稍候）…</div>';
  try {
    const r = await BA.playerReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; return; }
    lastReport = { id: stbid, name: name || stbid };
    renderReport(r, name);
  } catch (e) {
    area.innerHTML = `<div class="loss">报告生成失败：${esc(e.message)}</div>`;
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
function styleLabel(key) { return key ? (STYLE_LABELS[key] || String(key)) : '-'; }

// ---- 对局档案 ----------
function renderArchive(list) {
  const el = $('archiveList');
  if (!list || !list.length) {
    el.innerHTML = '<span class="dim">暂无档案。开始一局并结束后会自动记录。</span>';
    return;
  }
  el.innerHTML = list.map((m) => {
    const fid = m.fid || '';
    const link = fid ? ` data-link="${MATCH_URL(fid)}"` : '';
    return `
    <div class="archive-item"${link} title="${fid ? '点击 / 右键：在 BATrace 打开对局' : ''}">
      <b>${esc(m.map || '未知地图')}</b>
      <span>${esc(fid || '无ID')}</span>
      <span>${m.players.length} 人</span>
      <span>${fmtDuration(m.durationSec)}</span>
      <span>${m.points != null ? '分数 ' + m.points : ''}</span>
      <span class="dim">${new Date(m.startTime || Date.now()).toLocaleString('zh-CN')}</span>
    </div>`;
  }).join('');
  // 左键点击有 FID 的档案 → 直达 BATrace 对局页
  el.querySelectorAll('.archive-item[data-link]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      openLink(item.dataset.link);
    });
  });
}

// ---------- 卡组工具 ----------
async function refreshDecks() {
  try {
    const d = await BA.listDecks();
    const fmt = (s) => s ? (s.length > 70 ? '…' + s.slice(-70) : s) : '';
    $('deckPaths').textContent = `前线 ${fmt(d.decksDir)} ｜ 后勤 ${fmt(d.backupsDir)}`;
    const front = $('deckFront');
    const back = $('deckBack');
    if (!d.found) {
      front.innerHTML = '<option disabled>未找到卡组目录（游戏未安装 / 未运行过）</option>';
      back.innerHTML = '<option disabled>（无备份）</option>';
      deckMsg('未找到游戏卡组目录：' + d.decksDir + '。请确认《断箭》已安装并至少运行过一次。', true);
      return;
    }
    front.innerHTML = d.decks.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}（${fmtTime(f.mtime)}）</option>`).join('') || '<option disabled>（空）</option>';
    back.innerHTML = d.backups.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}（${fmtTime(f.mtime)}）</option>`).join('') || '<option disabled>（空）</option>';
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
  if (!names.length) { deckMsg('请先在左侧选择要备份的卡组（Ctrl+单击可多选）', true); return; }
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
async function doDeploy() {
  const names = selectedOptions($('deckBack'));
  if (!names.length) { deckMsg('请先在右侧选择要部署的备份包', true); return; }
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
function openSettings() {
  // 先立刻显示弹窗，再异步填充，避免“点了没反应”
  $('settingsModal').classList.remove('hidden');
  BA.getConfig().then((cfg) => {
    $('setLogDir').value = cfg.logDir || '';
    $('setPoll').value = cfg.pollMs;
    $('setDelay').value = cfg.apiDelayMs;
    $('setAuto').checked = !!cfg.autoQueryCurrentMatch;
    $('setHeartbeat').checked = !!cfg.heartbeatEnabled;
    $('setHeartbeatUrl').value = cfg.heartbeatUrl || '';
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

// ---------- 右键菜单：跳转 BATrace 对应页面 ----------
let ctxEl = null;
function ensureCtxMenu() {
  if (ctxEl) return ctxEl;
  ctxEl = document.createElement('div');
  ctxEl.id = 'ctxMenu';
  ctxEl.className = 'ctx-menu hidden';
  ctxEl.innerHTML = '<div class="ctx-item">🌐 在 BATrace 打开</div>';
  document.body.appendChild(ctxEl);
  ctxEl.addEventListener('click', (e) => {
    if (e.target.closest('.ctx-item') && ctxEl.dataset.link) { openLink(ctxEl.dataset.link); hideCtx(); }
  });
  return ctxEl;
}
function hideCtx() { if (ctxEl) ctxEl.classList.add('hidden'); }
function showCtx(x, y, link) {
  const el = ensureCtxMenu();
  el.dataset.link = link;
  el.classList.remove('hidden');
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - 190)) + 'px';
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - 48)) + 'px';
}
document.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('[data-link]');
  if (t && t.dataset.link) { e.preventDefault(); showCtx(e.clientX, e.clientY, t.dataset.link); }
  else hideCtx();
});
document.addEventListener('click', () => hideCtx());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

async function runMaggot(stbid, name) {
  const area = $('maggotArea');
  $('maggotCalls').textContent = '';
  area.innerHTML = '<div class="dim" id="maggotProgress">查蛆指数中：拉取最近 12 场有效对局明细（冷查约 13 次调用，24 小时缓存后仅 1 次）…</div>';
  try {
    const r = await BA.maggotReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; return; }
    renderMaggot(r, name);
  } catch (e) {
    area.innerHTML = `<div class="loss">蛆查失败：${esc(e.message)}</div>`;
  }
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
function renderVersion(v) {
  if (!v) return;
  const av = $('aboutVer');
  if (av) av.textContent = `当前版本 v${v.current}`;
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
  on('btnSettings', 'click', openSettings);
  on('btnCancel', 'click', () => $('settingsModal').classList.add('hidden'));
  on('btnSave', 'click', saveSettings);
  on('btnBrowse', 'click', async () => {
    const dir = await BA.selectDir();
    if (dir) $('setLogDir').value = dir;
  });
  on('btnHeartbeatTest', 'click', async () => {
    const url = $('setHeartbeatUrl').value.trim();
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

  on('btnReQuery', 'click', () => {
    if (querying) return;
    querying = true;
    BA.queryCurrentMatch().catch(() => { querying = false; });
  });

  on('btnMaggot', 'click', () => {
    if (!lastReport) { setStatus('请先搜索并点选一位玩家（粗查）再查蛆指数', false); return; }
    runMaggot(lastReport.id, lastReport.name);
  });
  on('btnUpdateOpen', 'click', () => openLink(GITHUB_URL));
  on('btnUpdateClose', 'click', () => $('updateBanner').classList.add('hidden'));
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
      $('searchResults').innerHTML = list.length
        ? list.map((p) => `<span class="chip" data-id="${p.id}" data-name="${esc(p.name)}" data-link="${PLAYER_URL(p.id)}">${esc(p.name)}<span class="s-lv">Lv.${p.level ?? '?'}</span><span class="s-elo">${p.rating != null ? Math.round(p.rating) : '?'}</span></span>`).join('')
        : '<span class="dim">未找到玩家</span>';
      document.querySelectorAll('.chip').forEach((el) => {
        el.addEventListener('click', () => loadReport(el.dataset.id, el.dataset.name));
      });
    } catch (e) {
      $('searchResults').innerHTML = '<span class="loss">搜索失败：' + esc(e.message) + '</span>';
    }
  };
  on('btnSearch', 'click', doSearch);
  on('searchInput', 'keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  on('btnClearArchive', 'click', async () => {
    await BA.clearArchive();
    renderArchive([]);
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
  on('btnOpenFront', 'click', () => BA.openDeckFolder('decks'));
  on('btnOpenBack', 'click', () => BA.openDeckFolder('backups'));
  enableToggleSelect($('deckFront'));
  enableToggleSelect($('deckBack'));
}

async function saveSettings() {
  const dir = $('setLogDir').value.trim();
  const v = await BA.validateDir(dir);
  if (!v.ok) { $('dirHint').textContent = '目录无效：' + (v.reason || ''); return; }
  await BA.setConfig({
    logDir: dir,
    pollMs: parseInt($('setPoll').value, 10) || 1500,
    apiDelayMs: parseInt($('setDelay').value, 10) || 350,
    autoQueryCurrentMatch: $('setAuto').checked,
    heartbeatEnabled: $('setHeartbeat').checked,
    heartbeatUrl: $('setHeartbeatUrl').value.trim()
  });
  $('settingsModal').classList.add('hidden');
  setStatus('监听中', true);
  $('fileText').textContent = dir;
}

// ---------- 主流程 ----------
async function init() {
  const cfg = await BA.getConfig();
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
  renderArchive(await BA.getArchive());
  refreshDecks();

  BA.onSession((d) => renderSession(d));
  BA.onWatcher((d) => {
    if (d.file) $('fileText').textContent = d.file;
    if (!d.file) setStatus('未找到日志文件', false);
  });
  BA.onMatchQuerying((d) => {
    matchRows = {};
    for (const p of d.players) matchRows[p.id] = { ...p, status: 'loading' };
    renderMatchGrid();
    $('queryStatus').textContent = `正在查询 ${d.players.length} 位玩家…`;
  });
  BA.onMatchPlayer((row) => {
    matchRows[row.id] = { ...row, status: 'done' };
    renderMatchGrid();
  });
  BA.onMatchDone((d) => {
    querying = false;
    const done = Object.values(matchRows).filter((r) => r.status === 'done').length;
    $('queryStatus').textContent = `查询完成：${done} 位玩家（对局 ${d.fid}）`;
  });
  BA.onArchiveChanged((list) => renderArchive(list));
  BA.onBudget(renderBudget);
  BA.getUsage().then(renderBudget).catch(() => {});
  BA.onHeartbeat(renderHeartbeat);
  BA.getHeartbeat().then(renderHeartbeat).catch(() => {});
  // 点击玩家卡片 → 打开完整报告；📋 按钮 → 复制
  $('teamGrid').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.p-copy');
    if (copyBtn) { e.stopPropagation(); const row = matchRows[copyBtn.dataset.id]; if (row) copyPlayerRow(row, copyBtn); return; }
    const teamBtn = e.target.closest('.team-copy');
    if (teamBtn) { copyTeamRow(teamBtn.dataset.team, teamBtn); return; }
    const card = e.target.closest('.player-card');
    if (card && card.dataset.id) loadReport(card.dataset.id, card.dataset.name);
  });
  BA.onMaggotProgress((d) => {
    const el = $('maggotProgress');
    if (el) el.textContent = `查蛆指数中：已解析 ${d.done}/${d.total} 场有效对局（扫描 ${d.scanned}/${d.of}）…`;
  });
  BA.getVersion().then(renderVersion).catch(() => {});
  BA.onVersion(renderVersion);
}

// 兜底：任何异步错误都显示出来，而不是“点了没反应”
window.addEventListener('error', (e) => setStatus('脚本错误：' + (e.message || '未知'), false));
window.addEventListener('unhandledrejection', (e) => setStatus('异步错误：' + (e.reason && e.reason.message || e.reason || '未知'), false));

bindUI();
init().catch((e) => setStatus('初始化失败：' + (e.message || e), false));

