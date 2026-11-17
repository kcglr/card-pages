/* PriceFallback: when the price service can't be reached, each printing's
   latest weekly market price from our own history files (history/<key>.json,
   built from TCGCSV by search/build_history.py) stands in.
   docs/SITE-PLAN.md §4.

   The stand-ins have the service's shape ({ productId, prices: [rows] }),
   so PricePick and the rest of the page work as they are. They're up to a
   week old, so the result's `updatedAt` becomes that week's date when
   nothing came from the service, and `fallback` counts them. A price older
   than four weeks before the file's last week isn't used. */
(function (root, factory) {
  // The module path also resolves from tests/ (tests/test_js_modules.py).
  if (typeof module === "object" && module.exports) module.exports = factory(require("../search/price-history.js"));
  else root.PriceFallback = factory(root.PullfolioHistory);
})(typeof window !== "undefined" ? window : this, function (history) {
  "use strict";

  var MAX_AGE_DAYS = 28;

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
  }

  // { pid: payload } for these product ids, from one parsed history file.
  function payloads(file, pids) {
    var out = {};
    if (!file || !history) return out;
    var last = history.lastDate(file);
    (pids || []).forEach(function (raw) {
      var pid = String(raw || "");
      if (!/^\d+$/.test(pid)) return;
      var rows = [];
      var asOf = "";
      history.subtypes(file, pid).forEach(function (sub) {
        var pts = history.points(file, pid, sub);
        var p = pts[pts.length - 1];
        if (!p || daysBetween(p.date, last) > MAX_AGE_DAYS) return;
        rows.push({ productId: Number(pid), subTypeName: sub, lowPrice: 0, midPrice: 0, highPrice: 0, marketPrice: p.usd, directLowPrice: 0 });
        if (p.date > asOf) asOf = p.date;
      });
      // asOf: the date of its newest stand-in price.
      if (rows.length) out[pid] = { productId: Number(pid), prices: rows, asOf: asOf };
    });
    return out;
  }

  // result: what fetchPrices resolved ({ prices, updatedAt, failed }); ids:
  // the product ids asked for; keys: the Pokémon their cards belong to.
  // Resolves the result with every id the service didn't answer filled from
  // the history files where possible. `load` is PullfolioHistory.load (or a
  // stand-in for tests).
  function fill(result, ids, keys, load) {
    result = result || {};
    var prices = Object.assign({}, result.prices || {});
    var missing = [];
    var seen = {};
    (ids || []).forEach(function (id) {
      id = String(id || "");
      if (id && !seen[id] && !prices[id]) { seen[id] = true; missing.push(id); }
    });
    var done = function (filled, asOf) {
      var n = Object.keys(filled).length;
      Object.keys(filled).forEach(function (id) { prices[id] = filled[id]; });
      var fromService = Object.keys(result.prices || {}).length > 0;
      return {
        prices: prices,
        updatedAt: fromService || !asOf ? result.updatedAt || "" : asOf + "T00:00:00Z",
        failed: Math.max(0, (result.failed || 0) - n),
        fallback: n
      };
    };
    if (!missing.length || !history) return Promise.resolve(done({}, ""));
    var get = load || history.load;
    var unique = [];
    (keys || []).forEach(function (k) { if (k && unique.indexOf(k) === -1) unique.push(k); });
    return Promise.all(unique.map(function (k) { return get(k); })).then(function (files) {
      var filled = {};
      var asOf = "";
      files.forEach(function (file) {
        var left = missing.filter(function (id) { return !filled[id]; });
        var got = payloads(file, left);
        Object.keys(got).forEach(function (id) {
          filled[id] = got[id];
          if (got[id].asOf > asOf) asOf = got[id].asOf;
        });
      });
      return done(filled, asOf);
    }, function () { return done({}, ""); });
  }

  return { payloads: payloads, fill: fill, MAX_AGE_DAYS: MAX_AGE_DAYS };
});
