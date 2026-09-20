/* state.js — 初始状态、事件溯源、持久化 */
(function (global) {
  'use strict';
  const RAS = global.RAS;
  const STORAGE_KEY = 'ras-console-v1';
  const SAMPLE_CAP = 20000;

  /* 演示起点：2026-09-21 07:00 UTC。默认目标天鹅座 A 08:45 前后在西北落入地形遮挡区 */
  const START_MS = Date.UTC(2026, 8, 21, 7, 0, 0);
  const DEFAULT_BATCH_MS = 2 * 3600 * 1000;

  const CAL_STEPS = [
    { key: 'delay',   name: '延迟/时间同步校准', bonus: 0.22 },
    { key: 'bandpass',name: '带通（频率响应）校准', bonus: 0.18 },
    { key: 'flux',    name: '流量定标', bonus: 0.16 },
    { key: 'phase',   name: '相位/复增益校准', bonus: 0.20 },
    { key: 'point',   name: '指向校准', bonus: 0.12 },
    { key: 'flag',    name: '数据剔除与自校验', bonus: 0.12 }
  ];

  function makeInitial() {
    const ants = RAS.buildAntennas().map(function (a) {
      return {
        id: a.id, name: a.name, x: a.x, y: a.y, arm: a.arm, r: a.r, rfiGain: a.rfiGain,
        enabled: true,
        driftRate: ((((a.id * 73) % 97) - 48) / 48) * 4.5, /* ns/h */
        biasNs: 0,
        offlineReason: null
      };
    });
    return {
      version: 1,
      startMs: START_MS,
      timeMs: START_MS,
      events: [],
      uiLog: [],
      targetId: 'cygA',
      scan: {
        azRad: RAS.targetPosition(RAS.TARGETS[4], START_MS).az,
        elRad: RAS.targetPosition(RAS.TARGETS[4], START_MS).el,
        radiusDeg: 0.4,
        history: [{ t: START_MS, az: RAS.targetPosition(RAS.TARGETS[4], START_MS).az,
                    el: RAS.targetPosition(RAS.TARGETS[4], START_MS).el, r: 0.4 }]
      },
      ants,
      rfiList: [],
      cal: { done: 0, completedAt: [] },
      driftBeforeDelay: null,
      batch: null,
      samples: [],
      savedWall: null
    };
  }

  function targetOf(s) {
    return RAS.TARGETS.find(function (t) { return t.id === s.targetId; }) || RAS.TARGETS[0];
  }

  function addLog(s, kind, text, t) {
    s.uiLog.unshift({ t: (t == null ? s.timeMs : t), kind, text });
    if (s.uiLog.length > 200) s.uiLog.length = 200;
  }

  function pushEvent(s, ev) {
    if (ev.t == null) ev.t = s.timeMs;
    s.events.push(ev);
  }

  /* 应用一个事件。live=true 表示用户当前操作（产生界面日志） */
  function applyEvent(s, ev, live) {
    const t = ev.t;
    switch (ev.type) {
      case 'selectTarget':
        s.targetId = ev.targetId;
        if (live) addLog(s, 'scan', '选择观测目标 ' + nameOf(s, ev.targetId));
        break;
      case 'setScanRadius':
        s.scan.radiusDeg = ev.radiusDeg;
        s.scan.history.push({ t, az: s.scan.azRad, el: s.scan.elRad, r: ev.radiusDeg });
        if (live) addLog(s, 'scan', '扫描半径调整为 ' + ev.radiusDeg.toFixed(2) + '°');
        break;
      case 'moveScan':
        s.scan.azRad = ev.az; s.scan.elRad = ev.el;
        s.scan.history.push({ t, az: ev.az, el: ev.el, r: s.scan.radiusDeg });
        if (live) addLog(s, 'scan', '扫描区域中心移动至 az ' +
          (ev.az * RAS.R2D).toFixed(1) + '° / el ' + (ev.el * RAS.R2D).toFixed(1) + '°');
        break;
      case 'antEnable': {
        const a = s.ants[ev.id];
        if (!a) break;
        a.enabled = ev.enabled;
        a.offlineReason = ev.enabled ? (ev.keepReason ? a.offlineReason : null)
                                     : (ev.reason || '手动排除');
        if (live && ev.changed !== false) addLog(s, 'sys', (ev.enabled ? '恢复天线 ' : '排除异常天线 ') + a.name +
          (ev.enabled ? '' : '（' + (ev.reason || '手动排除') + '）'));
        break;
      }
      case 'antDrift': {
        const ant = s.ants[ev.id];
        if (ant) ant.driftRate = ev.rateNsH;
        if (live) addLog(s, 'drift', '注入时钟漂移：' + (ev.id == null ? '多面天线' : s.ants[ev.id].name) +
          ' 漂移率 → ' + ev.rateNsH.toFixed(1) + ' ns/h');
        break;
      }
      case 'rfiOn':
        s.rfiList.push({ id: ev.id, az: ev.az, el: ev.el, power: ev.power,
          bands: ev.bands.slice(), name: ev.name, start: t });
        if (live) addLog(s, 'rfi', '检测到地面干扰源 ' + ev.name +
          '（' + ev.bands.map(bandName).join('/') + '），强度 ' + ev.power.toFixed(1));
        break;
      case 'rfiOff':
        s.rfiList = s.rfiList.filter(function (r) { return r.id !== ev.id; });
        if (live) addLog(s, 'rfi', '干扰源 ' + ev.name + ' 已清除/移出影响范围');
        break;
      case 'calDo': {
        const step = CAL_STEPS[ev.index];
        if (step.key === 'delay') {
          s.driftBeforeDelay = s.ants.map(function (a) { return a.driftRate; });
          s.ants.forEach(function (a) { a.biasNs = 0; a.driftRate = 0; });
        }
        s.cal.done = Math.max(s.cal.done, ev.index + 1);
        s.cal.completedAt[ev.index] = t;
        if (live) addLog(s, 'cal', '完成校准步骤：' + step.name);
        break;
      }
      case 'calUndo': {
        const idx = ev.fromIndex - 1;
        const undone = CAL_STEPS[idx];
        s.cal.done = idx;
        if (idx < 0 && s.cal.completedAt) { /* nothing */ }
        s.cal.completedAt = s.cal.completedAt.slice(0, Math.max(0, idx));
        if (undone && undone.key === 'delay' && s.driftBeforeDelay) {
          s.ants.forEach(function (a, i) { a.driftRate = s.driftBeforeDelay[i]; });
          s.driftBeforeDelay = null;
        }
        if (live) addLog(s, 'cal', '校准回退：撤销「' + (undone ? undone.name : '全部') + '」');
        break;
      }
      case 'batchNew':
        s.batch = { name: ev.name, start: t, durationMs: ev.durationMs,
          progressMs: 0, status: 'running', paused: false };
        if (live) addLog(s, 'batch', '创建观测批次 ' + ev.name + '（时长 ' +
          Math.round(ev.durationMs / 60000) + ' 分钟）');
        break;
      case 'batchPause':
        if (s.batch && s.batch.status === 'running') { s.batch.status = 'paused'; s.batch.paused = true; }
        if (live) addLog(s, 'batch', '观测批次暂停');
        break;
      case 'batchResume':
        if (s.batch && s.batch.status === 'paused') { s.batch.status = 'running'; s.batch.paused = false; }
        if (live) addLog(s, 'batch', '观测批次继续');
        break;
      case 'batchDone':
        if (s.batch) s.batch.status = 'done';
        if (live) addLog(s, 'batch', '观测批次完成');
        break;
      case 'gap':
        if (live) addLog(s, 'sys', '重启期间观测中断（' +
          Math.round(ev.durationMs / 60000) + ' 分钟无数据）', t);
        break;
    }
  }

  function nameOf(s, id) {
    const t = RAS.TARGETS.find(function (x) { return x.id === id; });
    return t ? t.name : id;
  }
  function bandName(id) {
    const b = RAS.BANDS.find(function (x) { return x.id === id; });
    return b ? b.name : id;
  }

  /* ---------- 持久化 ---------- */
  function save(s) {
    try {
      s.savedWall = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) { /* 配额超限时静默 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.version !== 1 || !s.ants || !s.events) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSave() { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} }

  Object.assign(RAS, {
    STORAGE_KEY, SAMPLE_CAP, START_MS, DEFAULT_BATCH_MS, CAL_STEPS,
    makeInitial, targetOf, addLog, pushEvent, applyEvent,
    save, load, clearSave
  });
})(window);
