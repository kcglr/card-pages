/* PullfolioHistory: each printing's TCGplayer market price, a point a week
   since 2024-02-12, from history/<key>.json. search/build_history.py builds
   those files from TCGCSV's daily price archive, which starts in February
   2024, so nothing older exists.

   A file: { v: 1, start: "2024-02-12", step: 7, n, s: { "pid|subtype":
   [first week, cents|null, ...] } }. There's no DOM here; the charts are in
   collection.js and tests/price-history.test.js covers the rest. */
(function (root, factory) {
  // The module path also resolves from tests/ (tests/test_js_modules.py).
  if (typeof module === "object" && module.exports) module.exports = factory(require("../search/price-pick.js"));
  else root.PullfolioHistory = factory(root.PricePick);
})(typeof window !== "undefined" ? window : this, function (pick) {
  "use strict";

  var KEY = /^\d+-[a-z0-9-]+$/;
  var DAY = /^\d{4}-\d\d-\d\d$/;

  function addDays(date, n) {
    var d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // A file as loaded, checked; null if it isn't one.
  function parse(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== 1 || !DAY.test(String(raw.start)) ||
        !(raw.step >= 1) || !(raw.n >= 0) || !raw.s || typeof raw.s !== "object") return null;
    var series = {};
    Object.keys(raw.s).forEach(function (key) {
      var v = raw.s[key];
      if (/^\d+\|/.test(key) && Array.isArray(v) && v.length > 1 && v[0] >= 0 && v[0] + v.length - 1 <= raw.n) series[key] = v;
    });
    return { start: raw.start, step: Math.floor(raw.step), n: Math.floor(raw.n), series: series };
  }

  function dateAt(file, week) { return addDays(file.start, week * file.step); }

  // The last week the file covers ("" when it covers none).
  function lastDate(file) { return file && file.n ? dateAt(file, file.n - 1) : ""; }

  function subtypes(file, pid) {
    var prefix = String(pid) + "|";
    return Object.keys(file.series).filter(function (k) { return k.indexOf(prefix) === 0; })
      .map(function (k) { return k.slice(prefix.length); });
  }

  // [{ date, usd }] for one product's subtype, weeks without a price left out.
  function points(file, pid, subtype) {
    var s = file && file.series[String(pid) + "|" + subtype];
    var out = [];
    if (!s) return out;
    for (var i = 1; i < s.length; i++) {
      if (s[i] > 0) out.push({ date: dateAt(file, s[0] + i - 1), usd: s[i] / 100 });
    }
    return out;
  }

  function lastCents(s) {
    for (var i = s.length - 1; i > 0; i--) if (s[i] > 0) return s[i];
    return 0;
  }

  // Which subtype is the card's: the one it's priced with today, else the
  // price rule's pick among the file's subtypes, on their latest prices.
  // card: { productId, variant, rarity, name, price }; `unique`: no other
  // printing of the Pokémon shares the product.
  function subtypeFor(card, file, unique) {
    var pid = String((card && card.productId) || "");
    if (!file || !pid) return null;
    var subs = subtypes(file, pid);
    if (!subs.length) return null;
    var now = card.price && card.price.subtype;
    if (now && subs.indexOf(now) !== -1) return now;
    if (!pick) return subs.length === 1 ? subs[0] : null;
    var rows = subs.map(function (sub) {
      return { subTypeName: sub, marketPrice: lastCents(file.series[pid + "|" + sub]) / 100 };
    });
    var row = pick.pickPriceRow(card, { prices: rows }, !!unique);
    return row ? row.subTypeName : null;
  }

  function cardPoints(card, file, unique) {
    var sub = subtypeFor(card, file, unique);
    return sub ? points(file, String(card.productId), sub) : [];
  }

  // The price history the binder charts use ({ days: [{ date, usdTry,
  // prices: { cardId: usd } }] }) from [{ id, points }].
  function toHistory(entries) {
    var byDate = {};
    (entries || []).forEach(function (e) {
      (e.points || []).forEach(function (p) {
        (byDate[p.date] || (byDate[p.date] = {}))[e.id] = p.usd;
      });
    });
    return { days: Object.keys(byDate).sort().map(function (d) { return { date: d, usdTry: null, prices: byDate[d] }; }) };
  }

  // One request per Pokémon, kept for the page's life. Resolves the parsed
  // file, or null when there's none (a failed request is tried again later).
  var files = {};
  function load(key, fetchFn) {
    if (!KEY.test(String(key || ""))) return Promise.resolve(null);
    if (!files[key]) {
      var get = fetchFn || function (url) { return fetch(url); };
      var p = files[key] = Promise.resolve().then(function () {
        return get("history/" + encodeURIComponent(key) + ".json");
      }).then(function (res) {
        if (res && res.status === 404) return { missing: true };
        if (!res || !res.ok) throw new Error("history " + (res && res.status));
        return res.json();
      }).then(function (raw) {
        return raw && raw.missing ? null : parse(raw);
      }, function () {
        if (files[key] === p) delete files[key];
        return null;
      });
    }
    return files[key];
  }

  return {
    parse: parse,
    dateAt: dateAt,
    lastDate: lastDate,
    subtypes: subtypes,
    points: points,
    subtypeFor: subtypeFor,
    cardPoints: cardPoints,
    toHistory: toHistory,
    load: load
  };
});
