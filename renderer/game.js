// ================= 防空小游戏 v4（独立入口：顶栏「🎮 小游戏」） =================
// 操作：Z 开关雷达（开机需 0.5s 延迟）；右键移动防空阵地（移动强制关机，到位后按 Z 重新开机）
// 导弹：只管发射，雷达每帧把导弹引导到不同目标；原目标死了自动换目标；关雷达后导弹失去制导乱飞消失
// 升级：击杀累计（每 8 架）触发三选一升级；各类强化有上限，防止战力无限膨胀
// 敌机：普通(2血/+10) / SEAD(2血/+15，开雷达时射导弹，关雷达其导弹失锁乱飞) / 干扰机(2血/+20，在场时射速变慢) / B2隐身(3血/+30)
// 炮击：固定间隔轰炸阵地当前位置（4 秒预警圈）；防空无血量，被命中即结算（密集阵可挡一次）
(function () {
  const $ = (id) => document.getElementById(id);
  let canvas = null, ctx = null, W = 0, H = 0, raf = 0;
  let running = false;
  let state = null;

  function freshState() {
    return {
      on: true, spinup: 0, spinupBase: 0.5, score: 0, t: 0, last: 0,
      x: 0, targetX: 0, moving: false, moveSpeed: 260,
      fireCd: 1.6, fireTimer: 0, volley: 1, range: 260,
      guide: 0, splash: 0, ciws: 0,
      kills: { normal: 0, sead: 0, jam: 0, b2: 0, total: 0 },
      nextUpgradeAt: 8,
      upgradeCount: 0,
      normTimer: 1.8, seadTimer: 6, jamTimer: 15, b2Timer: 26, artTimer: 14,
      planes: [], bullets: [], seadMissiles: [], arties: [],
      upgradePending: false, over: false
    };
  }

  function open() {
    const modal = $('gameModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    canvas = $('gameCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.round(rect.width));
    canvas.height = Math.max(220, Math.round(rect.height));
    ctx = canvas.getContext('2d');
    W = canvas.width; H = canvas.height;
    state = freshState();
    state.x = state.targetX = W / 2;
    running = true;
    $('gameUpgrade').classList.add('hidden');
    $('gameOver').classList.add('hidden');
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('mousedown', onMouse);
    state.last = performance.now();
    raf = requestAnimationFrame(loop);
    renderHud();
  }

  function close() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    if (canvas) { canvas.removeEventListener('contextmenu', onCtx); canvas.removeEventListener('mousedown', onMouse); }
    const modal = $('gameModal');
    if (modal) modal.classList.add('hidden');
  }

  function onKey(e) {
    if (!running || !e.key) return;
    if (e.key.toLowerCase() === 'z') {
      if (state.moving) return;
      if (state.on) { state.on = false; state.spinup = 0; }
      else if (state.spinup > 0) { state.spinup = 0; }
      else { state.spinup = state.spinupBase; }
      renderHud();
    }
  }
  function onCtx(e) { e.preventDefault(); if (running) moveTo(e.clientX); }
  function onMouse(e) { if (e.button === 2 && running) moveTo(e.clientX); }
  function moveTo(clientX) {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = Math.max(24, Math.min(W - 24, clientX - r.left));
    state.targetX = x; state.moving = true; state.on = false; state.spinup = 0;
    renderHud();
  }

  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - state.last) / 1000); state.last = now;
    if (!state.upgradePending && !state.over) update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function update(dt) {
    state.t += dt;
    if (state.spinup > 0) { state.spinup -= dt; if (state.spinup <= 0) { state.spinup = 0; state.on = true; } }
    if (state.moving) {
      const dx = state.targetX - state.x, step = state.moveSpeed * dt;
      if (Math.abs(dx) <= step) { state.x = state.targetX; state.moving = false; }
      else state.x += Math.sign(dx) * step;
    }
    spawn(dt);
    const jamActive = state.planes.some((p) => p.type === 'jam' && !p.gone);
    for (const p of state.planes) {
      if (p.type === 'sead' && state.on && !state.moving && Math.abs(p.x - state.x) <= state.range * 1.25 && p.y > 0) {
        p.seadCd -= dt;
        if (p.seadCd <= 0) { p.seadCd = Math.max(2.8, 3.6 - state.t * 0.003); fireSead(p); }
      }
    }
    state.fireTimer -= dt;
    const effCd = state.fireCd * (jamActive ? 1.35 : 1);
    if (state.on && !state.moving && state.fireTimer <= 0) {
      if (nearestTarget()) { fireVolley(); state.fireTimer = effCd; }
      else state.fireTimer = 0.15;
    }
    guideBullets(dt);
    for (const m of state.seadMissiles) {
      if (m.lock) {
        if (!state.on) { m.lock = false; m.fade = 1.4; m.vx = (Math.random() - 0.5) * 150; m.vy = -50 - Math.random() * 80; }
        else {
          const dx = state.x - m.x, dy = (H - 28) - m.y, d = Math.hypot(dx, dy) || 1;
          m.vx = (dx / d) * m.speed; m.vy = (dy / d) * m.speed;
        }
      }
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.fade) { m.fade -= dt; if (m.fade <= 0) m.gone = true; }
      else if (m.lock && Math.hypot(m.x - state.x, m.y - (H - 28)) < 16) {
        if (state.ciws > 0) state.ciws--;
        else { m.gone = true; gameOver(); return; }
        m.gone = true;
      }
      if (m.y > H + 40 || m.x < -40 || m.x > W + 40) m.gone = true;
    }
    state.artTimer -= dt;
    if (state.artTimer <= 0) {
      state.artTimer = Math.max(6, 14 - state.t * 0.025);
      state.arties.push({ x: state.x, warn: 4.0, impact: false, done: false });
    }
    for (const a of state.arties) {
      a.warn -= dt;
      if (a.warn <= 0 && !a.impact) {
        a.impact = true;
        if (Math.abs(state.x - a.x) < 44) {
          if (state.ciws > 0) state.ciws--;
          else { a.hit = true; gameOver(); return; }
        }
      }
      if (a.impact && a.warn <= -0.4) a.done = true;
    }
    for (const p of state.planes) { p.x += p.vx * dt; if (p.x < -70 || p.x > W + 70) p.gone = true; }
    state.planes = state.planes.filter((p) => !p.gone);
    state.bullets = state.bullets.filter((b) => !b.gone);
    state.seadMissiles = state.seadMissiles.filter((m) => !m.gone);
    state.arties = state.arties.filter((a) => !a.done);
    state.score += dt * 1;
    renderHud();
  }

  function guideBullets(dt) {
    if (state.on) {
      const chasing = new Set();
      for (const b of state.bullets) {
        if (b.gone) continue;
        let t = null, best = Infinity;
        for (const p of state.planes) {
          if (p.gone || p.y >= H - 50 || chasing.has(p)) continue;
          const d = Math.abs(p.x - b.x);
          if (d <= state.range && d < best) { t = p; best = d; }
        }
        if (!t) {
          for (const p of state.planes) {
            if (p.gone || p.y >= H - 50) continue;
            const d = Math.abs(p.x - b.x);
            if (d <= state.range && d < best) { t = p; best = d; }
          }
        }
        if (t) { chasing.add(t); b.target = t; b.lost = false; }
        else b.lost = true;
      }
    } else {
      for (const b of state.bullets) { b.lost = true; b.target = null; }
    }
    const hitR = 12 + state.guide * 5;
    for (const b of state.bullets) {
      if (b.lost) {
        if (!b.fade) b.fade = 1.2;
        b.fade -= dt;
        if (b.fade <= 0) { b.gone = true; continue; }
        b.x += b.vx * dt; b.y += b.vy * dt;
        continue;
      }
      const t = b.target;
      if (t && !t.gone) {
        const dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy) || 1;
        b.vx = (dx / d) * b.speed; b.vy = (dy / d) * b.speed;
        if (d <= b.speed * dt + hitR) {
          hit(t, 1);
          if (state.splash > 0) {
            for (const p of state.planes) {
              if (!p.gone && p !== t && Math.hypot(p.x - t.x, p.y - t.y) < 26) hit(p, 1);
            }
          }
          b.gone = true;
          continue;
        }
      } else {
        b.lost = true; b.fade = 0;
        continue;
      }
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.y < -40 || b.x < -40 || b.x > W + 40) b.gone = true;
    }
  }

  function spawn(dt) {
    state.normTimer -= dt;
    if (state.normTimer <= 0) { state.normTimer = Math.max(1.0, 2.6 - state.t * 0.005) * (0.7 + Math.random() * 0.6); spawnPlane('normal'); }
    state.seadTimer -= dt;
    if (state.seadTimer <= 0) { state.seadTimer = Math.max(4, 8 - state.t * 0.01); spawnPlane('sead'); }
    state.jamTimer -= dt;
    if (state.jamTimer <= 0) { state.jamTimer = Math.max(10, 15 - state.t * 0.01); spawnPlane('jam'); }
    state.b2Timer -= dt;
    if (state.b2Timer <= 0) { state.b2Timer = Math.max(18, 26 - state.t * 0.01); spawnPlane('b2'); }
    const alive = state.planes.filter((p) => !p.gone).length;
    if (alive < 2) state.normTimer = Math.min(state.normTimer, 0.5);
  }
  function spawnPlane(type) {
    const cap = Math.min(20, 14 + Math.floor(state.t / 90)); // 缓慢扩容
    if (state.planes.length >= cap) return;
    const fromLeft = Math.random() < 0.5;
    const y = 40 + Math.random() * (H * 0.42);
    const spdMul = 1 + Math.min(0.35, state.t * 0.002); // 速度增长更温和
    const base = type === 'normal' ? 42 + Math.random() * 22 : type === 'sead' ? 32 + Math.random() * 18 : type === 'jam' ? 46 + Math.random() * 18 : 28 + Math.random() * 14;
    const hp = type === 'b2' ? 3 : (type === 'normal' && state.t > 120) ? 3 : (type === 'jam' && state.t > 150) ? 3 : 2;
    state.planes.push({ type, hp, x: fromLeft ? -30 : W + 30, y, vx: (fromLeft ? 1 : -1) * base * spdMul, seadCd: 3.6, gone: false });
  }
  function nearestTarget() {
    let best = null, bd = Infinity;
    for (const p of state.planes) {
      if (p.gone || p.y >= H - 50) continue;
      const d = Math.abs(p.x - state.x);
      if (d <= state.range && d < bd) { best = p; bd = d; }
    }
    return best;
  }
  function fireVolley() {
    const speed = 360 + state.guide * 40;
    for (let i = 0; i < state.volley; i++) {
      state.bullets.push({ x: state.x + (i - (state.volley - 1) / 2) * 10, y: H - 36, vx: 0, vy: -speed, speed, target: null, lost: false, fade: 0, gone: false });
    }
  }
  function hit(t, dmg) {
    t.hp -= dmg;
    if (t.hp <= 0 && !t.gone) {
      t.gone = true;
      const pts = { normal: 10, sead: 15, jam: 20, b2: 30 }[t.type] || 10;
      state.score += pts;
      if (t.type === 'b2') state.score += 50;
      state.kills[t.type] = (state.kills[t.type] || 0) + 1;
      state.kills.total++;
      if (!state.upgradePending && state.kills.total >= state.nextUpgradeAt) {
        state.nextUpgradeAt += 8 + state.upgradeCount * 2;
        state.upgradeCount++;
        triggerUpgrade();
      }
    }
  }
  function fireSead(p) {
    const dx = state.x - p.x, dy = (H - 28) - p.y, d = Math.hypot(dx, dy) || 1;
    state.seadMissiles.push({ x: p.x, y: p.y + 10, vx: (dx / d) * 240, vy: (dy / d) * 240, speed: 240, lock: true, fade: 0, gone: false });
  }

  function triggerUpgrade() {
    const opts = pickUpgrades();
    if (!opts.length) { state.upgradePending = false; state.score += 100; renderHud(); return; } // 全部升满：不再卡关，加分
    state.upgradePending = true;
    const wrap = $('gameUpgradeCards');
    wrap.innerHTML = opts.map((o, i) =>
      `<div class="game-up-card" data-i="${i}"><b>${o.label}</b><span>${o.desc}</span></div>`).join('');
    wrap.querySelectorAll('.game-up-card').forEach((el) => {
      el.addEventListener('click', () => chooseUpgrade(opts[Number(el.dataset.i)]));
    });
    $('gameUpgrade').classList.remove('hidden');
  }
  function pickUpgrades() {
    const pool = [];
    if (state.fireCd > 0.55) pool.push({ id: 'fire', label: '⚡ 射速+25%', desc: '导弹冷却缩短', apply: () => { state.fireCd *= 0.75; } });
    if (state.volley < 3) pool.push({ id: 'volley', label: '🎯 齐射+1', desc: '每轮多发一枚（分散目标）', apply: () => { state.volley++; } });
    if (state.guide < 3) pool.push({ id: 'guide', label: '🚀 制导增强', desc: '导弹更快、命中判定更大', apply: () => { state.guide++; } });
    if (state.splash < 1) pool.push({ id: 'splash', label: '💣 近炸引信', desc: '命中溅射周围敌机', apply: () => { state.splash = 1; } });
    if (state.range < 400) pool.push({ id: 'range', label: '📡 射程+70', desc: '索敌距离增大', apply: () => { state.range += 70; } });
    if (state.moveSpeed < 878) pool.push({ id: 'move', label: '🚚 机动强化', desc: '阵地移速×1.5', apply: () => { state.moveSpeed *= 1.5; } });
    if (state.ciws < 3) pool.push({ id: 'ciws', label: '🛡 密集阵', desc: '挡一次致命伤害', apply: () => { state.ciws++; } });
    if (state.spinupBase > 0.1) pool.push({ id: 'quick', label: '⏱ 雷达快启', desc: '开机延迟减半', apply: () => { state.spinupBase = Math.max(0.1, state.spinupBase / 2); } });
    return pool.sort(() => Math.random() - 0.5).slice(0, 3);
  }
  function chooseUpgrade(opt) {
    opt.apply();
    state.upgradePending = false;
    $('gameUpgrade').classList.add('hidden');
    renderHud();
  }

  function gameOver() {
    if (state.over) return;
    state.over = true; running = false;
    const best = parseInt(localStorage.getItem('ba_game_best') || '0', 10) || 0;
    const sc = Math.round(state.score);
    if (sc > best) { localStorage.setItem('ba_game_best', String(sc)); }
    const k = state.kills;
    $('gameOverStats').innerHTML =
      `总击杀 <b>${k.total}</b>（普通 ${k.normal} ｜ SEAD ${k.sead} ｜ 干扰 ${k.jam} ｜ B2 ${k.b2}）<br>` +
      `坚持了 <b>${fmtTime(state.t)}</b> ｜ 本次得分 <b>${sc}</b> ｜ 历史最高 <b>${Math.max(best, sc)}</b>`;
    $('gameOver').classList.remove('hidden');
  }
  function fmtTime(t) {
    const s = Math.floor(t), m = Math.floor(s / 60);
    return m + ' 分 ' + (s % 60) + ' 秒';
  }

  function radarLabel() {
    if (state.on) return '🟢 开';
    if (state.spinup > 0) return '🟡 开机中…';
    return '🔴 关';
  }
  function renderHud() {
    const hud = $('gameHud');
    if (!hud) return;
    const jamActive = state.planes.some((p) => p.type === 'jam' && !p.gone);
    hud.innerHTML =
      `<span>雷达 <b class="${state.on ? 'hud-on' : 'hud-off'}">${radarLabel()}</b></span>` +
      `${state.ciws ? `<span>🛡 密集阵×${state.ciws}</span>` : ''}` +
      `<span>得分 <b>${Math.round(state.score)}</b></span>` +
      `<span>时间 <b>${fmtTime(state.t)}</b></span>` +
      `<span>升级 <b>${state.kills.total}/${state.nextUpgradeAt}</b></span>` +
      (jamActive ? '<span style="color:var(--warn)">📡 干扰中</span>' : '') +
      `<span>射速 <b>${state.fireCd.toFixed(1)}s/发</b> 齐射×${state.volley}${state.guide ? ' 制导' + state.guide : ''}${state.splash ? ' 近炸' : ''}</span>` +
      (state.moving ? '<span style="color:var(--warn)">🚚 移动中（到位后按 Z 开机）</span>' : '');
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#07130d'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(0, H - 4, W, 4);
    if (state.on) {
      ctx.strokeStyle = 'rgba(76,217,138,.15)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(state.x, H - 28, state.range, 0, Math.PI * 2); ctx.stroke();
    }
    for (const a of state.arties) {
      if (a.warn > 0) {
        ctx.strokeStyle = 'rgba(245,185,66,.85)'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.arc(a.x, H - 28, 44, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(245,185,66,.15)'; ctx.beginPath(); ctx.arc(a.x, H - 28, 44, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f5b942'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('⚠ 炮击 ' + Math.ceil(a.warn) + 's', a.x, H - 66);
      } else if (a.impact) {
        ctx.fillStyle = a.hit ? 'rgba(255,107,107,.5)' : 'rgba(245,185,66,.25)';
        ctx.beginPath(); ctx.arc(a.x, H - 28, 40, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(a.x, H - 28, 26, 0, Math.PI * 2); ctx.stroke();
      }
    }
    for (const p of state.planes) {
      const color = p.type === 'sead' ? '#f5b942' : p.type === 'b2' ? '#8b9bb8' : p.type === 'jam' ? '#ff9dd2' : '#b7c1cf';
      ctx.fillStyle = color;
      if (p.type === 'b2') { ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); }
      ctx.fillRect(p.x - 14, p.y - 5, 28, 9);
      ctx.fillRect(p.x - 8, p.y - 10, 5, 5);
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      if (p.type === 'sead') ctx.fillText('SEAD', p.x, p.y - 14);
      if (p.type === 'jam') ctx.fillText('JAM', p.x, p.y - 14);
      if (p.type === 'b2') ctx.fillText('B2', p.x, p.y - 14);
    }
    ctx.fillStyle = '#ff6b6b';
    for (const m of state.seadMissiles) {
      ctx.globalAlpha = m.fade ? Math.max(0.2, m.fade) : 1;
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - 4, m.y + 9); ctx.lineTo(m.x + 4, m.y + 9); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#f5b942';
    for (const b of state.bullets) {
      ctx.globalAlpha = b.lost ? Math.max(0.2, b.fade || 1) : 1;
      ctx.fillRect(b.x - 1.5, b.y - 5, 3, 10);
    }
    ctx.globalAlpha = 1;
    ctx.save();
    if (!state.on) ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#4cd98a';
    ctx.beginPath(); ctx.moveTo(state.x, H - 42); ctx.lineTo(state.x - 18, H - 16); ctx.lineTo(state.x + 18, H - 16); ctx.closePath(); ctx.fill();
    ctx.fillRect(state.x - 12, H - 14, 24, 7);
    ctx.restore();
    if (state.moving) { ctx.fillStyle = '#f5b942'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('移动中…', state.x, H - 50); }
    else if (state.spinup > 0) { ctx.fillStyle = '#f5b942'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('开机中…', state.x, H - 50); }
  }

  function bind() {
    const closeBtn = $('btnGameClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const restart = $('btnGameRestart');
    if (restart) restart.addEventListener('click', () => { $('gameOver').classList.add('hidden'); open(); });
    const overClose = $('btnGameOverClose');
    if (overClose) overClose.addEventListener('click', close);
    const modal = $('gameModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  }

  window.BAGame = { open, close, isOpen: () => running, debug: () => state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
