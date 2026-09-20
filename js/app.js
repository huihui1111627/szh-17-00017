/* app.js — 主控：仿真循环、交互、故障注入、持久化/恢复 */
(function () {
  'use strict';
  const RAS = window.RAS, Views = RAS.Views;
  const $ = function (id) { return document.getElementById(id); };

  let s = null;
  let running = true;
  let speed = 3000;
  let rafLast = null;
  let saveDirty = false;
  let rfiSeq = 1;

  /* ---------------- 初始化 ---------------- */
  function init() {
    const loaded = RAS.load();
    if (loaded) {
      s = loaded;
      running = true;
      const gapMs = Date.now() - (s.savedWall || Date.now());
      if (s.batch && s.batch.status === 'running' && gapMs > 20000) {
        const resumeAt = s.timeMs;
        const gapSim = Math.min(6 * 3600000, Math.round(gapMs * 0.05) + 15 * 60000);
        s.timeMs += gapSim;
        s.events.push({ type: 'gap', t: resumeAt, durationMs: gapSim });
        RAS.addLog(s, 'sys', '检测到重启后中断：批次在 ' + RAS.fmtUTC(resumeAt) +
          ' 暂停，缺失约 ' + Math.round(gapSim / 60000) + ' 分钟数据，已从断点恢复', resumeAt);
      } else {
        RAS.addLog(s, 'sys', '控制台重启，会话状态已恢复');
      }
      showResumeBanner();
    } else {
      s = RAS.makeInitial();
      RAS.addLog(s, 'sys', '观测会话建立：' + RAS.SITE.name);
      seedNaturalEvents();
      running = true;
    }
    bindUI();
    populateTargets();
    syncControls();
    render();
    RAS.save(s);
    requestAnimationFrame(loop);
    setInterval(persist, 4000);
    window.addEventListener('beforeunload', persist);
  }

  /* 预置少量“正在发展”的物理事件，让演示一开始就有数据可读 */
  function seedNaturalEvents() {
    /* 让两面天线漂移率略高，运行几分钟后越过漂移阈值 */
    const t = s.timeMs;
    s.ants[6].driftRate = 21;
    s.ants[15].driftRate = 19;
    s.ants[6].biasNs = 4; s.ants[15].biasNs = 3;
  }

  function showResumeBanner() {
    if (!s.batch) return;
    const b = s.batch;
    $('resumeText').textContent = b.status === 'done'
      ? '重启恢复：上一批次已完成观测。'
      : '重启恢复：批次「' + b.name + '」尚未完成（' +
        Math.round(b.progressMs / 60000) + ' / ' + Math.round(b.durationMs / 60000) +
        ' min），已从断点继续，中断时段在时间线中标记。';
    $('resumeBanner').classList.remove('hidden');
  }

  function populateTargets() {
    $('targetSelect').innerHTML = RAS.TARGETS.map(function (t) {
      return '<option value="' + t.id + '"' + (t.id === s.targetId ? ' selected' : '') + '>' +
        t.name + '</option>';
    }).join('');
  }

  function syncControls() {
    $('simSpeed').value = String(speed);
    $('scanRadius').value = s.scan.radiusDeg;
    $('scanRadiusVal').textContent = s.scan.radiusDeg.toFixed(2) + '°';
    $('tlWindow').value = String(Views.ui.tlWindow);
    $('btnPlay').textContent = running ? '▶ 运行中' : '▶ 运行';
  }

  /* 用户操作：记录为事件（重算可回放） */
  function userEvent(ev, applyLive) {
    ev.t = s.timeMs;
    s.events.push(ev);
    RAS.applyEvent(s, ev, true);
    saveDirty = true;
    render();
  }

  /* ---------------- 主循环 ---------------- */
  function loop(now) {
    if (rafLast == null) rafLast = now;
    const wallDt = now - rafLast;
    rafLast = now;
    if (running) {
      const simDt = wallDt / 1000 * speed;
      if (simDt > 0) {
        const onsets = RAS.advance(s, simDt);
        if (onsets.length) { RAS.commitOnsets(s, onsets); Views.ui.cursorMs = null; }
        saveDirty = true;
      }
    }
    updateClock();
    Views.ui.cursorMs = Views.ui.cursorMs; /* 保持光标 */
    render();
    requestAnimationFrame(loop);
  }

  function render() {
    const snap = RAS.computeSnapshot(s, s.timeMs);
    Views.renderAll(s, snap);
  }

  function updateClock() {
    const d = new Date(s.timeMs);
    $('clockUtc').textContent = d.toISOString().slice(11, 19);
    $('clockLocal').textContent = new Date(s.timeMs + 8 * 3600000)
      .toISOString().slice(11, 19) + ' UTC+8';
    const lstH = RAS.lstRad(s.timeMs) / Math.PI * 12;
    const hh = Math.floor(lstH), mm = Math.floor((lstH - hh) * 60);
    $('clockLst').textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function persist() {
    if (!saveDirty) return;
    saveDirty = false;
    RAS.save(s);
  }

  /* ---------------- 交互绑定 ---------------- */
  function bindUI() {
    $('btnPlay').onclick = function () { running = true; syncControls(); };
    $('btnPause').onclick = function () { running = false; syncControls(); };
    $('simSpeed').onchange = function (e) { speed = Number(e.target.value); };
    $('btnReset').onclick = function () {
      if (!confirm('确定清空全部观测状态并重置演示？')) return;
      RAS.clearSave();
      location.reload();
    };
    $('btnDismissResume').onclick = function () { $('resumeBanner').classList.add('hidden'); };

    $('targetSelect').onchange = function (e) {
      userEvent({ type: 'selectTarget', targetId: e.target.value });
    };
    $('scanRadius').oninput = function (e) {
      const r = Number(e.target.value);
      $('scanRadiusVal').textContent = r.toFixed(2) + '°';
    };
    $('scanRadius').onchange = function (e) {
      userEvent({ type: 'setScanRadius', radiusDeg: Number(e.target.value) });
    };
    $('btnMoveScan').onclick = function () {
      const snap = RAS.computeSnapshot(s, s.timeMs);
      userEvent({ type: 'moveScan',
        az: snap.pos.az + 0.012, el: Math.max(0.05, snap.pos.el - 0.008) });
    };

    /* 天空视图拖动扫描区域 */
    const sky = $('skyCanvas');
    let dragging = false;
    sky.addEventListener('mousedown', function (e) { dragging = true; moveScanTo(e); });
    window.addEventListener('mousemove', function (e) { if (dragging) moveScanTo(e, true); });
    window.addEventListener('mouseup', function () {
      if (dragging) { dragging = false; commitScanDrag(); }
    });
    let pendingScan = null;
    function moveScanTo(e, live) {
      const rect = sky.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const R = Math.min(rect.width, rect.height) / 2 - 44;
      const p = Views.canvasToAzEl(x, y, rect.width / 2, rect.height / 2 + 6, R);
      pendingScan = p;
      Views._pendingScan = p;
      if (!live) return;
    }
    function commitScanDrag() {
      if (!pendingScan) return;
      const p = pendingScan; pendingScan = null; Views._pendingScan = null;
      userEvent({ type: 'moveScan', az: p.az, el: Math.max(0.03, p.el) });
    }

    /* 天线格点击：排除/恢复 */
    $('antennaGrid').addEventListener('click', function (e) {
      const el = e.target.closest('.ant');
      if (!el) return;
      const id = Number(el.dataset.id);
      const a = s.ants[id];
      userEvent({ type: 'antEnable', id, enabled: !a.enabled,
        reason: a.enabled ? '研究人员手动排除（信号异常）' : '手动恢复' });
    });

    $('presetSelect').onchange = function (e) {
      applyPreset(e.target.value);
      e.target.value = 'all';
    };

    $('btnAntDrift').onclick = injectDrift;
    $('btnAntOffline').onclick = injectOffline;
    $('btnAntRestore').onclick = restoreAll;
    $('btnRfiBroad').onclick = injectBroadRfi;
    $('btnRfiNarrow').onclick = injectNarrowRfi;
    $('btnRfiClear').onclick = clearRfi;

    $('btnCalStep').onclick = function () {
      if (s.cal.done >= RAS.CAL_STEPS.length) return;
      userEvent({ type: 'calDo', index: s.cal.done });
    };
    $('btnCalUndo').onclick = function () {
      if (s.cal.done === 0) return;
      userEvent({ type: 'calUndo', fromIndex: s.cal.done });
    };

    $('btnBatchNew').onclick = function () {
      const n = s.uiLog.filter(function (l) { return l.text.indexOf('创建观测批次') >= 0; }).length + 1;
      userEvent({ type: 'batchNew', name: '批次 #' + String(n + 1).padStart(2, '0'),
        durationMs: RAS.DEFAULT_BATCH_MS });
    };
    $('btnBatchPause').onclick = function () {
      if (s.batch && s.batch.status === 'paused') userEvent({ type: 'batchResume' });
      else userEvent({ type: 'batchPause' });
    };

    /* 时间线：点击定位光标，滚轮缩放窗口 */
    const tl = $('timelineCanvas');
    tl.addEventListener('click', function (e) {
      const t = tlTimeAt(e);
      if (t != null) { Views.ui.cursorMs = t; render(); }
    });
    tl.addEventListener('mousemove', function (e) {
      const t = tlTimeAt(e);
      const tip = $('tlTooltip');
      if (t == null) { tip.classList.add('hidden'); return; }
      const snap = RAS.computeSnapshot(s, t);
      const bands = snap.metrics.perBand.map(function (b) {
        return b.id + ' ' + Math.round(b.quality * 100);
      }).join(' · ');
      tip.innerHTML = RAS.fmtUTC(t) + '<br>' + bands +
        (snap.blocked ? '<br><span style="color:#f5b942">目标遮挡，数据不可用</span>' : '');
      tip.style.left = (e.offsetX + 14) + 'px';
      tip.style.top = (e.offsetY + 10) + 'px';
      tip.classList.remove('hidden');
    });
    tl.addEventListener('mouseleave', function () { $('tlTooltip').classList.add('hidden'); });
    tl.addEventListener('wheel', function (e) {
      e.preventDefault();
      const opts = [0, 7200000, 1800000];
      let idx = opts.indexOf(Views.ui.tlWindow);
      idx = Math.max(0, Math.min(opts.length - 1, idx + (e.deltaY > 0 ? 1 : -1)));
      Views.ui.tlWindow = opts[idx];
      $('tlWindow').value = String(Views.ui.tlWindow);
    }, { passive: false });
    $('tlWindow').onchange = function (e) { Views.ui.tlWindow = Number(e.target.value); };

    $('btnRecompute').onclick = function () {
      const from = Views.ui.cursorMs == null ? s.timeMs - 30 * 60000 : Views.ui.cursorMs;
      if (from <= s.startMs) { alert('光标已在会话起点，无法回退重算。'); return; }
      if (!confirm('从 ' + RAS.fmtUTC(from) + ' 重新计算？\n之后的采样数据将丢弃并依据事件日志重放。')) return;
      s = RAS.rebuild(s, from);
      Views.ui.cursorMs = null;
      saveDirty = true; persist(); render();
    };
  }

  function tlTimeAt(e) {
    const rect = $('timelineCanvas').getBoundingClientRect();
    const x = e.clientX - rect.left;
    const m = $('timelineCanvas')._xmap;
    if (!m || x < m.padL || x > m.padL + m.plotW) return null;
    return m.t0 + (x - m.padL) / m.plotW * (m.t1 - m.t0);
  }

  /* ---------------- 阵列组合预设 ---------------- */
  function applyPreset(mode) {
    const t = s.timeMs;
    s.ants.forEach(function (a, i) {
      let enable = true;
      if (mode === 'core') enable = a.r < 200;
      else if (mode === 'arms') enable = a.r >= 200;
      const ev = { type: 'antEnable', id: i, enabled: enable, t,
        reason: '阵列组合调整：' + presetName(mode),
        changed: enable !== a.enabled,
        keepReason: !enable };
      s.events.push(ev);
      RAS.applyEvent(s, ev, enable !== a.enabled);
    });
    saveDirty = true;
    render();
  }
  function presetName(mode) {
    return mode === 'core' ? '紧凑核心阵列' : '长基线臂阵列';
  }

  /* ---------------- 故障注入（模拟监测系统告警） ---------------- */
  function injectDrift() {
    const candidates = s.ants.filter(function (a) { return a.enabled && a.driftRate === 0; });
    if (!candidates.length) {
      alert('当前没有可注入漂移的天线（延迟校准可能正在生效，先回退该步骤）。');
      return;
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const rate = 24 + Math.random() * 14;
    userEvent({ type: 'antDrift', id: pick.id, rateNsH: rate });
    /* 立即叠加一部分偏差，模拟“刚越限被监测发现” */
    pick.biasNs = (Math.random() > 0.5 ? 1 : -1) * (13 + Math.random() * 4);
  }

  function injectOffline() {
    const candidates = s.ants.filter(function (a) { return a.enabled; });
    const n = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < n && candidates.length > 8; k++) {
      const pick = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
      userEvent({ type: 'antEnable', id: pick.id, enabled: false,
        reason: '信号质量异常（自动标记，研究人员确认排除）' });
    }
  }

  function restoreAll() {
    s.ants.forEach(function (a, i) {
      if (!a.enabled) userEvent({ type: 'antEnable', id: i, enabled: true, reason: '手动恢复' });
    });
  }

  function injectBroadRfi() {
    const snap = RAS.computeSnapshot(s, s.timeMs);
    const az = snap.pos.az + (Math.random() - 0.5) * 6 * RAS.D2R;
    const el = Math.max(0.05, snap.pos.el - (6 + Math.random() * 3) * RAS.D2R);
    const id = 'rfi' + rfiSeq++;
    const name = '宽带地面源#' + id.slice(3);
    userEvent({ type: 'rfiOn', id, name, az, el, power: 14 + Math.random() * 1.5,
      bands: ['L', 'S', 'C', 'X'] });
  }

  function injectNarrowRfi() {
    const snap = RAS.computeSnapshot(s, s.timeMs);
    const az = snap.pos.az + (Math.random() > 0.5 ? 7 * RAS.D2R : -7 * RAS.D2R);
    const el = Math.max(0.05, snap.pos.el - (3 + Math.random() * 3) * RAS.D2R);
    const id = 'rfi' + rfiSeq++;
    const name = '窄带发射机#' + id.slice(3);
    userEvent({ type: 'rfiOn', id, name, az, el, power: 12 + Math.random() * 1,
      bands: ['L', 'S'] });
  }

  function clearRfi() {
    s.rfiList.slice().forEach(function (r) {
      userEvent({ type: 'rfiOff', id: r.id, name: r.name });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    init();
    /* 调试/演示接口：console 中可用 __ras.fastForward(分钟数) */
    window.__ras = {
      fastForward: function (minutes) {
        const onsets = RAS.advance(s, minutes * 60000);
        RAS.commitOnsets(s, onsets);
        Views.ui.cursorMs = null;
        persist(); render();
      },
      state: function () { return s; }
    };
  });
})();
