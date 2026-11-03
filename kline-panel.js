/* ===================== 个股 K 线研判面板 =====================
 * 依赖：Chart.js（chart.umd.min.js）
 * 入口：KPanel.open({ code, name, market, price, pct })
 *   日K 数据源与主看板一致：/api/qq/（同源反代，前复权）→ 失败回落直连
 *   周 / 月 / 季 K 由日K 本地聚合（自然周 / 自然月 / 自然季）
 * 内容：
 *   ① K 线 + MA5/10/20/60   ② 成交量   ③ MACD(12,26,9)
 *   ④ 量价关系判断（近 5 日量能对比 + 20 日量价相关 + OBV）
 *   ⑤ MACD 背离（价格与 DIF 的顶/底背离）+ 背驰（两段 MACD 柱面积萎缩）
 * 说明：背离/背驰为技术形态识别，仅作复盘参考，不构成投资建议。
 * ========================================================== */

(function () {
  "use strict";

  var YI = 1e8;
  var SAME_API = (location.protocol === "http:" || location.protocol === "https:") ? "/api/" : null;
  var sameDead = false;

  /* 前复权（近端可靠，适合日/周/月） */
  var SRC_QFQ = (SAME_API ? [
    SAME_API + "qq/ifzqgtimg/appstock/app/newfqkline/get?param={C},day,,{E},{P},qfq"
  ] : []).concat([
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param={C},day,,{E},{P},qfq"
  ]);
  /* 不复权（长周期必备：腾讯前复权在 2016 年前会把价格算成负数，季K 会因此失真） */
  var SRC_RAW = (SAME_API ? [
    SAME_API + "qq2/appstock/app/kline/kline?param={C},day,,{E},{P}"
  ] : []).concat([
    "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={C},day,,{E},{P}"
  ]);

  var PAGE = 800;      // 单次最多约 800 根，超出必须按结束日期向前翻页
  var PERIODS = [
    { k: "min",     n: "分时", min: true },
    { k: "day",     n: "日K", need: 60, target: 320,  raw: false },
    { k: "week",    n: "周K", need: 60, target: 600,  raw: false },
    { k: "month",   n: "月K", need: 60, target: 1500, raw: false },
    { k: "quarter", n: "季K", need: 60, target: 3600, raw: true }
  ];

  var C = {
    up: "#e63946",        // A 股习惯：涨红
    down: "#1a9e5f",      // 跌绿
    flat: "#8a9099",
    ma5: "#f0a020", ma10: "#2f6fed", ma20: "#a855f7", ma60: "#5b6472",
    dif: "#e8a33d", dea: "#4d7cfe",
    grid: "#f2f3f5", axis: "#9aa0a8",
    tipBg: "rgba(24,27,33,.97)", tipBd: "rgba(255,255,255,.18)"
  };

  var state = {
    open: false, info: null, period: "day",
    rows: [], all: null, charts: {}, cache: {}, reqId: 0, thin: false, min: null, volUnit: 1
  };

  /* ---------------- 工具 ---------------- */
  function num(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }
  function avg(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function sign(v) { return v > 0 ? "+" : ""; }
  function pctTxt(v) { return (v > 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function fmtVol(v) {
    if (v == null) return "—";
    if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿股";
    if (v >= 1e4) return (v / 1e4).toFixed(1) + " 万股";
    return Math.round(v) + " 股";
  }
  function fmtNum(v, d) { return v == null ? "—" : v.toFixed(d == null ? 2 : d); }

  function quoteKey(info) {
    if (info.market === "hk") return "hk" + info.code;
    if (info.market === "us") return "us" + info.code;
    var c = String(info.code);
    if (/^[489]/.test(c)) return "bj" + c;      // 北交所
    return (c.charAt(0) === "6" ? "sh" : "sz") + c;
  }

  /* ---------------- 取数 ---------------- */
  function fetchPage(qk, endDate, useRaw) {
    var pool = useRaw ? SRC_RAW : SRC_QFQ;
    var list = [];
    for (var i = 0; i < pool.length; i++) {
      var isSame = pool[i].charAt(0) === "/";
      if (isSame && sameDead) continue;
      list.push(pool[i]);
    }
    var idx = 0;
    function next() {
      if (idx >= list.length) return Promise.reject(new Error("kline failed"));
      var url = list[idx++]
        .replace("{C}", qk)
        .replace("{E}", endDate || "")
        .replace("{P}", PAGE);
      var isSame = url.charAt(0) === "/";
      return fetch(url, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (j) {
        var o = (j && j.data && j.data[qk]) || {};
        var kl = o.qfqday || o.day || [];
        if (kl && kl.length) return kl;
        // 返 200 且有该股节点、只是 K 线为空 => 已翻到上市首日之前，属正常终止
        if (j && j.data && j.data[qk]) return [];
        throw new Error("empty");
      }).catch(function () {
        if (isSame) sameDead = true;
        return next();
      });
    }
    return next();
  }

  function dayBefore(s) {
    var t = new Date(s + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  }

  /* 按目标根数向前翻页取数，带内存缓存（qfq / raw 分开缓存） */
  function loadRows(qk, target, useRaw) {
    var ck = qk + (useRaw ? "|raw" : "|qfq");
    var cached = state.cache[ck];
    if (cached && cached.length >= target) return Promise.resolve(cached);
    var pages = 0;
    function step(all) {
      if (all.length >= target || pages >= 10) {
        state.cache[ck] = all;
        return Promise.resolve(all);
      }
      pages++;
      var end = all.length ? dayBefore(all[0].d) : "";
      return fetchPage(qk, end, useRaw).then(function (kl) {
        var rows = parseRows(kl);
        if (!rows.length) { state.cache[ck] = all; return all; }
        var merged = rows.concat(all);
        // 去重（同一日期只保留一条）
        var seen = {}, out = [];
        for (var i = 0; i < merged.length; i++) {
          var k = merged[i].d;
          if (seen[k]) continue;
          seen[k] = 1;
          out.push(merged[i]);
        }
        out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
        if (out.length === all.length) { state.cache[ck] = all; return all; }
        return step(out);
      });
    }
    return step(cached ? cached.slice() : []);
  }

  function parseRows(kl) {
    var out = [];
    for (var i = 0; i < kl.length; i++) {
      var d = kl[i];
      if (!d || d.length < 6) continue;
      var o = num(d[1]), c = num(d[2]), h = num(d[3]), l = num(d[4]), v = num(d[5]), amt = num(d[8]);
      if (o == null || c == null || h == null || l == null) continue;
      if (o <= 0 || c <= 0 || h <= 0 || l <= 0) continue;   // 前复权早期可能出现 0/负值，直接丢弃
      out.push({ d: String(d[0]), o: o, c: c, h: Math.max(h, o, c), l: Math.min(l, o, c), v: v || 0, amt: amt || 0 });
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    // 腾讯同一接口对不同市场的成交量单位不一致（科创板按股、主板按手）：
    // 用「成交额 ÷ (量 × 收盘)」自洽推断，把量统一折算成「股」
    if (out.length) {
      var k = out[out.length - 1];
      if (k.amt > 0 && k.v > 0 && k.c > 0) {
        var ratio = (k.amt * 1e4) / (k.v * k.c);
        state.volUnit = ratio > 10 ? 100 : 1;
      }
      // 不复权接口没有成交额字段，沿用同一只股票已判定的单位
      if (state.volUnit === 100) for (var j = 0; j < out.length; j++) out[j].v = out[j].v * 100;
    }
    return out;
  }

  /* ---------------- 周期聚合 ---------------- */
  function keyOf(dateStr, mode) {
    var p = dateStr.split("-");
    var y = +p[0], m = +p[1], d = +p[2];
    if (mode === "month") return y + "-" + String(m).padStart(2, "0");
    if (mode === "quarter") return y + "Q" + (Math.floor((m - 1) / 3) + 1);
    if (mode === "week") {                     // 自然周：周一为一周起点
      var t = new Date(Date.UTC(y, m - 1, d));
      var wd = t.getUTCDay() || 7;             // 周日=0 → 7
      t.setUTCDate(t.getUTCDate() - wd + 1);   // 归到本周一
      var wy = t.getUTCFullYear();
      var start = new Date(Date.UTC(wy, 0, 1));
      var w = Math.floor((t - start) / 86400000 / 7) + 1;
      return wy + "-W" + String(w).padStart(2, "0");
    }
    return dateStr;
  }

  function aggregate(rows, mode) {
    if (mode === "day") return rows.slice();
    var out = [], curKey = null, cur = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], k = keyOf(r.d, mode);
      if (k !== curKey) {
        if (cur) out.push(cur);
        curKey = k;
        cur = { d: r.d, o: r.o, c: r.c, h: r.h, l: r.l, v: r.v, key: k };
      } else {
        cur.c = r.c;
        if (r.h > cur.h) cur.h = r.h;
        if (r.l < cur.l) cur.l = r.l;
        cur.v += r.v;
        cur.d_end = r.d;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* 剔除失真的早期数据：前复权历史价可能被算成极小值（甚至负数），会把 y 轴拉垮 */
  function cleanSeries(rows) {
    if (!rows.length) return rows;
    var base = rows[rows.length - 1].c;
    if (!(base > 0)) return rows;
    var out = rows.filter(function (r) { return r.c >= base * 0.02 && r.c <= base * 60; });
    return out.length >= 8 ? out : rows;
  }

  function labelOf(r, mode) {
    if (mode === "day") return r.d.slice(5);
    if (mode === "week") return r.key.slice(2).replace("-W", "/W");
    if (mode === "month") return r.key.slice(2);
    return r.key.slice(2);
  }

  /* ---------------- 指标 ---------------- */
  function maArr(closes, n) {
    var out = [], s = 0;
    for (var i = 0; i < closes.length; i++) {
      s += closes[i];
      if (i >= n) s -= closes[i - n];
      out.push(i >= n - 1 ? s / n : null);
    }
    return out;
  }

  function emaArr(vals, n) {
    var k = 2 / (n + 1), out = [], prev = null;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v == null) { out.push(null); continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function macdArr(closes) {
    var e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
    var dif = [], i;
    for (i = 0; i < closes.length; i++) dif.push((e12[i] == null || e26[i] == null) ? null : e12[i] - e26[i]);
    var dea = emaArr(dif, 9);
    var hist = [];
    for (i = 0; i < closes.length; i++) {
      hist.push((dif[i] == null || dea[i] == null) ? null : (dif[i] - dea[i]) * 2);
    }
    return { dif: dif, dea: dea, hist: hist };
  }

  function pearson(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 4) return null;
    var ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sa = 0, sb = 0, sab = 0;
    for (i = 0; i < n; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      sa += da * da; sb += db * db; sab += da * db;
    }
    if (sa <= 0 || sb <= 0) return null;
    return sab / Math.sqrt(sa * sb);
  }

  /* ---------------- 量价关系判断 ---------------- */
  function judgeVP(rows) {
    var n = rows.length;
    if (n < 12) return null;
    var c = rows.map(function (r) { return r.c; });
    var v = rows.map(function (r) { return r.v; });

    var i5 = Math.max(0, n - 5);
    var pct5 = c[i5] > 0 ? (c[n - 1] / c[i5] - 1) * 100 : 0;
    var vol5 = avg(v.slice(n - 5)) || 0;
    var volP = avg(v.slice(Math.max(0, n - 10), n - 5)) || 0;
    var vr = volP > 0 ? vol5 / volP : 1;

    var rets = [], dvol = [];
    for (var i = Math.max(1, n - 20); i < n; i++) {
      if (c[i - 1] > 0) rets.push(c[i] / c[i - 1] - 1);
      if (v[i - 1] > 0) dvol.push(v[i] / v[i - 1] - 1);
    }
    var corr = pearson(rets, dvol);

    // OBV：近 20 根累计（以区间总量归一，避免量纲问题）
    var obv = 0, obvStart = Math.max(1, n - 20), totV = 0;
    for (i = obvStart; i < n; i++) {
      var dir = c[i] > c[i - 1] ? 1 : c[i] < c[i - 1] ? -1 : 0;
      obv += dir * v[i];
      totV += v[i];
    }
    var obvPct = totV > 0 ? obv / totV * 100 : 0;

    // 60 根区间位置
    var hi = -Infinity, lo = Infinity;
    for (i = 0; i < n; i++) { if (rows[i].h > hi) hi = rows[i].h; if (rows[i].l < lo) lo = rows[i].l; }
    var pos = hi > lo ? (c[n - 1] - lo) / (hi - lo) * 100 : 50;

    var tag, tone, note;
    var up = pct5 >= 0;
    if (up && vr >= 1.08) { tag = "放量上涨"; tone = "good"; note = "增量资金推动，量价配合，趋势相对健康"; }
    else if (up && vr <= 0.92) { tag = "缩量上涨"; tone = "warn"; note = "量能跟不上价格，上攻动能在衰减，注意滞涨"; }
    else if (!up && vr >= 1.08) { tag = "放量下跌"; tone = "bad"; note = "下跌伴随放量，抛压集中释放，短线偏弱"; }
    else if (!up && vr <= 0.92) { tag = "缩量下跌"; tone = "mild"; note = "抛压有所减轻，但仍需等待放量企稳信号"; }
    else { tag = up ? "温和上涨" : "温和下跌"; tone = "flat"; note = "量能基本持平，方向未明"; }

    return {
      tag: tag, tone: tone, note: note,
      pct5: pct5, vr: vr, vol5: vol5, volP: volP,
      corr: corr, obvPct: obvPct, pos: pos, hi: hi, lo: lo
    };
  }

  /* ---------------- 背离 / 背驰 ---------------- */
  function pivots(rows, win) {
    var highs = [], lows = [];
    for (var i = win; i < rows.length - win; i++) {
      var isH = true, isL = true;
      for (var j = i - win; j <= i + win; j++) {
        if (j === i) continue;
        if (rows[j].h >= rows[i].h) isH = false;
        if (rows[j].l <= rows[i].l) isL = false;
      }
      if (isH) highs.push(i);
      if (isL) lows.push(i);
    }
    return { highs: highs, lows: lows };
  }

  function segArea(hist, from, to, positive) {
    var a = 0;
    for (var i = Math.max(0, from); i <= to && i < hist.length; i++) {
      var h = hist[i];
      if (h == null) continue;
      if (positive && h > 0) a += h;
      if (!positive && h < 0) a += -h;
    }
    return a;
  }

  function judgeDiverge(rows, m) {
    var n = rows.length;
    if (n < 20) return { type: "none" };
    var win = n >= 45 ? 3 : 2;
    var pv = pivots(rows, win);
    var dif = m.dif, hist = m.hist;

    function pick(list) {
      var out = [];
      for (var i = list.length - 1; i >= 0 && out.length < 2; i--) {
        var idx = list[i];
        if (dif[idx] == null) continue;
        if (out.length && Math.abs(out[0] - idx) < 5) continue;
        out.unshift(idx);
      }
      return out.length === 2 ? out : null;
    }

    var res = { type: "none" };

    // 顶背离：后高点价格更高、DIF 更低
    var hs = pick(pv.highs);
    if (hs) {
      var a = hs[0], b = hs[1];
      if (rows[b].h > rows[a].h * 1.001 && dif[b] < dif[a]) {
        var lowA = lastLowBefore(pv.lows, a), lowB = lastLowBefore(pv.lows, b);
        var areaA = segArea(hist, lowA, a, true);
        var areaB = segArea(hist, lowB, b, true);
        var shrink = areaA > 0 ? (1 - areaB / areaA) * 100 : 0;
        res = {
          type: "top", label: "顶背离",
          gap: b - a,
          priceA: rows[a].h, priceB: rows[b].h,
          difA: dif[a], difB: dif[b],
          areaA: areaA, areaB: areaB, shrink: shrink,
          beat: areaA > 0 && areaB < areaA * 0.78,
          dateA: rows[a].d, dateB: rows[b].d
        };
        return res;
      }
    }

    // 底背离：后低点价格更低、DIF 更高
    var ls = pick(pv.lows);
    if (ls) {
      var c1 = ls[0], c2 = ls[1];
      if (rows[c2].l < rows[c1].l * 0.999 && dif[c2] > dif[c1]) {
        var hiA = lastHighBefore(pv.highs, c1), hiB = lastHighBefore(pv.highs, c2);
        var areaC = segArea(hist, hiA, c1, false);
        var areaD = segArea(hist, hiB, c2, false);
        var shrink2 = areaC > 0 ? (1 - areaD / areaC) * 100 : 0;
        res = {
          type: "bottom", label: "底背离",
          gap: c2 - c1,
          priceA: rows[c1].l, priceB: rows[c2].l,
          difA: dif[c1], difB: dif[c2],
          areaA: areaC, areaB: areaD, shrink: shrink2,
          beat: areaC > 0 && areaD < areaC * 0.78,
          dateA: rows[c1].d, dateB: rows[c2].d
        };
      }
    }
    return res;
  }

  function lastLowBefore(lows, idx) {
    var best = null;
    for (var i = 0; i < lows.length; i++) if (lows[i] < idx) best = lows[i]; else break;
    return best == null ? Math.max(0, idx - 12) : best;
  }
  function lastHighBefore(highs, idx) {
    var best = null;
    for (var i = 0; i < highs.length; i++) if (highs[i] < idx) best = highs[i]; else break;
    return best == null ? Math.max(0, idx - 12) : best;
  }

  /* ---------------- 结构 ---------------- */
  var STYLE_ID = "kpStyle";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ""
      + ".kp-mask{position:fixed;inset:0;background:rgba(17,20,26,.55);backdrop-filter:blur(2px);z-index:9000;display:none;align-items:center;justify-content:center;padding:20px}"
      + ".kp-mask.on{display:flex}"
      + ".kp-box{background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.28);width:min(1120px,100%);max-height:calc(100vh - 40px);display:flex;flex-direction:column;overflow:hidden}"
      + ".kp-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #eef0f3;flex-wrap:wrap}"
      + ".kp-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}"
      + ".kp-title b{font-size:16px}"
      + ".kp-code{font-size:12px;color:#8a9099;font-variant-numeric:tabular-nums}"
      + ".kp-price{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}"
      + ".kp-pct{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}"
      + ".kp-pct.up{color:#e63946}.kp-pct.down{color:#1a9e5f}.kp-pct.flat{color:#8a9099}"
      + ".kp-tabs{margin-left:auto;display:flex;gap:4px;background:#f4f5f7;border-radius:9px;padding:3px}"
      + ".kp-tab{border:0;background:transparent;border-radius:7px;padding:6px 12px;font-size:12.5px;color:#6b7280;cursor:pointer;font-family:inherit;transition:.15s}"
      + ".kp-tab:hover{color:#2f6fed}"
      + ".kp-tab.on{background:#fff;color:#1f2329;font-weight:600;box-shadow:0 1px 3px rgba(16,24,40,.12)}"
      + ".kp-x{border:0;background:transparent;font-size:20px;line-height:1;color:#9aa0a8;cursor:pointer;padding:2px 6px;border-radius:6px}"
      + ".kp-x:hover{background:#f4f5f7;color:#1f2329}"
      + ".kp-body{padding:10px 16px 14px;overflow:auto;-webkit-overflow-scrolling:touch}"
      + ".kp-verdict{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}"
      + ".kp-chip{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid transparent;white-space:nowrap}"
      + ".kp-chip.good{background:#e8f7ef;color:#0f7a48;border-color:#c6ecd8}"
      + ".kp-chip.warn{background:#fff5e6;color:#a85400;border-color:#ffe0b2}"
      + ".kp-chip.bad{background:#fdecee;color:#b3242f;border-color:#f8d0d5}"
      + ".kp-chip.mild{background:#eefaf3;color:#137a4a;border-color:#cfeeda}"
      + ".kp-chip.flat{background:#f2f4f7;color:#5b6472;border-color:#e4e7ec}"
      + ".kp-chip.info{background:#eef2fb;color:#2f5fd0;border-color:#dbe4fa}"
      + ".kp-chart{position:relative;height:300px}"
      + ".kp-sub{position:relative;height:92px;margin-top:2px}"
      + ".kp-sub.macd{height:118px}"
      + ".kp-foot{margin-top:8px;border-top:1px dashed #eceef2;padding-top:8px;font-size:12px;color:#5b6472;line-height:1.85}"
      + ".kp-foot b{color:#1f2329;font-weight:600}"
      + ".kp-foot .row{display:flex;gap:16px;flex-wrap:wrap}"
      + ".kp-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.82);font-size:13px;color:#6b7280;z-index:2;border-radius:8px}"
      + ".kp-load.hide{display:none}"
      + "@media (max-width:720px){"
      + ".kp-mask{padding:0}.kp-box{width:100%;max-height:100%;border-radius:0}"
      + ".kp-body{overflow-y:auto}"
      + ".kp-head{padding:10px 12px 8px;gap:8px;position:relative}"
      + ".kp-title{padding-right:36px;flex:1 1 100%}"
      + ".kp-x{position:absolute;top:6px;right:6px;font-size:22px;padding:4px 8px}"
      + ".kp-tabs{width:100%;margin-left:0;justify-content:space-between;flex-wrap:nowrap}"
      + ".kp-tab{flex:1;padding:6px 4px;font-size:12px;white-space:nowrap}"
      + ".kp-body{padding:8px 12px 14px}"
      + ".kp-chart{height:230px}.kp-sub{height:78px}.kp-sub.macd{height:96px}"
      + ".kp-price{font-size:15px}.kp-title b{font-size:15px}"
      + "}";
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureDom() {
    injectStyle();
    if (document.getElementById("kpMask")) return;
    var mask = document.createElement("div");
    mask.className = "kp-mask";
    mask.id = "kpMask";
    mask.innerHTML = ''
      + '<div class="kp-box" role="dialog" aria-modal="true" aria-label="个股K线研判">'
      + '  <div class="kp-head">'
      + '    <div class="kp-title"><b id="kpName">—</b><span class="kp-code" id="kpCode"></span>'
      + '      <span class="kp-price" id="kpPrice">—</span><span class="kp-pct" id="kpPct"></span></div>'
      + '    <div class="kp-tabs" id="kpTabs"></div>'
      + '    <button class="kp-x" id="kpClose" title="关闭（Esc）">×</button>'
      + '  </div>'
      + '  <div class="kp-body">'
      + '    <div class="kp-verdict" id="kpVerdict"></div>'
      + '    <div class="kp-chart"><canvas id="kpMain"></canvas><div class="kp-load" id="kpLoad">加载 K 线…</div></div>'
      + '    <div class="kp-sub"><canvas id="kpVol"></canvas></div>'
      + '    <div class="kp-sub macd"><canvas id="kpMacd"></canvas></div>'
      + '    <div class="kp-foot" id="kpFoot"></div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(mask);

    var tabs = "";
    for (var i = 0; i < PERIODS.length; i++) {
      tabs += '<button class="kp-tab' + (i === 0 ? " on" : "") + '" data-p="' + PERIODS[i].k + '">' + PERIODS[i].n + "</button>";
    }
    mask.querySelector("#kpTabs").innerHTML = tabs;

    mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
    mask.querySelector("#kpClose").onclick = close;
    mask.querySelector("#kpTabs").addEventListener("click", function (e) {
      var b = e.target.closest(".kp-tab");
      if (!b || b.classList.contains("on")) return;
      var tabsEls = mask.querySelectorAll(".kp-tab");
      for (var i = 0; i < tabsEls.length; i++) tabsEls[i].classList.toggle("on", tabsEls[i] === b);
      state.period = b.dataset.p;
      loadAndDraw();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) close();
    });
  }

  /* ---------------- 绘制 ---------------- */
  function destroyCharts() {
    Object.keys(state.charts).forEach(function (k) {
      try { state.charts[k].destroy(); } catch (e) {}
    });
    state.charts = {};
  }

  var TIP = {
    backgroundColor: C.tipBg,
    borderColor: C.tipBd,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 10,
    displayColors: false,
    titleColor: "#ffffff",
    bodyColor: "#e9edf3",
    titleFont: { size: 12, weight: "600" },
    bodyFont: { size: 11.5 },
    bodySpacing: 4,
    caretSize: 6
  };

  function drawAll() {
    destroyCharts();
    var macdBox = document.querySelector(".kp-sub.macd");
    if (macdBox) macdBox.style.display = "";
    var chartBox = document.querySelector(".kp-chart");
    if (chartBox) chartBox.style.height = "";
    var rows = state.rows;
    var mode = state.period;
    var labels = rows.map(function (r) { return labelOf(r, mode); });
    var closes = rows.map(function (r) { return r.c; });
    var m = macdArr(closes);

    var ma5 = maArr(closes, 5), ma10 = maArr(closes, 10), ma20 = maArr(closes, 20), ma60 = maArr(closes, 60);

    var wick = [], body = [], wickC = [], bodyC = [], volC = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var isUp = r.c >= r.o;
      var col = isUp ? C.up : C.down;
      wick.push([r.l, r.h]);
      body.push([Math.min(r.o, r.c), Math.max(r.o, r.c)]);
      wickC.push(col); bodyC.push(col); volC.push(col);
    }

    // 主图 y 轴必须贴合价格区间：Chart.js 的 bar 默认从 0 起算，
    // 高价股（如茅台 1400+）会被压成一条直线，新股则下方留出大片空白
    var yLo = Infinity, yHi = -Infinity;
    for (var bi = 0; bi < rows.length; bi++) {
      if (rows[bi].l < yLo) yLo = rows[bi].l;
      if (rows[bi].h > yHi) yHi = rows[bi].h;
    }
    var maSets = [ma5, ma10, ma20, ma60];
    for (var mi = 0; mi < maSets.length; mi++) {
      for (var mj = 0; mj < maSets[mi].length; mj++) {
        var mv = maSets[mi][mj];
        if (mv == null) continue;
        if (mv < yLo) yLo = mv;
        if (mv > yHi) yHi = mv;
      }
    }
    if (!isFinite(yLo) || !isFinite(yHi) || yHi <= yLo) { yLo = 0; yHi = 1; }
    var padY = (yHi - yLo) * 0.08;
    // 让主图出现 4~6 条刻度线（Chart.js 默认步长太粗，高价股只剩 2 条）
    var spanY = (yHi + padY) - (yLo - padY);
    var rawStep = spanY / 6;
    var magY = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    var normY = (rawStep || 1) / magY;
    var stepY = (normY <= 1 ? 1 : normY <= 2 ? 2 : normY <= 2.5 ? 2.5 : normY <= 5 ? 5 : 10) * magY;
    // 边界对齐到步长整数倍，刻度才会落在 1200/1300/1400 这种整齐值上
    var yMin = Math.floor((yLo - padY) / stepY) * stepY;
    var yMax = Math.ceil((yHi + padY) / stepY) * stepY;

    var compact = window.innerWidth < 720;
    var axisFont = { size: compact ? 9 : 10 };
    var yCommon = {
      position: "right", border: { display: false },
      grid: { color: C.grid, drawTicks: false },
      ticks: { font: axisFont, color: C.axis, maxTicksLimit: compact ? 4 : 6, padding: 4 }
    };

    /* 主图：K 线 + 均线 */
    state.charts.main = new Chart(document.getElementById("kpMain").getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { label: "影线", data: wick, backgroundColor: wickC, borderWidth: 0, barThickness: 1.2, maxBarThickness: 2, order: 4 },
          { label: "K线", data: body, backgroundColor: bodyC, borderColor: bodyC, borderWidth: 0.6,
            barPercentage: 0.66, categoryPercentage: 0.92, maxBarThickness: 26, order: 3 },
          { type: "line", label: "MA5", data: ma5, borderColor: C.ma5, borderWidth: 1.2, pointRadius: 0, tension: 0, order: 2 },
          { type: "line", label: "MA10", data: ma10, borderColor: C.ma10, borderWidth: 1.2, pointRadius: 0, tension: 0, order: 2 },
          { type: "line", label: "MA20", data: ma20, borderColor: C.ma20, borderWidth: 1.3, pointRadius: 0, tension: 0, order: 2 },
          { type: "line", label: "MA60", data: ma60, borderColor: C.ma60, borderWidth: 1.1, pointRadius: 0, tension: 0, order: 2 }
        ]
      },
      options: {
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4 } },
        scales: {
          x: { display: false, grid: { display: false } },
          y: Object.assign({}, yCommon, {
            beginAtZero: false, min: yMin, max: yMax,
            ticks: Object.assign({}, yCommon.ticks, {
              callback: function (v) { return v >= 100 ? v.toFixed(0) : v.toFixed(2); }
            })
          })
        },
        plugins: {
          legend: {
            position: "top", align: "end",
            labels: {
              boxWidth: 8, boxHeight: 8, padding: 10, font: { size: compact ? 9.5 : 10.5 }, color: "#5b6472",
              filter: function (it) { return it.text !== "影线"; }
            }
          },
          tooltip: Object.assign({}, TIP, {
            callbacks: {
              title: function (its) { return its.length ? rows[its[0].dataIndex].d : ""; },
              label: function (c) {
                if (c.datasetIndex !== 1) return null;
                var r = rows[c.dataIndex];
                var pre = c.dataIndex > 0 ? rows[c.dataIndex - 1].c : r.o;
                var pct = pre ? (r.c - pre) / pre * 100 : 0;
                var out = [
                  "开 " + r.o.toFixed(2) + "   收 " + r.c.toFixed(2),
                  "高 " + r.h.toFixed(2) + "   低 " + r.l.toFixed(2),
                  "涨跌 " + pctTxt(pct) + "   量 " + fmtVol(r.v)
                ];
                var mas = [["MA5", ma5], ["MA10", ma10], ["MA20", ma20], ["MA60", ma60]];
                var parts = [];
                for (var k = 0; k < mas.length; k++) {
                  if (mas[k][1][c.dataIndex] != null) parts.push(mas[k][0] + " " + mas[k][1][c.dataIndex].toFixed(2));
                }
                if (parts.length) out.push(parts.join("  "));
                return out;
              }
            }
          })
        }
      }
    });

    /* 成交量 */
    var volMax = 0;
    for (var j = 0; j < rows.length; j++) if (rows[j].v > volMax) volMax = rows[j].v;
    state.charts.vol = new Chart(document.getElementById("kpVol").getContext("2d"), {
      type: "bar",
      data: { labels: labels, datasets: [{ label: "成交量", data: rows.map(function (r) { return r.v; }), backgroundColor: volC, borderWidth: 0, barPercentage: 0.66, categoryPercentage: 0.92, maxBarThickness: 26 }] },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: Object.assign({}, yCommon, {
            beginAtZero: true, suggestedMax: volMax * 1.05,
            ticks: { font: axisFont, color: C.axis, maxTicksLimit: 2, padding: 4,
              callback: function (v) { return v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : (v / 1e4).toFixed(0) + "万"; } }
          })
        },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, TIP, {
            callbacks: {
              title: function (its) { return its.length ? "成交量 " + rows[its[0].dataIndex].d : ""; },
              label: function (c) {
                var r = rows[c.dataIndex];
                var pre5 = [], from = Math.max(0, c.dataIndex - 5);
                for (var t = from; t < c.dataIndex; t++) pre5.push(rows[t].v);
                var m5 = avg(pre5);
                return [fmtVol(r.v), m5 > 0 ? ("近 5 根均量 " + fmtVol(m5) + "（" + (r.v / m5).toFixed(2) + " 倍）") : ""];
              }
            }
          })
        }
      }
    });

    /* MACD */
    var histC = m.hist.map(function (v) { return v == null ? C.flat : (v >= 0 ? C.up : C.down); });
    state.charts.macd = new Chart(document.getElementById("kpMacd").getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { label: "MACD", data: m.hist, backgroundColor: histC, borderWidth: 0, barPercentage: 0.6, categoryPercentage: 0.9, maxBarThickness: 24, order: 3 },
          { type: "line", label: "DIF", data: m.dif, borderColor: C.dif, borderWidth: 1.3, pointRadius: 0, tension: 0, order: 2 },
          { type: "line", label: "DEA", data: m.dea, borderColor: C.dea, borderWidth: 1.3, pointRadius: 0, tension: 0, order: 2 }
        ]
      },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: axisFont, color: C.axis, maxRotation: 0, autoSkip: true, maxTicksLimit: compact ? 4 : 7, padding: 2 }
          },
          y: Object.assign({}, yCommon, {
            ticks: { font: axisFont, color: C.axis, maxTicksLimit: 3, padding: 4,
              callback: function (v) { return Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2); } }
          })
        },
        plugins: {
          legend: {
            position: "top", align: "end",
            labels: { boxWidth: 8, boxHeight: 8, padding: 8, font: { size: compact ? 9.5 : 10.5 }, color: "#5b6472" }
          },
          tooltip: Object.assign({}, TIP, {
            callbacks: {
              title: function (its) { return its.length ? "MACD " + rows[its[0].dataIndex].d : ""; },
              label: function (c) {
                var i = c.dataIndex;
                if (c.datasetIndex === 1) return "DIF " + fmtNum(m.dif[i], 3);
                if (c.datasetIndex === 2) return "DEA " + fmtNum(m.dea[i], 3);
                return "柱 " + fmtNum(m.hist[i], 3);
              }
            }
          })
        }
      }
    });

    renderVerdict(rows, m);
  }

  /* ---------------- 结论区 ---------------- */
  function chip(txt, tone) { return '<span class="kp-chip ' + tone + '">' + txt + "</span>"; }

  function renderVerdict(rows, m) {
    var vp = judgeVP(rows);
    var dv = judgeDiverge(rows, m);
    var closes = rows.map(function (r) { return r.c; });
    var ma20 = maArr(closes, 20);
    var last = rows.length - 1;
    var ma20v = ma20[last];
    var ma60 = maArr(closes, 60);
    var ma60v = ma60[last];
    var hist = m.hist;
    var histNow = hist[last];

    var thin = rows.length < 20;
    var chips = [];
    if (thin) chips.push(chip("样本仅 " + rows.length + " 根", "flat"));
    if (vp) chips.push(chip(vp.tag, vp.tone));
    if (dv.type === "top") chips.push(chip(dv.beat ? "顶背离 · 背驰" : "顶背离", "bad"));
    else if (dv.type === "bottom") chips.push(chip(dv.beat ? "底背离 · 背驰" : "底背离", "good"));
    else chips.push(chip("未见有效背离", "flat"));

    if (ma20v != null) chips.push(chip(closes[last] >= ma20v ? "MA20 上方" : "MA20 下方", closes[last] >= ma20v ? "info" : "flat"));
    if (ma60v != null) chips.push(chip(closes[last] >= ma60v ? "MA60 上方" : "MA60 下方", "flat"));
    if (histNow != null) chips.push(chip(histNow >= 0 ? "MACD 红柱" : "MACD 绿柱", histNow >= 0 ? "bad" : "mild"));

    document.getElementById("kpVerdict").innerHTML = chips.join("");

    var lines = [];
    if (!vp && thin) {
      lines.push("<b>量价</b>　样本仅 " + rows.length + " 根，量价四象限与相关性需要至少 12 根才具统计意义，暂不判定。");
    }
    if (vp) {
      lines.push("<b>量价</b>　近 5 根 " + pctTxt(vp.pct5) + "，量能 " + vp.vr.toFixed(2) + " 倍（近 5 根均量 "
        + fmtVol(vp.vol5) + " / 前 5 根 " + fmtVol(vp.volP) + "）→ " + vp.tag
        + "。" + vp.note + "。");
      var corrTxt = vp.corr == null ? "样本不足" : (vp.corr >= 0.3 ? "正相关（量价配合）" : vp.corr <= -0.3 ? "负相关（价量背离）" : "弱相关");
      lines.push("<b>结构</b>　20 根量价相关 " + (vp.corr == null ? "—" : sign(vp.corr) + vp.corr.toFixed(2))
        + "（" + corrTxt + "）；OBV 20 根净流入占比 " + sign(vp.obvPct) + vp.obvPct.toFixed(1) + "%；"
        + "当前价处于区间 " + vp.pos.toFixed(0) + "% 分位（" + vp.lo.toFixed(2) + " ~ " + vp.hi.toFixed(2) + "）。");
    }

    if (dv.type !== "none") {
      var isTop = dv.type === "top";
      lines.push("<b>背离</b>　" + dv.label + "：价格由 " + (isTop ? dv.priceA.toFixed(2) : dv.priceA.toFixed(2)) + " → " + dv.priceB.toFixed(2)
        + "（" + (isTop ? "新高" : "新低") + "），DIF 由 " + dv.difA.toFixed(3) + " → " + dv.difB.toFixed(3)
        + "（" + (isTop ? "未新高" : "未新低") + "），跨度 " + dv.gap + " 根。");
      lines.push("<b>背驰</b>　两段 MACD " + (isTop ? "红柱" : "绿柱") + "面积 " + dv.areaA.toFixed(2) + " → " + dv.areaB.toFixed(2)
        + "（" + (dv.shrink >= 0 ? "萎缩 " + dv.shrink.toFixed(0) + "%" : "扩张 " + Math.abs(dv.shrink).toFixed(0) + "%") + "），"
        + (dv.beat ? "<b>后段动能明显弱于前段，构成背驰</b>，趋势进入衰竭区。" : "面积尚未明显萎缩，形态成立但动能未衰竭，暂不构成标准背驰。"));
    } else {
      if (thin) {
        lines.push("<b>背离</b>　样本仅 " + rows.length + " 根（新股或长周期），不足以构成两个同向极值点，"
          + "背离 / 背驰暂不判定；切到日K 或等上市满 20 个周期后再看。");
      } else {
        lines.push("<b>背离</b>　本区间内未找到满足条件的两个同向极值点，MACD 与价格同步，暂无背离信号。");
      }
    }

    var slope = null;
    if (ma20[last] != null && ma20[Math.max(0, last - 5)] != null) {
      slope = (ma20[last] / ma20[Math.max(0, last - 5)] - 1) * 100;
    }
    lines.push("<b>趋势</b>　MA20 " + (ma20v == null ? "—" : ma20v.toFixed(2)) + "（近 5 根 "
      + (slope == null ? "—" : pctTxt(slope)) + "），MA60 " + (ma60v == null ? "—" : ma60v.toFixed(2))
      + "；" + (ma20v == null ? "" : (closes[last] >= ma20v ? "价格在 MA20 上方运行，短中期偏强。" : "价格在 MA20 下方运行，短线偏弱。")));

    lines.push('<span style="color:#9aa0a8">背离 / 背驰为技术形态识别，需结合量能与大盘环境验证；不构成投资建议。</span>');
    document.getElementById("kpFoot").innerHTML = lines.map(function (s) { return "<div>" + s + "</div>"; }).join("");
  }

  /* ---------------- 分时 ---------------- */
  var MIN_SRC = (SAME_API ? [
    SAME_API + "qq2/appstock/app/minute/query?code={C}"
  ] : []).concat([
    "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={C}"
  ]);

  function fetchMinute(qk) {
    var list = [];
    for (var i = 0; i < MIN_SRC.length; i++) {
      var isSame = MIN_SRC[i].charAt(0) === "/";
      if (isSame && sameDead) continue;
      list.push(MIN_SRC[i]);
    }
    var idx = 0;
    function next() {
      if (idx >= list.length) return Promise.reject(new Error("分时接口不可用"));
      var url = list[idx++].replace("{C}", qk);
      var isSame = url.charAt(0) === "/";
      return fetch(url, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (j) {
        var o = (j && j.data && j.data[qk]) || {};
        var arr = (o.data && o.data.data) || [];
        if (!arr.length) throw new Error("今日无分时");
        var qt = (o.qt && o.qt[qk]) || [];
        return { arr: arr, prev: num(qt[4]), price: num(qt[3]), name: qt[1] || "", date: (o.data && o.data.date) || "" };
      }).catch(function () {
        if (isSame) sameDead = true;
        return next();
      });
    }
    return next();
  }

  /* 每行格式：HHMM 价格 累计成交量 累计成交额(元)
     成交量单位随市场不同（股 / 手），用「成交额 ÷ 量 ÷ 价」自洽判断后统一成股 */
  function parseMinute(raw) {
    var rows = [];
    for (var i = 0; i < raw.arr.length; i++) {
      var sp = String(raw.arr[i]).split(" ");
      if (sp.length < 3) continue;
      var p = num(sp[1]);
      if (p == null || p <= 0) continue;
      rows.push({ t: sp[0], p: p, cv: num(sp[2]), ca: num(sp[3]) });
    }
    if (!rows.length) return { pts: [], amt: 0 };

    var lastR = rows[rows.length - 1];
    var unit = 1;
    if (lastR.ca > 0 && lastR.cv > 0) {
      var g = lastR.ca / lastR.cv;              // 若量是「手」，这里会得到约 100 倍的价格
      if (g > lastR.p * 3) unit = 100;
    }

    var pts = [];
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var prevCv = i ? (rows[i - 1].cv || 0) : 0;
      var vol = r.cv == null ? 0 : Math.max(0, r.cv - prevCv) * unit;
      pts.push({
        t: r.t, p: r.p,
        avg: (r.ca > 0 && r.cv > 0 ? r.ca / (r.cv * unit) : r.p),
        vol: vol
      });
    }
    return { pts: pts, amt: lastR.ca || 0 };
  }

  function drawMinute() {
    destroyCharts();
    var d = state.min, pts = d.pts, prev = d.prev;
    var macdBox = document.querySelector(".kp-sub.macd");
    if (macdBox) macdBox.style.display = "none";
    var chartBox = document.querySelector(".kp-chart");
    if (chartBox) chartBox.style.height = (window.innerWidth < 720 ? "260px" : "380px");

    var labels = pts.map(function (x) { return x.t.slice(0, 2) + ":" + x.t.slice(2); });
    var prices = pts.map(function (x) { return x.p; });
    var avgs = pts.map(function (x) { return x.avg; });
    var vols = pts.map(function (x) { return x.vol; });
    var last = prices[prices.length - 1];
    var col = last >= prev ? C.up : C.down;

    var dev = 0;
    for (var i = 0; i < pts.length; i++) {
      dev = Math.max(dev, Math.abs(prices[i] - prev), Math.abs(avgs[i] - prev));
    }
    dev = Math.max(dev * 1.15, prev * 0.008);

    var compact = window.innerWidth < 720;
    var axisFont = { size: compact ? 9 : 10 };
    var flatLine = [];
    for (i = 0; i < pts.length; i++) flatLine.push(prev);
    var volC = pts.map(function (x, k) { return k && x.p < pts[k - 1].p ? C.down : C.up; });

    state.charts.main = new Chart(document.getElementById("kpMain").getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          { label: "昨收", data: flatLine, borderColor: C.flat, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0, order: 3 },
          { label: "价格", data: prices, borderColor: col, borderWidth: 1.4, pointRadius: 0, tension: 0,
            fill: true, backgroundColor: col + "16", order: 1 },
          { label: "均价", data: avgs, borderColor: C.ma5, borderWidth: 1.2, pointRadius: 0, tension: 0, order: 2 }
        ]
      },
      options: {
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4 } },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: axisFont, color: C.axis, maxRotation: 0, autoSkip: true, maxTicksLimit: compact ? 4 : 7, padding: 2 }
          },
          y: {
            position: "right",
            min: prev - dev, max: prev + dev,
            border: { display: false },
            grid: { color: C.grid, drawTicks: false },
            ticks: {
              font: axisFont, color: C.axis, maxTicksLimit: compact ? 4 : 6, padding: 4,
              callback: function (v) { return v.toFixed(prev >= 100 ? 0 : 2); }
            }
          }
        },
        plugins: {
          legend: {
            position: "top", align: "end",
            labels: { boxWidth: 8, boxHeight: 8, padding: 10, font: { size: compact ? 9.5 : 10.5 }, color: "#5b6472",
              filter: function (it) { return it.text !== "昨收"; } }
          },
          tooltip: Object.assign({}, TIP, {
            callbacks: {
              title: function (its) { return (d.date ? d.date + " " : "") + labels[its[0].dataIndex]; },
              label: function (c) {
                if (c.datasetIndex !== 1) return null;
                var r = pts[c.dataIndex];
                return [
                  "价 " + r.p.toFixed(2) + "   均 " + r.avg.toFixed(2),
                  "涨跌 " + pctTxt(prev ? (r.p - prev) / prev * 100 : 0) + "   分钟量 " + fmtVol(r.vol)
                ];
              }
            }
          })
        }
      }
    });

    var volMax = 0;
    for (i = 0; i < vols.length; i++) if (vols[i] > volMax) volMax = vols[i];
    state.charts.vol = new Chart(document.getElementById("kpVol").getContext("2d"), {
      type: "bar",
      data: { labels: labels, datasets: [{ label: "分钟量", data: vols, backgroundColor: volC, borderWidth: 0, barPercentage: 0.8, categoryPercentage: 0.96 }] },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            position: "right", beginAtZero: true, suggestedMax: volMax * 1.05,
            border: { display: false }, grid: { color: C.grid, drawTicks: false },
            ticks: { font: axisFont, color: C.axis, maxTicksLimit: 2, padding: 4,
              callback: function (v) { return v >= 1e4 ? (v / 1e4).toFixed(0) + "万" : v; } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, TIP, {
            callbacks: {
              title: function (its) { return labels[its[0].dataIndex] + " 分钟量"; },
              label: function (c) { return fmtVol(pts[c.dataIndex].vol); }
            }
          })
        }
      }
    });

    renderMinuteVerdict();
  }

  function renderMinuteVerdict() {
    var d = state.min, pts = d.pts, prev = d.prev;
    var lastP = pts[pts.length - 1];
    var prices = pts.map(function (x) { return x.p; });
    var hi = prices[0], lo = prices[0], sumVol = 0;
    for (var i = 0; i < prices.length; i++) {
      if (prices[i] > hi) hi = prices[i];
      if (prices[i] < lo) lo = prices[i];
      sumVol += pts[i].vol;
    }
    var upMin = 0, downMin = 0;
    for (i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) upMin++;
      else if (prices[i] < prices[i - 1]) downMin++;
    }
    var pct = prev ? (lastP.p - prev) / prev * 100 : 0;
    var devAvg = lastP.avg ? (lastP.p - lastP.avg) / lastP.avg * 100 : 0;
    var amp = prev ? (hi - lo) / prev * 100 : 0;
    var pos = hi > lo ? (lastP.p - lo) / (hi - lo) * 100 : 50;
    var total = upMin + downMin || 1;

    var chips = [];
    chips.push(chip(pct >= 0 ? "分时上涨" : "分时下跌", pct >= 0 ? "bad" : "good"));
    chips.push(chip(lastP.p >= lastP.avg ? "价在均价上方" : "价在均价下方", lastP.p >= lastP.avg ? "bad" : "good"));
    chips.push(chip("日内 " + pos.toFixed(0) + "% 位", pos >= 70 ? "bad" : pos <= 30 ? "good" : "flat"));
    chips.push(chip("上涨分钟 " + (upMin / total * 100).toFixed(0) + "%", upMin >= downMin ? "info" : "flat"));
    document.getElementById("kpVerdict").innerHTML = chips.join("");

    var lines = [];
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    lines.push("<b>分时</b>　" + (d.date || "今日") + " 共 " + pts.length + " 个分钟点（"
      + t0.slice(0, 2) + ":" + t0.slice(2) + "–" + t1.slice(0, 2) + ":" + t1.slice(2) + "），现价 "
      + lastP.p.toFixed(2) + "（" + pctTxt(pct) + "），昨收 " + prev.toFixed(2)
      + "，均价 " + lastP.avg.toFixed(2) + "（偏离 " + pctTxt(devAvg) + "）。");
    lines.push("<b>区间</b>　日内高 " + hi.toFixed(2) + " / 低 " + lo.toFixed(2) + "，振幅 " + amp.toFixed(2)
      + "%，现价处于日内 " + pos.toFixed(0) + "% 分位；上涨分钟 " + upMin + " / 下跌分钟 " + downMin + "。");
    lines.push("<b>量能</b>　累计成交 " + fmtVol(sumVol) + "，成交额 "
      + (d.amt >= 1e8 ? (d.amt / 1e8).toFixed(2) + " 亿" : (d.amt / 1e4).toFixed(0) + " 万") + "元。");
    lines.push('<span style="color:#9aa0a8">分时仅反映当日盘中强弱，需结合日线结构与量能判断；不构成投资建议。</span>');
    document.getElementById("kpFoot").innerHTML = lines.map(function (x) { return "<div>" + x + "</div>"; }).join("");
  }

  function syncTabs() {
    var els = document.querySelectorAll("#kpTabs .kp-tab");
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("on", els[i].dataset.p === state.period);
  }

  /* 名称/报价兜底：stocks.js 静态快照里没有的新股（如 688836 宇树科技-W）也能显示全 */
  function applyQuote(name, price, prev) {
    var info = state.info;
    if (!info) return;
    if (name && (!info.name || info.name === info.code)) {
      info.name = name;
      document.getElementById("kpName").textContent = name;
    }
    var priceEl = document.getElementById("kpPrice");
    var pctEl = document.getElementById("kpPct");
    if (price == null) return;
    if (info.price == null) info.price = price;
    var pct = (prev > 0) ? (price - prev) / prev * 100 : null;
    if (info.pct == null && pct != null) {
      info.pct = pct;
      pctEl.className = "kp-pct " + (pct > 0 ? "up" : pct < 0 ? "down" : "flat");
      pctEl.textContent = pctTxt(pct);
    }
    priceEl.style.display = "";
    priceEl.textContent = price.toFixed(2);
    priceEl.style.color = (info.pct > 0) ? C.up : (info.pct < 0) ? C.down : C.flat;
  }

  function loadMinute(qk, reqId) {
    var loadEl = document.getElementById("kpLoad");
    loadEl.classList.remove("hide");
    loadEl.textContent = "加载分时…";
    destroyCharts();

    fetchMinute(qk).then(function (raw) {
      if (reqId !== state.reqId) return;
      var parsed = parseMinute(raw);
      if (parsed.pts.length < 2) throw new Error("今日无成交");
      var pv = raw.prev || parsed.pts[0].p;
      state.min = { pts: parsed.pts, prev: pv, amt: parsed.amt, date: raw.date, name: raw.name };
      applyQuote(raw.name, raw.price, pv);
      loadEl.classList.add("hide");
      drawMinute();
    }).catch(function () {
      if (reqId !== state.reqId) return;
      if (state.period !== "min") return;
      // 分时不可用（停牌/未开盘/接口异常）→ 自动回退日K，保证面板能用
      state.period = "day";
      syncTabs();
      loadAndDraw();
    });
  }

  /* ---------------- 加载 ---------------- */
  function loadAndDraw() {
    var info = state.info;
    if (!info) return;
    var qk = quoteKey(info);
    var reqId = ++state.reqId;
    if (state.period === "min") { loadMinute(qk, reqId); return; }
    var p = PERIODS.filter(function (x) { return x.k === state.period; })[0] || PERIODS[1];

    var loadEl = document.getElementById("kpLoad");
    loadEl.classList.remove("hide");
    loadEl.textContent = "加载 " + p.n + "…";
    destroyCharts();          // 先清掉上一周期的图，避免加载期间看到错周期的旧图

    var task = loadRows(qk, p.target, p.raw).then(function (rows) {
      if (!rows.length) throw new Error("empty");
      return rows;
    });

    task.then(function (daily) {
      if (reqId !== state.reqId) return;
      var series = aggregate(daily, state.period);
      series = cleanSeries(series);
      if (series.length > p.need) series = series.slice(series.length - p.need);
      // 新股样本天然偏少（宇树科技 2026-08 上市，季K 仅 1~2 根），
      // 不能因为不足 60 根就判失败：够 2 根就画，另在结论区标注样本不足
      if (series.length < 2) throw new Error("上市不足一个周期，暂无" + p.n);
      state.thin = series.length < 20;
      state.rows = series;
      loadEl.classList.add("hide");
      drawAll();
    }).catch(function (e) {
      if (reqId !== state.reqId) return;
      loadEl.classList.remove("hide");
      loadEl.textContent = "K 线加载失败（" + (e && e.message ? e.message : "网络异常") + "），点击重试";
      loadEl.onclick = function () { loadEl.onclick = null; loadAndDraw(); };
    });
  }

  /* ---------------- 对外 ---------------- */
  function open(info) {
    ensureDom();
    state.info = info || {};
    state.volUnit = 1;
    state.period = "min";   // 盘中先看分时，日K/周K/月K/季K 一键切换
    state.rows = [];
    state.reqId++;
    var mask = document.getElementById("kpMask");
    mask.classList.add("on");
    state.open = true;
    document.body.style.overflow = "hidden";

    document.getElementById("kpName").textContent = info.name || info.code;
    document.getElementById("kpCode").textContent = info.code;
    var priceEl = document.getElementById("kpPrice");
    var pctEl = document.getElementById("kpPct");
    if (info.price != null) {
      priceEl.style.display = "";
      priceEl.textContent = info.price.toFixed(2);
    } else {
      priceEl.style.display = "none";
      priceEl.textContent = "";
    }
    if (info.pct != null) {
      var cls = info.pct > 0 ? "up" : info.pct < 0 ? "down" : "flat";
      pctEl.className = "kp-pct " + cls;
      pctEl.textContent = pctTxt(info.pct);
      priceEl.style.color = info.pct > 0 ? C.up : info.pct < 0 ? C.down : C.flat;
    } else {
      pctEl.className = "kp-pct flat"; pctEl.textContent = "";
      priceEl.style.color = "";
    }

    var tabs = mask.querySelectorAll(".kp-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].dataset.p === "min");

    destroyCharts();
    document.getElementById("kpVerdict").innerHTML = "";
    document.getElementById("kpFoot").innerHTML = "";
    loadAndDraw();
  }

  function close() {
    var mask = document.getElementById("kpMask");
    if (mask) mask.classList.remove("on");
    state.open = false;
    document.body.style.overflow = "";
    destroyCharts();
  }

  window.KPanel = { open: open, close: close };
})();
