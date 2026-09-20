/* model.js — 纯计算：波段、台站、天文坐标、地形遮挡、阵列几何、UV 覆盖 */
(function (global) {
  'use strict';
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const H2R = Math.PI / 12;
  const C_LIGHT = 299792458;

  const BANDS = [
    { id: 'L', name: 'L 波段', freq: 1.4e9, color: '#4da3ff' },
    { id: 'S', name: 'S 波段', freq: 3.0e9, color: '#36d6c9' },
    { id: 'C', name: 'C 波段', freq: 6.0e9, color: '#a78bfa' },
    { id: 'X', name: 'X 波段', freq: 10.0e9, color: '#f5b942' }
  ];

  const SITE = { latDeg: 37.2, lonDeg: 116.8, name: '北方台站 37.2°N 116.8°E' };
  const LAT = SITE.latDeg * D2R;

  /* 观测目标：J2000 近似（演示精度足够） */
  const TARGETS = [
    { id: '3c286', name: '3C 286（定标源）', raH: 13 + 31 / 60 + 8.288 / 3600, decDeg: 30 + 30 / 60 + 32.96 / 3600 },
    { id: '3c147', name: '3C 147（定标源）', raH: 5 + 42 / 60 + 28.755 / 3600, decDeg: 49 + 51 / 60 + 7.31 / 3600 },
    { id: '3c48',  name: '3C 48（定标源）', raH: 1 + 37 / 60 + 41.3 / 3600, decDeg: 33 + 9 / 60 + 35.4 / 3600 },
    { id: 'casA',  name: '仙后座 A（超新星遗迹）', raH: 23 + 23 / 60 + 24 / 3600, decDeg: 58 + 48.9 / 60 },
    { id: 'cygA',  name: '天鹅座 A（射电星系）', raH: 19 + 59 / 60 + 28.36 / 3600, decDeg: 40 + 44 / 60 + 2.1 / 3600 }
  ];

  /* 由 Unix 毫秒计算格林尼治平恒星时（度） */
  function gmstDeg(ms) {
    const d = ms / 86400000 - 10957;
    const t = d / 36525;
    let g = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000;
    g = ((g % 360) + 360) % 360;
    return g;
  }
  function lstRad(ms) {
    return (((gmstDeg(ms) + SITE.lonDeg) % 360) + 360) % 360 * D2R;
  }

  /* 赤道坐标 → 地平坐标，返回弧度 az（自北向东）/el */
  function equatorialToHorizontal(raRad, decRad, lst) {
    const ha = lst - raRad;
    const sinEl = Math.sin(LAT) * Math.sin(decRad) + Math.cos(LAT) * Math.cos(decRad) * Math.cos(ha);
    const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
    const sinAz = -Math.cos(decRad) * Math.sin(ha) / Math.cos(el);
    const cosAz = (Math.sin(decRad) - Math.sin(LAT) * sinEl) / (Math.cos(LAT) * Math.cos(el));
    let az = Math.atan2(sinAz, Math.max(-1, Math.min(1, cosAz)));
    if (az < 0) az += Math.PI * 2;
    return { az, el };
  }
  function targetPosition(target, ms) {
    return equatorialToHorizontal(target.raH * H2R, target.decDeg * D2R, lstRad(ms));
  }

  /* 地形遮挡轮廓：每 10° 一个高度角（度），北侧山脊、东南侧低山 */
  const HORIZON = (function () {
    const bins = [];
    for (let k = 0; k < 36; k++) {
      const az = k * 10 * D2R;
      const hill = 3 + 2.2 * Math.sin(k * 0.7 + 1.1) + 1.6 * Math.sin(k * 0.31 + 2.0);
      const northRidge = 6 * Math.exp(-Math.pow(angWrap(az) / D2R / 25, 2));
      const seRidge = 3 * Math.exp(-Math.pow(angWrap(az - 130 * D2R) / D2R / 18, 2));
      bins.push(Math.max(1, hill + northRidge + seRidge));
    }
    return bins;
  })();
  function angWrap(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function horizonElDeg(azRad) {
    const f = ((azRad / D2R % 360) + 360) % 360 / 10;
    const i = Math.floor(f), frac = f - i;
    const a = HORIZON[i % 36], b = HORIZON[(i + 1) % 36];
    return a + (b - a) * frac;
  }

  /* 两天体方向角距（弧度） */
  function angularSep(az1, el1, az2, el2) {
    const cosD = Math.sin(el1) * Math.sin(el2) + Math.cos(el1) * Math.cos(el2) * Math.cos(az1 - az2);
    return Math.acos(Math.max(-1, Math.min(1, cosD)));
  }

  /* Y 形阵列：3 条臂，每臂 8 面天线，单位米 */
  function buildAntennas() {
    const ants = [];
    let n = 0;
    [90, 210, 330].forEach(function (armDeg, arm) {
      for (let i = 0; i < 8; i++) {
        const r = 70 + i * 52;
        const a = armDeg * D2R;
        ants.push({
          id: n,
          name: 'A' + String(n + 1).padStart(2, '0'),
          x: r * Math.sin(a),
          y: r * Math.cos(a),
          arm,
          r,
          rfiGain: 0.15 + ((n * 37) % 100) / 100 * 0.45
        });
        n++;
      }
    });
    return ants;
  }

  /* 基线 UV 投影（东西 u、南北 v），单位波长 */
  function baselineUV(dx, dy, ha, dec) {
    const u = (dx * Math.cos(ha) - dy * Math.sin(LAT) * Math.sin(ha)) / 1;
    const v = (dy * (Math.cos(LAT) * Math.sin(dec) + Math.sin(LAT) * Math.cos(dec) * Math.cos(ha))
            + dx * Math.cos(dec) * Math.sin(ha));
    return { u, v };
  }
  function uvSamples(ants, enabled, target, centerMs, haSpanMs, stepMs) {
    const pts = [];
    const raRad = target.raH * H2R, decRad = target.decDeg * D2R;
    for (let m = -haSpanMs / 2; m <= haSpanMs / 2; m += stepMs) {
      const lst = lstRad(centerMs + m);
      const ha = lst - raRad;
      for (let i = 0; i < ants.length; i++) {
        if (!enabled[i]) continue;
        for (let j = i + 1; j < ants.length; j++) {
          if (!enabled[j]) continue;
          const dx = (ants[j].x - ants[i].x), dy = (ants[j].y - ants[i].y);
          const uv = baselineUV(dx, dy, ha, decRad);
          pts.push({ u: uv.u, v: uv.v, past: m < 0 });
          pts.push({ u: -uv.u, v: -uv.v, past: m < 0 });
        }
      }
    }
    return pts;
  }

  const api = {
    D2R, R2D, C_LIGHT, BANDS, SITE, LAT, TARGETS,
    lstRad, targetPosition, horizonElDeg, angularSep,
    buildAntennas, uvSamples, baselineUV, angWrap
  };
  global.RAS = global.RAS || {};
  Object.assign(global.RAS, api);
})(window);
