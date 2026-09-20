/* engine.js — 仿真步进、快照（覆盖/质量/可用性）、时间线采样、重算 */
(function (global) {
  'use strict';
  const RAS = global.RAS;
  const D2R = RAS.D2R, R2D = RAS.R2D;
  const TICK_MS = 20000;              /* 仿真内部分辨率 20 秒 */
  const MAX_BIAS_NS = 60;
  const DRIFT_LIMIT_NS = 12;          /* |偏差| 超过该值判定时间漂移 */
  const DRIFT_RATE_LIMIT = 18;        /* ns/h 预警 */
  const SAMPLE_MS = 60000;            /* 时间线存储粒度 1 分钟 */
  const rfiLatch = new WeakMap();      /* 受扰频段迟滞，避免阈值抖动反复报警 */

  function makeMetrics() {
    return {
      baselineCount: 0, longestM: 0,
      synthBeamArcsec: 0, relSensitivity: 1, skyCoveragePct: 0,
      uvFillPct: 0, qualityOverall: 0,
      perBand: RAS.BANDS.map(function (b) {
        return { id: b.id, usable: true, quality: 1, rfiAnts: 0, reason: '' };
      })
    };
  }

  /* 当前时刻完整快照 */
  function computeSnapshot(s, t) {
    const target = RAS.targetOf(s);
    const lst = RAS.lstRad(t);
    const pos = RAS.targetPosition(target, t);
    const horizonDeg = RAS.horizonElDeg(pos.az);
    const blocked = pos.el * R2D < horizonDeg;
    const targetVisible = pos.el > 0;

    /* 扫描区域历史坐标（用于绘制随时间移动的覆盖） */
    const scanHere = scanAt(s, t);

    const rfiActive = s.rfiList.slice();
    if (!rfiLatch.has(s)) rfiLatch.set(s, {});
    const latch = rfiLatch.get(s);
    if (!rfiActive.length) Object.keys(latch).forEach(function (k) { latch[k] = false; });
    const ants = s.ants.map(function (a) {
      const rfiFlags = [false, false, false, false];
      let rfiPower = -99;
      rfiActive.forEach(function (r) {
        const d = RAS.angularSep(pos.az, pos.el, r.az, r.el);
        const p = r.power - (d * R2D) * 0.6 - (1 - a.rfiGain) * 8;
        if (p > rfiPower) rfiPower = p;
        r.bands.forEach(function (bid) {
          const idx = bandIndex(bid);
          if (idx < 0) return;
          const key = a.id + '_' + idx;
          if (latch[key] == null) latch[key] = false;
          if (latch[key] && p > 4) rfiFlags[idx] = true;   /* 迟滞：已受扰需降到 4 以下才解除 */
          else if (!latch[key] && p > 6) { latch[key] = true; rfiFlags[idx] = true; }
          else if (latch[key] && p <= 4) latch[key] = false;
        });
      });
      const drifting = a.enabled && !blocked && (Math.abs(a.biasNs) > DRIFT_LIMIT_NS ||
        Math.abs(a.driftRate) > DRIFT_RATE_LIMIT);
      let status = 'ok';
      if (!a.enabled) status = 'off';
      else if (blocked) status = 'block';
      else if (drifting) status = 'drift';
      else if (rfiFlags.some(Boolean)) status = 'rfi';
      return { id: a.id, name: a.name, x: a.x, y: a.y, arm: a.arm, r: a.r,
        enabled: a.enabled, biasNs: a.biasNs,
        driftRate: a.driftRate, rfiFlags, rfiPower, drifting, blocked, status };
    });

    const enabledCount = ants.filter(function (a) { return a.enabled; }).length;
    const usable = ants.filter(function (a) {
      return a.enabled && !a.blocked && !a.rfiFlags.some(Boolean);
    });

    /* 分频段质量 */
    const perBand = RAS.BANDS.map(function (b, bi) {
      let good = 0, rfiAnts = 0, driftAnts = 0, driftPenalty = 0, reasons = [];
      ants.forEach(function (a) {
        if (!a.enabled) return;
        if (a.blocked) return;
        if (a.rfiFlags[bi]) { rfiAnts++; return; }
        good++;
        const fGHz = b.freq / 1e9;
        const phase = Math.abs(a.biasNs) * fGHz * 0.036; /* 周期比例近似 */
        if (a.drifting) driftAnts++;
        driftPenalty += Math.min(1, phase);
      });
      const total = ants.length;
      let q = good / total;
      q *= 1 - (good ? driftPenalty / Math.max(1, good) * 0.6 : 0);
      if (blocked) { reasons.push('目标在遮挡区内'); q *= 0.15; }
      if (rfiAnts > 0) reasons.push(rfiAnts + ' 面天线受扰');
      if (driftAnts > 0) reasons.push(driftAnts + ' 面时间漂移');
      if (good < total / 3) reasons.push('可用基线不足');
      q = Math.max(0, Math.min(1, q));
      const cleanGood = ants.filter(function (a) {
        return a.enabled && !a.blocked && !a.rfiFlags[bi];
      }).length;
      return { id: b.id, usable: !blocked && cleanGood >= Math.max(3, total / 3),
        quality: q, rfiAnts, driftAnts, reason: reasons.join('；') };
    });

    const m = makeMetrics();
    m.perBand = perBand;
    m.baselineCount = Math.max(0, usable.length * (usable.length - 1) / 2);
    const geomSource = ants.filter(function (a) { return a.enabled && !a.blocked; });
    if (geomSource.length >= 2) {
      let maxD = 0;
      for (let i = 0; i < geomSource.length; i++)
        for (let j = i + 1; j < geomSource.length; j++) {
          const dx = geomSource[i].x - geomSource[j].x, dy = geomSource[i].y - geomSource[j].y;
          maxD = Math.max(maxD, Math.hypot(dx, dy));
        }
      m.longestM = maxD;
      m.synthBeamArcsec = 1.22 * (RAS.C_LIGHT / RAS.BANDS[0].freq) / Math.max(1, maxD) * R2D * 3600;
      m.relSensitivity = Math.sqrt(m.baselineCount / (24 * 23 / 2));
      m.skyCoveragePct = Math.min(100, usable.length / 24 * 100 * scanHere.radiusDeg / 0.4);
    }

    /* UV 填充代理：沿三条臂方向的基线延伸范围 */
    if (geomSource.length >= 2) {
      let reach = [0, 0, 0];
      geomSource.forEach(function (a) { reach[a.arm] = Math.max(reach[a.arm], a.r); });
      const fullArms = reach.filter(function (r) { return r > 350; }).length;
      m.uvFillPct = Math.min(100, usable.length / 24 * 60 + fullArms * 12 +
        (reach.reduce(function (x, y) { return x + y; }, 0) / (3 * 434)) * 14);
    }

    let calBonus = 0;
    RAS.CAL_STEPS.forEach(function (st, i) { if (s.cal.done > i) calBonus += st.bonus; });
    const bandQ = perBand.reduce(function (x, b) { return x + b.quality; }, 0) / perBand.length;
    m.qualityOverall = Math.min(1, bandQ * (0.62 + calBonus) *
      (0.6 + 0.4 * m.relSensitivity));

    return {
      t, target, pos, blocked, targetVisible, horizonDeg, scan: scanHere,
      lst, ants, rfiActive, metrics: m
    };
  }

  function bandIndex(id) {
    return RAS.BANDS.findIndex(function (b) { return b.id === id; });
  }

  /* 扫描区域：默认锁定目标，手动移动后不再自动跟随，重算时取最近历史 */
  function scanAt(s, t) {
    let h = s.scan.history[0], found = h;
    for (let i = 0; i < s.scan.history.length; i++) {
      if (s.scan.history[i].t <= t) found = s.scan.history[i];
      else break;
    }
    return { azRad: found.az, elRad: found.el, radiusDeg: found.r };
  }

  /* 推进 dtMs 仿真时间 */
  function advance(s, dtMs) {
    const before = s.timeMs;
    const end = before + dtMs;
    const prev = s.samples.length ? s.samples[s.samples.length - 1] : null;
    const onsetEvents = [];
    let prevSnap = null;

    const firstTick = before + Math.min(TICK_MS, Math.max(1, Math.round((end - before) / 1000) * 1000));
    for (let t = firstTick; t <= end + 0.5; t += TICK_MS) {
      const dtH = TICK_MS / 3600000;
      s.ants.forEach(function (a) {
        if (a.enabled) a.biasNs = Math.max(-MAX_BIAS_NS, Math.min(MAX_BIAS_NS,
          a.biasNs + a.driftRate * dtH));
      });
      s.timeMs = t;

      /* 批次进度 */
      if (s.batch && s.batch.status === 'running') {
        s.batch.progressMs += TICK_MS;
        if (s.batch.progressMs >= s.batch.durationMs) {
          s.batch.progressMs = s.batch.durationMs;
          s.batch.status = 'done';
          RAS.addLog(s, 'batch', '观测批次完成', t);
        }
      }

      /* 每分钟采样 + 问题起点检测 */
      const snap = computeSnapshot(s, t);
      if (prevSnap) detectOnsets(prevSnap, snap, onsetEvents);
      const lastStore = s.samples.length ? s.samples[s.samples.length - 1].t : -Infinity;
      if (t - lastStore >= SAMPLE_MS) storeSample(s, snap);
      prevSnap = snap;
    }
    s.timeMs = end;
    return onsetEvents;
  }

  /* 天线状态码：0 ok / 1 drift / 2 rfi / 3 block / 4 off */
  function statusCode(a) {
    if (!a.enabled) return 4;
    if (a.blocked) return 3;
    if (a.rfiFlags.some(Boolean)) return 2;
    if (a.drifting) return 1;
    return 0;
  }
  function storeSample(s, snap) {
    const samp = {
      t: snap.t,
      st: snap.ants.map(statusCode),
      rf: snap.ants.map(function (a) {
        let m = 0;
        a.rfiFlags.forEach(function (f, i) { if (f) m |= (1 << i); });
        return m;
      }),
      bq: snap.metrics.perBand.map(function (b) { return Math.round(b.quality * 100); }),
      q: Math.round(snap.metrics.qualityOverall * 100)
    };
    s.samples.push(samp);
    if (s.samples.length > RAS.SAMPLE_CAP) s.samples.splice(0, s.samples.length - RAS.SAMPLE_CAP);
  }

  function detectOnsets(prev, cur, out) {
    cur.ants.forEach(function (a, i) {
      const p = prev.ants[i];
      if (p.status !== a.status) {
        if (a.status === 'rfi' && p.status !== 'rfi')
          out.push({ t: cur.t, kind: 'rfi', scope: 'ant', ref: a.id,
            text: a.name + ' 开始受到地面干扰（' +
              RAS.BANDS.filter(function (b, bi) { return a.rfiFlags[bi]; }).map(function (b) { return b.id; }).join('/') + '）' });
        if (a.status === 'drift' && p.status !== 'drift')
          out.push({ t: cur.t, kind: 'drift', scope: 'ant', ref: a.id,
            text: a.name + ' 时间漂移越限（偏差 ' + Math.abs(a.biasNs).toFixed(1) + ' ns）' });
        if (a.status === 'off' && p.status !== 'off')
          out.push({ t: cur.t, kind: 'off', scope: 'ant', ref: a.id,
            text: a.name + ' 被排除出阵列组合' });
        if (['rfi', 'drift', 'off'].indexOf(p.status) >= 0 && a.status === 'ok')
          out.push({ t: cur.t, kind: 'sys', scope: 'ant', ref: a.id, text: a.name + ' 数据恢复可用' });
      }
    });
    if (!prev.blocked && cur.blocked)
      out.push({ t: cur.t, kind: 'block', scope: 'target',
        text: '目标进入地形遮挡区（方位 ' + (cur.pos.az * R2D).toFixed(0) + '°，地形 ' +
          cur.horizonDeg.toFixed(0) + '° 以下）' });
    if (prev.blocked && !cur.blocked)
      out.push({ t: cur.t, kind: 'block', scope: 'target', text: '目标离开遮挡区，观测恢复' });
    cur.metrics.perBand.forEach(function (b, i) {
      const pb = prev.metrics.perBand[i];
      if (pb.usable && !b.usable)
        out.push({ t: cur.t, kind: 'rfi', scope: 'band', ref: i,
          text: RAS.BANDS[i].name + ' 数据已不可用：' + (b.reason || '可用基线不足') });
      if (!pb.usable && b.usable)
        out.push({ t: cur.t, kind: 'sys', scope: 'band', ref: i,
          text: RAS.BANDS[i].name + ' 重新可用' });
    });
  }

  /* 从 onsetEvents 写入界面日志（去重：同刻同文） */
  function commitOnsets(s, onsets) {
    onsets.forEach(function (o) {
      if (s.uiLog.some(function (l) { return l.t === o.t && l.text === o.text; })) return;
      RAS.addLog(s, o.kind === 'off' ? 'sys' : o.kind, o.text, o.t);
    });
  }

  /* ---------- 从指定时刻重算（事件溯源回放） ---------- */
  function rebuild(s, fromMs) {
    const t0 = fromMs <= s.startMs ? s.startMs : fromMs;
    const oldEvents = s.events.filter(function (e) { return e.t <= t0; });
    const fresh = RAS.makeInitial();
    /* 回放起点之前的事件（含重启 gap 标记），不重复写界面日志 */
    oldEvents.forEach(function (e) {
      RAS.applyEvent(fresh, e, false);
      fresh.events.push(e);
    });
    fresh.timeMs = t0;
    /* 校准状态在回放中已由 calDo/calUndo 恢复 */
    /* 保留起点之前的关键操作日志，便于追溯“问题从哪里开始” */
    fresh.uiLog = s.uiLog.filter(function (l) {
      return l.t <= t0 && ['rfi', 'drift', 'block', 'cal', 'scan', 'sys'].indexOf(l.kind) >= 0;
    }).slice(0, 60);
    RAS.addLog(fresh, 'sys', '⟳ 从 ' + fmtUTC(t0) + ' 重新计算，' +
      Math.round((s.timeMs - t0) / 60000) + ' 分钟后续数据已丢弃并重算');

    /* 重新仿真到原当前时刻 */
    const targetTime = s.timeMs;
    let guard = 0;
    while (fresh.timeMs < targetTime && guard++ < 200000) {
      const ons = advance(fresh, Math.min(TICK_MS * 30, targetTime - fresh.timeMs));
      commitOnsets(fresh, ons);
    }
    fresh.timeMs = targetTime;
    return fresh;
  }

  function fmtUTC(ms) {
    const d = new Date(ms);
    return d.toISOString().slice(11, 19) + ' UTC';
  }

  Object.assign(RAS, {
    TICK_MS, SAMPLE_MS, DRIFT_LIMIT_NS,
    computeSnapshot, scanAt, advance, commitOnsets, rebuild, fmtUTC, statusCode
  });
})(window);
