/* ===================== 银行板块观察模块 =====================
 * 依赖：Chart.js（chart.umd.min.js）
 * 板块：东方财富 行业板块「银行Ⅱ」 secid=90.BK0475（等价通达信 银行板块口径）
 *   · 实时    push2 /api/qt/stock/get
 *   · 分时    push2 /api/qt/stock/trends2/get（ndays=1，含均价线）
 *   · 日K     push2his /api/qt/stock/kline/get（klt=101 前复权）
 * 个股：工商银行(601398 国有大行) / 招商银行(600036 股份制) / 宁波银行(002142 城商行)
 *   · 报价    push2 /api/qt/ulist.np/get
 *   · 日K     push2his /api/qt/stock/kline/get（用于 60 日相对走势）
 * 全部经同源反代（/api/em/、/api/emh/），失败自动回落直连 JSONP。
 * ========================================================== */
(function () {
  "use strict";

  var YI = 1e8;
  var SAME_API = (location.protocol === "http:" || location.protocol === "https:") ? "/api/" : null;
  var sameBroken = false;

  /* ===== 统一 tooltip 配色 =====
     原先各图只设了深色文字（#16181d），却沿用 Chart.js 默认的半透明黑底，
     深字压深底导致悬浮提示几乎看不清。这里统一定义为「不透明深底 + 亮字」，
     对比度约 15:1，投影到图表上也不会糊成一团。 */
  var TIP_BG = "rgba(24,27,33,.97)";
  var TIP_BORDER = "rgba(255,255,255,.18)";
  var TIP_TITLE = "#ffffff";
  var TIP_BODY = "#e9edf3";
  try {
    var td = Chart.defaults.plugins.tooltip;
    td.backgroundColor = TIP_BG;
    td.borderColor = TIP_BORDER;
    td.borderWidth = 1;
    td.cornerRadius = 8;
    td.padding = 10;
    td.caretSize = 6;
    td.titleColor = TIP_TITLE;
    td.bodyColor = TIP_BODY;
    td.titleFont = { size: 12, weight: "600" };
    td.bodyFont = { size: 11.5 };
    td.bodySpacing = 4;
  } catch (e) {}

  /* 板块可切换：默认银行Ⅱ，sectors.html 通过 window.SECTOR_CONF 指定初始板块，
     之后点列表用 SectorPanel.switchTo(secid, name) 切换。dynamic=true 时成分股由接口取。 */
  var CFG = window.SECTOR_CONF || {};
  var BK_SECID = CFG.secid || "90.BK0475";
  var BK_CODE = BK_SECID.split(".")[1] || "BK0475";
  var BK_NAME = CFG.name || "银行板块";
  var MULTI = !!CFG.dynamic;                 /* true = 任意板块，成分股按成交额动态取 */
  var STOCK_N = CFG.stockN || 5;             /* 动态模式取前 N 大成交额成分股 */
  var COLPAL = ["#e63946", "#2f6fed", "#f59e0b", "#7c3aed", "#0d9488", "#db2777"];

  var STOCKS = CFG.stocks || [
    { secid: "1.601398", code: "601398", name: "工商银行", tag: "国有大行", color: "#e63946" },
    { secid: "1.600036", code: "600036", name: "招商银行", tag: "股份制", color: "#2f6fed" },
    { secid: "0.002142", code: "002142", name: "宁波银行", tag: "城商行", color: "#f59e0b" }
  ];

  var SLOTS = (function () {
    var a = [], i, t;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    for (i = 0; i < 121; i++) { t = 9 * 60 + 30 + i; a.push(pad(Math.floor(t / 60)) + pad(t % 60)); }
    for (i = 0; i < 121; i++) { t = 13 * 60 + i; a.push(pad(Math.floor(t / 60)) + pad(t % 60)); }
    return a;
  })();
  var LABELS = SLOTS.map(function (t) { return t.slice(0, 2) + ":" + t.slice(2); });

  var ch = null, chRel = null, tab = "min", timer = null;
  var quote = null, trends = null, bkKline = null, stockQ = null, relSeries = null, bkFlow = null;
  var dayFailed = false;               /* 日K 请求失败（区别于「尚未加载」） */

  function $(id) { return document.getElementById(id); }
  function num(x) { var v = parseFloat(x); return isFinite(v) ? v : 0; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* 502/504 = 反代本身有响应、上游（东财）掐了连接。这类错误必须重试，
     但绝不能当成「反代不可用」——真降级成跨域直连就彻底没救了 */
  function okJson(r) {
    if (r.status >= 500) { var e = new Error("HTTP " + r.status); e.gateway = true; throw e; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  function jp(url, timeout) {
    return new Promise(function (resolve) {
      var cb = "__bk" + Math.random().toString(36).slice(2), s = document.createElement("script"), done = false;
      function fin(v) {
        if (done) return; done = true;
        if (s.parentNode) { try { s.parentNode.removeChild(s); } catch (e) {} }
        try { delete window[cb]; } catch (e) {}
        resolve(v);
      }
      window[cb] = function (d) { fin(d); };
      s.onerror = function () { fin(null); };
      s.src = url + (url.indexOf("?") >= 0 ? "&" : "?") + "cb=" + cb;
      document.body.appendChild(s);
      setTimeout(function () { fin(null); }, timeout || 9000);
    });
  }
  /* 同源优先 → 失败重试 → 直连 JSONP 兜底；连续两次「连不上」才判定反代不可用。
     判定不可用后 45 秒自动恢复再试 —— 否则一次抖动会让整页永久降级成直连（跨域必失败） */
  var sameFails = 0, sameUntil = 0;
  function api(path, direct, timeout, tryN) {
    if (sameBroken && Date.now() > sameUntil) { sameBroken = false; sameFails = 0; }
    if (SAME_API && !sameBroken) {
      var n = tryN || 0;
      return fetch(SAME_API + path, { cache: "no-store" }).then(okJson).then(function (j) {
        sameFails = 0;
        return j;
      }).catch(function (err) {
        /* 上游网关错误：只重试、不降级（降级到跨域直连必然失败） */
        if (err && err.gateway && n < 2) {
          return new Promise(function (res) { setTimeout(res, 500 + n * 600); }).then(function () {
            return api(path, direct, timeout, n + 1);
          });
        }
        if (n < 2) {
          return new Promise(function (res) { setTimeout(res, 350 + n * 450); }).then(function () {
            return api(path, direct, timeout, n + 1);
          });
        }
        if (++sameFails >= 2) { sameBroken = true; sameUntil = Date.now() + 45000; }
        return jp(direct, timeout);
      });
    }
    return jp(direct, timeout);
  }

  /* ---------- 取数 ---------- */
  var F_BK = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f168,f169,f170";

  function fetchQuote() {
    var qs = "?secid=" + BK_SECID + "&fields=" + F_BK;
    return api("em/api/qt/stock/get" + qs, "https://push2.eastmoney.com/api/qt/stock/get" + qs, 9000)
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.f43) return null;
        return {
          name: d.f58 || BK_NAME,
          px: d.f43 / 100, open: d.f46 / 100, high: d.f44 / 100, low: d.f45 / 100,
          pre: d.f60 / 100, chg: (d.f169 || 0) / 100, pct: (d.f170 || 0) / 100,
          amt: d.f48 || 0, vol: d.f47 || 0, turn: (d.f168 || 0) / 100
        };
      });
  }

  function fetchTrends() {
    var qs = "?secid=" + BK_SECID + "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&ndays=1&iscr=0";
    return api("em/api/qt/stock/trends2/get" + qs, "https://push2.eastmoney.com/api/qt/stock/trends2/get" + qs, 9000)
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.trends || !d.trends.length) return null;
        var px = new Array(SLOTS.length).fill(null), av = new Array(SLOTS.length).fill(null);
        var vol = new Array(SLOTS.length).fill(0), last = -1;
        d.trends.forEach(function (line) {
          var p = String(line).split(",");
          var t = p[0].slice(11, 13) + p[0].slice(14, 16);
          var i = SLOTS.indexOf(t);
          if (i < 0) return;
          px[i] = num(p[1]);
          vol[i] = num(p[2]);
          av[i] = num(p[3]) || null;
          if (i > last) last = i;
        });
        return { px: px, avg: av, vol: vol, last: last, pre: num(d.preClose), name: d.name || "" };
      });
  }

  function fetchKline(secid, lmt) {
    var qs = "?secid=" + secid + "&klt=101&fqt=1&end=20500101&lmt=" + (lmt || 120)
      + "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57";
    return api("emh/api/qt/stock/kline/get" + qs, "https://push2his.eastmoney.com/api/qt/stock/kline/get" + qs, 9000)
      .then(function (j) {
        var ks = (j && j.data && j.data.klines) || [];
        if (!ks.length) return null;
        return ks.map(function (line) {
          var p = String(line).split(",");
          return { d: p[0], o: num(p[1]), c: num(p[2]), h: num(p[3]), l: num(p[4]), v: num(p[5]), amt: num(p[6]) };
        });
      });
  }

  function fetchStockQ() {
    var secids = STOCKS.map(function (s) { return s.secid; }).join(",");
    var qs = "?fltt=2&secids=" + secids + "&fields=f2,f3,f4,f6,f12,f14,f18";
    return api("em/api/qt/ulist.np/get" + qs, "https://push2.eastmoney.com/api/qt/ulist.np/get" + qs, 9000)
      .then(function (j) {
        var rows = j && j.data && j.data.diff;
        if (!rows) return null;
        if (!Array.isArray(rows)) rows = Object.keys(rows).map(function (k) { return rows[k]; });
        var m = {};
        rows.forEach(function (r) { m[String(r.f12)] = { px: num(r.f2), pct: num(r.f3), chg: num(r.f4), amt: num(r.f6) }; });
        return m;
      });
  }

  /* 全量板块列表（行业 fs=2 / 概念 fs=3 / 地域 fs=1）：单页上限 100 条，分页拉全 */
  function fetchBoards(fs) {
    function page(pn) {
      var qs = "?pn=" + pn + "&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:" + fs + "+f:!50"
        + "&fields=f12,f14,f2,f3,f6,f62,f104,f105,f128";
      return api("em/api/qt/clist/get" + qs,
        "https://push2.eastmoney.com/api/qt/clist/get" + qs, 12000).then(function (j) {
        var d = j && j.data;
        if (!d) return { total: 0, rows: [] };
        var rows = d.diff;
        if (!Array.isArray(rows)) rows = Object.keys(rows || {}).map(function (k) { return rows[k]; });
        return { total: num(d.total), rows: rows || [] };
      }).catch(function () { return { total: 0, rows: [] }; });
    }
    return page(1).then(function (first) {
      var total = first.total || first.rows.length;
      var need = [], pn;
      for (pn = 2; pn <= Math.ceil(total / 100); pn++) need.push(pn);
      if (!need.length) return first.rows;
      /* 每批 3 个：并发太高会把反代打成失败，反被误判为「不可用」 */
      var all = first.rows.slice();
      function batch(i) {
        if (i >= need.length) return all;
        return Promise.all(need.slice(i, i + 3).map(function (p) { return page(p); }))
          .then(function (arr) {
            arr.forEach(function (r) { all = all.concat(r.rows); });
            return new Promise(function (res) { setTimeout(res, 80); }).then(function () { return batch(i + 3); });
          });
      }
      return batch(0);
    }).then(function (rows) {
      return rows.map(function (r) {
        var fl = (r.f62 === "-" || r.f62 == null) ? null : num(r.f62);
        return {
          code: String(r.f12), name: String(r.f14), px: num(r.f2), pct: num(r.f3),
          amt: num(r.f6), flow: fl, up: num(r.f104), dn: num(r.f105),
          lead: r.f128 ? String(r.f128) : ""
        };
      }).filter(function (x) { return x.code; });
    });
  }

  /* 板块成分股：按成交额降序取前 N 只，用于相对走势与个股表（任意板块通用） */
  function fetchMembers(secid) {
    var bk = (secid || BK_SECID).split(".")[1];
    var qs = "?pn=1&pz=" + (STOCK_N + 3) + "&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:" + bk
      + "&fields=f12,f13,f14,f2,f3,f6";
    return api("em/api/qt/clist/get" + qs,
      "https://push2.eastmoney.com/api/qt/clist/get" + qs, 9000)
      .then(function (j) {
        var rows = j && j.data && j.data.diff;
        if (!rows) return [];
        if (!Array.isArray(rows)) rows = Object.keys(rows).map(function (k) { return rows[k]; });
        return rows.filter(function (r) { return r && r.f12; })
          .slice(0, STOCK_N)
          .map(function (r, i) {
            var mk = String(r.f13) === "0" ? "0" : "1";   /* 0=深市 1=沪市 */
            return {
              secid: mk + "." + r.f12, code: String(r.f12), name: String(r.f14 || r.f12),
              tag: "", color: COLPAL[i % COLPAL.length]
            };
          });
      })
      .catch(function () { return []; });
  }

  /* 板块资金流（日线）：主力 = 大单 + 超大单；小/中单为对手盘，四类合计为 0
     返回按时间升序，最后一条为当日（盘中为实时累计） */
  function fetchFlow() {
    var qs = "?lmt=0&klt=101&secid=" + BK_SECID
      + "&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65";
    return api("emh/api/qt/stock/fflow/daykline/get" + qs,
      "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get" + qs, 12000)
      .then(function (j) {
        var ks = (j && j.data && j.data.klines) || [];
        if (!ks.length) return null;
        return ks.map(function (line) {
          var p = String(line).split(",");
          return {
            d: p[0], main: num(p[1]), small: num(p[2]), mid: num(p[3]), big: num(p[4]), huge: num(p[5]),
            mainPct: num(p[6]), c: num(p[11]), pct: num(p[12])
          };
        });
      });
  }

  /* ---------- 渲染：分时 ---------- */
  /* 分时量能柱：价格区在下沿以上，量能区占用下沿以下的 34% 高度，与券商分时图一致 */
  var mState = null;
  var minVolPlugin = {
    id: "bkMinVol",
    beforeDatasetsDraw: function (c) {
      var st = c.$mv || mState;
      if (!st) return;
      var ctx = c.ctx, ys = c.scales.y, area = c.chartArea;
      var meta = c.getDatasetMeta(0);
      if (!meta || !meta.data.length) return;
      var base = ys.getPixelForValue(st.priceBot);
      var bot = area.bottom;
      var hMax = bot - base;
      if (!(hMax > 2)) return;
      var n = meta.data.length;
      var step = n > 1 ? (meta.data[1].x - meta.data[0].x) : 1.2;
      var bw = Math.max(1, Math.min(7, step * 0.7));
      for (var i = 0; i < n; i++) {
        var v = st.vol[i];
        if (!(v > 0)) continue;
        var h = v / st.maxVol * hMax;
        if (h < 0.7) h = 0.7;
        if (h > hMax) h = hMax;
        ctx.fillStyle = st.cols[i];
        ctx.fillRect(meta.data[i].x - bw / 2, bot - h, bw, h);
      }
    }
  };

  function renderMin() {
    var cv = $("bkChart");
    if (!cv || !trends) return;
    var pre = trends.pre || 0;
    if (!pre) return;
    var pct = trends.px.map(function (v) { return v == null ? null : (v / pre - 1) * 100; });
    var apct = trends.avg.map(function (v) { return v == null ? null : (v / pre - 1) * 100; });
    /* 价格轴自适应：始终包含 0（昨收），但不做正负对称，避免单边行情留大片空白 */
    var hiP = 0, loP = 0, i;
    for (i = 0; i < pct.length; i++) {
      if (pct[i] == null) continue;
      if (pct[i] > hiP) hiP = pct[i];
      if (pct[i] < loP) loP = pct[i];
    }
    var padP = Math.max((hiP - loP) * 0.10, 0.12);
    var yMax = Math.ceil((hiP + padP) * 10) / 10;
    var yMin = Math.floor((loP - padP) * 10) / 10;
    if (yMax - yMin < 0.3) { yMax += 0.15; yMin -= 0.15; }
    var lastV = trends.last >= 0 ? pct[trends.last] : 0;
    var mainCol = lastV >= 0 ? "#e63946" : "#1a9e5f";
    var ctx = cv.getContext("2d");
    var g = ctx.createLinearGradient(0, 0, 0, 220);
    g.addColorStop(0, lastV >= 0 ? "rgba(230,57,70,.16)" : "rgba(26,158,95,.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");

    /* 量能区：价格区下沿再留 30% 高度；用 96 分位而非最大值，避免开盘巨量压平全天 */
    var volBot = yMin - (yMax - yMin) * 0.30;
    var volArr = trends.vol || [];
    var nz = volArr.filter(function (v) { return v > 0; });
    var sorted = nz.slice().sort(function (a, b) { return a - b; });
    var maxVol = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.96))] : 1;
    if (!(maxVol > 0)) maxVol = 1;
    var vcols = pct.map(function (v, i) {
      if (v == null) return "rgba(198,203,214,.5)";
      var pv = (i > 0 && pct[i - 1] != null) ? pct[i - 1] : 0;
      return v >= pv ? "rgba(230,57,70,.55)" : "rgba(26,158,95,.55)";
    });

    if (ch) ch.destroy();
    mState = { priceBot: yMin, vol: volArr, maxVol: maxVol, cols: vcols };   /* 必须先于构造 */
    ch = new Chart(ctx, {
      type: "line",
      plugins: [minVolPlugin],
      data: {
        labels: LABELS,
        datasets: [
          {
            label: "价格", data: pct, borderColor: mainCol, borderWidth: 1.7,
            pointRadius: 0, pointHitRadius: 10, tension: 0, spanGaps: false,
            fill: true, backgroundColor: g
          },
          {
            label: "均价", data: apct, borderColor: "#f59e0b", borderWidth: 1.2,
            borderDash: [3, 2], pointRadius: 0, tension: 0, spanGaps: false, fill: false
          },
          {
            label: "昨收", data: LABELS.map(function () { return 0; }),
            borderColor: "#c7cbd4", borderWidth: 1, borderDash: [4, 4],
            pointRadius: 0, fill: false
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 8, right: 8, bottom: 0, left: 2 } },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: true, boxWidth: 8, boxHeight: 8,
            callbacks: {
              title: function (its) { return its.length ? its[0].label : ""; },
              label: function (c) {
                if (c.datasetIndex === 2) return null;
                var i = c.dataIndex;
                var raw = c.datasetIndex === 0 ? trends.px[i] : trends.avg[i];
                if (raw == null) return null;
                var v = (raw / pre - 1) * 100;
                return c.dataset.label + " " + raw.toFixed(2) + "（" + (v >= 0 ? "+" : "") + v.toFixed(2) + "%）";
              },
              afterBody: function (its) {
                if (!its.length) return [];
                var v = (trends.vol || [])[its[0].dataIndex];
                return v ? ["该分钟量能 " + (v / 1e4).toFixed(1) + " 万"] : [];
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
            min: volBot, max: yMax,
            grid: {
              color: function (c) { return c.tick && c.tick.value === 0 ? "#d8dbe2" : "#f2f3f6"; },
              drawTicks: false
            },
            border: { display: false },
            afterBuildTicks: function (sc) {
              var step = Math.max(yMax, -yMin) / 2, a = [], k, v;
              for (k = 2; k >= -2; k--) {
                v = step * k;
                if (v >= yMin - 1e-9 && v <= yMax + 1e-9) a.push({ value: v });
              }
              sc.ticks = a;
            },
            ticks: {
              font: { size: 11 }, padding: 6,
              color: function (c2) {
                var v = (c2 && c2.tick && typeof c2.tick.value === "number") ? c2.tick.value : 0;
                return v > 0 ? "#e63946" : (v < 0 ? "#1a9e5f" : "#9aa0a8");
              },
              callback: function (v) { return Math.abs(v) < 1e-9 ? "0" : v.toFixed(2) + "%"; }
            }
          }
        }
      }
    });
    ch.$mv = mState;
    ch.update();                                   /* 保险：状态就位后补一次重绘 */
  }

  /* ---------- 渲染：日K（标准蜡烛图：实心红绿实体 + 影线 + 均线 + 成交量 + 十字光标）---------- */
  function ma(arr, n) {
    var out = [], i, s = 0;
    for (i = 0; i < arr.length; i++) {
      s += arr[i];
      if (i >= n) s -= arr[i - n];
      out.push(i >= n - 1 ? s / n : null);
    }
    return out;
  }

  /* 蜡烛 + 成交量 + 十字光标，全部画在同一坐标系内：
     y 轴下沿留出约 28% 高度给成交量（价格刻度只落在蜡烛区，成交量区不显示刻度） */
  /* 状态放在模块作用域：Chart 构造末尾会同步渲染一次，那时 ch 还没返回，
     所以不能依赖实例上的 $kst（否则首帧画不出蜡烛且之后不再重绘） */
  var kState = null;

  var klinePlugin = {
    id: "bkCandles",
    beforeDatasetsDraw: function (c) {
      var st = c.$kst || kState;
      if (!st) return;
      var ctx = c.ctx, K = st.K, ys = c.scales.y, area = c.chartArea;
      var divY = ys.getPixelForValue(st.procBot);
      var volH = area.bottom - divY;
      var maxV = st.maxVol || 1;
      var meta = c.getDatasetMeta(0);
      if (!meta.data.length) return;
      var step = meta.data.length > 1 ? (meta.data[1].x - meta.data[0].x) : 8;
      var bw = Math.max(2, Math.min(10, step * 0.64));

      ctx.save();
      /* 成交量区与价格区的分隔线 */
      ctx.strokeStyle = "#e9ecf2";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(area.left, divY);
      ctx.lineTo(area.right, divY);
      ctx.stroke();
      ctx.setLineDash([]);

      for (var i = 0; i < K.length; i++) {
        var el = meta.data[i];
        if (!el) continue;
        var k = K[i];
        var up = k.c >= k.o;
        var col = up ? "#e63946" : "#1a9e5f";
        var x = el.x;

        /* 成交量柱 */
        if (volH > 5 && k.v > 0) {
          var vh = k.v / maxV * (volH - 3);
          ctx.fillStyle = up ? "rgba(230,57,70,.42)" : "rgba(26,158,95,.42)";
          ctx.fillRect(Math.round(x - bw / 2), area.bottom - vh, Math.max(bw, 1), vh);
        }

        var yH = ys.getPixelForValue(k.h), yL = ys.getPixelForValue(k.l);
        var yO = ys.getPixelForValue(k.o), yC = ys.getPixelForValue(k.c);
        var xc = Math.round(x) + 0.5;

        /* 上下影线 */
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xc, Math.round(yH) + 0.5);
        ctx.lineTo(xc, Math.round(yL) + 0.5);
        ctx.stroke();

        /* 实体（收=开时画一条横线，即十字星） */
        var top = Math.min(yO, yC);
        var hgt = Math.max(Math.abs(yC - yO), 1);
        ctx.fillStyle = col;
        ctx.fillRect(Math.round(x - bw / 2), Math.round(top), Math.max(bw, 1), Math.round(hgt));
      }
      ctx.restore();
    },
    afterDraw: function (c) {
      var st = c.$kst || kState;
      if (!st) return;
      var act = c.tooltip && c.tooltip._active;
      if (!act || !act.length) return;
      var i = act[0].index, K = st.K;
      if (!K[i]) return;
      var el = c.getDatasetMeta(0).data[i];
      if (!el) return;
      var ctx = c.ctx, area = c.chartArea, ys = c.scales.y;
      var x = Math.round(el.x) + 0.5;
      var y = ys.getPixelForValue(K[i].c);

      ctx.save();
      ctx.strokeStyle = "#b9c0cc";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      /* 右侧价格标签 */
      var txt = K[i].c.toFixed(2);
      ctx.font = "700 10.5px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      var tw = Math.round(ctx.measureText(txt).width) + 9;
      var bh = 15;
      var bx = Math.min(area.right + 2, c.width - tw - 1);
      ctx.fillStyle = K[i].c >= K[i].o ? "#e63946" : "#1a9e5f";
      ctx.fillRect(bx, y - bh / 2, tw, bh);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, bx + tw / 2, y);
      ctx.restore();
    }
  };

  /* 日K 失败时给可见提示 + 一键重试，不能静默留白（用户只会以为「日K坏了」） */
  function showDayErr(msg) {
    var box = $("bkKBox");
    if (!box) return;
    var old = box.querySelector(".bk-err");
    if (!msg) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    box.style.position = "relative";
    if (old) { old.querySelector(".bk-err-t").textContent = msg; return; }
    var d = document.createElement("div");
    d.className = "bk-err";
    d.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;"
      + "align-items:center;justify-content:center;gap:9px;background:rgba(251,252,254,.95);z-index:4;"
      + "font-size:13px;color:#8a93a0;border-radius:8px";
    var t = document.createElement("div");
    t.className = "bk-err-t";
    t.textContent = msg;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "↻ 重新加载日K";
    btn.style.cssText = "padding:5px 14px;font-size:12.5px;border:1px solid #cfd6e2;border-radius:6px;"
      + "background:#fff;color:#2f6fed;cursor:pointer";
    btn.onclick = function () { showDayErr(null); load(); };
    d.appendChild(t); d.appendChild(btn);
    box.appendChild(d);
  }

  function renderDay() {
    var cv = $("bkChart");
    if (!cv || !bkKline) return;
    var K = bkKline.slice(-60);
    var off = bkKline.length - K.length;                       /* 均线用完整序列算，MA60 才有效 */
    var closesAll = bkKline.map(function (x) { return x.c; });
    var labels = K.map(function (x) { return x.d.slice(5); });
    var loR = Math.min.apply(null, K.map(function (x) { return x.l; }));
    var hiR = Math.max.apply(null, K.map(function (x) { return x.h; }));
    var pad = (hiR - loR) * 0.06 || 1;
    var procBot = loR - pad, procTop = hiR + pad;
    var axisMin = procBot - (procTop - procBot) * 0.40;   /* 下沿留出成交量区 */
    var maxVol = Math.max.apply(null, K.map(function (x) { return x.v; })) || 1;

    var ds = [{
      label: "__k", data: closesAll.slice(off), borderColor: "rgba(0,0,0,0)", borderWidth: 0,
      pointRadius: 0, pointHitRadius: 12, fill: false, spanGaps: true
    }];
    var MA = [[5, "#f59e0b"], [10, "#2f6fed"], [20, "#a855f7"], [60, "#64748b"]];
    MA.forEach(function (m) {
      ds.push({
        label: "MA" + m[0], data: ma(closesAll, m[0]).slice(off), borderColor: m[1],
        borderWidth: 1.1, pointRadius: 0, tension: 0, spanGaps: true, fill: false
      });
    });

    if (ch) ch.destroy();
    kState = { K: K, procBot: procBot, maxVol: maxVol };   /* 必须先于构造，首帧才能画出蜡烛 */
    ch = new Chart(cv.getContext("2d"), {
      type: "line",
      data: { labels: labels, datasets: ds },
      plugins: [klinePlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 8, right: 48, bottom: 0, left: 2 } },
        interaction: { mode: "index", intersect: false },
        hover: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true, position: "top", align: "end",
            labels: {
              boxWidth: 8, boxHeight: 8, font: { size: 10.5 }, color: "#6b7280",
              filter: function (it) { return !/^__/.test(it.text); }
            }
          },
          tooltip: {
            displayColors: false, padding: 10, cornerRadius: 8,
            backgroundColor: TIP_BG, borderColor: TIP_BORDER, borderWidth: 1,
            titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11.5 }, bodySpacing: 4,
            titleColor: TIP_TITLE, bodyColor: TIP_BODY,
            filter: function (it) { return !/^__/.test(it.dataset.label); },
            callbacks: {
              title: function (its) { return its.length ? K[its[0].dataIndex].d : ""; },
              label: function (c) {
                if (!/^MA/.test(c.dataset.label)) return null;
                return c.dataset.label + "：" + (c.parsed.y == null ? "--" : c.parsed.y.toFixed(2));
              },
              afterBody: function (its) {
                if (!its.length) return [];
                var idx = its[0].dataIndex, k = K[idx];
                var pre = idx > 0 ? K[idx - 1].c : k.o;
                var pct = pre ? (k.c - pre) / pre * 100 : 0;
                return [
                  "开 " + k.o.toFixed(2) + "    收 " + k.c.toFixed(2),
                  "高 " + k.h.toFixed(2) + "    低 " + k.l.toFixed(2),
                  "涨跌 " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%    振幅 "
                    + (pre ? ((k.h - k.l) / pre * 100).toFixed(2) : "0.00") + "%",
                  "成交 " + (k.amt / YI).toFixed(1) + " 亿"
                ];
              }
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
            min: axisMin, max: procTop,
            grid: { color: "#f4f5f7" }, border: { display: false },
            /* 价格刻度只铺在蜡烛区，成交量区留空 */
            afterBuildTicks: function (sc) {
              var a = [], n = 5, i;
              for (i = 0; i < n; i++) a.push({ value: procBot + (procTop - procBot) * i / (n - 1) });
              sc.ticks = a;
            },
            ticks: {
              font: { size: 10.5 }, color: "#9aa0a8", padding: 5,
              callback: function (v) { return Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2); }
            }
          }
        }
      }
    });
    ch.$kst = kState;
    ch.update();                                          /* 保险：状态变更后强制重绘一帧 */
  }

  /* ---------- 渲染：60 日相对走势（基准 100）---------- */
  function renderRel() {
    var cv = $("bkRel");
    if (!cv || !relSeries) return;
    var series = relSeries;
    var n = series.base.length;
    if (!n) return;
    var labels = series.dates.map(function (d) { return d.slice(5); });
    var sets = [];
    var COLS = { "板块": "#16181d" };
    sets.push({
      label: BK_NAME, data: series.base, borderColor: "#16181d", borderWidth: 2,
      pointRadius: 0, tension: 0.15, fill: false
    });
    STOCKS.forEach(function (s) {
      var v = series.stocks[s.code];
      if (!v) return;
      sets.push({
        label: s.name.replace(/银行/g, ""), data: v, borderColor: s.color, borderWidth: 1.6,
        pointRadius: 0, tension: 0.15, fill: false
      });
    });
    if (chRel) chRel.destroy();
    chRel = new Chart(cv.getContext("2d"), {
      type: "line",
      data: { labels: labels, datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 6, right: 8, bottom: 0, left: 2 } },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true, position: "top", align: "end",
            labels: { boxWidth: 8, boxHeight: 8, font: { size: 11 }, color: "#6b7280" }
          },
          tooltip: {
            displayColors: true, boxWidth: 8, boxHeight: 8,
            callbacks: {
              label: function (c) {
                var v = c.parsed.y;
                if (v == null) return null;
                return c.dataset.label + " " + v.toFixed(1) + "（" + (v - 100 >= 0 ? "+" : "") + (v - 100).toFixed(1) + "%）";
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: {
              font: { size: 10 }, maxRotation: 0, autoSkip: false, color: "#9aa0a8",
              callback: function (val) { return this.getLabelForValue(val); },
              // 只保留约 5 个刻度
              autoSkip: true, maxTicksLimit: 5
            }
          },
          y: {
            grid: { color: "#f4f5f7" }, border: { display: false },
            ticks: {
              font: { size: 10.5 }, maxTicksLimit: 5, color: "#9aa0a8", padding: 5,
              callback: function (v) { return v.toFixed(0); }
            }
          }
        }
      }
    });
  }

  /* ---------- 量价关系 ---------- */
  function avg(a) {
    if (!a.length) return 0;
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  /* 交易时间进度（9:30-11:30 + 13:00-15:00，共 242 分钟），收盘后 = 1 */
  function sessionProgress() {
    var n = new Date(), wd = n.getDay(), m = n.getHours() * 60 + n.getMinutes();
    if (wd === 0 || wd === 6) return 1;
    if (m <= 570) return 1;                       /* 开盘前视为上一交易日已收盘 */
    if (m <= 690) return (m - 570) / 242;
    if (m < 780) return 120 / 242;                /* 午间休市 */
    if (m <= 900) return (120 + m - 780) / 242;
    return 1;
  }
  function pearson(x, y) {
    var n = Math.min(x.length, y.length), i, mx = 0, my = 0, sxy = 0, sx2 = 0, sy2 = 0, v, w;
    if (n < 3) return null;
    for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) { v = x[i] - mx; w = y[i] - my; sxy += v * w; sx2 += v * v; sy2 += w * w; }
    if (sx2 <= 0 || sy2 <= 0) return null;
    return sxy / Math.sqrt(sx2 * sy2);
  }

  /* 九宫格：价(涨/平/跌) × 量(增/平/缩) */
  var VP_RULES = {
    "涨增": ["量价齐升", "up", "资金持续进场，量能配合价格上行，趋势健康度较高。"],
    "涨平": ["温和上行", "up", "量能基本持平而价格走强，属存量资金推动，尚未形成放量突破。"],
    "涨缩": ["缩量上涨", "warn", "价格上行但量能收缩，跟风盘不足，需防滞涨与量价顶背离。"],
    "跌增": ["放量下跌", "down", "下跌伴随成交量放大，抛压集中释放，短线趋势偏弱。"],
    "跌平": ["量价齐跌", "down", "量能持平而价格走弱，属阴跌格局，趋势尚未扭转。"],
    "跌缩": ["缩量下跌", "warn", "跌幅有限且量能萎缩，抛压趋于衰竭，等待企稳信号确认。"],
    "平增": ["放量滞涨", "warn", "价格原地踏步而量能放大，多空分歧加剧，多见于换手或高位派发。"],
    "平缩": ["缩量整理", "flat", "量能收缩且价格横盘，方向待选择，属观望状态。"],
    "平平": ["量价平稳", "flat", "量价均无显著变化，维持原有运行节奏。"]
  };

  function computeVP() {
    var K = bkKline;
    if (!K || K.length < 26) return null;
    var n = K.length, i;
    var cur = K[n - 1], prev = K[n - 2];
    /* 涨跌幅优先取实时报价，与卡片头部一致（日K收盘价与之可能有 0.0x% 的口径差）*/
    var pct = (quote && quote.px && quote.pre)
      ? (quote.px / quote.pre - 1) * 100
      : (prev && prev.c ? (cur.c - prev.c) / prev.c * 100 : 0);
    var amts = K.map(function (x) { return x.amt > 0 ? x.amt : x.v * 100; });

    var a5 = avg(amts.slice(-6, -1));          /* 前 5 日均额（不含当日，避免自我影响）*/
    var a20 = avg(amts.slice(-21, -1));        /* 前 20 日均额 */
    var amtNow = (quote && quote.amt) ? quote.amt : cur.amt;
    var prog = sessionProgress();
    /* 量比：当日成交额按时间进度折算为全天 → 除以前 5 日均额；收盘后 prog=1 即真实倍数 */
    var vr = a5 > 0 ? (amtNow / Math.max(prog, 0.04)) / a5 : null;

    /* 20 日量价相关：日涨跌幅 vs 成交额对数环比变化 */
    var r = [], g = [];
    for (i = n - 20; i < n; i++) {
      if (i <= 0) continue;
      r.push((K[i].c - K[i - 1].c) / K[i - 1].c * 100);
      g.push(Math.log(amts[i] / Math.max(amts[i - 1], 1)) * 100);
    }
    var cor = pearson(r, g);

    /* OBV：以成交额加权（板块指数成交量单位不统一，额更可比），20 日净额占累计额比重 */
    var obv = 0, sumA = 0;
    for (i = n - 20; i < n; i++) {
      if (i <= 0) continue;
      obv += (K[i].c > K[i - 1].c ? 1 : (K[i].c < K[i - 1].c ? -1 : 0)) * amts[i];
      sumA += amts[i];
    }
    var obvR = sumA > 0 ? obv / sumA * 100 : 0;

    var pz = pct >= 1 ? "涨" : (pct <= -1 ? "跌" : "平");
    var vz = vr == null ? "平" : (vr >= 1.15 ? "增" : (vr <= 0.85 ? "缩" : "平"));
    return {
      pct: pct, vr: vr, a5: a5, a20: a20, ra: a20 > 0 ? a5 / a20 : null,
      cor: cor, obvR: obvR, prog: prog, amtNow: amtNow, cur: cur,
      rule: VP_RULES[pz + vz] || VP_RULES["平平"], pz: pz, vz: vz
    };
  }

  function sign(v, d) { return (v >= 0 ? "+" : "") + v.toFixed(d == null ? 2 : d); }

  function renderVP() {
    var vp = computeVP();
    var badge = $("vpBadge"), txt = $("vpTxt"), note = $("vpNote");
    if (!badge) return;
    if (!vp) {
      /* 首屏 renderVP 会先跑一次（日K 还没回来），这里要区分「加载中」「加载失败」「真的没数据」 */
      var loading = !bkKline && !dayFailed;
      badge.textContent = loading ? "加载中…" : (dayFailed ? "加载失败" : "数据不足");
      badge.className = "vp-badge flat";
      if (txt) txt.textContent = loading ? "日K 数据加载中，稍候自动刷新。"
        : (dayFailed ? "日K 行情源临时断开，量价关系待重试成功后计算。"
          : "日K 历史不足 26 个交易日，无法判定量价关系。");
      return;
    }

    var rule = vp.rule;
    badge.textContent = rule[0];
    badge.className = "vp-badge " + rule[1];
    txt.textContent = rule[2];

    var vr = $("vpVR"), vri = $("vpVRi");
    if (vr) {
      vr.textContent = vp.vr == null ? "--" : vp.vr.toFixed(2) + " 倍";
      vr.className = vp.vr == null ? "" : (vp.vr >= 1.15 ? "up" : (vp.vr <= 0.85 ? "down" : ""));
      vri.textContent = vp.prog < 0.999
        ? "按 " + Math.round(vp.prog * 100) + "% 进度折算" : "前 5 日均额 " + (vp.a5 / YI).toFixed(0) + " 亿";
    }
    var ra = $("vpRA"), rai = $("vpRAi");
    if (ra) {
      ra.textContent = vp.ra == null ? "--" : vp.ra.toFixed(2);
      ra.className = vp.ra == null ? "" : (vp.ra >= 1.05 ? "up" : (vp.ra <= 0.95 ? "down" : ""));
      rai.textContent = "5日 " + (vp.a5 / YI).toFixed(0) + "亿 ｜ 20日 " + (vp.a20 / YI).toFixed(0) + "亿";
    }
    var co = $("vpCor"), coi = $("vpCori");
    if (co) {
      var c = vp.cor;
      co.textContent = c == null ? "--" : sign(c, 2);
      co.className = c == null ? "" : (c >= 0.2 ? "up" : (c <= -0.2 ? "down" : ""));
      coi.textContent = c == null ? "--" : (Math.abs(c) >= 0.5 ? "强" : (Math.abs(c) >= 0.2 ? "弱" : "无"))
        + (c >= 0 ? "正相关·配合" : "负相关·背离");
    }
    var ob = $("vpObv"), obi = $("vpObvi");
    if (ob) {
      ob.textContent = sign(vp.obvR, 1) + "%";
      ob.className = vp.obvR >= 0 ? "up" : "down";
      obi.textContent = vp.obvR >= 0 ? "20 日量能净流入" : "20 日量能净流出";
    }

    if (note) {
      var bits = [];
      bits.push("今日 <b>" + sign(vp.pct) + "%</b> 配合 <b>" + (vp.vr == null ? "--" : vp.vr.toFixed(2)) + " 倍</b>量能（较前 5 日均额），判定为<b>" + rule[0] + "</b>。");
      if (vp.ra != null) {
        bits.push("中期量能" + (vp.ra >= 1.15 ? "仍在扩张" : (vp.ra <= 0.9 ? "持续收缩" : "大体平稳"))
          + "（5 日/20 日均额 " + vp.ra.toFixed(2) + "）。");
      }
      if (vp.cor != null && vp.cor <= -0.2) bits.push("近 20 日量价<b>负相关</b>（" + sign(vp.cor) + "），价量背离，反弹持续性存疑。");
      else if (vp.cor != null && vp.cor >= 0.4 && vp.pz === "跌") bits.push("但近 20 日量价正相关（" + sign(vp.cor) + "），本轮下跌仍属<b>放量常态</b>，未见缩量止跌。");
      note.innerHTML = bits.join(" ")
        + "<br>口径：量比 = 当日成交额 ÷ 交易时间进度 ÷ 前 5 日均额；5日/20日均额为板块成交额均值之比（>1 量能扩张）；20日量价相关为日涨跌幅与成交额对数环比的 Pearson 系数（正=量价配合，负=背离）；OBV 以成交额加权，取 20 日净额占累计额比重。";
    }
    renderVPChart();
  }

  var chVP = null;
  function renderVPChart() {
    var cv = $("bkVP");
    if (!cv || !bkKline) return;
    var K = bkKline.slice(-60);
    var labels = K.map(function (x) { return x.d.slice(5); });
    var bars = K.map(function (x) { return +(x.amt / YI).toFixed(2); });
    var line = K.map(function (x) { return x.c; });
    var cols = K.map(function (x, i) {
      var p = i > 0 ? K[i - 1].c : x.o;
      return x.c >= p ? "rgba(230,57,70,.62)" : "rgba(26,158,95,.62)";
    });

    /* 价量分栏：柱只用下方 46% 高度，价格线压在上方 —— 与券商「价量图」一致，互不遮挡 */
    var lo = Math.min.apply(null, line), hi = Math.max.apply(null, line);
    var rng = (hi - lo) || hi * 0.02 || 1;
    var maxBar = Math.max.apply(null, bars) || 1;
    var vMax = maxBar / 0.46;                     /* 峰值柱恰好落在 46% 高度 */
    var pMin = lo - rng * 1.15;                   /* lo 落在 ~53.5% 高度，留出空隙 */
    var pMax = hi;

    if (chVP) chVP.destroy();
    chVP = new Chart(cv.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "成交额", data: bars, backgroundColor: cols, borderWidth: 0,
            borderRadius: 1, barPercentage: 0.8, categoryPercentage: 0.92, yAxisID: "y", order: 2
          },
          {
            type: "line", label: "收盘价", data: line, borderColor: "#16181d", borderWidth: 1.8,
            pointRadius: 0, pointHitRadius: 10, tension: 0, spanGaps: true, fill: false,
            yAxisID: "y1", order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 6, right: 6, bottom: 0, left: 0 } },
        interaction: { mode: "index", intersect: false },
        hover: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true, position: "top", align: "end",
            labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 }, color: "#6b7280" }
          },
          tooltip: {
            displayColors: false, padding: 10, cornerRadius: 8,
            backgroundColor: TIP_BG, borderColor: TIP_BORDER, borderWidth: 1,
            titleFont: { size: 11.5 }, bodyFont: { size: 11 },
            titleColor: TIP_TITLE, bodyColor: TIP_BODY,
            titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11.5 }, bodySpacing: 4,
            callbacks: {
              title: function (its) { return its.length ? K[its[0].dataIndex].d : ""; },
              label: function (c2) {
                var i = c2.dataIndex, k = K[i];
                if (c2.datasetIndex === 1) return "收盘 " + k.c.toFixed(2);
                var pre = i > 0 ? K[i - 1].c : k.o;
                var pct = pre ? (k.c - pre) / pre * 100 : 0;
                return ["成交额 " + (k.amt / YI).toFixed(2) + " 亿",
                        "涨跌 " + sign(pct) + "%"];
              },
              afterBody: function (its) {
                if (!its.length) return [];
                var i = its[0].dataIndex;
                var s5 = K.slice(Math.max(0, i - 5), i);
                if (!s5.length) return [];
                var m5 = avg(s5.map(function (x) { return x.amt; }));
                return ["较前 5 日均额 " + (m5 > 0 ? (K[i].amt / m5).toFixed(2) + " 倍" : "--")];
              }
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
            position: "left", min: 0, max: vMax,
            grid: { color: "#f4f5f7" }, border: { display: false },
            /* 刻度只铺在量柱区（0 / 半 / 峰值），避免顶部落到价格区 */
            afterBuildTicks: function (sc) {
              sc.ticks = [{ value: 0 }, { value: maxBar / 2 }, { value: maxBar }];
            },
            ticks: {
              font: { size: 10 }, color: "#b6bcc6", padding: 4,
              callback: function (v) { return v === 0 ? "0" : Math.round(v) + "亿"; }
            }
          },
          y1: {
            position: "right", min: pMin, max: pMax,
            grid: { display: false }, border: { display: false },
            /* 价格刻度只铺在价格区（lo~hi），不显示 pMin 这类无意义值 */
            afterBuildTicks: function (sc) {
              var a = [], n = 3, i;
              for (i = 0; i < n; i++) a.push({ value: lo + (hi - lo) * i / (n - 1) });
              sc.ticks = a;
            },
            ticks: {
              font: { size: 10.5 }, color: "#9aa0a8", padding: 5,
              callback: function (v) { return Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2); }
            }
          }
        }
      }
    });
  }

  /* ---------- 资金流向（主力净流入 / 流出） ---------- */
  /* 口径：主力 = 超大单 + 大单；小单/中单为对手盘，四类净额相加为 0。
     流入用红、流出用绿（A 股习惯），与价格涨跌色无关，只看资金方向。 */
  function computeFlow() {
    var F = bkFlow;
    if (!F || F.length < 6) return null;
    var n = F.length, cur = F[n - 1], i;
    function sumN(k) {
      var s = 0;
      for (i = Math.max(0, n - k); i < n; i++) s += F[i].main;
      return s;
    }
    var d1 = cur.main, d5 = sumN(5), d10 = sumN(10), d20 = sumN(20);

    /* 连续同向天数 */
    var dir = d1 >= 0 ? 1 : -1, streak = 0;
    for (i = n - 1; i >= 0; i--) {
      if ((F[i].main >= 0 ? 1 : -1) === dir) streak++; else break;
    }
    /* 5 日 vs 前 5 日：同号看放大/收敛，异号即方向反转 */
    var prev5 = 0;
    for (i = Math.max(0, n - 10); i < n - 5; i++) prev5 += F[i].main;
    var accel = null, accelTxt = "前 5 日基本无净额";
    if (Math.abs(prev5) > 1e6 && Math.abs(d5) > 1e6) {
      if (d5 * prev5 > 0) {
        accel = d5 / prev5;
        accelTxt = accel >= 1.15 ? "较前 5 日放大 " + accel.toFixed(2) + " 倍"
          : (accel <= 0.87 ? "收敛至前 5 日的 " + accel.toFixed(2) + " 倍" : "与前 5 日基本持平");
      } else {
        accelTxt = "方向反转（前 5 日 " + yiFmt(prev5, 1) + "）";
      }
    }

    var inDays = 0, outDays = 0;
    for (i = Math.max(0, n - 20); i < n; i++) { if (F[i].main > 0) inDays++; else outDays++; }

    var pz = d1 > 0 ? 1 : -1, mz = d20 > 0 ? 1 : -1;
    var label, cls;
    if (pz > 0 && mz > 0) { label = "主力持续流入"; cls = "up"; }
    else if (pz > 0 && mz <= 0) { label = "单日回流"; cls = "warn"; }
    else if (pz <= 0 && mz > 0) { label = "获利兑现"; cls = "warn"; }
    else { label = "主力持续流出"; cls = "down"; }

    /* 结构：超大单≈机构、小单≈散户 */
    var struct = [
      { k: "超大单", v: cur.huge, tag: "机构" },
      { k: "大单", v: cur.big, tag: "主力" },
      { k: "中单", v: cur.mid, tag: "游资" },
      { k: "小单", v: cur.small, tag: "散户" }
    ];
    var sMax = 1;
    struct.forEach(function (x) { if (Math.abs(x.v) > sMax) sMax = Math.abs(x.v); });

    var read = "";
    if (cur.huge > 0 && cur.small < 0) read = "超大单净买、小单净卖，机构资金承接散户抛盘，属健康换手。";
    else if (cur.huge < 0 && cur.small > 0) read = "超大单净卖、小单净买，机构派发而散户接盘，需防高位滞涨。";
    else if (cur.huge > 0 && cur.small > 0) read = "超大单与小单同向净买，增量资金进场，人气与主力共振。";
    else if (cur.huge < 0 && cur.small < 0) read = "超大单与小单同向净卖，全面减仓，短线承接力偏弱。";
    else read = "四类资金方向不一致，多空分歧较大，等待方向选择。";

    return {
      d: cur.d, d1: d1, d5: d5, d10: d10, d20: d20,
      mainPct: cur.mainPct, pct: cur.pct, c: cur.c,
      streak: streak, dir: dir, inDays: inDays, outDays: outDays,
      accel: accel, accelTxt: accelTxt, prev5: prev5,
      label: label, cls: cls, struct: struct, sMax: sMax, read: read,
      upd: cur.d
    };
  }

  function yiFmt(v, d) {
    var a = Math.abs(v) / YI;
    return (v >= 0 ? "+" : "-") + a.toFixed(d == null ? 2 : d) + " 亿";
  }

  function renderFlow() {
    var fl = computeFlow();
    var badge = $("flBadge"), txt = $("flTxt"), note = $("flNote");
    if (!badge) return;
    if (!fl) {
      var loading = !bkFlow;
      badge.textContent = loading ? "加载中…" : "数据未就绪";
      badge.className = "vp-badge flat";
      if (txt) txt.textContent = loading ? "资金流数据加载中，稍候自动刷新。"
        : "资金流接口暂不可用或该板块资金流历史不足，稍后自动重试。";
      if (note) note.textContent = "口径：主力净额 = 超大单 + 大单，数据源为东方财富板块日线资金流（需联网，经同源反代 /api/emh/）。";
      return;
    }

    badge.textContent = fl.label;
    badge.className = "vp-badge " + fl.cls;

    var bits = [];
    bits.push("今日主力 <b>" + yiFmt(fl.d1) + "</b>（占成交额 <b>" + sign(fl.mainPct) + "%</b>），20 日累计 <b>"
      + yiFmt(fl.d20, 1) + "</b>。");
    if (fl.label === "主力持续流入") bits.push("今日与中期同向净买入，资金面支撑价格。");
    else if (fl.label === "单日回流") bits.push("今日为短线回流，中期仍是净流出格局，趋势未改。");
    else if (fl.label === "获利兑现") bits.push("今日净卖出但中期仍在净买入区间，多为获利兑现而非趋势反转。");
    else bits.push("今日与中期同为净流出，资金持续撤离，反弹持续性存疑。");
    /* 5 日与 20 日方向相反时，补一句短期拐点提示，避免只看中期结论 */
    if (fl.d5 * fl.d20 < 0 && Math.abs(fl.d5) > 1e8) {
      bits.push("但近 5 日已转为" + (fl.d5 > 0 ? "净流入" : "净流出") + " <b>" + yiFmt(fl.d5, 1)
        + "</b>，短期方向与中期相反。");
    }
    if (txt) txt.innerHTML = bits.join("");
    if (note) {
      note.innerHTML = "结构：" + fl.read
        + "<br>口径：主力净额 = 超大单 + 大单（东财板块 " + BK_NAME + " " + BK_CODE
        + " 日线资金流）；近 20 日净流入 " + fl.inDays + " 天 / 净流出 " + fl.outDays + " 天；连续"
        + (fl.dir > 0 ? "净流入 " : "净流出 ") + fl.streak + " 天；5 日累计 " + yiFmt(fl.d5, 1)
        + "，" + fl.accelTxt + "。数据时点 " + fl.upd + "（盘中为实时累计）。";
    }

    /* 四个指标卡 */
    var k1 = $("flD1"), k1i = $("flD1i");
    if (k1) {
      k1.textContent = yiFmt(fl.d1);
      k1.className = fl.d1 >= 0 ? "up" : "down";
      k1i.textContent = "占成交额 " + sign(fl.mainPct) + "%";
    }
    var k5 = $("flD5"), k5i = $("flD5i");
    if (k5) {
      k5.textContent = yiFmt(fl.d5, 1);
      k5.className = fl.d5 >= 0 ? "up" : "down";
      k5i.textContent = fl.accelTxt;
    }
    var k20 = $("flD20"), k20i = $("flD20i");
    if (k20) {
      k20.textContent = yiFmt(fl.d20, 1);
      k20.className = fl.d20 >= 0 ? "up" : "down";
      k20i.textContent = "20 日内 " + fl.inDays + " 天流入 / " + fl.outDays + " 天流出";
    }
    var kS = $("flStreak"), kSi = $("flStreaki");
    if (kS) {
      kS.textContent = fl.streak + " 天";
      kS.className = fl.dir > 0 ? "up" : "down";
      kSi.textContent = "连续" + (fl.dir > 0 ? "净流入" : "净流出");
    }

    /* 今日四类资金结构条 */
    var box = $("flStruct");
    if (box) {
      box.innerHTML = fl.struct.map(function (x) {
        var up = x.v >= 0;
        var w = Math.min(50, Math.abs(x.v) / fl.sMax * 50);
        var style = up
          ? "left:50%;width:" + w.toFixed(1) + "%;background:#e63946"
          : "right:50%;width:" + w.toFixed(1) + "%;background:#1a9e5f";
        return '<div class="fl-row"><span class="fl-lb">' + x.k + '<i>' + x.tag + '</i></span>'
          + '<span class="fl-bar"><i style="' + style + '"></i></span>'
          + '<b class="' + (up ? "up" : "down") + '">' + yiFmt(x.v) + '</b></div>';
      }).join("");
    }

    renderFlowChart();
  }

  var chFL = null;
  /* 把步长归到 1/2/2.5/5/10 × 10^n，避免出现 34/30/20 这种边界畸形刻度 */
  function niceStep(x) {
    if (!(x > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var m = x / e;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
  }

  function renderFlowChart() {
    var cv = $("bkFlow");
    if (!cv || !bkFlow || bkFlow.length < 2) return;
    var F = bkFlow.slice(-30);
    var labels = F.map(function (x) { return x.d.slice(5); });
    var bars = F.map(function (x) { return +(x.main / YI).toFixed(2); });
    var cols = F.map(function (x) { return x.main >= 0 ? "rgba(230,57,70,.72)" : "rgba(26,158,95,.72)"; });
    /* 累计净额：窗口内从 0 起算，反映「这 30 天主力是净买还是净卖」 */
    var cum = [], s = 0;
    F.forEach(function (x) { s += x.main; cum.push(+(s / YI).toFixed(2)); });

    /* 双轴各管一条：左轴只按当日净额定范围（0 轴居中，流入流出柱高可比），
       右轴只管累计线 —— 否则累计到上百亿会把日柱压成一条线 */
    var bAbs = Math.max.apply(null, bars.map(function (v) { return Math.abs(v); }).concat([1]));
    /* 轴上限定在「最大值 +8%」，刻度取整到步长 —— 若像原来那样把上限圆整到下一个步长，
       遇单日极端净流出会把上限撑到 40 亿，其余日子柱子就只剩几个像素 */
    var half = bAbs * 1.08;
    var stepL = niceStep(bAbs / 3);                 /* 目标 3 条正刻度，避免只有 0/±20 三条 */
    var topL = Math.floor(half / stepL) * stepL;
    var cMax = Math.max.apply(null, cum.concat([0]));
    var cMin = Math.min.apply(null, cum.concat([0]));
    var stepR = niceStep((cMax - cMin || 1) / 4);
    var cLo = Math.floor(cMin / stepR) * stepR, cHi = Math.ceil(cMax / stepR) * stepR;
    if (cHi === cLo) cHi = cLo + stepR;
    function ticksOf(lo, hi, st) {
      var a = [], v;
      for (v = lo; v <= hi + st * 1e-6; v += st) a.push({ value: +v.toFixed(6) });
      return a;
    }

    if (chFL) chFL.destroy();
    chFL = new Chart(cv.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "主力净流入（亿）", data: bars, backgroundColor: cols, borderWidth: 0,
            borderRadius: 1.5, barPercentage: 0.86, categoryPercentage: 0.92, yAxisID: "y", order: 2
          },
          {
            type: "line", label: "主力累计净额（亿）", data: cum, borderColor: "#2f6fed", borderWidth: 1.8,
            pointRadius: 0, pointHitRadius: 10, tension: 0, fill: false, yAxisID: "y1", order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 6, right: 6, bottom: 0, left: 0 } },
        interaction: { mode: "index", intersect: false },
        hover: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true, position: "top", align: "end",
            labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 }, color: "#6b7280" }
          },
          tooltip: {
            displayColors: false, padding: 10, cornerRadius: 8,
            backgroundColor: TIP_BG, borderColor: TIP_BORDER, borderWidth: 1,
            titleFont: { size: 11.5 }, bodyFont: { size: 11 },
            titleColor: TIP_TITLE, bodyColor: TIP_BODY,
            titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11.5 }, bodySpacing: 4,
            callbacks: {
              title: function (its) { return its.length ? F[its[0].dataIndex].d : ""; },
              label: function (c2) {
                var k = F[c2.dataIndex];
                if (c2.datasetIndex === 1) return "累计 " + (cum[c2.dataIndex] >= 0 ? "+" : "-") + Math.abs(cum[c2.dataIndex]).toFixed(1) + " 亿";
                return "主力 " + yiFmt(k.main) + "（占额 " + sign(k.mainPct) + "%）";
              },
              afterBody: function (its) {
                if (!its.length) return [];
                var k = F[its[0].dataIndex];
                return [
                  "超大单 " + yiFmt(k.huge) + " ｜ 大单 " + yiFmt(k.big),
                  "中单 " + yiFmt(k.mid) + " ｜ 小单 " + yiFmt(k.small),
                  "板块涨跌 " + sign(k.pct) + "%"
                ];
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: {
              font: { size: 10 }, maxRotation: 0, autoSkip: false, color: "#9aa0a8",
              callback: function (val, idx) { return idx % 5 === 0 ? this.getLabelForValue(val) : ""; }
            }
          },
          y: {
            position: "left", min: -half, max: half,
            grid: { color: function (ctx) { return ctx.tick && ctx.tick.value === 0 ? "#dde1e8" : "#f4f5f7"; } },
            border: { display: false },
            afterBuildTicks: function (sc) { sc.ticks = ticksOf(-topL, topL, stepL); },
            ticks: {
              font: { size: 10 }, color: "#b6bcc6", padding: 4,
              callback: function (v) { return v === 0 ? "0" : (Math.abs(v) < 10 ? +v.toFixed(1) : Math.round(v)) + "亿"; }
            }
          },
          y1: {
            position: "right", min: cLo, max: cHi,
            grid: { display: false }, border: { display: false },
            afterBuildTicks: function (sc) { sc.ticks = ticksOf(cLo, cHi, stepR); },
            ticks: {
              font: { size: 10 }, color: "#2f6fed", padding: 5,
              callback: function (v) { return (Math.abs(v) < 10 ? +v.toFixed(1) : Math.round(v)) + "亿"; }
            }
          }
        }
      }
    });
  }

  /* ---------- 指标区 / 个股表 ---------- */
  function renderHeader() {
    if (!quote) return;
    BK_NAME = quote.name || BK_NAME;
    $("bkName").textContent = BK_NAME;
    var tag = $("bkTag");
    if (tag) tag.textContent = BK_CODE;
    var relH = $("bkRelH4");
    if (relH) {
      relH.textContent = "60 日相对走势（首日 = 100）：" + BK_NAME + " vs "
        + STOCKS.map(function (s) { return s.name.replace(/银行/g, ""); }).join(" / ");
    }
    var px = $("bkPx"), chg = $("bkChg");
    px.textContent = quote.px.toFixed(2);
    var c = quote.pct >= 0 ? "up" : "down";
    px.className = c;
    chg.textContent = (quote.chg >= 0 ? "+" : "") + quote.chg.toFixed(2) + "  "
      + (quote.pct >= 0 ? "+" : "") + quote.pct.toFixed(2) + "%";
    chg.className = "bk-chg " + c;
    var amp = quote.pre ? (quote.high - quote.low) / quote.pre * 100 : 0;
    $("bkMeta").textContent = "成交 " + (quote.amt / YI).toFixed(0) + "亿 ｜ 换手 " + quote.turn.toFixed(2)
      + "% ｜ 振幅 " + amp.toFixed(2) + "% ｜ 最高 " + quote.high.toFixed(2) + " 最低 " + quote.low.toFixed(2);

    var st = $("bkStatus");
    var n = new Date();
    var hm = n.getHours() * 100 + n.getMinutes(), wd = n.getDay();
    var open = (wd >= 1 && wd <= 5) && ((hm >= 930 && hm <= 1130) || (hm >= 1300 && hm <= 1500));
    st.textContent = open ? ("盘中 " + ("0" + n.getHours()).slice(-2) + ":" + ("0" + n.getMinutes()).slice(-2)) : "已收盘";
    st.className = "idx-status " + (open ? "s-cyb" : "s-mid");
  }

  /* 个股表：按 STOCKS 动态生成（只在其数量变化时重建 DOM，刷新时只改文本，避免闪动） */
  function buildStockRows() {
    var box = $("bkStockRows");
    if (!box) return;
    if (box.getAttribute("data-n") === String(STOCKS.length)) return;
    var html = "";
    STOCKS.forEach(function (s, i) {
      html += '<div class="bk-srow"><span class="bk-sname"><b>' + esc(s.name) + "</b>"
        + (s.tag ? "<i>" + esc(s.tag) + "</i>" : "") + "</span>"
        + '<span class="bk-spx" id="bsPx' + i + '">--</span>'
        + '<span class="bk-spct" id="bsPct' + i + '">--</span>'
        + '<span class="bk-sexc" id="bsExc' + i + '">--</span></div>';
    });
    box.innerHTML = html;
    box.setAttribute("data-n", String(STOCKS.length));
  }

  function renderStocks() {
    buildStockRows();          /* 先建行：行情没回来时也能看到成分股名称 */
    if (!stockQ) return;
    var bkPct = quote ? quote.pct : null;
    STOCKS.forEach(function (s, i) {
      var q = stockQ[s.code];
      var pxEl = $("bsPx" + i), pctEl = $("bsPct" + i), excEl = $("bsExc" + i);
      if (!pxEl) return;
      if (!q) { pxEl.textContent = "--"; pctEl.textContent = "--"; excEl.textContent = "--"; return; }
      pxEl.textContent = q.px.toFixed(2);
      pxEl.className = "bk-spx " + (q.pct >= 0 ? "up" : "down");
      pctEl.textContent = (q.pct >= 0 ? "+" : "") + q.pct.toFixed(2) + "%";
      pctEl.className = "bk-spct " + (q.pct >= 0 ? "up" : "down");
      if (bkPct == null) { excEl.textContent = "--"; return; }
      var ex = q.pct - bkPct;
      excEl.textContent = (ex >= 0 ? "+" : "") + ex.toFixed(2) + "%";
      excEl.className = "bk-sexc " + (ex >= 0 ? "up" : "down");
    });
  }

  function renderCap() {
    if (!relSeries) return;
    var seg = relSeries.dates.length;
    var b = relSeries.base[relSeries.base.length - 1];
    var parts = ["板块 " + (b - 100 >= 0 ? "+" : "") + (b - 100).toFixed(1) + "%"];
    STOCKS.forEach(function (s) {
      var v = relSeries.stocks[s.code];
      if (!v) return;
      var last = v[v.length - 1];
      parts.push(s.name.replace(/银行/g, "") + " " + (last - 100 >= 0 ? "+" : "") + (last - 100).toFixed(1) + "%");
    });
    $("bkCap").innerHTML = "近 " + seg + " 个交易日涨跌幅（以首日为 100）：" + parts.join(" ｜ ")
      + "。口径：东财板块「" + BK_NAME + "」" + BK_CODE + " 与"
      + (MULTI ? "成分股（按成交额取前 " + STOCKS.length + " 只）" : "个股")
      + "前复权价；超额 = 个股涨跌幅 − 板块涨跌幅。";
  }

  function draw() {
    if (tab === "min") renderMin(); else renderDay();
    renderRel();
    renderVP();
    renderFlow();
    renderHeader();
    renderStocks();
    renderCap();
  }

  /* ---------- 载入 ---------- */
  /* 快速连点板块时，旧板块的晚到响应会覆盖新板块 —— 用代次号丢弃过期回调 */
  var GEN = 0;
  function load() {
    var g = ++GEN;
    var st = $("bkStatus");
    if (st) { st.textContent = "加载中…"; st.className = "idx-status s-mid"; }

    /* 资金流独立请求：让位于日K，延后 1 秒再发，避免一次性把上游配额打光；
       失败时保留上一次数据，首次失败给明确提示 */
    setTimeout(function () {
      if (g !== GEN) return;
      fetchFlow().then(function (f) {
        if (g !== GEN) return;
        if (f && f.length) bkFlow = f;
        renderFlow();
      }).catch(function (e) { console.warn("板块面板：资金流加载失败", e); });
    }, 1000);

    Promise.all([fetchQuote(), fetchTrends(), fetchStockQ()]).then(function (r) {
      if (g !== GEN) return;
      if (r[0]) quote = r[0];
      if (r[1]) trends = r[1];
      if (r[2]) stockQ = r[2];
      if (tab === "min") renderMin();
      renderHeader(); renderStocks();
      renderVP();                                   /* 量比依赖当日成交额，行情回来后刷新 */
      if (!trends && tab === "min") {
        st.textContent = "分时不可用";
        st.className = "idx-status s-mid";
      }
    }).catch(function (e) { console.warn("板块面板：行情加载失败", e); });

    /* ① 先取板块日K：用户在等的是这张图，不等成分股；
          而且上游对突发并发敏感，串行请求命中率明显更稳 */
    fetchKline(BK_SECID, 120).then(function (k) {
      if (g !== GEN) return;
      bkKline = k;
      dayFailed = !k;
      /* 板块 K 线拿不到就没有日K，必须显式告知并给出重试入口 */
      showDayErr(k ? null : "日K 数据获取失败：行情源临时断开连接，可点下方重试");
      if (tab === "day") renderDay();
      renderVP();
      if (!k) { renderCap(); return; }
      return loadRel(g);
    }).catch(function (e) { console.warn("板块面板：日K加载失败", e); });
  }

  /* ② 成分股 K 线：逐个取、间隔 320ms，凑齐后画相对走势 */
  function loadRel(g) {
    var got = [bkKline];
    function step(i) {
      if (g !== GEN) return Promise.resolve(null);
      if (i >= STOCKS.length) return Promise.resolve(got);
      return fetchKline(STOCKS[i].secid, 80).then(function (k) {
        got.push(k || null);
      }).catch(function () {
        got.push(null);
      }).then(function () {
        return new Promise(function (res) { setTimeout(res, 320); })
          .then(function () { return step(i + 1); });
      });
    }
    return step(0).then(function (r) {
      if (!r || g !== GEN || !bkKline) return;
      /* 对齐日期 → 归一化 */
      var map = {};
      bkKline.forEach(function (k) { map[k.d] = { bk: k.c }; });
      var relOK = {};
      STOCKS.forEach(function (s, i) {
        var kl = r[i + 1];
        if (!kl || !kl.length) return;
        relOK[s.code] = 1;
        kl.forEach(function (k) { if (map[k.d]) map[k.d][s.code] = k.c; });
      });
      /* 只要求「成功取到 K 线」的成分股对齐；个别股票取数失败不应让整张图空白 */
      var live = STOCKS.filter(function (s) { return relOK[s.code]; });
      var capEl = $("bkCap");
      function relFail(msg) {
        if (capEl) capEl.textContent = msg;
      }
      if (!live.length) { relFail("成分股日K未取到，60 日相对走势暂不可用（不影响上方日K与分时）"); return; }
      var dates = Object.keys(map).filter(function (d) {
        return live.every(function (s) { return map[d][s.code] != null; });
      }).sort().slice(-60);
      if (dates.length < 5) { relFail("成分股日K历史不足 5 个交易日，无法计算相对走势"); return; }
      var b0 = map[dates[0]].bk;
      var base = dates.map(function (d) { return +(map[d].bk / b0 * 100).toFixed(2); });
      var stocks = {};
      live.forEach(function (s) {
        var s0 = map[dates[0]][s.code];
        stocks[s.code] = dates.map(function (d) { return +(map[d][s.code] / s0 * 100).toFixed(2); });
      });
      relSeries = { dates: dates, base: base, stocks: stocks };
      renderRel(); renderCap();
    });
  }

  function setTab(t) {
    tab = t;
    var bs = document.querySelectorAll("#bkSeg button"), i;
    for (i = 0; i < bs.length; i++) bs[i].className = bs[i].getAttribute("data-tab") === t ? "on" : "";
    var box = $("bkKBox");
    if (box) box.hidden = false;
    if (t === "min") { if (trends) renderMin(); } else { if (bkKline) renderDay(); }
  }

  /* ---------- 切换板块 ---------- */
  /* secid 形如 90.BK0475；name 用于首屏占位文案（接口回来后以接口名为准） */
  function switchTo(secid, name) {
    if (!secid) return Promise.resolve();
    GEN++;                                        /* 立即让在途回调失效 */
    BK_SECID = secid;
    BK_CODE = String(secid).split(".")[1] || BK_CODE;
    BK_NAME = name || BK_NAME;
    quote = trends = bkKline = bkFlow = stockQ = relSeries = null;
    dayFailed = false;
    if (ch) { ch.destroy(); ch = null; }
    if (chRel) { chRel.destroy(); chRel = null; }
    if (chVP) { chVP.destroy(); chVP = null; }
    if (chFL) { chFL.destroy(); chFL = null; }
    showDayErr(null);                              /* 清掉上一个板块的失败提示 */

    var nm = $("bkName"); if (nm) nm.textContent = BK_NAME;
    var tg = $("bkTag"); if (tg) tg.textContent = BK_CODE;
    /* 清掉上一个板块的读数，避免新板块还没回来时显示旧价格 */
    var px0 = $("bkPx"), chg0 = $("bkChg"), meta0 = $("bkMeta");
    if (px0) { px0.textContent = "--"; px0.className = ""; }
    if (chg0) { chg0.textContent = "--"; chg0.className = "bk-chg"; }
    if (meta0) meta0.textContent = "--";
    var cap = $("bkCap"); if (cap) cap.textContent = "加载中…";
    var badge = $("vpBadge"); if (badge) { badge.textContent = "加载中…"; badge.className = "vp-badge flat"; }
    var fbadge = $("flBadge"); if (fbadge) { fbadge.textContent = "加载中…"; fbadge.className = "vp-badge flat"; }
    var box = $("bkStockRows"); if (box) box.setAttribute("data-n", "");   /* 强制重建个股行 */

    if (!MULTI) return Promise.resolve(load());

    return fetchMembers(secid).then(function (list) {
      if (list && list.length) STOCKS = list;
      else STOCKS = [];
      load();
    });
  }

  function boot() {
    if (typeof Chart === "undefined" || !$("bkChart")) return;
    var seg = $("bkSeg");
    if (seg) {
      seg.addEventListener("click", function (e) {
        var el = e.target;
        while (el && el !== seg && !(el.getAttribute && el.getAttribute("data-tab"))) el = el.parentNode;
        if (el && el.getAttribute && el.getAttribute("data-tab")) setTab(el.getAttribute("data-tab"));
      });
    }
    var b = $("bkRefresh");
    if (b) b.onclick = function () { trends = null; load(); };

    if (MULTI && CFG.deferLoad) {
      /* 动态页面：先只显示占位，等用户点板块再取数，避免首屏白跑一轮请求 */
      if (timer) clearInterval(timer);
      return;
    }
    if (MULTI) {
      fetchMembers(BK_SECID).then(function (list) {
        if (list && list.length) STOCKS = list;
        load();
      });
    } else {
      load();
    }
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) load(); }, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) load(); }, 60000);
  }

  var API = {
    reload: load, switchTo: switchTo, startTimer: startTimer, boards: fetchBoards,
    get data() { return { quote: quote, trends: trends, kline: bkKline }; },
    get info() { return { secid: BK_SECID, code: BK_CODE, name: BK_NAME, stocks: STOCKS.slice() }; }
  };
  window.SectorPanel = API;
  window.BankPanel = API;
})();
