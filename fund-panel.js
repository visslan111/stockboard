/* ===================== 资金看板模块 =====================
 * 依赖：页面已加载 Chart.js（chart.umd.min.js + zoom 插件）
 * 数据：腾讯 web.ifzq.gtimg.cn day/query（近5个交易日逐分钟累计成交额）
 *       东方财富 push2 ulist.np（实时主力净流入 f62）
 * 口径：B=本日累计成交额；A=前一交易日「同一时点」累计成交额；B-A=差值
 *       副图为每分钟量差（红=放量 / 绿=缩量）
 * ====================================================== */
(function () {
  "use strict";

  var YI = 1e8;
  /* 同源反代前缀：部署在自有服务器（含 Nginx /api/ 反代）时优先走它，
     可规避腾讯云 WAF 对客户端 IP 段的拦截、消除跨域、并复用服务端 15s 缓存。
     以 file:// 打开或部署到无 /api/ 的静态托管时自动回落直连。 */
  var SAME_API = (location.protocol === "http:" || location.protocol === "https:") ? "/api/" : null;
  var TENCENT = "https://web.ifzq.gtimg.cn/appstock/app/day/query?code=";
  var EM_ULIST = "https://push2.eastmoney.com/api/qt/ulist.np/get";
  var EM_FENBU = "https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt";
  var EM_FFLOW = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get";
  var EM_FFLOW_HIS = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get";
  var TENCENT_Q = "https://qt.gtimg.cn/q=";

  function okJson(r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
  var sameBroken = false;   /* 同源反代不可用后不再重试，避免每次刷新白跑一轮 */
  /* 同源优先 → 直连兜底 */
  function viaApi(samePath, directUrl, timeout) {
    if (SAME_API && !sameBroken) {
      return fetch(SAME_API + samePath, { cache: "no-store" })
        .then(okJson)
        .catch(function () {
          sameBroken = true;
          return fetch(directUrl, { cache: "no-store" }).then(okJson);
        })
        .catch(function () { return jsonp(directUrl, timeout); });
    }
    return fetch(directUrl, { cache: "no-store" }).then(okJson)
      .catch(function () { return jsonp(directUrl, timeout); });
  }
  var charts = { cum: null, min: null, vol: null, bd: null, fl: null };
  var timer = null;
  var state = { day: null, prev: null, isToday: false, at: null };
  /* 新增模块状态：涨跌分布 / 指数报价 / 主力资金流 */
  var breadth = null, quotes = null;
  var flow = { day: null, d60: null };
  var viewName = "breadth", flowTab = "day";
  var pending = { vol: true, flow: true };

  function isVis(el) { return !!(el && el.offsetParent !== null); }
  function dirOf(v) { return v == null ? "" : (v >= 0 ? "up" : "down"); }
  function setDirText(el, txt, v) {
    if (!el) return;
    el.textContent = txt;
    el.className = (el.className || "").replace(/\s*(up|down)\b/g, "") + (v == null ? "" : " " + dirOf(v));
  }
  /* 轴刻度取整：1 / 2 / 2.5 / 5 × 10^n，避免出现 2172.4亿 这类怪值 */
  function niceNum(v) {
    if (!(v > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var m = v / e;
    var n = m <= 1 ? 1 : (m <= 2 ? 2 : (m <= 2.5 ? 2.5 : (m <= 5 ? 5 : 10)));
    return n * e;
  }
  function fmtAxisYi(v) {
    if (Math.abs(v) < 1e-9) return "0";
    var a = Math.abs(v);
    var s = a >= 100 ? String(Math.round(a)) : a.toFixed(1);
    return (v < 0 ? "-" : "") + s + "亿";
  }
  /* 亿元，带符号 + 1 位小数（主力资金轴/曲线用） */
  function yiTxt(yuan, digits, sign) {
    if (yuan == null || !isFinite(yuan)) return "--";
    var v = yuan / YI;
    var s = Math.abs(v).toFixed(digits == null ? 1 : digits);
    if (v < 0) return "-" + s;
    return (sign ? "+" : "") + s;
  }

  /* ---------- 动态加载脚本（腾讯报价为 GBK 变量脚本，无法 fetch 解析）---------- */
  function loadScript(url, timeout) {
    return new Promise(function (resolve) {
      var s = document.createElement("script"), done = false;
      function fin(ok) {
        if (done) return; done = true;
        if (s.parentNode) { try { s.parentNode.removeChild(s); } catch (e) {} }
        resolve(ok);
      }
      s.onload = function () { fin(true); };
      s.onerror = function () { fin(false); };
      s.src = url;
      document.body.appendChild(s);
      setTimeout(function () { fin(false); }, timeout || 8000);
    });
  }
  function loadFirst(urls, i) {
    i = i || 0;
    if (i >= urls.length) return Promise.resolve(false);
    return loadScript(urls[i]).then(function (ok) { return ok ? true : loadFirst(urls, i + 1); });
  }

  function $(id) { return document.getElementById(id); }

  /* ---------- 242 个交易分钟槽位 ---------- */
  var SLOTS = (function () {
    var a = [], i, t;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    for (i = 0; i < 121; i++) { t = 9 * 60 + 30 + i; a.push(pad(Math.floor(t / 60)) + pad(t % 60)); }
    for (i = 0; i < 121; i++) { t = 13 * 60 + i; a.push(pad(Math.floor(t / 60)) + pad(t % 60)); }
    return a;
  })();
  var LABELS = SLOTS.map(function (t) { return t.slice(0, 2) + ":" + t.slice(2); });

  function fmtYi(yuan) {
    if (yuan == null) return "--";
    var v = yuan / YI;
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + " 万亿";
    return v.toFixed(1) + " 亿";
  }
  function fmtSigned(yuan) {
    if (yuan == null) return "--";
    return (yuan >= 0 ? "+" : "") + fmtYi(yuan);
  }
  /* 整数亿（量能预测卡用，贴近设计稿的「4391亿」「15674亿」写法） */
  function fmtYiInt(yuan) {
    if (yuan == null || !isFinite(yuan)) return "--";
    var v = yuan / YI;
    if (Math.abs(v) >= 100000) return (v / 10000).toFixed(2) + "万亿";
    return Math.round(v) + "亿";
  }
  function num(x) { var v = parseFloat(x); return isFinite(v) ? v : 0; }

  /* ---------- JSONP（东财支持 cb 回调）---------- */
  function jsonp(url, timeout) {
    return new Promise(function (resolve) {
      var cb = "__fq" + Math.random().toString(36).slice(2) + "_" + Date.now();
      var sep = url.indexOf("?") >= 0 ? "&" : "?";
      var s = document.createElement("script");
      var done = false;
      function cleanup() {
        if (s.parentNode) { try { s.parentNode.removeChild(s); } catch (e) {} }
        try { delete window[cb]; } catch (e) {}
      }
      window[cb] = function (d) { if (done) return; done = true; cleanup(); resolve(d); };
      s.onerror = function () { if (done) return; done = true; cleanup(); resolve(null); };
      s.src = url + sep + "cb=" + cb;
      document.body.appendChild(s);
      setTimeout(function () { if (!done) { done = true; cleanup(); resolve(null); } }, timeout || 9000);
    });
  }

  /* ---------- 累计量/额 -> 每分钟成交额 ---------- */
  function splitMinutes(lines) {
    var cumAmt = {}, prices = {}, i, p;
    for (i = 0; i < lines.length; i++) {
      p = String(lines[i]).split(/\s+/);
      if (p.length < 3) continue;
      prices[p[0]] = parseFloat(p[1]);
      if (p.length >= 4) cumAmt[p[0]] = parseFloat(p[3]);
    }
    var amt = new Array(SLOTS.length).fill(null);
    var prc = new Array(SLOTS.length).fill(null);
    var prevA = 0, lastP = null;
    for (i = 0; i < SLOTS.length; i++) {
      var t = SLOTS[i];
      if (cumAmt[t] != null) {
        var v = cumAmt[t];
        amt[i] = Math.max(v - prevA, 0);
        prevA = v;
      }
      if (prices[t] != null) lastP = prices[t];
      prc[i] = lastP;
    }
    return { amt: amt, price: prc };
  }

  function fetchDay(code) {
    // 同源 /api/qq2/ 优先；去掉 _= 时间戳，让反代 10s 缓存能命中
    return viaApi("qq2/appstock/app/day/query?code=" + code, TENCENT + code + "&_=" + Date.now(), 9000)
      .then(function (j) {
        var node = ((j && j.data) || {})[code] || {};
        var out = {};
        (node.data || []).forEach(function (d) {
          var dt = String(d.date || "");
          if (dt.length === 8) dt = dt.slice(0, 4) + "-" + dt.slice(4, 6) + "-" + dt.slice(6);
          if (!dt) return;
          out[dt] = splitMinutes(d.data || []);
        });
        return out;
      });
  }

  function fetchNet() {
    var qs = "?fltt=2&secids=1.000001,0.399001&fields=f12,f14,f62";
    return viaApi("em/api/qt/ulist.np/get" + qs, EM_ULIST + qs + "&_=" + Date.now(), 9000)
      .then(function (j) {
        if (!j || !j.data || !j.data.diff) return null;
        var rows = j.data.diff;
      if (!Array.isArray(rows)) rows = Object.keys(rows).map(function (k) { return rows[k]; });
      var sh = null, sz = null;
      rows.forEach(function (r) {
        if (String(r.f12) === "000001") sh = num(r.f62);
        if (String(r.f12) === "399001") sz = num(r.f62);
      });
      if (sh == null && sz == null) return null;
      return { sh: sh || 0, sz: sz || 0, net: (sh || 0) + (sz || 0) };
    });
  }

  /* ---------- 主计算 ---------- */
  function compute(histSh, histSz) {
    var dates = Object.keys(histSh).filter(function (d) { return histSz[d]; }).sort();
    if (dates.length < 2) throw new Error("分时历史不足 2 个交易日");
    var day = dates[dates.length - 1];
    var prev = dates[dates.length - 2];
    var a = histSh[day].amt, b = histSz[day].amt;
    var a2 = histSh[prev].amt, b2 = histSz[prev].amt;

    function perMin(x, y) {
      var out = [], i;
      for (i = 0; i < SLOTS.length; i++) {
        if ((x[i] == null) && (y[i] == null)) { out.push(null); continue; }
        out.push((x[i] || 0) + (y[i] || 0));
      }
      return out;
    }
    var mB = perMin(a, b), mA = perMin(a2, b2);
    var cumB = [], cumA = [], mdiff = [], i, sB = 0, sA = 0;
    for (i = 0; i < SLOTS.length; i++) {
      if (mB[i] != null) sB += mB[i];
      if (mA[i] != null) sA += mA[i];
      cumB.push(mB[i] != null ? sB : null);
      cumA.push(mA[i] != null ? sA : null);
      mdiff.push((mB[i] != null && mA[i] != null) ? mB[i] - mA[i] : null);
    }
    var diff = cumB.map(function (v, k) {
      return (v != null && cumA[k] != null) ? v - cumA[k] : null;
    });

    var lastI = -1;
    for (i = 0; i < cumB.length; i++) if (cumB[i] != null) lastI = i;

    var today = new Date();
    var todayStr = today.getFullYear() + "-" + ("0" + (today.getMonth() + 1)).slice(-2) + "-" + ("0" + today.getDate()).slice(-2);
    var isToday = (day === todayStr);

    var curB = lastI >= 0 ? cumB[lastI] : null;
    var curA = (lastI >= 0 && cumA[lastI] != null) ? cumA[lastI] : (sA || null);
    var fullB = sB, fullA = sA;

    // 放量/缩量分钟统计
    var upN = 0, dnN = 0, flatN = 0, upAmt = 0, dnAmt = 0;
    for (i = 0; i < mdiff.length; i++) {
      if (mdiff[i] == null) continue;
      if (mdiff[i] > 0) { upN++; upAmt += mB[i]; }
      else if (mdiff[i] < 0) { dnN++; dnAmt += mB[i]; }
      else flatN++;
    }

    /* ---- 量能预测：用前 N 日「同一分钟累计额占全天比例」作为时间进度模型 ----
       pred(t) = 当日累计额(t) / 历史同刻平均进度比例(t)
       偏离(t) = (pred(t) - 昨日全天额) / 昨日全天额 * 100
       开盘初期进度比例样本少、外推误差大，故曲线前段会从高位快速收敛。 */
    var histDays = dates.slice(0, dates.length - 1);
    var rSum = new Array(SLOTS.length), rN = new Array(SLOTS.length), k, h;
    for (k = 0; k < SLOTS.length; k++) { rSum[k] = 0; rN[k] = 0; }
    for (h = 0; h < histDays.length; h++) {
      if (!histSh[histDays[h]] || !histSz[histDays[h]]) continue;
      var hm = perMin(histSh[histDays[h]].amt, histSz[histDays[h]].amt);
      var hc = 0, ht = 0;
      for (k = 0; k < hm.length; k++) ht += (hm[k] || 0);
      if (!(ht > 0)) continue;
      for (k = 0; k < hm.length; k++) {
        hc += (hm[k] || 0);
        rSum[k] += hc / ht;
        rN[k] += 1;
      }
    }

    var MIN_I = 3;                       // 前 3 分钟样本太少，不做外推
    var vsDev = [], vsPred = [];
    for (i = 0; i < SLOTS.length; i++) {
      var rr = rN[i] ? (rSum[i] / rN[i]) : 0;
      if (sA > 0 && i >= MIN_I && rr > 0 && cumB[i] != null) {
        var pv = cumB[i] / rr;
        vsPred.push(pv);
        vsDev.push((pv - sA) / sA * 100);
      } else { vsPred.push(null); vsDev.push(null); }
    }

    // 纵轴上限：取第 6 分钟之后的稳态偏离，避免开盘噪声把坐标轴撑爆
    var mSteady = 0;
    for (i = 5; i <= (lastI < 0 ? 0 : lastI); i++) {
      if (vsDev[i] != null && Math.abs(vsDev[i]) > mSteady) mSteady = Math.abs(vsDev[i]);
    }
    var curDev = (lastI >= 0 && vsDev[lastI] != null) ? vsDev[lastI] : 0;
    var axMax = Math.max(mSteady, Math.abs(curDev) * 1.25, 2.5);
    axMax = Math.min(Math.ceil(axMax * 100) / 100, 80);

    return {
      day: day, prev: prev, isToday: isToday, lastI: lastI,
      cumB: cumB, cumA: cumA, diff: diff, mdiff: mdiff, mB: mB,
      curB: curB, curA: curA, fullB: fullB, fullA: fullA,
      at: lastI >= 0 ? LABELS[lastI] : null,
      upN: upN, dnN: dnN, flatN: flatN, upAmt: upAmt, dnAmt: dnAmt,
      vsDev: vsDev, vsPred: vsPred, axMax: axMax,
      curPred: lastI >= 0 ? vsPred[lastI] : null,
      curDev: curDev, histN: rN[SLOTS.length - 1] || 0
    };
  }

  /* ---------- 渲染 ---------- */
  function setSigned(el, yuan, digits) {
    el.textContent = fmtSigned(yuan);
    el.className = yuan >= 0 ? "up" : "down";
  }

  /* 把「昨日量能」徽标对齐到 0 基准虚线的垂直位置 */
  function placeBadge(ch) {
    var b = $("vtBadge");
    if (!b) return;
    if (!ch || !ch.scales || !ch.scales.y) { b.style.top = "50%"; b.style.transform = "translateY(-50%)"; return; }
    try {
      var y = ch.scales.y.getPixelForValue(0);
      if (!isFinite(y)) throw new Error("nan");
      b.style.top = Math.round(y) + "px";
      b.style.transform = "translateY(-50%)";
    } catch (e) {
      b.style.top = "50%"; b.style.transform = "translateY(-50%)";
    }
  }

  /* ---- 当日页：实际量能 / 预测量能 / 偏离率曲线 ---- */
  /* 只更新文本（与是否可见无关），保证「实际量能」在任何视图下都有值 */
  function renderVolText(d) {
    var real = $("vtReal"), pe = $("vtPred"), note = $("vtNote"), prev = $("vtPrev");
    var curAmt = (d.curB != null) ? d.curB : ((d.fullB != null && d.fullB > 0) ? d.fullB : null);
    if (real) real.textContent = fmtYiInt(curAmt);
    if (prev) prev.textContent = fmtYiInt(d.fullA);
    var pred = d.curPred;
    if (pred == null || !d.fullA) {
      if (pe) { pe.textContent = "--"; pe.className = "vt-v"; }
      if (note) { note.textContent = ""; note.className = "vt-note"; }
    } else {
      var delta = pred - d.fullA, pct = delta / d.fullA * 100;
      setDirText(pe, fmtYiInt(pred), delta);
      if (note) {
        note.textContent = "(较昨日" + (delta >= 0 ? "增量" : "减量") + Math.abs(delta / YI).toFixed(1)
          + "亿 " + pct.toFixed(2) + "%)";
        note.className = "vt-note " + dirOf(delta);
      }
    }
  }

  function renderVol(d) {
    renderVolText(d);
    var cv = $("vtChart");
    if (!cv || !isVis(cv)) return;
    var ax = d.axMax || 5;
    var data = d.vsDev.map(function (v) {
      if (v == null) return null;
      return Math.max(-ax, Math.min(ax, v));   // 超出轴范围的点贴边（开盘噪声）
    });
    var base = d.vsDev.map(function () { return 0; });

    if (charts.vol) charts.vol.destroy();
    charts.vol = new Chart(cv.getContext("2d"), {
      type: "line",
      data: {
        labels: LABELS,
        datasets: [
          {
            label: "昨日量能基准", data: base, borderColor: "#c7cbd4", borderWidth: 1,
            borderDash: [4, 4], pointRadius: 0, tension: 0, fill: false, order: 2
          },
          {
            label: "预测量能偏离", data: data, borderColor: "#16181d", borderWidth: 1.7,
            pointRadius: 0, pointHitRadius: 10, tension: 0, spanGaps: false, fill: false, order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 8, right: 10, bottom: 0, left: 2 } },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (it) { return it.datasetIndex === 1 && it.parsed.y != null; },
            displayColors: false,
            callbacks: {
              title: function (its) { return its.length ? its[0].label : ""; },
              label: function (c) {
                var i = c.dataIndex, raw = d.vsDev[i], pv = d.vsPred[i];
                var out = ["偏离 " + (raw >= 0 ? "+" : "") + raw.toFixed(2) + "%"];
                if (pv != null) out.push("预测 " + fmtYiInt(pv));
                return out;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              maxRotation: 0, autoSkip: false, font: { size: 11 }, color: "#9aa0a8",
              callback: function (val, idx) {
                if (idx === 0) return "9:30";
                if (idx === LABELS.length - 1) return "15:00";
                return "";
              }
            }
          },
          y: {
            min: -ax, max: ax,
            grid: { display: false },
            border: { display: false },
            afterBuildTicks: function (sc) {
              sc.ticks = [
                { value: ax }, { value: ax / 2 }, { value: 0 },
                { value: -ax / 2 }, { value: -ax }
              ];
            },
            ticks: {
              font: { size: 11.5 }, padding: 5,
              color: function (ctx) {
                var v = (ctx && ctx.tick && typeof ctx.tick.value === "number") ? ctx.tick.value : 0;
                if (v > 0) return "#e63946";      // 涨红
                if (v < 0) return "#1a9e5f";      // 跌绿
                return "transparent";             // 0 位置留白，让给徽标
              },
              callback: function (v) {
                if (Math.abs(v) < 1e-9) return "";
                return v.toFixed(2) + "%";
              }
            }
          }
        }
      }
    });
    placeBadge(charts.vol);
  }

  function renderCum(d) {
    var ctx = $("fundCum").getContext("2d");
    var g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, "rgba(230,57,70,.20)");
    g.addColorStop(1, "rgba(230,57,70,.01)");
    var labels = LABELS.slice(0, (d.lastI >= 0 ? d.lastI + 1 : LABELS.length));
    // 收盘后展示全天
    if (!d.isToday) labels = LABELS.slice();
    var n = labels.length;
    var dataB = d.cumB.slice(0, n).map(function (v) { return v == null ? null : +(v / YI).toFixed(2); });
    var dataA = d.cumA.slice(0, n).map(function (v) { return v == null ? null : +(v / YI).toFixed(2); });
    var dataD = d.diff.slice(0, n).map(function (v) { return v == null ? null : +(v / YI).toFixed(2); });

    if (charts.cum) charts.cum.destroy();
    charts.cum = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "A 前一日累计", data: dataA, borderColor: "#9aa4b2", borderWidth: 1.6,
            borderDash: [5, 4], pointRadius: 0, tension: .25, spanGaps: true, yAxisID: "y"
          },
          {
            label: "B 本日累计", data: dataB, borderColor: "#e63946", borderWidth: 2.2,
            pointRadius: 0, tension: .25, spanGaps: true, fill: true, backgroundColor: g, yAxisID: "y"
          },
          {
            label: "B-A 差值", data: dataD, borderColor: "#f59e0b", borderWidth: 1.8,
            pointRadius: 0, tension: .25, spanGaps: true, yAxisID: "y"
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed.y;
                if (v == null) return c.dataset.label + "：--";
                return c.dataset.label + "：" + (c.datasetIndex === 2 && v >= 0 ? "+" : "") + v.toLocaleString() + " 亿";
              }
            }
          },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxRotation: 0, autoSkip: false, font: { size: 10 },
              callback: function (val, idx) {
                var s = this.getLabelForValue(val);
                if (!s) return "";
                var mm = s.slice(3);
                return (idx === 0 || mm === "00" || mm === "30") ? s : "";
              }
            }
          },
          y: {
            title: { display: true, text: "累计成交额（亿元）", font: { size: 11 } },
            grid: { color: "#f0f1f4" },
            ticks: { font: { size: 10 } }
          }
        }
      }
    });
  }

  function renderMin(d) {
    var labels = LABELS.slice(0, (d.isToday && d.lastI >= 0) ? d.lastI + 1 : LABELS.length);
    var n = labels.length;
    var vals = d.mdiff.slice(0, n).map(function (v) { return v == null ? 0 : +(v / YI).toFixed(3); });
    var colors = vals.map(function (v) { return v >= 0 ? "rgba(230,57,70,.85)" : "rgba(26,158,95,.85)"; });

    if (charts.min) charts.min.destroy();
    charts.min = new Chart($("fundMin").getContext("2d"), {
      type: "bar",
      data: { labels: labels, datasets: [{ label: "每分钟量差", data: vals, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed.y;
                return (v >= 0 ? "放量 +" : "缩量 ") + v.toFixed(2) + " 亿";
              }
            }
          },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxRotation: 0, autoSkip: false, font: { size: 10 },
              callback: function (val, idx) {
                var s = this.getLabelForValue(val);
                if (!s) return "";
                var mm = s.slice(3);
                return (idx === 0 || mm === "00" || mm === "30") ? s : "";
              }
            }
          },
          y: {
            title: { display: true, text: "量差（亿元）", font: { size: 11 } },
            grid: { color: "#f0f1f4" },
            ticks: { font: { size: 10 } }
          }
        }
      }
    });
  }

  /* ==================== 涨跌分布 / 三大指数 / 主力资金 ==================== */

  /* 东财涨跌分布：fenbu 为 -11..11 档位计数（11≈涨停，-11≈跌停，0=平盘） */
  function fetchBreadth() {
    var qs = "?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt";
    return viaApi("emx/getTopicZDFenBu" + qs, EM_FENBU, 9000).then(function (j) {
      var f = j && j.data && j.data.fenbu;
      if (!f || !f.length) return null;
      var m = {}, i, k, x;
      for (i = 0; i < f.length; i++) {
        for (k in f[i]) { if (!isFinite(+k)) continue; m[k] = (m[k] || 0) + num(f[i][k]); }
      }
      function s(a, b) { var t = 0; for (x = a; x <= b; x++) t += (m[x] || 0); return t; }
      var buckets = [
        { k: "涨停", n: s(11, 11), up: true },
        { k: ">7%", n: s(8, 10), up: true },
        { k: "7-5%", n: s(6, 7), up: true },
        { k: "5-2%", n: s(3, 5), up: true },
        { k: "2-0%", n: s(1, 2), up: true },
        { k: "平", n: s(0, 0), up: null },
        { k: "0-2%", n: s(-2, -1), up: false },
        { k: "2-5%", n: s(-5, -3), up: false },
        { k: "5-7%", n: s(-7, -6), up: false },
        { k: ">7%", n: s(-10, -8), up: false },
        { k: "跌停", n: s(-11, -11), up: false }
      ];
      var up = 0, dn = 0, flat = 0;
      for (i = 0; i < buckets.length; i++) {
        if (buckets[i].up === true) up += buckets[i].n;
        else if (buckets[i].up === false) dn += buckets[i].n;
        else flat += buckets[i].n;
      }
      return { buckets: buckets, up: up, dn: dn, flat: flat, date: (j.data && j.data.qdate) || null };
    });
  }

  /* 三大指数（腾讯 qt，GBK 变量脚本） */
  function fetchQuotes() {
    var q = "sh000001,sz399001,sz399006";
    var urls = [];
    if (SAME_API && !sameBroken) urls.push(SAME_API + "qt/q=" + q + "&_=" + Date.now());
    urls.push(TENCENT_Q + q + "&_=" + Date.now());
    return loadFirst(urls).then(function (ok) {
      if (!ok) return null;
      var out = {}, got = 0;
      [["sh", "sh000001", "上证指数"], ["sz", "sz399001", "深证成指"], ["cy", "sz399006", "创业板指"]].forEach(function (x) {
        var raw = window["v_" + x[1]];
        if (typeof raw !== "string" || !raw) return;
        var a = raw.split("~");
        var p = parseFloat(a[3]), prev = parseFloat(a[4]);
        if (!isFinite(p) || !isFinite(prev) || !prev) return;
        out[x[0]] = { name: a[1] || x[2], p: p, prev: prev, chg: p - prev, pct: (p - prev) / prev * 100 };
        got++;
      });
      return got ? out : null;
    });
  }

  /* 主力资金流（东财）：
     当日 → push2 fflow/kline?klt=1（分钟级累计净流入，沪市+深市相加）
     60日 → push2his fflow/daykline（历史日线，指数级 fflow/kline 的 klt=101 只回当日） */
  function fetchFlow(kind) {
    var isDay = kind !== "d60";
    var tail = "&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56";
    function one(secid) {
      var qs = isDay
        ? "?lmt=0&klt=1&secid=" + secid + tail
        : "?lmt=0&klt=101&secid=" + secid + tail;
      var path = isDay ? "em/api/qt/stock/fflow/kline/get" + qs : "emh/api/qt/stock/fflow/daykline/get" + qs;
      var direct = (isDay ? EM_FFLOW : EM_FFLOW_HIS) + qs;
      return viaApi(path, direct, 9000);
    }
    return Promise.all([one("1.000001"), one("0.399001")]).then(function (res) {
      var m = {}, keys = [];
      res.forEach(function (j) {
        var ks = (j && j.data && j.data.klines) || [];
        ks.forEach(function (line) {
          var p = String(line).split(","), v = parseFloat(p[1]);
          if (!p[0] || !isFinite(v)) return;
          if (m[p[0]] == null) keys.push(p[0]);
          m[p[0]] = (m[p[0]] || 0) + v;
        });
      });
      if (!keys.length) return null;
      keys.sort();
      if (isDay) {
        var arr = new Array(SLOTS.length).fill(null), last = -1;
        keys.forEach(function (k) {
          var t = k.slice(11, 13) + k.slice(14, 16);
          var i = SLOTS.indexOf(t);
          if (i >= 0) { arr[i] = m[k]; if (i > last) last = i; }
        });
        return { kind: "day", arr: arr, last: last, at: keys[keys.length - 1] };
      }
      var k60 = keys.slice(-60);
      return {
        kind: "d60",
        labels: k60.map(function (k) { return k.slice(5, 10); }),
        vals: k60.map(function (k) { return m[k]; })
      };
    });
  }

  /* ---------- 三格（涨跌分布 / 量能预测 / 主力净买）---------- */
  function renderBrief(d) {
    if (breadth) {
      var el = $("mcRatio");
      if (el) el.innerHTML = '<span class="r-up">' + breadth.up + '</span>:<span class="r-dn">' + breadth.dn + "</span>";
      $("bdUp").textContent = breadth.up;
      $("bdDn").textContent = breadth.dn;
      var tot = breadth.up + breadth.dn + breadth.flat || 1;
      $("bdTUp").style.width = (breadth.up / tot * 100).toFixed(2) + "%";
      $("bdTFlat").style.width = (breadth.flat / tot * 100).toFixed(2) + "%";
      $("bdTDn").style.width = (breadth.dn / tot * 100).toFixed(2) + "%";
    }
    if (d) {
      var pe = $("mcVolVal"), pn = $("mcVolNote");
      if (d.curPred != null && d.fullA) {
        var delta = d.curPred - d.fullA, pct = delta / d.fullA * 100;
        setDirText(pe, fmtYiInt(d.curPred), delta);
        if (pn) {
          pn.textContent = (delta >= 0 ? "↑" : "↓") + Math.abs(delta / YI).toFixed(1) + "亿(" + pct.toFixed(2) + "%)";
          pn.className = dirOf(delta);
        }
      } else {
        setDirText(pe, "--", null);
        if (pn) { pn.textContent = ""; pn.className = ""; }
      }
    }
    var fv = null;
    if (flow.day && flow.day.last >= 0) fv = flow.day.arr[flow.day.last];
    else if (state && state.net != null) fv = state.net;
    if (fv != null) setDirText($("mcFlowVal"), yiTxt(fv, 1) + "亿", fv);
  }

  /* ---------- 情绪温度（自建复合指标：宽度 60% + 指数 25% + 量能 15%）---------- */
  function renderTemp() {
    var up = breadth ? breadth.up : null, dn = breadth ? breadth.dn : null;
    var pct = (quotes && quotes.sh) ? quotes.sh.pct : null;
    var vdev = (state && state.curDev != null) ? state.curDev : null;
    if (up == null || dn == null || pct == null) return;
    var br = up / Math.max(up + dn, 1);
    var sb = br * 100;
    var si = Math.max(0, Math.min(100, 50 + pct * 12));
    var sv = (vdev == null) ? 50 : Math.max(0, Math.min(100, 50 + vdev * 3));
    var t = 0.60 * sb + 0.25 * si + 0.15 * sv;
    t = Math.max(0, Math.min(100, t));
    var shown = Math.round(t);
    $("mtVal").textContent = shown;
    $("mtVal").parentNode.style.color = t >= 50 ? "var(--up)" : "var(--down)";
    var dot = $("mtDot");
    if (dot) dot.style.left = Math.max(2, Math.min(98, t)) + "%";
    var desc;
    if (t < 30) desc = "市场冰点，整体走势极弱，交投冷清，整体赚钱效应较差；建议轻仓观望，等待情绪修复。";
    else if (t < 45) desc = "市场偏冷，赚钱效应偏弱，多数个股承压；宜控制仓位，等待企稳信号。";
    else if (t < 58) desc = "市场温吞，多空拉锯，指数与个股分化；以结构性机会为主，不宜追高。";
    else if (t < 72) desc = "市场偏暖，交投活跃，赚钱效应尚可；可适度参与强势主线。";
    else if (t < 86) desc = "市场高热，情绪亢奋，成交显著放大；注意追高风险与高位分歧。";
    else desc = "市场过热，情绪极端，警惕高位回落与快速缩量。";
    $("mtDesc").textContent = desc + "（宽度 " + up + ":" + dn + "，上证 " + (pct >= 0 ? "+" : "") + pct.toFixed(2)
      + "%" + (vdev == null ? "" : "，量能偏离 " + (vdev >= 0 ? "+" : "") + vdev.toFixed(2) + "%") + "）";
  }

  /* ---------- 三大指数卡 ---------- */
  function renderIdx3() {
    if (!quotes) return;
    var map = { sh: ["i3Sh", "i3ShP"], sz: ["i3Sz", "i3SzP"], cy: ["i3Cy", "i3CyP"] };
    Object.keys(map).forEach(function (k) {
      var q = quotes[k];
      if (!q) return;
      var b = $(map[k][0]), i = $(map[k][1]);
      b.textContent = q.p.toFixed(2);
      i.textContent = (q.chg >= 0 ? "+" : "") + q.chg.toFixed(2) + "  " + (q.pct >= 0 ? "+" : "") + q.pct.toFixed(2) + "%";
      var c = dirOf(q.chg);
      b.className = c; i.className = c;
    });
    var now = new Date();
    var wk = "日一二三四五六".charAt(now.getDay());
    $("i3Date").textContent = now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2) + "-"
      + ("0" + now.getDate()).slice(-2) + " 周" + wk;
    /* 交易状态：工作日 9:30-11:30 / 13:00-15:00 视为开盘 */
    var hm = now.getHours() * 100 + now.getMinutes(), wd = now.getDay();
    var open = (wd >= 1 && wd <= 5) && ((hm >= 930 && hm <= 1130) || (hm >= 1300 && hm <= 1500));
    var st = $("i3Status"), dot = $("i3Dot");
    if (open) { st.textContent = "开盘交易中"; if (dot) dot.className = "live-dot"; }
    else if (wd >= 1 && wd <= 5 && hm < 930) { st.textContent = "未开盘"; if (dot) dot.className = "live-dot off"; }
    else if (wd >= 1 && wd <= 5 && hm > 1130 && hm < 1300) { st.textContent = "午间休市"; if (dot) dot.className = "live-dot off"; }
    else { st.textContent = "已收盘"; if (dot) dot.className = "live-dot off"; }
  }

  /* ---------- 涨跌分布 11 档柱图 ---------- */
  var barLabels = {
    id: "barLabels",
    afterDatasetsDraw: function (ch) {
      var meta = ch.getDatasetMeta(0), ctx = ch.ctx;
      ctx.save();
      ctx.font = "700 10.5px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      meta.data.forEach(function (el, i) {
        var v = ch.data.datasets[0].data[i];
        if (!v) return;
        ctx.fillStyle = ch.data.datasets[0].backgroundColor[i];
        ctx.fillText(String(v), el.x, el.y - 2);
      });
      ctx.restore();
    }
  };

  function renderBreadth() {
    var cv = $("bdChart");
    if (!cv || !breadth || !isVis(cv)) return;
    var B = breadth.buckets;
    var vals = B.map(function (x) { return x.n; });
    var cols = B.map(function (x) { return x.up === true ? "#e63946" : (x.up === false ? "#1a9e5f" : "#9aa0a8"); });
    var mx = Math.max.apply(null, vals.concat([1]));
    if (charts.bd) charts.bd.destroy();
    charts.bd = new Chart(cv.getContext("2d"), {
      type: "bar",
      data: {
        labels: B.map(function (x) { return x.k; }),
        datasets: [{
          data: vals, backgroundColor: cols, borderWidth: 0,
          borderRadius: 3, borderSkipped: false, categoryPercentage: .62, barPercentage: .88
        }]
      },
      plugins: [barLabels],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 16, right: 4, bottom: 0, left: 2 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: function (it) { return it[0].label; },
              label: function (c) { return B[c.dataIndex].n + " 家"; }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: {
              font: { size: window.innerWidth < 400 ? 9.5 : 10.5 },
              maxRotation: 0, autoSkip: false, padding: 2,
              color: function (ctx) {
                var b = B[ctx.index];
                return b && b.up === true ? "#e63946" : (b && b.up === false ? "#1a9e5f" : "#9aa0a8");
              },
              /* 窄屏去掉 % 后缀，避免 11 个标签互相挤压 */
              callback: function (val) {
                var s2 = this.getLabelForValue(val);
                return window.innerWidth < 400 ? s2.replace("%", "") : s2;
              }
            }
          },
          y: {
            display: false, beginAtZero: true,
            suggestedMax: mx * 1.18, grid: { display: false }
          }
        }
      }
    });
  }

  /* ---------- 主力资金曲线（当日分时 / 60日日线）---------- */
  function renderFlow() {
    var cv = $("flChart");
    if (!cv) return;
    var nowEl = $("flNow");
    if (flowTab === "day") {
      if (!flow.day) { if (nowEl) setDirText(nowEl, "--", null); return; }
      var arr = flow.day.arr, last = flow.day.last;
      var lastV = last >= 0 ? arr[last] : null;
      var lk = $("flK");
      if (lk) lk.textContent = "主力资金：";
      if (nowEl) setDirText(nowEl, yiTxt(lastV, 1) + "亿", lastV);
      if (!isVis(cv)) return;
      var mxv = 0, i;
      for (i = 0; i < arr.length; i++) if (arr[i] != null && Math.abs(arr[i]) > mxv) mxv = Math.abs(arr[i]);
      var ax = niceNum(mxv / YI * 1.15);
      var data = arr.map(function (v) { return v == null ? null : +(v / YI).toFixed(2); });
      if (charts.fl) charts.fl.destroy();
      charts.fl = new Chart(cv.getContext("2d"), {
        type: "line",
        data: {
          labels: LABELS,
          datasets: [{
            label: "主力资金", data: data, borderColor: "#16181d", borderWidth: 1.7,
            pointRadius: 0, pointHitRadius: 10, tension: 0, spanGaps: false, fill: false
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          layout: { padding: { top: 8, right: 8, bottom: 0, left: 2 } },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              displayColors: false,
              filter: function (it) { return it.parsed.y != null; },
              callbacks: {
                title: function (its) { return its.length ? its[0].label : ""; },
                label: function (c) {
                  var raw = arr[c.dataIndex];
                  return "主力净流入 " + yiTxt(raw, 1, true) + " 亿";
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false }, border: { display: false },
              ticks: {
                maxRotation: 0, autoSkip: false, font: { size: 11 }, color: "#9aa0a8",
                callback: function (val, idx) {
                  if (idx === 0) return "9:30";
                  if (idx === LABELS.length - 1) return "15:00";
                  return "";
                }
              }
            },
            y: {
              min: -ax, max: ax,
              grid: {
                color: function (c) { return c.tick && c.tick.value === 0 ? "#d8dbe2" : "#f2f3f6"; },
                lineWidth: 1, drawTicks: false
              },
              border: { display: false },
              afterBuildTicks: function (sc) {
                sc.ticks = [{ value: ax }, { value: ax / 2 }, { value: 0 }, { value: -ax / 2 }, { value: -ax }];
              },
              ticks: {
                font: { size: 11.5 }, padding: 6,
                color: function (ctx) {
                  var v = (ctx && ctx.tick && typeof ctx.tick.value === "number") ? ctx.tick.value : 0;
                  if (v > 0) return "#e63946";
                  if (v < 0) return "#1a9e5f";
                  return "#9aa0a8";
                },
                callback: function (v) { return fmtAxisYi(v); }
              }
            }
          }
        }
      });
      return;
    }
    /* 60 日：日线净流入柱 */
    if (!flow.d60) { if (nowEl) nowEl.textContent = "--"; return; }
    var vals60 = flow.d60.vals, labels60 = flow.d60.labels;
    var sum60 = 0, si;
    for (si = 0; si < vals60.length; si++) sum60 += (vals60[si] || 0);
    var lk60 = $("flK");
    if (lk60) lk60.textContent = "近60日累计：";
    if (nowEl) setDirText(nowEl, yiTxt(sum60, 1) + "亿", sum60);
    if (!isVis(cv)) return;
    var mv = 0;
    vals60.forEach(function (v) { if (Math.abs(v) > mv) mv = Math.abs(v); });
    var ax60 = niceNum(mv / YI * 1.12);
    if (charts.fl) charts.fl.destroy();
    charts.fl = new Chart(cv.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels60,
        datasets: [{
          data: vals60.map(function (v) { return +(v / YI).toFixed(2); }),
          backgroundColor: function (c) { return c.raw >= 0 ? "#e63946" : "#1a9e5f"; },
          borderWidth: 0, borderRadius: 2, categoryPercentage: .74, barPercentage: .9
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 6, right: 8, bottom: 0, left: 2 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              label: function (c) { return "主力净流入 " + (c.parsed.y >= 0 ? "+" : "") + c.parsed.y.toFixed(1) + " 亿"; }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: {
              font: { size: 10 }, maxRotation: 0, autoSkip: false, color: "#9aa0a8",
              callback: function (val, idx) { return idx % 10 === 0 ? this.getLabelForValue(val) : ""; }
            }
          },
          y: {
            min: -ax60, max: ax60,
            grid: {
              color: function (c) { return c.tick && c.tick.value === 0 ? "#d8dbe2" : "#f2f3f6"; },
              drawTicks: false
            },
            border: { display: false },
            ticks: {
              font: { size: 11 }, padding: 6,
              color: function (ctx) {
                var v = (ctx && ctx.tick && typeof ctx.tick.value === "number") ? ctx.tick.value : 0;
                return v > 0 ? "#e63946" : (v < 0 ? "#1a9e5f" : "#9aa0a8");
              },
              callback: function (v) { return fmtAxisYi(v); }
            }
          }
        }
      }
    });
  }

  /* ---------- 视图切换（三格）---------- */
  function showView(v) {
    viewName = v;
    var bs = document.querySelectorAll("#mktCards .mc"), i;
    for (i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute("data-view") === v;
      bs[i].className = on ? "mc on" : "mc";
    }
    var p1 = $("mvBreadth"), p2 = $("mvVol"), p3 = $("mvFlow");
    if (p1) p1.hidden = (v !== "breadth");
    if (p2) p2.hidden = (v !== "vol");
    if (p3) p3.hidden = (v !== "flow");
    setTimeout(function () {
      if (v === "breadth") renderBreadth();
      else if (v === "vol") { if (state) renderVol(state); }
      else { if (!flow[flowTab === "day" ? "day" : "d60"] && flowTab !== "day") ensureFlow("d60").then(renderFlow); else renderFlow(); }
    }, 40);
  }

  function showFlowTab(t) {
    flowTab = t;
    var bs = document.querySelectorAll("#flSeg button"), i;
    for (i = 0; i < bs.length; i++) bs[i].className = bs[i].getAttribute("data-tab") === t ? "on" : "";
    if (t !== "day" && !flow.d60) {
      ensureFlow("d60").then(function () { renderFlow(); });
      return;
    }
    renderFlow();
  }

  var flowBusy = false;
  function ensureFlow(kind) {
    if (flow[kind] || flowBusy) return Promise.resolve(flow[kind]);
    flowBusy = true;
    return fetchFlow(kind).then(function (r) {
      flowBusy = false;
      if (r) flow[kind] = r;
      return r;
    }).catch(function () { flowBusy = false; return null; });
  }

  function renderMeta(d) {
    $("fundAt").textContent = d.isToday ? (d.at || "--") : d.day.slice(5).replace("-", "/");
    $("fundB").textContent = fmtYi(d.curB);
    $("fundA").textContent = fmtYi(d.curA);
    setSigned($("fundD"), d.curB != null && d.curA != null ? d.curB - d.curA : null);
    var pct = (d.curB != null && d.curA) ? (d.curB / d.curA - 1) * 100 : null;
    var pe = $("fundP");
    if (pct == null) { pe.textContent = "--"; }
    else {
      pe.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
      pe.className = pct >= 0 ? "up" : "down";
    }
    var st = $("fundStatus");
    st.textContent = d.isToday ? ("盘中 " + (d.at || "")) : ("收盘 " + d.day.slice(5).replace("-", "/"));
    st.className = "idx-status " + (d.isToday ? "s-cyb" : "s-mid");

    $("fundCap").innerHTML =
      "口径：<b>B</b> = 沪深两市本日累计成交额；<b>A</b> = 前一交易日 <b>同一时点</b> 累计成交额"
      + "（盘中拿半天比全天会虚报缩量，故按同刻对比；收盘后即全天对全天）。"
      + "<b>B-A</b> 在 0 轴上方=较昨日放量，下方=缩量。副图为每分钟成交额相对昨日同刻的差值。"
      + "<br>放量 <b>" + d.upN + "</b> 分钟（" + fmtYi(d.upAmt) + "）；缩量 <b>" + d.dnN
      + "</b> 分钟（" + fmtYi(d.dnAmt) + "）；持平 <b>" + d.flatN + "</b> 分钟。前一交易日全天 "
      + fmtYi(d.fullA) + "。数据源：腾讯行情/通达信口径，滚动鼠标可缩放。";
  }

  function stamp() {
    var n = new Date();
    return ("0" + n.getHours()).slice(-2) + ":" + ("0" + n.getMinutes()).slice(-2);
  }
  function touchMkt() {
    var ms = $("mktStatus");
    if (ms) { ms.textContent = "已更新 " + stamp(); ms.className = "idx-status s-mid"; }
  }

  function renderAll(d) {
    renderMeta(d);
    renderCum(d);
    renderMin(d);
    renderBrief(d);
    renderTemp();
    renderVolText(d);
    if (viewName === "vol") renderVol(d);
    if (viewName === "breadth") renderBreadth();
    touchMkt();
  }

  function load() {
    var st = $("fundStatus");
    if (st) { st.textContent = "加载中…"; st.className = "idx-status s-mid"; }
    var ms = $("mktStatus");
    if (ms) { ms.textContent = "加载中…"; ms.className = "idx-status s-mid"; }

    /* ① 成交额（B/A/B−A）+ 量能预测 */
    Promise.all([fetchDay("sh000001"), fetchDay("sz399001")]).then(function (res) {
      var d = compute(res[0], res[1]);
      d.net = state ? state.net : null;
      state = d;
      renderAll(d);
      window.__fundData = d;
    }).catch(function (e) {
      console.warn("资金看板：分时成交额加载失败", e);
      if (st) { st.textContent = "加载失败"; st.className = "idx-status s-mid"; }
      var cap = $("fundCap");
      if (cap) cap.textContent = "分时成交额接口暂时不可用（腾讯 day/query），点击右上角「↻ 刷新」重试。";
    });

    /* ② 主力净买（沪深两市） */
    fetchNet().then(function (n) {
      if (!n) { $("fundNet").textContent = "--"; $("fundNetSub").textContent = "东财资金流接口暂不可用"; return; }
      setSigned($("fundNet"), n.net);
      $("fundNetSub").textContent = "沪 " + fmtSigned(n.sh) + " ｜ 深 " + fmtSigned(n.sz);
      if (state) state.net = n.net;
    }).catch(function () { $("fundNet").textContent = "--"; });

    /* ③ 涨跌分布 */
    fetchBreadth().then(function (b) {
      if (!b) return;
      breadth = b;
      renderBrief(state && state.cumB != null ? state : null);
      if (viewName === "breadth") renderBreadth();
      renderTemp();
      touchMkt();
    }).catch(function () {});

    /* ④ 三大指数 */
    fetchQuotes().then(function (q) {
      if (!q) return;
      quotes = q;
      renderIdx3();
      renderTemp();
      touchMkt();
    }).catch(function () {});

    /* ⑤ 主力资金分时 */
    flow.day = null;
    ensureFlow("day").then(function () {
      renderBrief(state && state.cumB != null ? state : null);
      if (viewName === "flow") renderFlow();
      touchMkt();
    }).catch(function () {});
  }

  /* ---- 当日 / 历史 分段切换 ---- */
  function boot() {
    if (typeof Chart === "undefined" || !$("fundCum")) return;
    var b = $("fundRefresh");
    if (b) b.onclick = load;
    var b2 = $("fundRefreshHist");
    if (b2) b2.onclick = load;

    /* 三格切换视图 */
    var cards = $("mktCards");
    if (cards) {
      cards.addEventListener("click", function (e) {
        var el = e.target;
        while (el && el !== cards && !(el.getAttribute && el.getAttribute("data-view"))) el = el.parentNode;
        if (el && el.getAttribute && el.getAttribute("data-view")) showView(el.getAttribute("data-view"));
      });
    }
    /* 当日 / 60日 */
    var seg = $("flSeg");
    if (seg) {
      seg.addEventListener("click", function (e) {
        var el = e.target;
        while (el && el !== seg && !(el.getAttribute && el.getAttribute("data-tab"))) el = el.parentNode;
        if (el && el.getAttribute && el.getAttribute("data-tab")) showFlowTab(el.getAttribute("data-tab"));
      });
    }
    var more = $("mktMore");
    if (more) more.onclick = function () {
      var c = $("fundCard");
      if (c && c.scrollIntoView) c.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    var tg = $("mktToggle");
    if (tg) tg.onclick = function () {
      var body = $("mktBody");
      if (!body) return;
      var hide = !body.hidden;
      body.hidden = hide;
      tg.textContent = hide ? "展开" : "收起";
      if (!hide) setTimeout(function () {
        if (viewName === "breadth") renderBreadth();
        else if (viewName === "vol" && state) renderVol(state);
        else renderFlow();
      }, 50);
    };

    load();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (!document.hidden) load();
    }, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.FundPanel = { reload: load, get data() { return state; } };
})();
