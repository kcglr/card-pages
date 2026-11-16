/* PricePick: which TCGplayer price row belongs to a printing, and the one
   price the site shows for it (market, else mid, else the lowest listing).
   The same rules as prices.py. Shared by the Pokémon binders and My binder,
   so a price sticker and the collection's totals always agree. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PricePick = factory();
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function formatUsd(amount) {
    if (amount == null || !isFinite(amount)) return "";
    if (Math.abs(amount - Math.round(amount)) < 0.005 && amount >= 10) {
      return "$" + Math.round(amount).toLocaleString("en-US");
    }
    return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function textOf(card) {
    return [card.variant, card.rarity, card.name].filter(Boolean).join(" ");
  }
  function wantsReverse(card) { return /reverse\s*holo/i.test(textOf(card)); }
  function wantsFirst(card) { return /(1st|first)\s+edition/i.test(textOf(card)); }
  function wantsHolo(card) {
    var t = textOf(card);
    return /holo/i.test(t) && !/reverse\s*holo/i.test(t);
  }
  function wantsNormal(card) { return !wantsReverse(card) && !wantsHolo(card); }
  function subName(row) { return String((row && row.subTypeName) || ""); }
  function positive(row, key) {
    if (!row) return 0;
    var n = Number(row[key || "marketPrice"]);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function bestAmount(row) {
    if (!row) return null;
    if (positive(row, "marketPrice")) return { kind: "market", value: positive(row, "marketPrice") };
    if (positive(row, "midPrice")) return { kind: "mid", value: positive(row, "midPrice") };
    if (positive(row, "lowPrice")) return { kind: "low", value: positive(row, "lowPrice") };
    return null;
  }
  function findRow(rows, pred) {
    var matched = rows.filter(function (row) { return pred(subName(row)); });
    if (!matched.length) return null;
    var priced = matched.filter(function (row) { return bestAmount(row); });
    return (priced[0] || matched[0] || null);
  }

  // `uniqueProduct`: no other printing in the Pokémon's file shares this
  // TCGplayer product, so any priced row of it may stand in.
  function pickPriceRow(card, payload, uniqueProduct) {
    if (!payload || !payload.prices) return null;
    var rows = payload.prices.filter(function (r) { return r && typeof r === "object"; });
    if (!rows.length) return null;
    var row;

    if (wantsFirst(card)) {
      if (wantsReverse(card)) {
        row = findRow(rows, function (n) { return /(1st|first)\s+edition/i.test(n) && /reverse/i.test(n); });
        if (row && bestAmount(row)) return row;
        if (!uniqueProduct) return null;
      } else if (wantsHolo(card)) {
        row = findRow(rows, function (n) { return /(1st|first)\s+edition/i.test(n) && /holo/i.test(n) && !/reverse/i.test(n); });
        if (row && bestAmount(row)) return row;
        if (!uniqueProduct) return null;
      } else {
        row = findRow(rows, function (n) { return /(1st|first)\s+edition/i.test(n); });
        if (row && bestAmount(row)) return row;
        if (!uniqueProduct) return null;
      }
    }

    if (wantsReverse(card)) {
      row = findRow(rows, function (n) { return /reverse\s*holo/i.test(n); });
      if (row && bestAmount(row)) return row;
      if (!uniqueProduct) return null;
    }

    var hasUnlimited = rows.some(function (r) { return /unlimited/i.test(subName(r)); });
    if (hasUnlimited && !wantsFirst(card)) {
      if (wantsHolo(card)) {
        row = findRow(rows, function (n) { return /unlimited/i.test(n) && /holo/i.test(n) && !/reverse/i.test(n); });
        if (row && bestAmount(row)) return row;
      }
      if (wantsNormal(card)) {
        row = findRow(rows, function (n) { return /^unlimited$/i.test(n) || (/unlimited/i.test(n) && !/holo/i.test(n)); });
        if (row && bestAmount(row)) return row;
      }
    }

    if (wantsHolo(card)) {
      row = findRow(rows, function (n) { return /^holofoil$/i.test(n) || (/holo/i.test(n) && !/reverse|1st|first|unlimited/i.test(n)); });
      if (row && bestAmount(row)) return row;
      if (!uniqueProduct) return null;
    }

    row = findRow(rows, function (n) { return /^normal$/i.test(n); });
    if (row && bestAmount(row)) return row;
    row = findRow(rows, function (n) { return /^unlimited$/i.test(n); });
    if (row && bestAmount(row)) return row;
    var preferred = payload.preferred;
    if (preferred && bestAmount(preferred) && !/(1st|first)\s+edition|reverse/i.test(subName(preferred))) {
      return preferred;
    }
    if (uniqueProduct) {
      if (preferred && bestAmount(preferred)) return preferred;
      for (var i = 0; i < rows.length; i++) {
        if (bestAmount(rows[i])) return rows[i];
      }
    }
    return null;
  }

  // The price the site shows for one printing, or null.
  function price(card, payload, uniqueProduct) {
    var row = pickPriceRow(card, payload, uniqueProduct);
    var amount = bestAmount(row);
    if (!amount) return null;
    var low = positive(row, "lowPrice");
    var mid = positive(row, "midPrice");
    var range = "";
    if (low && mid && low <= amount.value && mid < amount.value * 20) {
      range = formatUsd(low) + "–" + formatUsd(mid);
    }
    return {
      headline: formatUsd(amount.value),
      value: amount.value,
      subtype: subName(row),
      kind: amount.kind,
      range: range
    };
  }

  return {
    formatUsd: formatUsd,
    positive: positive,
    bestAmount: bestAmount,
    subName: subName,
    pickPriceRow: pickPriceRow,
    price: price
  };
});
