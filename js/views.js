/* views.js — Canvas 与面板渲染 */
(function (global) {
  'use strict';
  const RAS = global.RAS;
  const D2R = RAS.D2R, R2D = RAS.R2D;
  const COL = { ok: '#46d17d', warn: '#f5b942', bad: '#ff5d6c', blue: '#4da3ff',
    teal: '#36d6c9', purple: '#a78bfa', muted: '#8294b0', brown: '#b08a4e' };
  const STATUS_COL = { ok: COL.ok, drift: COL.warn, rfi: COL.bad, block: COL.brown, off: COL.muted };

  const ui = { cursorMs: null, tlWindow: 0, dragScan: false };

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  function azElToCanvas(az, el, cx, cy, R) {
    const zen = Math.PI / 2 - el;
    const r = R * (zen / (Math.PI / 2));
    return [cx + r * Math.sin(az), cy - r * Math.cos(az)];
  }
  function canvasToAzEl(x, y, cx, cy, R) {
    const dx = x - cx, dy = y - cy;
    const r = Math.min(R, Math.hypot(dx, dy));
    const zen = r / R * Math.PI / 2;
    const az = Math.atan2(dx, -dy);
    const azN = az < 0 ? az + Math.PI * 2 : az;
    return { az: azN, el: Math.PI / 2 - zen };
  }

  /* ---------------- 天空视图 ---------------- */
  function drawSky(s, snap) {
    const canvas = document.getElementById('skyCanvas');
    const { ctx, w, h } = setup(canvas);
    const cx = w / 2, cy = h / 2 + 6, R = Math.min(w, h) / 2 - 44;
    ctx.clearRect(0, 0, w, h);

    /* 高度圈 + 方位标注 */
    ctx.strokeStyle = '#1b2740'; ctx.fillStyle = COL.muted; ctx.font = '10px monospace';
    [90, 60, 30, 10].forEach(function (el) {
      const rr = R * (90 - el) / 90;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(el + '°', cx + 3, cy - rr - 2);
    });
    for (let k = 0; k < 8; k++) {
      const az = k * Math.PI / 4;
      const x = cx + R * Math.sin(az), y = cy - R * Math.cos(az);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      const lx = cx + (R + 14) * Math.sin(az), ly = cy - (R + 14) * Math.cos(az) + 3;
      const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      ctx.fillText(labels[k], lx - 7, ly);
    }

    /* 地形遮挡区（地平线轮廓以内即被山体遮挡） */
    ctx.beginPath();
    for (let deg = 0; deg <= 360; deg += 2) {
      const az = deg * D2R;
      const hz = RAS.horizonElDeg(az) * D2R;
      const p = azElToCanvas(az, hz, cx, cy, R);
      if (deg === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,90,50,.28)';
    ctx.strokeStyle = 'rgba(150,115,65,.7)';
    ctx.fill(); ctx.stroke();
    /* 遮挡区外环（地面） */
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.save(); ctx.clip();

    /* 扫描区域（沿最近 40 分钟轨迹画覆盖带） */
    drawScanCoverage(ctx, s, snap, cx, cy, R);

    /* 各启用天线当前指向波束（围绕扫描中心抖动） */
    snap.ants.forEach(function (a, i) {
      if (!a.enabled) return;
      const wob = 0.006 + (i % 5) * 0.0015;
      const az = snap.scan.azRad + Math.sin(snap.t / 9e5 + i) * wob;
      const el = snap.scan.elRad + Math.cos(snap.t / 1.1e6 + i * 1.7) * wob;
      const p = azElToCanvas(az, el, cx, cy, R);
      const rr = R * (0.35 * D2R) / (Math.PI / 2);
      ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(54,214,201,.25)'; ctx.stroke();
    });

    /* RFI 地面干扰源 */
    snap.rfiActive.forEach(function (r, ri) {
      const p = azElToCanvas(r.az, Math.max(0.02, r.el), cx, cy, R);
      const pulse = 7 + Math.sin(snap.t / 300000 + r.az * 5) * 3;
      const grd = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], pulse * 2.4);
      grd.addColorStop(0, 'rgba(255,93,108,.8)');
      grd.addColorStop(1, 'rgba(255,93,108,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(p[0], p[1], pulse * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.bad;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.font = '10px sans-serif';
      const labelDy = 26 + (ri % 3) * 15;
      ctx.fillStyle = 'rgba(10,17,32,.85)';
      const rfiLabel = r.name + ' ⚠';
      const rfiW = ctx.measureText(rfiLabel).width + 8;
      ctx.fillRect(p[0] - rfiW / 2, p[1] - labelDy, rfiW, 13);
      ctx.strokeStyle = 'rgba(255,93,108,.5)';
      ctx.strokeRect(p[0] - rfiW / 2, p[1] - labelDy, rfiW, 13);
      ctx.fillStyle = COL.bad;
      ctx.fillText(rfiLabel, p[0] - rfiW / 2 + 4, p[1] - labelDy + 10);
    });

    /* 目标 */
    const tp = azElToCanvas(snap.pos.az, Math.max(0, snap.pos.el), cx, cy, R);
    const tcol = snap.blocked ? COL.warn : (snap.targetVisible ? COL.ok : COL.muted);
    ctx.strokeStyle = tcol; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(tp[0], tp[1], 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tp[0] - 10, tp[1]); ctx.lineTo(tp[0] + 10, tp[1]);
    ctx.moveTo(tp[0], tp[1] - 10); ctx.lineTo(tp[0], tp[1] + 10);
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = tcol; ctx.font = 'bold 11px sans-serif';
    const labelX = tp[0] > 380 ? tp[0] - 130 : tp[0] + 11;
    const tgtName = snap.target.name.split('（')[0];
    const nameW = ctx.measureText(tgtName).width + 8;
    ctx.fillStyle = 'rgba(10,17,32,.7)';
    ctx.fillRect(labelX - 4, tp[1] + 9, nameW, 14);
    ctx.fillStyle = tcol;
    ctx.fillText(tgtName, labelX, tp[1] + 20);
    ctx.font = '10px monospace';
    const coord = 'az ' + (snap.pos.az * R2D).toFixed(1) + '° el ' +
      (snap.pos.el * R2D).toFixed(1) + '° / 地形 ' + snap.horizonDeg.toFixed(0) + '°';
    const coordW = ctx.measureText(coord).width + 8;
    ctx.fillStyle = 'rgba(10,17,32,.7)';
    ctx.fillRect(labelX - 4, tp[1] + 22, coordW, 13);
    ctx.fillStyle = tcol;
    ctx.fillText(coord, labelX, tp[1] + 33);
    ctx.restore();

    /* 标题信息 */
    ctx.fillStyle = snap.blocked ? COL.warn : COL.muted;
    ctx.font = '11px sans-serif';
    ctx.fillText(snap.blocked ? '⚠ 目标处于地形遮挡区：该时段数据不可用' : '目标可见，统一天空视图实时对齐',
      12, 16);
  }

  function drawScanCoverage(ctx, s, snap, cx, cy, R) {
    /* 扫描区域当前范围 + 过去 40 分钟扫过的覆盖范围 */
    const lookMs = 40 * 60000;
    const stepMs = 4 * 60000;
    for (let dt = -lookMs; dt <= 0; dt += stepMs) {
      const tt = snap.t + dt;
      if (tt < s.startMs) continue;
      const sc = RAS.scanAt(s, tt);
      const p = azElToCanvas(sc.azRad, Math.max(0.01, sc.elRad), cx, cy, R);
      const rr = R * (sc.radiusDeg * D2R) / (Math.PI / 2);
      ctx.fillStyle = 'rgba(77,163,255,.05)';
      ctx.strokeStyle = 'rgba(77,163,255,.10)';
      ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    const p0 = azElToCanvas(snap.scan.azRad, Math.max(0.01, snap.scan.elRad), cx, cy, R);
    const rr0 = R * (snap.scan.radiusDeg * D2R) / (Math.PI / 2);
    ctx.strokeStyle = COL.blue; ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(p0[0], p0[1], rr0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
  }

  /* ---------------- 阵列布局 ---------------- */
  function drawArray(s, snap) {
    const canvas = document.getElementById('arrayCanvas');
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    const maxR = 520;
    const sc = (Math.min(w, h) - 40) / 2 / maxR;
    const cx = w / 2, cy = h / 2;

    /* 启用天线间基线（仅绘制同一时刻有效对） */
    snap.ants.forEach(function (a) {
      if (a.enabled && a.status !== 'off') {
        snap.ants.forEach(function (b) {
          if (b.id <= a.id || !b.enabled || b.status === 'off') return;
          ctx.strokeStyle = 'rgba(54,214,201,.07)';
          ctx.beginPath();
          ctx.moveTo(cx + s.ants[a.id].x * sc, cy - s.ants[a.id].y * sc);
          ctx.lineTo(cx + s.ants[b.id].x * sc, cy - s.ants[b.id].y * sc);
          ctx.stroke();
        });
      }
    });
    snap.ants.forEach(function (a) {
      const x = cx + s.ants[a.id].x * sc, y = cy - s.ants[a.id].y * sc;
      ctx.fillStyle = STATUS_COL[a.status] || COL.ok;
      ctx.globalAlpha = a.enabled ? 1 : 0.25;
      ctx.beginPath(); ctx.arc(x, y, a.enabled ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.font = '8px monospace'; ctx.fillStyle = 'rgba(220,228,242,.55)';
      ctx.fillText(a.name, x + 5, y + 3);
    });
    ctx.fillStyle = COL.muted; ctx.font = '10px sans-serif';
    ctx.fillText('Y 形阵列 · 最长基线 ' + snap.metrics.longestM.toFixed(0) +
      ' m · 有效基线 ' + snap.metrics.baselineCount + ' 条', 10, 15);
  }

  /* ---------------- UV 覆盖 ---------------- */
  function drawUV(s, snap) {
    const canvas = document.getElementById('uvCanvas');
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const target = snap.target;

    /* 地球自转合成：过去 1 小时已采样 + 未来 1 小时预测，λ 取 L 波段 */
    const enabled = snap.ants.map(function (a) { return a.enabled && !a.blocked &&
      !a.rfiFlags.some(Boolean); });
    const lamL = RAS.C_LIGHT / RAS.BANDS[0].freq;
    const pts = RAS.uvSamples(s.ants, enabled, target, snap.t, 2 * 3600000, 10 * 60000);
    let maxUV = 1;
    pts.forEach(function (p) { maxUV = Math.max(maxUV, Math.abs(p.u), Math.abs(p.v)); });
    const scale = (Math.min(w, h) / 2 - 26) / (maxUV / lamL);

    ctx.strokeStyle = '#1b2740';
    [-0.66, -0.33, 0, 0.33, 0.66].forEach(function (f) {
      const x = cx + f * (Math.min(w, h) / 2 - 26);
      ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, h - 20); ctx.stroke();
      const y = cy + f * (Math.min(w, h) / 2 - 26);
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke();
    });

    pts.forEach(function (p) {
      const x = cx + (p.u / lamL) * scale, y = cy - (p.v / lamL) * scale;
      ctx.fillStyle = p.past ? 'rgba(77,163,255,.75)' : 'rgba(130,148,176,.28)';
      ctx.fillRect(x - 1, y - 1, 2.4, 2.4);
    });
    ctx.fillStyle = COL.muted; ctx.font = '10px monospace';
    ctx.fillText('u →', w - 26, cy - 6);
    ctx.fillText('v ↑', cx + 6, 16);
    ctx.fillText((maxUV / lamL / 1000).toFixed(1) + ' kλ', 8, h - 6);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = COL.blue; ctx.fillRect(10, 12, 8, 8);
    ctx.fillStyle = COL.muted; ctx.fillText('已采集', 22, 20);
    ctx.fillStyle = 'rgba(130,148,176,.5)'; ctx.fillRect(70, 12, 8, 8);
    ctx.fillStyle = COL.muted; ctx.fillText('自转预测（未来 1 h）', 82, 20);
  }

  /* ---------------- 数据可用性时间线 ---------------- */
  function timelineRange(s) {
    const win = ui.tlWindow;
    const end = s.timeMs;
    const start = win ? Math.max(s.startMs, end - win) : s.startMs;
    return [start, end];
  }
  function drawTimeline(s) {
    const canvas = document.getElementById('timelineCanvas');
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    const [t0, t1] = timelineRange(s);
    const span = Math.max(1, t1 - t0);
    const padL = 46, padR = 14, top = 26, laneH = 13, gap = 3, antH = 7, antGap = 1.5;
    const plotW = w - padL - padR;
    function X(t) { return padL + (t - t0) / span * plotW; }

    /* 网格与时间刻度 */
    ctx.strokeStyle = '#1b2740'; ctx.fillStyle = COL.muted; ctx.font = '9px monospace';
    const tick = niceTick(span);
    for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
      const x = X(t);
      if (x > padL + plotW - 18) continue;
      ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, h - 34); ctx.stroke();
      ctx.fillText(new Date(t).toISOString().slice(11, 16), x - 14, top - 10);
    }

    /* 24 条独立天线泳道 */
    const antTop = top;
    s.ants.forEach(function (a, i) {
      const y = antTop + i * (antH + antGap);
      ctx.fillStyle = 'rgba(255,255,255,.04)';
      ctx.fillRect(padL, y, plotW, antH);
      ctx.fillStyle = COL.muted; ctx.font = '8px monospace';
      ctx.fillText(a.name, 6, y + antH - 1);
      for (let si = 0; si < s.samples.length; si++) {
        const sm = s.samples[si], nx = s.samples[si + 1];
        if (sm.t < t0) continue;
        if (sm.t > t1) break;
        const x0 = X(sm.t);
        const x1 = nx ? X(Math.min(nx.t, t1)) : X(t1);
        const segH = antH / 2;
        /* 下半：L/S；上半：C/X */
        ctx.fillStyle = segColor(sm.st[i], sm.rf[i], 0x3, false);
        ctx.fillRect(x0, y, Math.max(1, x1 - x0 - 0.4), segH);
        ctx.fillStyle = segColor(sm.st[i], sm.rf[i], 0xC, true);
        ctx.fillRect(x0, y + segH, Math.max(1, x1 - x0 - 0.4), antH - segH);
      }
    });

    /* 4 个频段可用性行 */
    const bandTop = antTop + 24 * (antH + antGap) + 10;
    RAS.BANDS.forEach(function (b, bi) {
      const y = bandTop + bi * (laneH + gap);
      ctx.fillStyle = COL.muted; ctx.font = '9px sans-serif';
      ctx.fillText(b.name, 8, y + laneH - 3);
      ctx.fillStyle = 'rgba(255,255,255,.04)';
      ctx.fillRect(padL, y, plotW, laneH);
      for (let si = 0; si < s.samples.length; si++) {
        const sm = s.samples[si], nx = s.samples[si + 1];
        if (sm.t < t0) continue;
        if (sm.t > t1) break;
        const q = (sm.bq[bi] == null ? 0 : sm.bq[bi]) / 100;
        const x0 = X(sm.t), x1 = nx ? X(Math.min(nx.t, t1)) : X(t1);
        ctx.fillStyle = q > 0.6 ? 'rgba(70,209,125,.8)'
          : q > 0.3 ? 'rgba(245,185,66,.75)'
          : q > 0.12 ? 'rgba(255,93,108,.7)' : 'rgba(60,60,70,.6)';
        ctx.fillRect(x0, y, Math.max(1, x1 - x0 - 0.4), laneH);
      }
    });

    /* 重启 gap（事件） */
    s.events.forEach(function (e) {
      if (e.type !== 'gap') return;
      const x = X(e.t);
      if (x < padL || x > w - padR) return;
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(x - 1.5, top - 6, 3, bandTop + RAS.BANDS.length * (laneH + gap) - top);
      ctx.font = '9px sans-serif'; ctx.fillStyle = COL.muted;
      ctx.fillText('重启中断', x + 4, top + 2);
    });

    /* 问题起点标记（从 uiLog 提取 onset） */
    const onsetY = bandTop + RAS.BANDS.length * (laneH + gap) + 6;
    s.uiLog.forEach(function (l) {
      if (l.t < t0 || l.t > t1) return;
      if (['rfi', 'drift', 'block'].indexOf(l.kind) < 0) return;
      if (l.text.indexOf('恢复') >= 0) return;
      const x = X(l.t);
      ctx.strokeStyle = l.kind === 'rfi' ? COL.bad : l.kind === 'drift' ? COL.warn : COL.brown;
      ctx.beginPath();
      ctx.moveTo(x, top - 4); ctx.lineTo(x - 4, onsetY); ctx.lineTo(x + 4, onsetY); ctx.closePath();
      ctx.globalAlpha = .8; ctx.stroke(); ctx.globalAlpha = 1;
    });

    /* 图例 */
    const legY = h - 14;
    ctx.font = '9px sans-serif';
    const legs = [['可用', COL.ok], ['时间漂移', COL.warn], ['干扰', COL.bad], ['遮挡', COL.brown], ['已排除/无数据', COL.muted]];
    let lx = padL;
    legs.forEach(function (g) {
      ctx.fillStyle = g[1]; ctx.fillRect(lx, legY - 8, 9, 9);
      ctx.fillStyle = COL.muted; ctx.fillText(g[0], lx + 12, legY);
      lx += ctx.measureText(g[0]).width + 34;
    });

    /* 光标 */
    const cur = ui.cursorMs == null ? s.timeMs : Math.max(t0, Math.min(t1, ui.cursorMs));
    const cxp = X(cur);
    ctx.strokeStyle = '#ffffff'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cxp, top - 6); ctx.lineTo(cxp, h - 20); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    const curLabel = RAS.fmtUTC(cur);
    let curLabelX = cxp + 5;
    if (curLabelX + 60 > padL + plotW) curLabelX = cxp - 62;
    ctx.fillText(curLabel, curLabelX, h - 4);

    canvas._xmap = { t0, t1, padL, plotW };
  }

  function statusColorFromMask(mask, blocked) {
    if (mask & 3) return 'rgba(255,93,108,.75)';
    if (mask & 12) return 'rgba(245,185,66,.7)';
    return blocked ? 'rgba(176,138,78,.55)' : 'rgba(70,209,125,.8)';
  }
  function segColor(code, mask, bandMask, high) {
    if (code === 4) return 'rgba(130,148,176,.22)';
    if (code === 3) return 'rgba(176,138,78,.55)';
    if (mask & bandMask) return high ? 'rgba(167,139,250,.85)' : 'rgba(255,93,108,.85)';
    if (code === 1) return 'rgba(245,185,66,.7)';
    return 'rgba(70,209,125,.8)';
  }
  function rfiColorMask(mask, high, blocked) {
    if (high) return (mask & 12) ? 'rgba(255,93,108,.75)' : 'rgba(130,148,176,.3)';
    return (mask & 3) ? 'rgba(255,93,108,.75)' : 'rgba(130,148,176,.3)';
  }
  function niceTick(span) {
    const min = span / 8;
    const cand = [60000, 5 * 60000, 15 * 60000, 30 * 60000, 3600000,
      2 * 3600000, 6 * 3600000, 12 * 3600000, 24 * 3600000];
    for (let i = 0; i < cand.length; i++) if (cand[i] >= min) return cand[i];
    return cand[cand.length - 1];
  }

  /* ---------------- 右侧面板 ---------------- */
  function qColor(q) { return q > 0.65 ? COL.ok : q > 0.35 ? COL.warn : COL.bad; }

  function renderQuality(s, snap) {
    const m = snap.metrics;
    const q = m.qualityOverall;
    const eff = snap.ants.filter(function (a) { return a.enabled; }).length;
    let html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
      '<div style="font-size:26px;font-family:monospace;color:' + qColor(q) + '">' +
      Math.round(q * 100) + '</div><div class="muted" style="font-size:11px">综合成像质量指数<br>' +
      (snap.blocked ? '目标遮挡中，整体数据不可用' : '随阵列组合 / 校准 / 干扰连续更新') + '</div></div>';
    html += '<div class="qbands">';
    m.perBand.forEach(function (b) {
      const band = RAS.BANDS.find(function (x) { return x.id === b.id; });
      html += '<div class="qband' + (b.usable ? '' : ' dead') + '">' +
        '<div class="bn" style="color:' + band.color + '">' + band.name + '</div>' +
        '<div class="bv" style="color:' + qColor(b.quality) + '">' + Math.round(b.quality * 100) +
        '</div><div style="font-size:10px"><span class="dot ' +
        (b.usable ? (b.quality > .65 ? 'ok' : 'warn') : 'bad') + '"></span>' +
        (b.usable ? (b.rfiAnts ? b.rfiAnts + ' 面受扰' : '正常') : '不可用') + '</div></div>';
    });
    html += '</div>';
    const rows = [
      ['有效天线', eff + ' / 24'],
      ['有效基线', m.baselineCount + ' 条'],
      ['最长基线', m.longestM.toFixed(0) + ' m'],
      ['合成波束（L）', m.synthBeamArcsec ? m.synthBeamArcsec.toFixed(1) + ' ″' : '—'],
      ['相对灵敏度', m.relSensitivity.toFixed(2) + ' σ'],
      ['UV 平面填充', m.uvFillPct.toFixed(0) + ' %'],
      ['天空覆盖范围', m.skyCoveragePct.toFixed(0) + ' %'],
      ['校准完成度', s.cal.done + ' / ' + RAS.CAL_STEPS.length + ' 步']
    ];
    html += rows.map(function (r) {
      return '<div class="qrow"><span class="muted">' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
    document.getElementById('qualityBox').innerHTML = html;
  }

  function renderAntennas(s, snap) {
    const box = document.getElementById('antennaGrid');
    box.innerHTML = snap.ants.map(function (a) {
      const real = s.ants[a.id];
      const tip = real.enabled
        ? a.name + '：' + (a.status === 'ok' ? '正常' :
            a.status === 'drift' ? '时钟漂移 ' + real.biasNs.toFixed(1) + ' ns' :
            a.status === 'rfi' ? '受到干扰 ' + RAS.BANDS.filter(function (b, bi) { return a.rfiFlags[bi]; }).map(function (b) { return b.id; }).join('/') :
            a.status === 'block' ? '目标遮挡' : '')
        : a.name + '：已排除（' + (real.offlineReason || '') + '）';
      return '<div class="ant ' + (real.enabled ? a.status : 'off') +
        '" data-id="' + a.id + '" title="' + tip + '">' + a.name + '</div>';
    }).join('');
  }

  function renderRfi(s, snap) {
    const box = document.getElementById('rfiBox');
    if (!s.rfiList.length) {
      box.innerHTML = '<div class="kv"><span class="muted">当前无已识别地面干扰源</span></div>';
      return;
    }
    let html = '';
    s.rfiList.forEach(function (r) {
      const affected = snap.ants.filter(function (a) {
        return a.rfiFlags.some(Boolean);
      }).length;
      const note = snap.blocked ? '目标遮挡中，干扰暂不计入有效数据' : affected + ' 面受扰';
      html += '<div class="kv"><span><i style="color:' + COL.bad + '">●</i> ' + r.name +
        '（' + r.bands.join('/') + '）</span><b>' + note + '</b></div>';
    });
    html += '<div class="kv"><span class="muted">影响频段数据在时间线中以红色分段标记</span></div>';
    box.innerHTML = html;
  }

  function renderCalibration(s) {
    const wrap = document.getElementById('calSteps');
    wrap.innerHTML = RAS.CAL_STEPS.map(function (st, i) {
      const done = s.cal.done > i;
      const ct = s.cal.completedAt[i];
      return '<div class="calstep' + (done ? ' done' : '') + '">' +
        '<span class="chk">' + (done ? '✔' : '○') + '</span><span>' + (i + 1) + '. ' +
        st.name + '</span><span class="ct">' + (ct ? RAS.fmtUTC(ct) : '') + '</span></div>';
    }).join('');
    const next = RAS.CAL_STEPS[s.cal.done];
    document.getElementById('btnCalStep').textContent = next ? '执行下一步：' + next.name : '校准已全部完成';
    document.getElementById('btnCalStep').disabled = !next;
    document.getElementById('btnCalUndo').disabled = s.cal.done === 0;
  }

  function renderBatch(s) {
    const box = document.getElementById('batchBox');
    if (!s.batch) { box.innerHTML = '<div class="kv"><span class="muted">暂无进行中的观测批次</span></div>'; return; }
    const b = s.batch;
    const pct = Math.min(100, b.progressMs / b.durationMs * 100);
    const stTxt = b.status === 'done' ? '已完成' : b.status === 'paused' ? '已暂停' : '观测中';
    const stCol = b.status === 'done' ? COL.ok : b.status === 'paused' ? COL.warn : COL.blue;
    box.innerHTML =
      '<div class="kv"><span>' + b.name + '</span><b style="color:' + stCol + '">' + stTxt + '</b></div>' +
      '<div class="kv"><span class="muted">开始</span><span>' + RAS.fmtUTC(b.start) + '</span></div>' +
      '<div class="kv"><span class="muted">进度</span><b>' + Math.round(b.progressMs / 60000) +
        ' / ' + Math.round(b.durationMs / 60000) + ' min</b></div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>';
    document.getElementById('btnBatchPause').textContent = b.status === 'paused' ? '继续批次' : '暂停批次';
    document.getElementById('btnBatchPause').disabled = b.status === 'done';
  }

  function renderEvents(s) {
    const tagMap = { rfi: '干扰', drift: '漂移', block: '遮挡', cal: '校准',
      batch: '批次', sys: '系统', scan: '扫描' };
    document.getElementById('eventLog').innerHTML = s.uiLog.slice(0, 80).map(function (l) {
      return '<li><span class="et">' + RAS.fmtUTC(l.t) + '</span>' +
        '<span class="tag ' + l.kind + '">' + (tagMap[l.kind] || '事件') + '</span>' +
        esc(l.text) + '</li>';
    }).join('');
  }
  function esc(t) {
    return String(t).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* 问题起点清单（时间线光标时刻附近） */
  function renderOnsets(s) {
    const cur = ui.cursorMs == null ? s.timeMs : ui.cursorMs;
    const win = 20 * 60000;
    const list = s.uiLog.filter(function (l) {
      return ['rfi', 'drift', 'block'].indexOf(l.kind) >= 0 && Math.abs(l.t - cur) <= win;
    }).slice(0, 6);
    document.getElementById('onsetList').innerHTML = list.map(function (l) {
      return '<div class="onset ' + l.kind + '"><b>' + RAS.fmtUTC(l.t) + '</b> — ' + esc(l.text) +
        ' <span class="muted">[' + (l.t <= cur ? '此前' : '此后') + '数据受影响]</span></div>';
    }).join('') || '<div class="hint">光标 ±20 分钟内无异常起点事件</div>';
  }

  function renderAll(s, snap) {
    drawSky(s, snap);
    drawArray(s, snap);
    drawUV(s, snap);
    drawTimeline(s);
    renderQuality(s, snap);
    renderAntennas(s, snap);
    renderRfi(s, snap);
    renderCalibration(s);
    renderBatch(s);
    renderEvents(s);
    renderOnsets(s);
  }

  RAS.Views = {
    ui, renderAll, drawTimeline, timelineRange, canvasToAzEl,
    skyCanvasId: 'skyCanvas'
  };
})(window);
