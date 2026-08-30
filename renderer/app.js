// ================= 渲染进程逻辑 =================
const BA = window.api;

// ---------- 小工具 ----------
const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDuration(sec) {
  if (sec == null) return '-';
  return I18N.t('match.durationFmt', { m: Math.floor(sec / 60), s: sec % 60 });
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
  let text = limit > 0 ? I18N.t('budget.used', { used, limit }) : I18N.t('budget.unlimited', { used });
  if (d.skipped) text += I18N.t('status.skipN', { n: d.skipped });
  if (d.finished) text += ' ✓';
  t.textContent = text;
  const exhausted = limit > 0 && used >= limit;
  t.classList.toggle('warn', exhausted);
  t.title = exhausted ? I18N.t('status.budgetExhausted') : '';
}
// 顶栏：心跳统计（在线人数）
function renderHeartbeat(h) {
  const el = $('onlineText');
  if (!el) return;
  lastHeartbeat = h;
  if (h && h.online != null) {
    el.classList.add('ok'); el.classList.remove('err');
    el.textContent = I18N.t('status.online', { n: h.online });
    el.title = h.lastError
      ? I18N.t('status.heartbeatLastErr', { err: h.lastError })
      : I18N.t('status.heartbeatLastOk', { t: h.lastPing ? new Date(h.lastPing).toLocaleTimeString('zh-CN') : '-' });
  } else if (h && h.lastError) {
    el.classList.remove('ok'); el.classList.add('err');
    el.textContent = I18N.t('heartbeat.failed');
    el.title = h.lastError;
  } else {
    el.classList.remove('ok', 'err');
    el.textContent = I18N.t('status.online', { n: 0 });
    el.title = I18N.t('status.onlineTitle');
  }
}
// 顶栏：BATrace API 稳定性灯（绿=全通 / 黄=部分 / 红=全挂 / 灰=未检测）
function renderApiHealth(d) {
  const el = $('apiHealth');
  if (!el) return;
  if (!d || !d.state) { el.className = 'api-health unknown'; el.title = I18N.t('api.checking'); el.textContent = 'BATrace ●'; return; }
  const map = { ok: ['ok', I18N.t('api.ok')], partial: ['warn', I18N.t('api.partial')], down: ['down', I18N.t('api.down')] };
  const pair = map[d.state] || ['unknown', I18N.t('api.unknown')];
  el.className = 'api-health ' + pair[0];
  const detail = (d.checks || []).map((c) => (c.ok ? I18N.t('status.apiCheckOk', { label: c.label, ms: c.ms }) : I18N.t('status.apiCheckFail', { label: c.label, detail: c.status ? 'HTTP ' + c.status : I18N.t('status.apiTimeout') }))).join('\n');
  el.title = pair[1] + '（' + d.okCount + '/' + d.total + '）\n' + detail + '\n' + I18N.t('status.apiCheckedAt', { t: d.at ? fmtTime(d.at) : '-' }) + '\n' + I18N.t('status.apiHourly');
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
  const elo = info && info.elo != null ? Math.round(info.elo) : I18N.t('common.none');
  const cat = info && info.category ? catLabel(info.category) : I18N.t('common.noData');
  const top = info && info.topUnits ? info.topUnits : I18N.t('common.noData');
  return I18N.t('report.playerLine', { name: p.name, id: p.id, elo, cat, top });
}
function copyPlayerRow(row, btn) { copyText(playerInfoText(row), btn, '✅'); }
// 单队一行：名字+ELO（油猴脚本同格式）
function copyTeamRow(team, btn, rows) {
  const src = rows || matchRows;
  const teamVal = team === 'alpha' ? 'Alpha' : team === 'bravo' ? 'Bravo' : null;
  const players = Object.values(src).filter((p) => teamVal ? p.team === teamVal : !p.team);
  const line = players.map((p) => {
    const elo = p.info && p.info.elo != null ? Math.round(p.info.elo) : I18N.t('common.none');
    return p.name + ' ' + elo;
  }).join(', ');
  copyText(line, btn, '✅');
}

// ---------- 预加载健康检查 ----------
if (!window.api) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#5a1f1f;color:#ffd7d7;padding:10px 16px;font-size:13px;';
  banner.textContent = I18N.t('status.preloadMissing');
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
  if (titleEl) titleEl.textContent = cur ? I18N.t('match.current') : I18N.t('match.room');
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
      $('matchInfo').innerHTML = `<span>${I18N.t('match.notStarted', { n: lobby.length })}</span><span class="dim">${I18N.t('match.autoQueried')}</span>`;
    } else {
      $('matchInfo').innerHTML = '<span class="dim">' + I18N.t('match.waitingStart') + '</span>';
    }
    renderMatchGrid();
    $('queryStatus').textContent = '';
    return;
  }
  $('matchInfo').innerHTML = `
    <span>${I18N.t('match.map', { v: '<b>' + esc(cur.map || I18N.t('common.unknown')) + '</b>' })}</span>
    <span>${I18N.t('match.fid', { v: '<b>' + esc(cur.fid || '-') + '</b>' })}</span>
    <span>${I18N.t('match.localPlayer', { v: '<b>' + esc(s.localName || '-') + '</b>' })}</span>
    <span>${I18N.t('match.localDeck', { v: '<b>' + esc(cur.localDeck || '-') + '</b>' })}</span>`;
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

const CAT_LABELS = { aircrafts: 'cat.aircrafts', helicopters: 'cat.helicopters', tanks: 'cat.tanks', ifvs: 'cat.ifvs', apcs: 'cat.apcs', artillery: 'cat.artillery', airdefense: 'cat.airdefense', infantry: 'cat.infantry', recon: 'cat.recon', ships: 'cat.ships', transports: 'cat.transports', drones: 'cat.drones', missiles: 'cat.missiles', naval: 'cat.naval', vehicles: 'cat.vehicles', support: 'cat.support', planes: 'cat.planes', armor: 'cat.armor' };
function catLabel(key) { if (!key) return '-'; const k = CAT_LABELS[String(key).toLowerCase()]; return k ? I18N.t(k) : String(key); }

function playerCard(p) {
  const selfName = session.localName;
  const selfTag = selfName && p.name === selfName ? '<span class="pself">' + I18N.t('common.me') + '</span>' : '';
  const toolTag = toolUserIds.has(String(p.id)) ? '<span class="ptool" title="' + I18N.t('common.alsoUsing') + '">🎮</span>' : '';
  let statHtml = '';
  if (p.status === 'loading') statHtml = '<span class="loading">' + I18N.t('common.loading') + '</span>';
  else if (p.error) {
    if (p.localSnapshot) statHtml = `<span class="dim">${I18N.t('common.localElo', { v: p.localSnapshot.elo ?? '-' })}${p.localSnapshot.winRate != null ? I18N.t('common.winRate', { v: p.localSnapshot.winRate }) : ''}${I18N.t('common.offlineSnapshot', { t: fmtTime(p.localSnapshot.at) })}</span>`;
    else statHtml = `<span class="err">${esc(p.error)}</span>`;
  }
  else if (p.info) {
    const units = p.info.topUnits ? (p.info.topUnits.length > 18 ? p.info.topUnits.slice(0, 18) + '…' : p.info.topUnits) : '';
    statHtml = `
      <span class="elo">ELO ${p.info.elo ?? '-'}</span>
      ${p.info.kd != null ? `<span>K/D ${p.info.kd}</span>` : ''}
      ${p.info.winRate != null ? `<span class="wr">${I18N.t('common.winRate', { v: p.info.winRate })}</span>` : ''}
      ${p.info.matchCount ? `<span>${I18N.t('common.sample', { n: p.info.matchCount })}</span>` : ''}
      ${p.info.category ? `<span class="cat">${esc(catLabel(p.info.category))}</span>` : ''}
      ${units ? `<span class="topu" title="${I18N.t('common.fav', { u: esc(p.info.topUnits) })}">${esc(units)}</span>` : ''}`;
  }
  return `<div class="player-card" data-id="${p.id}" data-name="${esc(p.name)}" data-link="${PLAYER_URL(p.id)}" title="${I18N.t('common.leftClickFull')}">
    <div class="prow"><span class="pname">${esc(p.name)}${selfTag}${toolTag}</span><span class="pid">ID ${esc(p.id)}</span><button class="p-copy" data-id="${p.id}" title="${I18N.t('common.copyRow')}">📋</button><span class="pmark">›</span></div>
    <div class="pstats">${statHtml || '<span class="dim">' + I18N.t('common.notQueried') + '</span>'}</div>
  </div>`;
}

function renderMatchGrid() {
  const players = Object.values(matchRows);
  if (!players.length) { $('teamGrid').innerHTML = '<span class="dim">' + I18N.t('common.noRoster') + '</span>'; return; }
  const copyLabel = (cls) => cls === 'lobby' ? I18N.t('team.copyAll') : I18N.t('team.copyTeam');
  const col = (title, cls, list, wide) => `
    <div class="team-col ${cls}${wide ? ' wide' : ''}">
      <h3>${title}（${list.length}）${list.length ? `<button class="team-copy ghost" data-team="${cls}" title="${I18N.t('common.copyTeamRow')}">📋 ${copyLabel(cls)}</button>` : ''}</h3>
      ${list.map(playerCard).join('') || '<span class="dim">-</span>'}
    </div>`;
  if (!session.current) {
    $('teamGrid').innerHTML = col(I18N.t('team.roomPlayers'), 'lobby', players, true);
    return;
  }
  const alpha = players.filter((p) => p.team === 'Alpha');
  const bravo = players.filter((p) => p.team === 'Bravo');
  const other = players.filter((p) => p.team !== 'Alpha' && p.team !== 'Bravo');
  let html = col(I18N.t('team.alpha'), 'alpha', alpha) + col(I18N.t('team.bravo'), 'bravo', bravo);
  if (other.length) html += col(I18N.t('team.specOther'), '', other);
  $('teamGrid').innerHTML = html;
}

// ---------- 上一局视图 ----------
let prevLoading = false;
function togglePrevView() {
  if (viewMode === 'prev') { exitPrevView(); return; }
  if (prevLoading) return;
  const m = archiveList[0];
  if (!m || !m.fid) {
    $('matchInfo').innerHTML = '<span class="dim">' + I18N.t('match.noPrev') + '</span>';
    $('teamGrid').innerHTML = '<span class="dim">-</span>';
    return;
  }
  prevLoading = true;
  BA.getMatchDetail(m.fid).then((d) => {
    prevLoading = false;
    if (!d || !d.players || !d.players.length) {
      $('matchInfo').innerHTML = '<span class="dim">' + I18N.t('match.noPrev') + '</span>';
      $('teamGrid').innerHTML = '<span class="dim">-</span>';
      return;
    }
    viewMode = 'prev';
    prevMatch = d;
    prevRows = {};
    for (const p of d.players) prevRows[p.id] = { id: p.id, name: p.name, team: p.team, status: 'idle' };
    $('currentCardTitle').textContent = I18N.t('match.prev');
    const b = $('btnPrevMatch'); if (b) b.textContent = I18N.t('match.backToCurrent');
    $('matchInfo').innerHTML = `<span>${I18N.t('match.map', { v: '<b>' + esc(d.map || I18N.t('common.unknown')) + '</b>' })}</span><span>${I18N.t('match.fid', { v: '<b>' + esc(d.fid || '-') + '</b>' })}</span><span>${I18N.t('match.endTime', { v: '<b>' + fmtTime(d.endTime) + '</b>' })}</span><span>${I18N.t('match.playersN', { n: d.players.length })}</span>`;
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
    $('matchInfo').innerHTML = '<span class="dim">' + I18N.t('match.prevLoadFail') + '</span>';
  });
}
function exitPrevView() {
  if (viewMode !== 'prev') return;
  viewMode = 'current';
  prevMatch = null;
  prevRows = {};
  const b = $('btnPrevMatch'); if (b) b.textContent = I18N.t('btn.prevMatch');
  renderSession(session);
}
function resetPrevIfViewing() {
  if (viewMode !== 'prev') return;
  viewMode = 'current';
  prevMatch = null;
  prevRows = {};
  const b = $('btnPrevMatch'); if (b) b.textContent = I18N.t('btn.prevMatch');
  const t = $('currentCardTitle');
  if (t) t.textContent = session.current ? I18N.t('match.current') : I18N.t('match.room');
}
function renderPrevGrid() {
  const players = Object.values(prevRows);
  if (!players.length) { $('teamGrid').innerHTML = '<span class="dim">' + I18N.t('common.noRoster') + '</span>'; return; }
  const col = (title, cls, list, wide) => `
    <div class="team-col ${cls}${wide ? ' wide' : ''}">
      <h3>${title}（${list.length}）</h3>
      ${list.map(playerCard).join('') || '<span class="dim">-</span>'}
    </div>`;
  const alpha = players.filter((p) => p.team === 'Alpha');
  const bravo = players.filter((p) => p.team === 'Bravo');
  const other = players.filter((p) => p.team !== 'Alpha' && p.team !== 'Bravo');
  let html = col(I18N.t('team.alpha'), 'alpha', alpha) + col(I18N.t('team.bravo'), 'bravo', bravo);
  if (other.length) html += col(I18N.t('team.specOther'), '', other);
  $('teamGrid').innerHTML = html;
}

async function loadReport(stbid, name) {
  const area = $('reportArea');
  area.innerHTML = '<div class="dim">' + esc(I18N.t('report.generating')) + '</div>';
  area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await BA.playerReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; area.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    lastReport = { id: stbid, name: name || stbid };
    renderReport(r, name);
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    area.innerHTML = `<div class="loss">${esc(I18N.t('report.genFail', { msg: e.message }))}</div>`;
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
          <span class="tag" style="color:var(--warn)">${esc(I18N.t('report.basicOnly'))}</span>
        </div>
        <div class="kv">
          <div class="item"><b>${r.elo ?? '-'}</b><span>ELO</span></div>
          <div class="item"><b>${r.winRate != null ? r.winRate + '%' : '-'}</b><span>${I18N.t('report.rankedWinRateN', { n: r.matchCount ?? 0 })}</span></div>
          <div class="item"><b>${r.wins ?? '-'} / ${r.losses ?? '-'}</b><span>${I18N.t('report.winsLosses')}</span></div>
        </div>
        <div class="dim" style="margin-top:8px">${esc(I18N.t('report.noRankedData'))}</div>
      </div>`;
    return;
  }
  const cats = (r.categories || []).map((c) =>
    `<span class="tag">${esc(catLabel(c.key))}${c.pct != null ? ' ' + c.pct + '%' : ''}</span>`).join('');
  const fav = (r.favUnits || []).map((u) =>
    `<span class="tag" title="${I18N.t('report.spawnsN', { n: u.spawn ?? '-' })}">${esc(u.name)}${u.val ? I18N.t('report.dmgOut', { v: Math.round(u.val) }) : ''}</span>`).join('');
  const maps = (r.mapStats || []).map((m) =>
    `<span class="tag" title="${I18N.t('report.matchesN', { n: m.matchCount ?? '-' })}">${esc(m.name)}${m.winRate != null ? ' ' + m.winRate + '%' : ''}</span>`).join('');
  const style = styleLabel(r.playStyle && r.playStyle.primaryStyle);
  const rows = (r.recentMatches || []).map((m) => `
    <tr>
      <td class="${m.win == null ? 'unk' : m.win ? 'win' : 'loss'}">${m.win == null ? I18N.t('common.unknown') : m.win ? I18N.t('common.win') : I18N.t('common.loss')}</td>
      <td>${fmtDelta(m.eloDelta)}</td>
      <td>${m.kd ?? '-'}</td>
      <td>${m.dmr ?? '-'}</td>
      <td>${m.destruction ?? '-'}</td>
      <td>${m.losses ?? '-'}</td>
      <td>${m.objectives ?? '-'}</td>
      <td class="dim" data-link="${MATCH_URL(m.matchId)}" title="${I18N.t('common.rightClickBatrace')}">${esc(m.matchId ?? '-')}</td>
    </tr>`).join('');
  const catText = (r.categories || []).map((c) => catLabel(c.key)).join('/') || I18N.t('common.none');
  const favText = (r.favUnits || []).map((u) => u.name).join('/') || I18N.t('common.none');
  const copyText = I18N.t('report.playerLine', { name: name || r.stbid, id: r.stbid, elo: r.elo ?? I18N.t('common.none'), cat: catText, top: favText });
  $('reportArea').innerHTML = `
    <div class="report">
      <div class="report-head">
        <span class="rname" data-link="${PLAYER_URL(r.stbid)}" title="${I18N.t('common.rightClickBatrace')}">${esc(name || r.stbid)}</span>
        <span class="dim">ID ${r.stbid}</span>
        <span class="dim">${I18N.t('common.sampleMatches', { n: r.matchCount ?? '-' })}</span>
        <button id="btnCopyReport" class="ghost" style="margin-left:auto">${I18N.t('report.copySingle')}</button>
        <button id="btnMaggotFromReport" class="accent">${I18N.t('btn.maggot')}</button>
      </div>
      <div class="kv">
        <div class="item"><b>${r.elo ?? '-'}</b><span>ELO</span></div>
        <div class="item"><b>${r.winRate != null ? r.winRate + '%' : '-'}</b><span>${I18N.t('report.winRateN', { n: r.matchCount ?? 0 })}</span></div>
        <div class="item"><b>${r.wins ?? '-'} / ${r.losses ?? '-'}</b><span>${I18N.t('report.winsLosses')}</span></div>
        <div class="item"><b>${r.kd ?? '-'}</b><span>${I18N.t('report.latestKd')}</span></div>
        <div class="item"><b>${r.dmr ?? '-'}</b><span>${I18N.t('report.latestDmr')}</span></div>
        <div class="item"><b>${esc(style)}</b><span>${I18N.t('report.style')}</span></div>
      </div>
      ${cats ? `<div class="tags"><span class="dim">${I18N.t('report.prefLabel')}</span>${cats}</div>` : ''}
      ${fav ? `<div class="favunits"><span class="dim">${I18N.t('report.favLabel')}</span>${fav}</div>` : ''}
      ${maps ? `<div class="favunits"><span class="dim">${I18N.t('report.mapLabel')}</span>${maps}</div>` : ''}
      <table class="matches">
        <thead><tr><th>${I18N.t('report.thResult')}</th><th>${I18N.t('report.thElo')}</th><th>${I18N.t('report.thKd')}</th><th>${I18N.t('report.thDmr')}</th><th>${I18N.t('report.thDestr')}</th><th>${I18N.t('report.thLosses')}</th><th>${I18N.t('report.thObj')}</th><th>${I18N.t('report.thFid')}</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="dim">' + I18N.t('report.noRecent') + '</td></tr>'}</tbody>
      </table>
      <div class="dim" style="margin-top:8px">${esc(I18N.t('report.hint'))}</div>
    </div>`;
  const copyBtn = $('btnCopyReport');
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard.writeText(copyText).then(() => {
      copyBtn.textContent = I18N.t('report.copied');
      setTimeout(() => { copyBtn.textContent = I18N.t('report.copySingle'); }, 1500);
    }).catch(() => {});
  };
  const mgBtn = $('btnMaggotFromReport');
  if (mgBtn) mgBtn.onclick = () => runMaggot(r.stbid, name || r.stbid);
}

const STYLE_LABELS = {
  team_player: 'style.team_player', combat_focused: 'style.combat_focused', balanced_combat: 'style.balanced_combat',
  balanced_economy: 'style.balanced_economy', economy_focused: 'style.economy_focused', aggressive: 'style.aggressive',
  defensive: 'style.defensive', support: 'style.support'
};
function styleLabel(key) { if (!key) return '-'; const k = STYLE_LABELS[String(key).toLowerCase()]; return k ? I18N.t(k) : String(key); }

// ---- 对局档案（本地 matches 表，最近 500 局） ----------
// 对局状态（本机视角）：观战 / 胜 / 负 / 未知
function matchState(m) {
  if (m.restarted) return { text: I18N.t('common.restarted'), cls: 'unk' };
  if (m.localSpectator) return { text: I18N.t('common.spectate'), cls: 'spec' };
  if (m.localWon === true) return { text: I18N.t('common.win'), cls: 'win' };
  if (m.localWon === false) return { text: I18N.t('common.loss'), cls: 'loss' };
  return { text: I18N.t('common.unknown'), cls: 'unk' };
}
function renderArchive(list) {
  archiveList = Array.isArray(list) ? list : [];
  const el = $('archiveList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<span class="dim">' + esc(I18N.t('archive.empty')) + '</span>';
    return;
  }
  const modeBadge = (m) => m.mode === 'custom' ? '<span class="mode-tag custom">' + esc(I18N.t('common.custom')) + '</span>' : m.mode === 'ranked' ? '<span class="mode-tag ranked">' + esc(I18N.t('common.ranked')) + '</span>' : (m.custom === true ? '<span class="mode-tag custom">' + esc(I18N.t('common.custom')) + '</span>' : m.custom === false ? '<span class="mode-tag ranked">' + esc(I18N.t('common.ranked')) + '</span>' : '<span class="dim">' + esc(I18N.t('common.unknown')) + '</span>');
  el.innerHTML = `
    <table class="archive-table">
      <thead><tr><th>${I18N.t('archive.thStatus')}</th><th>${I18N.t('archive.thMode')}</th><th>${I18N.t('archive.thMap')}</th><th>${I18N.t('archive.thElo')}</th><th>${I18N.t('archive.thTime')}</th><th>${I18N.t('archive.thAccount')}</th></tr></thead>
      <tbody>${list.map((m) => {
        const fid = m.fid || '';
        const link = fid ? ` data-link="${MATCH_URL(fid)}"` : '';
        const st = matchState(m);
        const hasReplay = !!(m.fid && replayFids.has(String(m.fid)));
        const elo = m.localEloDelta != null ? fmtDelta(m.localEloDelta) + ' / ' + fmtElo(m.localEloAfter) : '-';
        const who = m.localPersona || m.localName || '';
        return `<tr class="archive-row"${link} data-fid="${fid}" title="${esc(I18N.t('archive.rowTitle'))}">
          <td class="${st.cls}">${st.text}</td>
          <td>${modeBadge(m)}</td>
          <td>${esc(m.map || I18N.t('common.unknownMap'))}${hasReplay ? ' <span class="replay-mark" title="' + esc(I18N.t('archive.replayMarkTitle')) + '" role="button">📹</span>' : ''}</td>
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

// 手动收录对局 ID：拉取 BATrace /api/match 写入追踪库并刷新档案
async function addMatchByFid() {
  const input = $('addMatchFid');
  const fid = (input && input.value || '').trim();
  if (!/^\d+$/.test(fid)) { setStatus(I18N.t('archive.addInvalid'), false); return; }
  try {
    const r = await BA.addMatchByFid(fid);
    setStatus((r && r.message) || I18N.t('status.refreshed'), !!(r && r.ok));
    if (r && r.ok) {
      if (input) input.value = '';
      const mm = await BA.getTrackerMatches();
      renderArchive(mm && mm.list);
    }
  } catch (e) { setStatus(I18N.t('status.refreshFail', { msg: e.message }), false); }
}

// 从对局档案的 📹 打开录像：单个直接播；多个本地文件弹列表选择
async function openReplayForFid(fid) {
  try {
    const items = await collectReplayItemsForFid(fid);
    if (!items.length) { setStatus(I18N.t('status.replayOpened'), false); return; }
    let chosen = items[0];
    if (items.length > 1) {
      chosen = await pickReplay(items);
      if (!chosen) return;
    }
    await playReplayItem(chosen);
  } catch (e) { setStatus(I18N.t('status.openReplayFail', { msg: e.message }), false); }
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
  setStatus(I18N.t('status.replayOpened'), false);
}

let replayPickResolve = null;
let lastVersionInfo = null; // 最近一次版本信息（下载按钮用）
let lastHeartbeat = null;   // 最近一次心跳（语言切换时重渲染）
let currentCfg = null;      // 最近一次配置（语言切换时重渲染录像提示）
function pickReplay(items) {
  return new Promise((resolve) => {
    replayPickResolve = resolve;
    const wrap = $('replayPickerList');
    if (!wrap) { resolve(null); return; }
    wrap.innerHTML = (items || []).map((it, i) => `
      <div class="inv-item replay-pick-item" data-idx="${i}" title="${I18N.t('common.clickPlay')}">
        <span class="r-name">${esc(it.name || I18N.t('common.unknown'))}</span>
        <span class="r-src local">${I18N.t('replay.localTag')}</span>
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
  $('matchTitle').textContent = I18N.t('modal.matchDetail');
  $('matchFid').textContent = I18N.t('match.id', { id: fid });
  $('matchDetailBody').innerHTML = '<div class="dim">' + esc(I18N.t('loading.detail')) + '</div>';
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
    $('matchDetailBody').innerHTML = '<div class="loss">' + esc(I18N.t('match.loadFail', { msg: e.message })) + '</div>';
  }
}
function renderMatchDetail(d) {
  if (!d) { $('matchDetailBody').innerHTML = '<div class="dim">' + esc(I18N.t('match.noRecord')) + '</div>'; return; }
  $('matchTitle').textContent = d.map || I18N.t('common.unknownMap');
  $('matchFid').textContent = I18N.t('match.id', { id: d.fid });
  const modeTxt = d.mode === 'custom' ? I18N.t('common.custom') : d.mode === 'ranked' ? I18N.t('common.ranked') : (d.custom === true ? I18N.t('common.custom') : d.custom === false ? I18N.t('common.ranked') : I18N.t('common.unknown'));
  const st = matchState(d);
  const elo = d.localEloDelta != null ? fmtDelta(d.localEloDelta) : '-';
  const settle = d.localEloAfter != null ? fmtElo(d.localEloAfter) : '-';
  const sc = d.localScores ? (d.localScores.destruction ?? '-') + '/' + (d.localScores.losses ?? '-') : '-';
  const account = d.localPersona || d.localName || '';
  const fetchNote = d.fetched ? '<div class="dim">' + esc(I18N.t('match.fetchNote')) + '</div>' : (d.fetchError ? `<div class="dim">${esc(I18N.t('match.fetchError', { msg: d.fetchError }))}</div>` : '');
  const restartNote = d.restarted ? '<div class="dim">' + esc(I18N.t('match.restartNote')) + '</div>' : '';
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
    const delta = (p.oldRating != null && p.newRating != null) ? fmtDelta(p.newRating - p.oldRating) : null;
    const eloVal = p.newRating != null ? fmtElo(p.newRating) : (p.oldRating != null ? fmtElo(p.oldRating) : null);
    const eloC = eloVal != null ? (delta != null ? eloVal + ' (' + delta + ')' : eloVal) : (delta != null ? delta : '-');
    const score = p.destructionScore != null ? p.destructionScore + '/' + (p.lossesScore ?? '-') : '-';
    const obj = p.objectivesCaptured != null ? p.objectivesCaptured : '-';
    const k = p.killed != null ? p.killed : '-';
    const dmg = p.damageDealt != null ? p.damageDealt : '-';
    const taken = p.damageReceived != null ? p.damageReceived : '-';
    const dlr = p.dlRatio != null ? p.dlRatio : '-';
    const sp = p.supplyPoints != null ? p.supplyPoints : '-';
    const ex = p.exp != null ? p.exp : '-';
    const md = p.medals != null ? p.medals : '-';
    return `<tr data-id="${esc(p.id)}" data-name="${esc(p.name || '')}" data-link="${PLAYER_URL(p.id)}" title="${I18N.t('inv.rightClickInv')}">
      <td><b>${esc(p.name || I18N.t('common.unknown'))}</b></td>
      <td class="dim md-id-cell"><span class="md-id">${esc(p.id)}</span></td>
      <td>${eloC}</td>
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
        <thead><tr><th>${I18N.t('match.thPlayer')}</th><th>${I18N.t('match.thId')}</th><th>${I18N.t('match.thElo')}</th><th>${I18N.t('match.thScore')}</th><th>${I18N.t('match.thObj')}</th><th>${I18N.t('match.thKills')}</th><th>${I18N.t('match.thDmg')}</th><th>${I18N.t('match.thDmgTaken')}</th><th>${I18N.t('match.thKd')}</th><th>${I18N.t('match.thSupply')}</th><th>${I18N.t('match.thExp')}</th><th>${I18N.t('match.thMedals')}</th></tr></thead>
        <tbody>${list.map(playerRow).join('')}</tbody>
      </table>
    </div>` : '';
  let body = '';
  if (d.winnerTeam === 0 || d.winnerTeam === 1) {
    const w = d.winnerTeam, l = d.winnerTeam === 0 ? 1 : 0;
    body = group(I18N.t('match.groupWinner', { team: w === 0 ? I18N.t('match.teamAlpha') : I18N.t('match.teamBravo') }), groups[w]) + group(I18N.t('match.groupLoser', { team: l === 0 ? I18N.t('match.teamAlpha') : I18N.t('match.teamBravo') }), groups[l]);
  } else {
    body = group(I18N.t('match.groupAlpha'), groups[0]) + group(I18N.t('match.groupBravo'), groups[1]);
  }
  body += group(I18N.t('match.groupSpec'), groups[100]) + group(I18N.t('match.groupOther'), groups.other);
  $('matchDetailBody').innerHTML = `
    <div class="inv-stats">
      <div class="inv-stat"><b>${esc(d.fid)}</b><span>${I18N.t('match.idStat')}</span></div>
      <div class="inv-stat"><b>${esc(d.map || I18N.t('common.unknownMap'))}</b><span>${I18N.t('match.mapStat')}</span></div>
      <div class="inv-stat"><b>${fmtTime(d.endTime)}</b><span>${I18N.t('match.timeStat')}</span></div>
      <div class="inv-stat"><b>${fmtDuration(d.durationSec)}</b><span>${I18N.t('match.durationStat')}</span></div>
      <div class="inv-stat"><b>${modeTxt}</b><span>${I18N.t('match.modeStat')}</span></div>
      <div class="inv-stat"><b class="${st.cls}">${st.text}</b><span>${I18N.t('match.resultStat')}</span></div>
      <div class="inv-stat"><b>${elo}</b><span>${I18N.t('match.eloDeltaStat')}</span></div>
      <div class="inv-stat"><b>${settle}</b><span>${I18N.t('match.settleEloStat')}</span></div>
      <div class="inv-stat"><b>${sc}</b><span>${I18N.t('match.scoreStat')}</span></div>
      <div class="inv-stat"><b>${account ? esc(account) : '-'}</b><span>${I18N.t('match.localAccountStat')}</span></div>
    </div>
    ${fetchNote}
    ${restartNote}
    ${body}`;
}

// ---------- 卡组工具 ----------
async function refreshDecks() {
  try {
    const d = await BA.listDecks();
    const fmt = (s) => s ? (s.length > 70 ? '…' + s.slice(-70) : s) : '';
    $('deckPaths').textContent = I18N.t('deck.paths', { f: fmt(d.decksDir), b: fmt(d.backupsDir) }) + ' ';
    const front = $('deckFront');
    const back = $('deckBack');
    if (!d.found) {
      front.innerHTML = '<option disabled>' + I18N.t('deck.noDirOpt') + '</option>';
      back.innerHTML = '<option disabled>' + I18N.t('deck.noBackupOpt') + '</option>';
      deckMsg(I18N.t('deck.noDirMsg', { dir: d.decksDir }), true);
      return;
    }
    front.innerHTML = d.decks.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') || '<option disabled>' + I18N.t('deck.emptyOpt') + '</option>';
    back.innerHTML = d.backups.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') || '<option disabled>' + I18N.t('deck.emptyOpt') + '</option>';
  } catch (e) {
    deckMsg(I18N.t('deck.loadFail', { msg: e.message }), true);
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
  if (!names.length) { deckMsg(I18N.t('deck.needSelectFront'), true); return; }
  backupAllPending = false;
  showBackupRow();
}
async function doBackupAll() {
  const names = allDeckNames();
  if (!names.length) { deckMsg(I18N.t('deck.noneFront'), true); return; }
  backupAllPending = true;
  for (const o of $('deckFront').options) if (!o.disabled) o.selected = true;
  showBackupRow();
}
async function confirmBackup() {
  const names = backupAllPending ? allDeckNames() : selectedOptions($('deckFront'));
  const pkg = $('backupName').value.trim();
  if (!names.length || !pkg) { deckMsg(I18N.t('deck.nameEmpty'), true); return; }
  backupAllPending = false;
  try {
    const r = await BA.backupDecks(names, pkg);
    deckMsg(r.message, !r.ok);
    $('backupRow').classList.add('hidden');
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg(I18N.t('deck.backupFail', { msg: e.message }), true);
  }
}
async function doSyncRestore() {
  const ok = await askConfirm(I18N.t('deck.confirmReplace'));
  if (!ok) return;
  try {
    const r = await BA.syncRestore();
    deckMsg(r.message, !r.ok);
    $('deckSyncAlert').classList.add('hidden');
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg(I18N.t('deck.syncFail', { msg: e.message }), true);
  }
}
async function doSyncIgnore() {
  const ok = await askConfirm(I18N.t('deck.confirmIgnore'));
  if (!ok) return;
  try {
    const r = await BA.syncIgnore();
    deckMsg(r.message, !r.ok);
    $('deckSyncAlert').classList.add('hidden');
    refreshDecks();
  } catch (e) {
    deckMsg(I18N.t('deck.opFail', { msg: e.message }), true);
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
    if (d.to) ai.textContent = I18N.t('deck.currentAccount', { name: d.to });
    else ai.textContent = '';
  }
  el.classList.remove('hidden');
}

async function doDeploy() {
  const names = selectedOptions($('deckBack'));
  if (!names.length) { deckMsg(I18N.t('deck.needSelectBack'), true); return; }
  const pkg = names[0];
  const ok = await askConfirm(I18N.t('deck.confirmDeploy', { pkg: pkg }));
  if (!ok) return;
  try {
    const r = await BA.deployDecks(pkg);
    deckMsg(r.message, !r.ok);
    if (r.ok) refreshDecks();
  } catch (e) {
    deckMsg(I18N.t('deck.deployFail', { msg: e.message }), true);
  }
}
async function doDelete(kind, label) {
  const sel = kind === 'backups' ? $('deckBack') : $('deckFront');
  const names = selectedOptions(sel);
  if (!names.length) { deckMsg(I18N.t('deck.needSelectDel', { label: label }), true); return; }
  const ok = await askConfirm(I18N.t('deck.confirmDeleteN', { n: names.length }));
  if (!ok) return;
  try {
    const r = await BA.deleteDecks(kind, names);
    deckMsg(r.message, !r.ok);
    refreshDecks();
  } catch (e) {
    deckMsg(I18N.t('deck.deleteFail', { msg: e.message }), true);
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
    const reason = !d ? I18N.t('apm.unavailable')
      : d.reason === 'disabled' ? I18N.t('apm.reasonDisabled')
      : d.reason === 'replay' ? I18N.t('apm.reasonReplay')
      : d.reason === 'hook' ? I18N.t('apm.reasonHook')
      : I18N.t('apm.unavailable');
    if (meta) meta.textContent = I18N.t('apm.unavailableShort');
    if (body) body.innerHTML = `<div class="apm-empty loss">⚠️ ${reason}</div>`;
    return;
  }
  apmRunning = true;
  if (meta) meta.textContent = d.map ? I18N.t('apm.ingameMap', { map: esc(d.map) }) : I18N.t('apm.ingame');
  if (body) body.innerHTML = `<div class="apm-live"><div class="apm-bignum" id="apmNow">0</div><div class="apm-live-label">${I18N.t('apm.currentLabel')}</div><div class="dim" id="apmLiveSub">${I18N.t('apm.counting')}</div></div>`;
}
function renderApmLive(d) {
  if (!apmRunning || !d) return;
  const now = $('apmNow');
  if (now) now.textContent = d.apm;
  const sub = $('apmLiveSub');
  if (sub) sub.textContent = I18N.t('apm.elapsed', { dur: fmtDuration(d.durationSec), n: d.totalActions });
}
function renderApmResult(r) {
  if (!r) return;
  apmRunning = false;
  const focusNote = r.focusFilter ? '' : '<span class="dim">' + I18N.t('apm.noFocusFilter') + '</span>';
  const max = Math.max(1, ...(r.perMinute || [1]));
  const bars = (r.minutes || []).map((m) => {
    const pct = Math.max(3, Math.round((m.actions / max) * 100));
    return `<div class="apm-bar-wrap" title="${I18N.t('apm.minuteTitle', { n: m.m + 1, c: m.actions })}"><div class="apm-bar" style="height:${pct}%"></div>${m.m % 5 === 0 ? '<span class="apm-min">' + (m.m + 1) + '</span>' : ''}</div>`;
  }).join('');
  const noData = r.totalActions <= 0 ? '<div class="dim">' + I18N.t('apm.noData') + '</div>' : '';
  const meta = $('apmMeta');
  if (meta) meta.textContent = I18N.t('apm.ended', { dur: fmtDuration(r.durationSec), n: r.totalActions, avg: r.avg, peak: r.peak });
  const body = $('apmBody');
  if (body) body.innerHTML = `
    <div class="apm-summary">
      <span class="apm-stat"><b>${r.totalActions}</b>${I18N.t('apm.totalOps')}</span>
      <span class="apm-stat"><b>${r.avg}</b>${I18N.t('apm.avgApm')}</span>
      <span class="apm-stat"><b>${r.peak}</b>${I18N.t('apm.peakApm')}</span>
      <span class="apm-stat"><b>${fmtDuration(r.durationSec)}</b>${I18N.t('apm.duration')}</span>
    </div>
    <div class="apm-chart">${bars}</div>
    <div class="dim note">${I18N.t('apm.source')}${focusNote}</div>
    ${noData}
  `;
}
function renderApmIdle() {
  apmRunning = false;
  const meta = $('apmMeta');
  if (meta) meta.textContent = I18N.t('apm.waiting');
  const body = $('apmBody');
  if (body) body.innerHTML = '<div class="apm-empty dim">' + I18N.t('apm.idleHint') + '</div>';
}

function setDeckCollapsed(collapsed) {
  const card = $('deckCard');
  if (!card) return;
  card.classList.toggle('collapsed', !!collapsed);
  const btn = $('btnDeckToggle');
  if (btn) btn.title = collapsed ? I18N.t('apm.expand') : I18N.t('apm.collapse');
}
function setApmCollapsed(collapsed) {
  const card = $('apmCard');
  if (!card) return;
  card.classList.toggle('collapsed', !!collapsed);
  const btn = $('btnApmToggle');
  if (btn) btn.title = collapsed ? I18N.t('apm.expand') : I18N.t('apm.collapse');
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
    panelOrder = normPanelOrder(cfg.panelOrder);
    renderPanelOrderList();
    savedTheme = cfg.theme || 'dark';
    setThemePicker(savedTheme);
    $('dirHint').textContent = '';
  }).catch((e) => setStatus(I18N.t('status.loadSettingsFail', { msg: e.message }), false));
}

// 容错绑定：元素缺失只提示，不中断后续按钮
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.error(I18N.t('common.missingEl', { id: id }));
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
    setStatus((r && r.message) || I18N.t('status.refreshed'), !!(r && r.ok));
  } catch (e) { setStatus(I18N.t('status.refreshFail', { msg: e.message }), false); }
}
document.addEventListener('contextmenu', (e) => {
  const rp = e.target.closest('.replay-row[data-key]');
  if (rp) {
    e.preventDefault();
    const fid = rp.dataset.fid || '';
    const items = [];
    if (fid) items.push({ label: I18N.t('ctx.openMatchDetail'), action: () => openMatchDetail(fid) });
    items.push({ label: I18N.t('ctx.openLocation'), action: () => BA.openLocalReplayFolder() });
    items.push({ label: I18N.t('ctx.deleteReplay'), action: async () => {
      const ok = await askConfirm(I18N.t('confirm.deleteReplay'));
      if (!ok) return;
      try { await BA.deleteLocalReplay(rp.dataset.key); setStatus(I18N.t('status.deleted'), true); renderReplayList(); refreshReplayFids(); }
      catch (err) { setStatus(I18N.t('status.deleteFailed', { msg: err.message }), false); }
    } });
    showCtx(e.clientX, e.clientY, items);
    return;
  }
  const t = e.target.closest('[data-link]');
  if (!t || !t.dataset.link) { hideCtx(); return; }
  e.preventDefault();
  const items = [];
  if (t.dataset.id) {
    items.push({ label: I18N.t('ctx.investigate'), action: () => openInvestigate(t.dataset.id, t.dataset.name) });
  }
  if (t.dataset.fid) {
    items.push({ label: I18N.t('ctx.refreshMatch'), action: () => refreshMatchRow(t.dataset.fid) });
    // 对局档案行：右键可直接删除不要的对局记录（如手动收录错）
    if (t.classList && t.classList.contains('archive-row')) {
      items.push({ label: I18N.t('ctx.deleteMatch'), action: async () => {
        const ok = await askConfirm(I18N.t('confirm.deleteMatch'));
        if (!ok) return;
        try {
          const r = await BA.deleteMatch(t.dataset.fid);
          setStatus((r && r.message) || I18N.t('status.deleted'), !!(r && r.ok));
          const mm = await BA.getTrackerMatches();
          renderArchive(mm && mm.list);
        } catch (err) { setStatus(I18N.t('status.deleteFailed', { msg: err.message }), false); }
      } });
    }
  }
  items.push({ label: I18N.t('ctx.openBatrace'), action: () => openLink(t.dataset.link) });
  showCtx(e.clientX, e.clientY, items);
});
document.addEventListener('click', () => hideCtx());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtx(); clearInvGameTimer(); stopRadarLoading(); if (window.BAGame && BAGame.isOpen()) BAGame.close(); const bm = $('banAlertModal'); if (bm) bm.classList.add('hidden'); const m = $('investigateModal'); if (m) m.classList.add('hidden'); const mm = $('matchModal'); if (mm) mm.classList.add('hidden'); const rp = $('replayModal'); if (rp) closeReplayPlayer(); const rsm = $('recSettingsModal'); if (rsm && !rsm.classList.contains('hidden')) closeRecSettings(); const pk = $('replayPickerModal'); if (pk) { pk.classList.add('hidden'); if (replayPickResolve) { replayPickResolve(null); replayPickResolve = null; } } } });
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
  if (e.rel === 'spec') return I18N.t('inv.rel.spec') + (e.won != null ? (e.won ? I18N.t('inv.rel.specWin') : I18N.t('inv.rel.specLoss')) : (e.custom ? I18N.t('inv.rel.custom') : ''));
  const base = e.rel === 'same' ? I18N.t('inv.rel.same') : e.rel === 'opp' ? I18N.t('inv.rel.opp') : null;
  if (!base) return I18N.t('common.unknown');
  if (e.won != null) {
    if (e.rel === 'same') return base + (e.won ? I18N.t('inv.rel.sameWin') : I18N.t('inv.rel.sameLoss'));
    return base + (e.won ? I18N.t('inv.rel.oppWin') : I18N.t('inv.rel.oppLoss'));
  }
  return base + (e.custom ? I18N.t('inv.rel.custom') : '');
}
function openInvestigate(id, name) {
  invId = id; invName = name || id;
  $('investigateModal').classList.remove('hidden');
  $('invName').textContent = invName;
  $('invId').textContent = 'ID ' + id;
  $('invBanBadge').classList.add('hidden');
  $('invStats').innerHTML = '<div class="inv-stat"><b>…</b><span>' + I18N.t('loading.detail') + '</span></div>';
  $('invEncounters').innerHTML = '<span class="dim">' + I18N.t('loading.detail') + '</span>';
  $('invNames').innerHTML = '<span class="dim">' + I18N.t('loading.detail') + '</span>';
  $('invInfo').textContent = I18N.t('loading.detail');
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
    $('invStats').innerHTML = '<div class="loss">' + esc(I18N.t('inv.loadFail', { msg: e.message })) + '</div>';
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
    ban.textContent = I18N.t('inv.banned') + (p.banInfo && p.banInfo.firstSeenAt ? I18N.t('inv.bannedSince', { t: fmtTime(p.banInfo.firstSeenAt) }) : '');
  } else {
    ban.classList.add('hidden');
  }
  const st = p.stats || {};
  $('invStats').innerHTML = `
    <div class="inv-stat"><b>${st.count ?? 0}</b><span>${I18N.t('inv.meetCount')}</span></div>
    <div class="inv-stat"><b>${st.sameTeam ?? 0}</b><span>${I18N.t('inv.sameTeam')}</span></div>
    <div class="inv-stat"><b>${st.oppTeam ?? 0}</b><span>${I18N.t('inv.oppTeam')}</span></div>
    <div class="inv-stat"><b>${st.sameWins ?? 0} / ${st.sameLosses ?? 0}</b><span>${I18N.t('inv.sameWl')}</span></div>
    <div class="inv-stat"><b>${st.oppWins ?? 0} / ${st.oppLosses ?? 0}</b><span>${I18N.t('inv.oppWl')}</span></div>
    <div class="inv-stat"><b>${st.spectator ?? 0}</b><span>${I18N.t('common.spectate')}</span></div>
    <div class="inv-stat"><b>${st.custom ?? 0}</b><span>${I18N.t('common.custom')}</span></div>
    <div class="inv-stat"><b>${st.lastAt ? fmtTime(st.lastAt) : '-'}</b><span>${I18N.t('inv.lastMeet')}</span></div>`;
  const eloHtml = p.latestElo != null
    ? (() => { const src = p.latestEloMatch || {}; return `<b class="elo">${I18N.t('inv.latestElo', { v: p.latestElo })}</b><span class="dim">（${src.fid || '-'}${src.map ? ' · ' + esc(src.map) : ''}${src.endTime ? ' · ' + fmtTime(src.endTime) : ''}）</span>`; })()
    : '<span class="dim">' + I18N.t('inv.noRanked') + '</span>';
﻿  const rec = p.recentMatches || [];
  $('invRecent').innerHTML = rec.length
    ? rec.slice(0, 10).map((m) => `
      <div class="inv-item"${m.fid && /^\d+$/.test(m.fid) ? ` data-link="${MATCH_URL(m.fid)}" title="${I18N.t('common.rightClickBatrace')}"` : ''}>
        <span class="${m.won == null ? 'unk' : m.won ? 'win' : 'loss'}">${m.won != null ? (m.won ? I18N.t('common.win') : I18N.t('common.loss')) : (m.custom ? I18N.t('common.custom') : I18N.t('common.unknown'))}</span>
        ${m.custom ? '<span class="mode-tag custom">' + I18N.t('common.custom') + '</span>' : '<span class="mode-tag ranked">' + I18N.t('common.ranked') + '</span>'}
        <span class="dim">${m.fid}</span>
        <span>${esc(m.map || I18N.t('common.unknownMap'))}</span>
        <span class="dim">${m.endTime ? fmtTime(m.endTime) : ''}</span>
        ${m.eloDelta != null ? `<span class="dim">${fmtDelta(m.eloDelta)}</span>` : ''}
      </div>`).join('')
    : (p.recentError
      ? '<span class="loss" title="' + esc(p.recentError) + '">' + esc(I18N.t('inv.recentError')) + '</span>'
      : '<span class="dim">' + I18N.t('inv.noRecent') + '</span>');

  const enc = p.encounters || [];
  $('invEncounters').innerHTML = enc.length
    ? enc.slice(0, 50).map((e) => `
      <div class="inv-item"${e.fid && /^\d+$/.test(e.fid) ? ` data-link="${MATCH_URL(e.fid)}" title="${I18N.t('common.rightClickBatrace')}"` : ''}>
        <span class="${e.rel === 'spec' ? 'spec' : (e.won == null ? 'unk' : e.won ? 'win' : 'loss')}">${encounterRelLabel(e)}</span>
        ${e.custom === true ? '<span class="mode-tag custom">' + I18N.t('common.custom') + '</span>' : e.custom === false ? '<span class="mode-tag ranked">' + I18N.t('common.ranked') + '</span>' : ''}
        <span class="dim">${e.fid}</span>
        <span>${esc(e.map || I18N.t('common.unknownMap'))}</span>
        <span class="dim">${e.at ? fmtTime(e.at) : ''}</span>
      </div>`).join('')
    : '<span class="dim">' + I18N.t('inv.noEncounters') + '</span>';
  const nh = p.nameHistory || [];
  $('invNames').innerHTML = nh.length
    ? nh.slice(0, 20).map((n) => `
      <div class="inv-item"><b>${esc(n.name)}</b><span class="dim">${fmtTime(n.firstSeen)} → ${fmtTime(n.lastSeen)}</span></div>`).join('')
    : '<span class="dim">' + I18N.t('inv.noNames') + '</span>';
  const info = p.info;
  const snap = p.localSnapshot || null;
  let infoHtml = eloHtml;
  if (info) {
    infoHtml = eloHtml + '<br>' +
      (info.kd != null ? ` <span>K/D ${info.kd}</span>` : '') +
      (info.winRate != null ? ` <span>${I18N.t('common.winRate', { v: info.winRate })}</span>` : '') +
      (info.category ? ` <span>${I18N.t('inv.pref', { v: esc(catLabel(info.category)) })}</span>` : '') +
      (info.topUnits ? ` <span>${I18N.t('inv.fav', { v: esc(info.topUnits) })}</span>` : '');
  } else if (snap) {
    const bits = [];
    if (snap.elo != null) bits.push('ELO <span class="elo">' + Math.round(snap.elo) + '</span>');
    if (snap.winRate != null) bits.push(I18N.t('common.winRate', { v: snap.winRate }));
    if (snap.matchCount != null) bits.push(I18N.t('common.sample', { n: snap.matchCount }));
    if (snap.category) bits.push(I18N.t('inv.pref', { v: esc(catLabel(snap.category)) }));
    infoHtml = eloHtml + '<br><span class="dim">' + I18N.t('inv.localSnapshot', { t: fmtTime(snap.at) }) + '</span> ' + (bits.length ? bits.join(' ') : I18N.t('common.noneShort'));
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
  if (info) info.textContent = (d && d.lastSync) ? I18N.t('ban.lastSync', { t: fmtTime(d.lastSync), n: list.length }) : I18N.t('ban.notSynced');
  const el = $('banList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<span class="dim">' + esc(I18N.t('ban.empty')) + '</span>';
    return;
  }
  el.innerHTML = list.slice(0, 100).map((b) => `
    <div class="ban-item" data-id="${b.id}" data-name="${esc(b.name || '')}" data-link="${PLAYER_URL(b.id)}" title="${I18N.t('inv.rightClickBatrace')}">
      <b>${esc(b.name || I18N.t('common.unknown'))}</b>
      <span class="dim">ID ${esc(b.id)}</span>
      ${b.rating != null ? `<span class="dim">ELO ${Math.round(b.rating)}</span>` : ''}
      <span class="dim">${fmtTime(b.firstSeenAt)}</span>
      ${b.encountered ? '<span class="ban-tag met">' + I18N.t('ban.met') + '</span>' : ''}
    </div>`).join('');
}

// 封禁提醒对话框：遇到过的玩家被新封时弹出
function renderBanAlert(d) {
  const list = (d && d.players) || [];
  if (!list.length) return;
  const el = $('banAlertList');
  el.innerHTML = list.map((b) => `
    <div class="ban-item" data-id="${b.id}" data-name="${esc(b.name || '')}" data-link="${PLAYER_URL(b.id)}" title="${I18N.t('inv.rightClickInv')}">
      <b>${esc(b.name || I18N.t('common.unknown'))}</b>
      <span class="dim">ID ${esc(b.id)}</span>
      ${b.rating != null ? `<span class="dim">ELO ${Math.round(b.rating)}</span>` : ''}
      <span class="ban-tag met">${I18N.t('ban.met')}</span>
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
  if (rec && rec.active) bits.push(I18N.t('replay.recording') + (rec.current && rec.current.fid ? ' #' + rec.current.fid : ''));
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
  if (lab) lab.textContent = I18N.t('replay.recording') + (cur && cur.sourceId ? ' · ' + cur.sourceId : '');
}
function updateReplayFids(list, status) {
  replayFids = new Set();
  for (const it of (list || [])) if (it && it.fid) replayFids.add(String(it.fid));
  if (archiveList && archiveList.length) renderArchive(archiveList); // 刷新对局档案的 📹 标记
}

// 轻量刷新：只更新「有录像的对局 ID」集合（驱动对局档案 📹 标记），不再渲染卡片列表
async function refreshReplayFids() {
  try {
    const lr = await BA.listLocalReplays().catch(() => null);
    updateReplayFids((lr && lr.list) || []);
  } catch (e) { updateReplayFids([]); }
}
function replayTeamTag(t) {
  if (t === 0) return '<span class="r-team alpha">' + I18N.t('team.a') + '</span>';
  if (t === 1) return '<span class="r-team bravo">' + I18N.t('team.b') + '</span>';
  if (t === 100) return '<span class="r-team spec">' + I18N.t('common.spectate') + '</span>';
  const team = String(t || '').toLowerCase();
  if (team === 'alpha') return '<span class="r-team alpha">' + I18N.t('team.a') + '</span>';
  if (team === 'bravo') return '<span class="r-team bravo">' + I18N.t('team.b') + '</span>';
  if (team === 'spectators' || team === 'spec') return '<span class="r-team spec">' + I18N.t('common.spectate') + '</span>';
  return '';
}
function fmtSize(n) {
  if (n == null) return '';
  const m = n / (1024 * 1024);
  if (m >= 1) return m.toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
let replayBlobUrl = null;
function openReplayPlayer(item) {
  if (replayBlobUrl) { URL.revokeObjectURL(replayBlobUrl); replayBlobUrl = null; }
  $('replayPlayTitle').textContent = I18N.t('replay.playTitle', { fid: item.fid || '' });
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
        ${d.thumb ? `<img src="${d.thumb}" alt=""/>` : '<div class="dim">' + I18N.t('common.noThumb') + '</div>'}
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
// ---------- 录像设置弹窗（分辨率/帧数/码率/声音/保存目录） ----------
const recCore = (typeof window !== 'undefined' && window.recCore) ? window.recCore : null;
let recSaveDirCache = '';
let recOriginalDir = '';
let recOriginalCount = 0;
let recMoved = false;
function recEstimate(fps, bitrateMbps, audioOn) {
  if (recCore && recCore.estSize45) return recCore.estSize45(fps, bitrateMbps, audioOn);
  const bit = Math.min(10, Math.max(3, Math.round(Number(bitrateMbps) || 5)));
  return { mb: Math.round(bit / 8 * 2700 * 0.5), audioMb: audioOn ? 43 : 0, bps: bit };
}
function fmtMb(mb) { return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'; }
const REC_QUALITIES = [240, 360, 480, 720, 1080];
function recSnapQuality(v) {
  const n = Number(v);
  let best = 720, bd = Infinity;
  for (const q of REC_QUALITIES) { const d = Math.abs(q - n); if (d < bd) { bd = d; best = q; } }
  return best;
}
function recRangeVal(id, def, snap) {
  const el = $(id);
  if (!el) return def;
  let v = Number(el.value);
  if (snap) v = recSnapQuality(v);
  return v;
}
function recSetRange(id, val, snap) {
  const el = $(id);
  if (!el) return;
  let v = Number(val);
  if (snap) v = recSnapQuality(v);
  el.value = String(v);
}
function recSliderLabels() {
  const q = recRangeVal('recQualityRange', 720, true);
  const fps = recRangeVal('recFpsRange', 30, false);
  const bit = recRangeVal('recBitrateRange', 5, false);
  const qv = $('recQualityVal'); if (qv) qv.textContent = q + 'p';
  const fv = $('recFpsVal'); if (fv) fv.textContent = fps + ' fps';
  const bv = $('recBitrateVal'); if (bv) bv.textContent = bit + ' Mbps';
}
function updateRecEstimate() {
  recSliderLabels();
  const fps = recRangeVal('recFpsRange', 30, false);
  const bit = recRangeVal('recBitrateRange', 5, false);
  const audioOn = $('recAudio') ? $('recAudio').value !== 'off' : false;
  const est = recEstimate(fps, bit, audioOn);
  const el = $('recEstSize');
  if (el) el.textContent = I18N.t('replay.estSize', { size: fmtMb(est.mb), audio: est.audioMb ? I18N.t('replay.audioPlus', { mb: fmtMb(est.audioMb) }) : '' }) + ' · ' + I18N.t('replay.estSmaller');
  const note = $('recEstNote');
  if (note) note.textContent = I18N.t('replay.estHint');
}
async function openRecSettings() {
  const cfg = await BA.getConfig();
  const dirInfo = await BA.getReplayDirInfo().catch(() => null);
  recOriginalDir = (dirInfo && dirInfo.dir) || '';
  recOriginalCount = (dirInfo && dirInfo.count) || 0;
  recMoved = false;
  const sel = $('recDisplay');
  if (sel) {
    const list = await BA.listDisplays().catch(() => []);
    const cur = cfg.replayDisplayId || '';
    sel.innerHTML = list.map((d) => '<option value="' + esc(d.id) + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.label || d.id) + '</option>').join('');
    if (!sel.value && list.length) sel.value = list[0].id;
  }
  recSetRange('recQualityRange', cfg.replayQuality || 720, true);
  recSetRange('recFpsRange', cfg.replayFps || 30, false);
  recSetRange('recBitrateRange', cfg.replayBitrateMbps || 5, false);
  const au = $('recAudio'); if (au) au.value = cfg.replayAudio === 'off' ? 'off' : 'default';
  recSaveDirCache = cfg.replaySaveDir || '';
  const dirEl = $('recSaveDir');
  if (dirEl) dirEl.textContent = recSaveDirCache || recOriginalDir || I18N.t('replay.defaultDir');
  const msg = $('recSettingsMsg'); if (msg) msg.textContent = '';
  updateRecEstimate();
  const m = $('recSettingsModal'); if (m) m.classList.remove('hidden');
}
function closeRecSettings() {
  const m = $('recSettingsModal'); if (m) m.classList.add('hidden');
}
async function saveRecSettings() {
  const quality = recRangeVal('recQualityRange', 720, true);
  const fps = recRangeVal('recFpsRange', 30, false);
  const bitrate = recRangeVal('recBitrateRange', 5, false);
  const audio = $('recAudio') ? $('recAudio').value : 'default';
  const displayId = $('recDisplay') ? $('recDisplay').value : '';
  const newDir = recSaveDirCache || recOriginalDir;
  await BA.setConfig({ replayQuality: quality, replayFps: fps, replayBitrateMbps: bitrate, replayAudio: audio, replayDisplayId: displayId, replaySaveDir: recSaveDirCache });
  renderReplayNote({ replayQuality: quality, replayFps: fps, replayBitrateMbps: bitrate, replayAudio: audio });
  if (recOriginalDir && newDir && newDir !== recOriginalDir && recOriginalCount > 0 && !recMoved) {
    const ok = await askConfirm(I18N.t('replay.migrateConfirm', { from: recOriginalDir, to: newDir }));
    if (ok) {
      try {
        const mv = await BA.moveReplays(recOriginalDir, newDir);
        recMoved = true;
        recOriginalDir = newDir;
        recOriginalCount = 0;
        setStatus((mv && mv.ok) ? I18N.t('status.migrated', { n: (mv && mv.moved) || 0 }) : I18N.t('status.migrateFail', { msg: (mv && mv.message) || I18N.t('common.unknown') }), !!(mv && mv.ok));
      } catch (err) { setStatus(I18N.t('status.migrateFail', { msg: err.message }), false); }
    }
  }
  refreshReplayFids();
  renderReplayList();
  closeRecSettings();
  setStatus(I18N.t('status.recSettingsSaved'), true);
}
function renderReplayNote(cfg) {
  const el = $('replayNote');
  if (!el) return;
  const q = REC_QUALITIES.includes(Number(cfg.replayQuality)) ? Number(cfg.replayQuality) : 720;
  const fps = Math.min(60, Math.max(30, Math.round(Number(cfg.replayFps) || 30)));
  const bit = Math.min(10, Math.max(3, Math.round(Number(cfg.replayBitrateMbps) || 5)));
  const est = recEstimate(fps, bit, cfg.replayAudio !== 'off');
  el.textContent = I18N.t('replay.note', { q: q, fps: fps, bit: bit, est: fmtMb(est.mb) });
}

// 主界面行车记录仪卡片：按时间倒序的录像列表（播放 / 删除 / 打开位置 / 清理 30 天前）
async function renderReplayList() {
  const el = $('replayList');
  const info = $('replayListInfo');
  try {
    const r = await BA.listLocalReplays();
    const list = (r && r.list) || [];
    let total = 0;
    for (const it of list) total += it.size || 0;
    if (info) info.textContent = I18N.t('replay.listInfo', { n: list.length, size: fmtSize(total) });
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="replay-empty dim">' + esc(I18N.t('replay.empty')) + '</div>'; return; }
    el.innerHTML = list.slice(0, 100).map((it) => `
      <div class="replay-row" data-key="${esc(it.id)}" data-fid="${esc(it.fid || '')}">
        <span class="r-name">${esc(it.map || I18N.t('common.unknownMap'))}</span>
        <span class="dim">#${esc(it.fid)}</span>
        <span class="dim">${fmtTime(it.createdAt)}</span>
        <span class="dim">${fmtSize(it.size)}</span>
        <button type="button" class="btn btn-ghost r-play" data-key="${esc(it.id)}" title="${I18N.t('common.playReplay')}">${I18N.t('common.play')}</button>
        <button type="button" class="r-del" data-key="${esc(it.id)}" title="${I18N.t('common.deleteReplayRow')}">🗑</button>
      </div>`).join('');
    el.querySelectorAll('.r-play').forEach((b) => b.addEventListener('click', () => {
      const it = list.find((x) => String(x.id) === String(b.dataset.key));
      if (it) playReplayItem({ local: it, fid: it.fid, name: it.uploaderName, map: it.map });
    }));
    el.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', async () => {
      const ok = await askConfirm(I18N.t('confirm.deleteReplay'));
      if (!ok) return;
      try {
        await BA.deleteLocalReplay(b.dataset.key);
        setStatus(I18N.t('status.deleted'), true);
        renderReplayList();
        refreshReplayFids();
      } catch (e) { setStatus(I18N.t('status.deleteFailed', { msg: e.message }), false); }
    }));
  } catch (e) {
    if (el) el.innerHTML = '<div class="replay-error">' + esc(I18N.t('replay.loadFail', { msg: e.message })) + '</div>';
  }
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
    if (info) info.textContent = I18N.t('replay.countInfo', { n: list.length, size: fmtSize(total) });
    if (!el) return;
    if (!list.length) { el.innerHTML = '<span class="dim">' + esc(I18N.t('replay.emptyLocal')) + '</span>'; return; }
    el.innerHTML = list.slice(0, 100).map((it) => `
      <div class="inv-item local-replay-item">
        <span class="dim">${esc(it.fid)}</span>
        <span>${esc(it.map || I18N.t('common.unknownMap'))}</span>
        <span class="dim">${fmtTime(it.createdAt)}</span>
        <span class="dim">${fmtSize(it.size)}</span>
        <button class="r-del" data-key="${esc(it.id)}" title="${I18N.t('common.deleteLocalReplay')}">🗑</button>
      </div>`).join('');
    el.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', async () => {
      const ok = await askConfirm(I18N.t('replay.deleteConfirm'));
      if (!ok) return;
      try {
        const r = await BA.deleteLocalReplay(b.dataset.key);
        $('localReplayResult').textContent = (r && r.message) || I18N.t('common.deleted');
        refreshLocalReplayList();
        refreshReplayFids();
        renderReplayList();
      } catch (e) { $('localReplayResult').textContent = I18N.t('status.deleteFailed', { msg: e.message }); }
    }));
  } catch (e) {
    if (el) el.innerHTML = '<span class="dim">' + esc(I18N.t('replay.loadFail', { msg: e.message })) + '</span>';
  }
}

// 封禁区：切换「我遇到过的作弊者」视图
let banView = 'all';
async function toggleBanCheaters() {
  const btn = $('btnBanCheaters');
  if (banView === 'all') {
    banView = 'met';
    if (btn) btn.textContent = I18N.t('ban.allBtn');
    const r = await BA.getCheaters();
    renderCheaters((r && r.list) || []);
  } else {
    banView = 'all';
    if (btn) btn.textContent = I18N.t('ban.cheatersBtn');
    BA.getBans().then(renderBans).catch(() => {});
  }
}
function renderCheaters(list) {
  const el = $('banList');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<span class="dim">' + esc(I18N.t('ban.noCheaters')) + '</span>'; return; }
  el.innerHTML = list.map((c) => `
    <div class="ban-item" data-id="${c.id}" data-name="${esc(c.name || '')}" data-link="${PLAYER_URL(c.id)}" data-matches="${encodeURIComponent(JSON.stringify(c.matches || []))}" title="${I18N.t('ban.rowTitle')}">
      <b>${esc(c.name || I18N.t('common.unknown'))}</b>
      <span class="dim">ID ${esc(c.id)}</span>
      ${c.rating != null ? `<span class="dim">ELO ${Math.round(c.rating)}</span>` : ''}
      <span class="ban-tag met">${I18N.t('ban.metN', { n: c.matchCount || 0 })}</span>
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
          <div class="cheater-match" data-link="${MATCH_URL(m.fid)}" title="${I18N.t('common.rightClickBatrace')}">
            <span class="${m.localWon == null ? 'unk' : m.localWon ? 'win' : 'loss'}">${m.localWon == null ? (m.custom ? I18N.t('common.custom') : I18N.t('common.unknown')) : m.localWon ? I18N.t('common.win') : I18N.t('common.loss')}</span>
            <span>${esc(m.map || I18N.t('common.unknownMap'))}</span>
            <span class="dim">${fmtTime(m.endTime)}</span>
            <span class="dim">${m.fid}</span>
          </div>`).join('')
        : '<span class="dim">' + I18N.t('ban.noMatches') + '</span>';
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
    if (!list.length) { el.innerHTML = '<span class="dim">' + esc(I18N.t('account.none')) + '</span>'; return; }
    el.innerHTML = list.map((a) =>
      '<div class="account-item">' +
      '<b>' + esc(a.persona || a.name || I18N.t('account.name', { id: a.id })) + '</b>' +
      '<span class="dim">ID ' + esc(a.id) + '</span>' +
      '<span class="dim">' + I18N.t('account.matchesN', { n: a.matchCount }) + '</span>' +
      '<button class="btn btn-danger btn-xs" data-del="' + esc(a.id) + '">' + I18N.t('account.delete') + '</button>' +
      '</div>').join('');
    el.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        const ok = await askConfirm(I18N.t('account.confirmDelete', { id: id }));
        if (!ok) return;
        try {
          const r = await BA.deleteAccount(id);
          setStatus((r && r.message) || I18N.t('common.deleted'), !!(r && r.ok));
          refreshAccountList();
        } catch (e) { setStatus(I18N.t('account.deleteFail', { msg: e.message }), false); }
      });
    });
  } catch (e) {
    el.innerHTML = '<span class="dim">' + esc(I18N.t('account.loadFail', { msg: e.message })) + '</span>';
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
  setMaggotProgress(I18N.t('maggot.progressText'), 0);
  try {
    const r = await BA.maggotReport(stbid);
    if (r.error) { area.innerHTML = `<div class="loss">${esc(r.error)}</div>`; return; }
    renderMaggot(r, name);
  } catch (e) {
    area.innerHTML = `<div class="loss">${esc(I18N.t('maggot.fail', { msg: e.message }))}</div>`;
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
  const trendMap = { up: I18N.t('maggot.trendUp'), down: I18N.t('maggot.trendDown'), flat: I18N.t('maggot.trendFlat') };
  const color = r.color === 'green' ? '#4ade80' : r.color === 'yellow' ? '#facc15' : '#f87171';
  const pct = r.maggotIndex != null ? Math.max(0, Math.min(100, ((r.maggotIndex - 1) / 9) * 100)) : 50;
  const rows = (r.rows || []).map((m) => `
    <tr>
      <td class="${m.win ? 'win' : 'loss'}">${m.win ? I18N.t('common.win') : I18N.t('common.loss')}</td>
      <td class="dim" data-link="${MATCH_URL(m.matchId)}" title="${I18N.t('common.rightClickBatrace')}">${esc(m.matchId ?? '-')}</td>
      <td>#${m.myRank}</td>
      <td>#${m.kRank}</td>
      <td>#${m.oRank}</td>
      <td>#${m.kdRank}</td>
      <td>#${m.lossRank}</td>
      <td>${fmtDelta(m.eloDelta)}</td>
    </tr>`).join('');
  $('maggotCalls').textContent = I18N.t('maggot.calls', { n: r.calls });
  $('maggotArea').innerHTML = `
    <div class="maggot-panel">
      <div class="mg-head">
        <div class="mg-score">
          <span class="mg-num" style="color:${color}">${r.maggotIndex}</span>
          <span class="mg-label" style="border-color:${color};color:${color}">${esc(r.label)}</span>
          <span class="mg-trend">${trendMap[r.trend] || ''}</span>
        </div>
        <div class="mg-meta">
          <span class="mg-name" data-link="${PLAYER_URL(r.stbid)}" title="${I18N.t('common.rightClickBatrace')}">${esc(name || r.stbid)}</span>
          <span class="dim">${I18N.t('maggot.avgRank', { rank: r.avgRank })}</span>
        </div>
      </div>
      <div class="mg-meter">
        <div class="mg-track" style="position:relative"><div class="mg-ind" style="left:${pct}%;transform:translateX(-50%)"></div></div>
        <div class="mg-scale"><span>${I18N.t('maggot.scaleGod')}</span><span>${I18N.t('maggot.scaleMaggot')}</span></div>
      </div>
      <div class="mg-refs">
        <div class="item"><b>#${r.refs.kdr}</b><span>${I18N.t('maggot.avgKdr')}</span></div>
        <div class="item"><b>#${r.refs.kr}</b><span>${I18N.t('maggot.avgKr')}</span></div>
        <div class="item"><b>#${r.refs.dr}</b><span>${I18N.t('maggot.avgDr')}</span></div>
        <div class="item"><b>#${r.refs.or}</b><span>${I18N.t('maggot.avgOr')}</span></div>
        <div class="item"><b>${r.refs.wr}%</b><span>${I18N.t('maggot.wr12')}</span></div>
      </div>
      <table class="matches">
        <thead><tr><th>${I18N.t('maggot.thResult')}</th><th>${I18N.t('maggot.thFid')}</th><th>${I18N.t('maggot.thRank')}</th><th>${I18N.t('maggot.thKills')}</th><th>${I18N.t('maggot.thMvp')}</th><th>${I18N.t('maggot.thKd')}</th><th>${I18N.t('maggot.thLosses')}</th><th>${I18N.t('maggot.thElo')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="dim note">${esc(I18N.t('maggot.algorithm'))}</div>
    </div>`;
}

// ---------- 版本提醒 ----------
// 开发者隐秘提示：BATrace 专属 bypass 状态（设置 → 开发者测试区）
function renderBypassHint(s) {
  const el = $('bypassHint');
  if (!el) return;
  if (s && s.enabled) {
    el.textContent = I18N.t('dev.bypassOn', { ms: s.delayMs || 300 });
    el.style.color = '#4ade80';
  } else {
    el.textContent = I18N.t('dev.bypassOff');
    el.style.color = '';
  }
}
function renderVersion(v) {
  if (!v) return;
  lastVersionInfo = v;
  const av = $('aboutVer');
  if (av) av.textContent = I18N.t('version.current', { v: v.current });
  const verEl = $('ver');
  if (verEl && v.current) verEl.textContent = 'v' + v.current;
  const banner = $('updateBanner');
  if (v.hasUpdate) {
    $('updateText').textContent = I18N.t('version.new', { v: v.latest }) + (v.announcement ? '：' + v.announcement : '');
    if (banner) banner.classList.remove('hidden');
  }
  const info = $('updateInfo');
  if (info) {
    info.innerHTML = `<p class="dim">${v.hasUpdate ? I18N.t('version.latestNew', { v: esc(v.latest) }) : I18N.t('version.latest', { v: esc(v.latest) })}${v.announcement ? I18N.t('version.announcement', { a: esc(v.announcement) }) : ''}｜<a href="#" class="link" id="linkVersion">${I18N.t('version.github')}</a></p>`;
    const lv = $('linkVersion');
    if (lv) lv.addEventListener('click', (e) => { e.preventDefault(); openLink(GITHUB_URL); });
  }
}

function bindUI() {
  on('btnGame', 'click', () => { if (window.BAGame) BAGame.open(); });
  on('btnSettings', 'click', openSettings);
  on('btnApmToggle', 'click', () => setApmCollapsed(!$('apmCard').classList.contains('collapsed')));
  on('btnDeckToggle', 'click', () => setDeckCollapsed(!$('deckCard').classList.contains('collapsed')));
  on('btnAddMatch', 'click', addMatchByFid);
  on('addMatchFid', 'keydown', (e) => { if (e.key === 'Enter') addMatchByFid(); });
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
    el.textContent = I18N.t('dev.testing');
    try {
      const r = await BA.pingHeartbeat(url);
      if (!r) { el.textContent = I18N.t('dev.heartbeatNotInit'); return; }
      if (r.ok && r.stats) el.textContent = I18N.t('dev.heartbeatOk', { t: r.lastPing, n: r.stats.online });
      else el.textContent = '❌ ' + (r.lastError || I18N.t('dev.heartbeatFail'));
    } catch (e) {
      el.textContent = I18N.t('dev.testFail', { msg: e.message });
    }
  });
  on('btnDetect', 'click', async () => {
    const dir = await BA.detectDir();
    if (dir) { $('setLogDir').value = dir; $('dirHint').textContent = I18N.t('dev.dirDetected', { dir: dir }); }
    else $('dirHint').textContent = I18N.t('dev.dirNotFound');
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
    if (!lastReport) { setStatus(I18N.t('dev.needSearchFirst'), false); return; }
    runMaggot(lastReport.id, lastReport.name);
  });
  on('btnUpdateClose', 'click', () => $('updateBanner').classList.add('hidden'));
  on('btnBatraceGateClose', 'click', () => { const b = $('batraceGateBanner'); if (b) b.classList.add('hidden'); });
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
      const offlineNote = data.offline ? '<div class="dim">' + esc(I18N.t('dev.offlineNote')) + '</div>' : '';
      $('searchResults').innerHTML = offlineNote + (list.length
        ? list.map((p) => `<span class="chip" data-id="${p.id}" data-name="${esc(p.name)}" data-link="${PLAYER_URL(p.id)}">${esc(p.name)}<span class="s-id">ID ${esc(p.id)}</span><span class="s-lv">Lv.${p.level ?? '?'}</span><span class="s-elo">${p.rating != null ? Math.round(p.rating) : '?'}</span></span>`).join('')
        : (data.offline ? '<span class="dim">' + I18N.t('dev.noLocalMatch') + '</span>' : '<span class="dim">' + I18N.t('dev.notFound') + '</span>'));
      document.querySelectorAll('.chip').forEach((el) => {
        el.addEventListener('click', () => loadReport(el.dataset.id, el.dataset.name));
      });
    } catch (e) {
      $('searchResults').innerHTML = '<span class="loss">' + esc(I18N.t('dev.searchFail', { msg: e.message })) + '</span>';
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
  on('btnInvRefresh', 'click', () => { if (invId) { $('invInfo').textContent = I18N.t('loading.detail'); loadInvestigate(invId); } });
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
    setStatus(I18N.t('dev.banNotifySoon'), true);
    setTimeout(async () => {
      const r = await BA.testBanNotify();
      setStatus((r && r.message) || I18N.t('dev.simFail'), !!(r && r.ok));
    }, 3000);
  });
  on('btnTestMatchSync', 'click', async () => { const r = await BA.syncMyMatchesNow(); $('testResult').textContent = (r && r.message) || I18N.t('dev.unknown'); });
  on('btnTestBanSync', 'click', async () => { const r = await BA.syncBans(); $('testResult').textContent = (r && r.newly != null) ? I18N.t('dev.banCheckDoneN', { n: r.newly }) : I18N.t('dev.banCheckDone'); });
  on('btnTestVersion', 'click', async () => { const r = await BA.testVersionUpdate(); $('testResult').textContent = (r && r.message) || I18N.t('dev.unknown'); });
  on('btnTestRecord', 'click', async () => {
    $('testResult').textContent = I18N.t('dev.recTestStart');
    const r = await BA.testRecord();
    if (!r || !r.ok) { $('testResult').textContent = I18N.t('dev.recTestFail', { msg: (r && r.message) || I18N.t('dev.unknown') }); return; }
  });

  // 卡组工具
  on('btnDeckRefresh', 'click', refreshDecks);
  on('btnDeckBackup', 'click', doBackup);
  on('btnDeckBackupAll', 'click', doBackupAll);
  on('btnBackupOk', 'click', confirmBackup);
  on('btnBackupCancel', 'click', () => { backupAllPending = false; $('backupRow').classList.add('hidden'); });
  on('btnDeckDeploy', 'click', doDeploy);
  on('btnDeckDelFront', 'click', () => doDelete('decks', I18N.t('deck.decks')));
  on('btnDeckDelBack', 'click', () => doDelete('backups', I18N.t('deck.backups')));
  on('btnSyncRestore', 'click', doSyncRestore);
  on('btnSyncIgnore', 'click', doSyncIgnore);
  on('btnSyncDismiss', 'click', dismissSyncAlert);
  on('btnOpenFront', 'click', () => BA.openDeckFolder('decks'));
  on('btnOpenBack', 'click', () => BA.openDeckFolder('backups'));
  enableToggleSelect($('deckFront'));
  enableToggleSelect($('deckBack'));

  // 对局录像
  on('setReplayEnabled', 'change', async () => {
    const el = $('setReplayEnabled');
    if (el && el.checked) {
      const ok = await askConfirm(I18N.t('replay.enableConfirm'));
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
    if (el && el.checked) refreshReplayFids();
  });
  on('btnRecSettings', 'click', openRecSettings);
  on('btnRecSettingsClose', 'click', closeRecSettings);
  on('btnRecSettingsCancel', 'click', closeRecSettings);
  on('btnRecSettingsSave', 'click', saveRecSettings);
  on('btnRecDisplayRefresh', 'click', async () => {
    const sel = $('recDisplay');
    if (!sel) return;
    const cur = sel.value;
    const list = await BA.listDisplays().catch(() => []);
    sel.innerHTML = list.map((d) => '<option value="' + esc(d.id) + '">' + esc(d.label || d.id) + '</option>').join('');
    if (cur) sel.value = cur;
    if (!sel.value && list.length) sel.value = list[0].id;
  });
  ['recQualityRange', 'recFpsRange', 'recBitrateRange'].forEach((rid) => {
    on(rid, 'input', () => { updateRecEstimate(); });
  });
  on('recAudio', 'change', updateRecEstimate);
  on('btnRecSaveDir', 'click', async () => {
    const r = await BA.selectReplaySaveDir();
    if (!r || !r.ok || !r.dir) return;
    recSaveDirCache = r.dir;
    const dirEl = $('recSaveDir');
    if (dirEl) dirEl.textContent = recSaveDirCache;
    const msg = $('recSettingsMsg');
    if (msg) msg.textContent = recOriginalDir && recOriginalDir !== recSaveDirCache && recOriginalCount > 0 ? I18N.t('replay.newDirHint') : '';
  });
  on('btnRecMigrate', 'click', async () => {
    let newDir = recSaveDirCache || '';
    if (!newDir || newDir === recOriginalDir) {
      const pick = await askConfirm(I18N.t('replay.pickDirConfirm'));
      if (!pick) return;
      const r = await BA.selectReplaySaveDir();
      if (!r || !r.ok || !r.dir) return;
      recSaveDirCache = r.dir;
      newDir = r.dir;
      const dirEl = $('recSaveDir'); if (dirEl) dirEl.textContent = recSaveDirCache;
    }
    if (!recOriginalDir || newDir === recOriginalDir) {
      const msg = $('recSettingsMsg'); if (msg) msg.textContent = I18N.t('replay.noMigrate');
      return;
    }
    const ok = await askConfirm(I18N.t('replay.migrateConfirm', { from: recOriginalDir, to: newDir }));
    if (!ok) return;
    try {
      const mv = await BA.moveReplays(recOriginalDir, newDir);
      if (mv && mv.ok) { recMoved = true; recOriginalCount = 0; }
      const msg = $('recSettingsMsg');
      if (msg) msg.textContent = (mv && mv.ok) ? I18N.t('replay.migratedNFile', { n: (mv && mv.moved) || 0 }) : I18N.t('replay.migrateFail', { msg: (mv && mv.message) || I18N.t('common.unknown') });
    } catch (err) {
      const msg = $('recSettingsMsg'); if (msg) msg.textContent = I18N.t('replay.migrateFail', { msg: err.message });
    }
  });
  on('btnRecOpenSaveDir', 'click', () => { BA.openLocalReplayFolder(); });
  on('btnReplayOpenFolder', 'click', () => { BA.openLocalReplayFolder(); });
  on('btnReplayClean30', 'click', async () => {
    const ok = await askConfirm(I18N.t('replay.clean30Confirm'));
    if (!ok) return;
    try {
      const r = await BA.cleanLocalReplays(30);
      setStatus(I18N.t('status.deletedN', { n: (r && r.removed) || 0 }), true);
      renderReplayList();
      refreshReplayFids();
    } catch (e) { setStatus(I18N.t('status.deleteFailed', { msg: e.message }), false); }
  });
  on('btnDisplayPickClose', 'click', () => { $('displayPickerModal').classList.add('hidden'); if (displayPickResolve) { displayPickResolve(null); displayPickResolve = null; } });
  on('btnReplayClose', 'click', closeReplayPlayer);
  on('btnReplayPickerClose', 'click', () => { $('replayPickerModal').classList.add('hidden'); if (replayPickResolve) { replayPickResolve(null); replayPickResolve = null; } });
  on('btnLocalClean30', 'click', async () => {
    const ok = await askConfirm(I18N.t('replay.clean30LocalConfirm'));
    if (!ok) return;
    try {
      const r = await BA.cleanLocalReplays(30);
      $('localReplayResult').textContent = I18N.t('status.deletedNLocal', { n: (r && r.removed) || 0 });
      refreshLocalReplayList();
      refreshReplayFids();
    } catch (e) { $('localReplayResult').textContent = I18N.t('status.deleteFailed', { msg: e.message }); }
  });
  on('btnOpenLocalReplay', 'click', () => { BA.openLocalReplayFolder(); });
  on('btnLocalCleanAll', 'click', async () => {
    const ok = await askConfirm(I18N.t('replay.deleteAllConfirm'));
    if (!ok) return;
    try {
      const r = await BA.cleanLocalReplays(0);
      $('localReplayResult').textContent = I18N.t('status.deletedAllLocal', { n: (r && r.removed) || 0 });
      refreshLocalReplayList();
      refreshReplayFids();
    } catch (e) { $('localReplayResult').textContent = I18N.t('status.deleteFailed', { msg: e.message }); }
  });
}


// ---------- 首页面板次序 ----------
const PANELS = [
  { key: 'current', id: 'currentCard', label: () => I18N.t('card.current') },
  { key: 'deck', id: 'deckCard', label: () => I18N.t('card.deck') },
  { key: 'maggot', id: 'maggotCard', label: () => I18N.t('card.maggot') },
  { key: 'ban', id: 'banCard', label: () => I18N.t('card.ban') },
  { key: 'archive', id: 'archiveSplit', label: () => I18N.t('card.archive') + ' / ' + I18N.t('card.replay') },
  { key: 'about', id: 'aboutCard', label: () => I18N.t('card.about') }
];
const PANEL_KEYS = PANELS.map((p) => p.key);
let panelOrder = []; // 当前生效顺序（空 = 默认 DOM 顺序）

function normPanelOrder(order) {
  if (!Array.isArray(order)) return [];
  const uniq = order.filter((k) => PANEL_KEYS.includes(k)).filter((k, i, a) => a.indexOf(k) === i);
  for (const k of PANEL_KEYS) if (!uniq.includes(k)) uniq.push(k); // 补齐缺失面板
  return uniq;
}
function applyPanelOrder(order) {
  panelOrder = normPanelOrder(order || []);
  const main = document.querySelector('main');
  if (!main || !panelOrder.length) return;
  for (const k of panelOrder) {
    const p = PANELS.find((x) => x.key === k);
    if (!p) continue;
    const el = $(p.id);
    if (el && el.parentNode === main) main.appendChild(el);
  }
}
function renderPanelOrderList() {
  const list = $('panelOrderList');
  if (!list) return;
  const order = normPanelOrder(panelOrder.length ? panelOrder : PANEL_KEYS);
  list.innerHTML = order.map((k, i) => {
    const p = PANELS.find((x) => x.key === k);
    return `<div class="panel-order-row" data-key="${k}">
      <span class="pn-label">${esc(p ? p.label() : k)}</span>
      <button type="button" class="btn btn-ghost btn-xs" data-move="up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-ghost btn-xs" data-move="down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.panel-order-row').forEach((row) => {
    const move = (dir) => {
      const cur = normPanelOrder(panelOrder.length ? panelOrder : PANEL_KEYS);
      const idx = cur.indexOf(row.dataset.key);
      const j = dir === 'up' ? idx - 1 : idx + 1;
      if (idx < 0 || j < 0 || j >= cur.length) return;
      const t = cur[idx]; cur[idx] = cur[j]; cur[j] = t;
      panelOrder = cur;
      renderPanelOrderList();
    };
    const up = row.querySelector('[data-move="up"]');
    const down = row.querySelector('[data-move="down"]');
    if (up) up.addEventListener('click', () => move('up'));
    if (down) down.addEventListener('click', () => move('down'));
  });
}

async function saveSettings() {
  const dir = $('setLogDir').value.trim();
  const v = await BA.validateDir(dir);
  if (!v.ok) { $('dirHint').textContent = I18N.t('dev.dirInvalid', { reason: v.reason || '' }); return; }
  await BA.setConfig({
    logDir: dir,
    autoQueryCurrentMatch: $('setAuto').checked,
    inputHookEnabled: $('setInputHook').checked,
    banPollEnabled: $('setBanPoll').checked,
    matchSyncEnabled: $('setMatchSync').checked,
    banCardVisible: $('setBanCard').checked,
    multiAccountBond: $('setMultiBond').checked,
    theme: currentTheme,
    panelOrder: normPanelOrder(panelOrder.length ? panelOrder : PANEL_KEYS)
  });
  savedTheme = currentTheme;
  setApmVisible($('setInputHook').checked);
  setBanCardVisible($('setBanCard').checked);
  applyTheme(currentTheme);
  $('settingsModal').classList.add('hidden');
  setStatus(I18N.t('status.listening'), true);
  $('fileText').textContent = dir;
}

// ---------- 主流程 ----------
// 语言切换：静态 data-i18n 由 I18N.setLang 处理；这里重渲染依赖 JS 的核心动态文案
function applyLangUI() {
  if (archiveList && archiveList.length) renderArchive(archiveList);
  renderReplayList();
  if (lastVersionInfo) renderVersion(lastVersionInfo);
  if (lastHeartbeat) renderHeartbeat(lastHeartbeat);
  if (currentCfg) renderReplayNote(currentCfg);
  const st = $('statusText');
  if (st && st.dataset.i18n) st.textContent = I18N.t(st.dataset.i18n);
}

// 页眉四语言按钮（中文 / English / 日本語 / Русский）
function bindLangButtons() {
  const pairs = [['langEn', 'en'], ['langZh', 'zh'], ['langJa', 'ja'], ['langRu', 'ru']];
  const cur = I18N.lang || 'zh';
  for (const [id, lg] of pairs) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.classList.toggle('active', cur === lg);
    b.addEventListener('click', async () => {
      I18N.setLang(lg);
      for (const [id2, lg2] of pairs) {
        const bb = document.getElementById(id2);
        if (bb) bb.classList.toggle('active', lg === lg2);
      }
      try { await BA.setConfig({ lang: lg }); } catch (e) {}
    });
  }
}

async function init() {
  const cfg = await BA.getConfig();
  savedTheme = cfg.theme || 'dark';
  applyTheme(savedTheme);
  currentCfg = cfg;
  I18N.setLang(cfg.lang || 'zh');
  bindLangButtons();
  I18N.onChange(applyLangUI);
  setApmVisible(!!cfg.inputHookEnabled);
  setBanCardVisible(!!cfg.banCardVisible);
  applyPanelOrder(cfg.panelOrder);
  const repSw = $('setReplayEnabled'); if (repSw) repSw.checked = !!cfg.replayEnabled;
  refreshReplayFids();
  renderReplayList();
  if (cfg.logDir) {
    const v = await BA.validateDir(cfg.logDir);
    setStatus(v.ok ? I18N.t('status.listening') : I18N.t('status.dirInvalid') + '：' + (v.reason || ''), v.ok);
    if (v.ok) $('fileText').textContent = cfg.logDir;
  } else {
    setStatus(I18N.t('status.noDir'), false);
  }

  const st = await BA.getWatcherStatus();
  if (st.file) $('fileText').textContent = st.file;

  renderSession(await BA.getSession());
  { const mm = await BA.getTrackerMatches(); renderArchive(mm && mm.list); }
  refreshDecks();

  BA.onSession((d) => renderSession(d));
  BA.onWatcher((d) => {
    if (d.file) $('fileText').textContent = d.file;
    if (!d.file) setStatus(I18N.t('status.noLogFile'), false);
  });
  BA.onMatchQuerying((d) => {
    if (d.prev) {
      prevRows = {};
      for (const p of d.players) prevRows[p.id] = { ...p, status: 'loading' };
      renderPrevGrid();
      $('queryStatus').textContent = I18N.t('match.queryPrev', { n: d.players.length });
      return;
    }
    resetPrevIfViewing();
    matchRows = {};
    for (const p of d.players) matchRows[p.id] = { ...p, status: 'loading' };
    renderMatchGrid();
    $('queryStatus').textContent = I18N.t('match.querying', { n: d.players.length });
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
      $('queryStatus').textContent = I18N.t('match.prevDone', { n: done });
      return;
    }
    const done = Object.values(matchRows).filter((r) => r.status === 'done').length;
    $('queryStatus').textContent = I18N.t('match.queryDone', { n: done, ctx: d.fid ? I18N.t('match.id', { id: d.fid }) : I18N.t('match.room') });
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
  // BATrace 人机验证横幅：弹出验证窗口/完成/取消时提示
  if (BA.onBatraceGate) BA.onBatraceGate((state) => {
    const b = $('batraceGateBanner');
    if (!b) return;
    const txt = $('batraceGateText');
    if (state === 'open') {
      txt.textContent = I18N.t('status.batraceVerifyOpen');
      b.classList.remove('hidden');
    } else if (state === 'done') {
      txt.textContent = I18N.t('status.batraceVerifyDone');
      b.classList.remove('hidden');
      setTimeout(() => b.classList.add('hidden'), 4000);
    } else {
      txt.textContent = I18N.t('status.batraceVerifyCancel');
      b.classList.remove('hidden');
      setTimeout(() => b.classList.add('hidden'), 6000);
    }
  });
  BA.onHeartbeat(renderHeartbeat);
  BA.getHeartbeat().then(renderHeartbeat).catch(() => {});
  BA.onApiHealth(renderApiHealth);
  BA.getApiHealth().then(renderApiHealth).catch(() => {});
  BA.getBans().then(renderBans).catch(() => {});
  BA.onBansChanged((d) => { if (banView === 'met') { banView = 'all'; const btn = $('btnBanCheaters'); if (btn) btn.textContent = I18N.t('ban.cheatersBtn'); } renderBans(d && d.list); });
  BA.onBanAlert(renderBanAlert);
  BA.onTestResult((d) => {
    if (!d) return;
    const el = $('testResult');
    if (!el) return;
    if (d.ok) { el.textContent = I18N.t('status.recTestDone', { file: d.file, size: fmtSize(d.size) }); refreshLocalReplayList(); renderReplayList(); }
    else { el.textContent = I18N.t('status.recTestFailed', { msg: d.error || I18N.t('common.unknown') }); }
  });
  BA.onRoomToolUsers((ids) => { toolUserIds = new Set((ids || []).map(String)); const cur = session && session.current; if (cur) renderMatchGrid(); else renderMatchGrid(); });
  BA.onReplayRecording((d) => {
    replayRecordingActive = !!(d && d.active && !d.error);
    if (d && d.error) { const el = $('replayStatus'); if (el) { el.textContent = I18N.t('replay.recError', { msg: d.error }); el.title = I18N.t('replay.recErrorDetail'); } setReplayPreview(false); return; }
    renderReplayStatus(d);
    if (d && d.active) {
      const cur = d.current || null;
      const lab = $('replayPreviewLabel');
      if (lab) lab.textContent = I18N.t('replay.recording') + (cur && cur.sourceId ? ' · ' + cur.sourceId : '');
    } else {
      setReplayPreview(false);
    }
  });
  BA.onReplayProgress(() => { BA.getReplayStatus().then(renderReplayStatus).catch(() => {}); });
  BA.onReplayChanged(() => { BA.getReplayStatus().then(renderReplayStatus).catch(() => {}); refreshReplayFids(); renderReplayList(); });
  // 预览帧持续更新图片；只有确实在录制时才显示（防止停止后残留帧把它重新点亮）
  BA.onReplayPreview((d) => {
    const img = $('replayPreviewImg');
    if (!img || !d || !d.dataUrl) return;
    img.src = d.dataUrl;
    setReplayPreview(replayRecordingActive);
    const au = $('replayPreviewAudio');
    if (au) au.textContent = d.hasAudio ? I18N.t('replay.audioOn') : I18N.t('replay.audioOff');
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
    setMaggotProgress(I18N.t('maggot.progress', { done: d.done, total: d.total, scanned: d.scanned, of: d.of }), pct);
  });
  BA.getVersion().then(renderVersion).catch(() => {});
  BA.onVersion(renderVersion);
  BA.onBypassState(renderBypassHint);
  BA.onAnnouncement((d) => { if (d && d.text) { const el = $('announcementText'); if (el) el.textContent = d.text; $('announcementModal').classList.remove('hidden'); } });
}

// 兜底：任何异步错误都显示出来，而不是“点了没反应”
window.addEventListener('error', (e) => setStatus(I18N.t('status.scriptError', { msg: e.message || I18N.t('dev.unknown') }), false));
window.addEventListener('unhandledrejection', (e) => setStatus(I18N.t('status.asyncError', { msg: (e.reason && e.reason.message) || e.reason || I18N.t('dev.unknown') }), false));

bindUI();
init().catch((e) => setStatus(I18N.t('status.initFail', { msg: e.message || e }), false));

