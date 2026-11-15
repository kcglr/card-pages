(function () {
  "use strict";

  var PRICE_URL = "https://pokecottage-prices.hello-cfb.workers.dev/prices";
  var PRICE_VER = "20260808-price-history";
  var FX_URLS = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.frankfurter.dev/v1/latest?from=USD&to=TRY"
  ];
  var CHUNK = 80;
  var LANG_ORDER = { ENG: 0, JP: 1, CN: 2 };
  var SPECIAL_VARIANT = /expansion stamp|championships|\bstaff\b|jumbo|no symbol|meiji|play!?\s*pok[eé]mon|world championships|yu nagaba/i;

  var speciesIndex = [];
  var current = null; // { meta, cards, payloads, updatedAt }
  var fxRate = null;
  var fxReady = null;
  var activeSuggest = -1;
  var suggestItems = [];

  var $ = function (id) { return document.getElementById(id); };

  function fold(value) {
    var text = String(value == null ? "" : value);
    text = text.replace(/[İI]/g, "i").replace(/ı/g, "i");
    text = text.toLowerCase();
    text = text.replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
      .replace(/ö/g, "o").replace(/ç/g, "c");
    if (text.normalize) text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return text.replace(/[^a-z0-9]+/g, "");
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    if (Math.abs(a.length - b.length) > 3) return 9;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    var i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  function scoreName(query, name) {
    var q = fold(query);
    var n = fold(name);
    if (!q || !n) return 0;
    if (n === q) return 100;
    if (n.startsWith(q)) return 90 - Math.min(20, n.length - q.length);
    if (q.length >= 3 && n.indexOf(q) !== -1) return 70;
    if (q.length >= 3) {
      var d = levenshtein(q, n);
      if (d === 1) return 60;
      if (d === 2 && q.length >= 5) return 45;
      if (d === 3 && q.length >= 7) return 25;
    }
    return 0;
  }

  function rankedSpecies(query, limit) {
    var scored = [];
    for (var i = 0; i < speciesIndex.length; i++) {
      var item = speciesIndex[i];
      var best = scoreName(query, item.name);
      var aliases = item.aliases || [];
      for (var a = 0; a < aliases.length; a++) {
        best = Math.max(best, scoreName(query, aliases[a]) * 0.95);
      }
      if (best > 0) scored.push({ item: item, score: best });
    }
    scored.sort(function (a, b) {
      return b.score - a.score || (a.item.number || 0) - (b.item.number || 0);
    });
    return scored.slice(0, limit || 8);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatUsd(amount) {
    if (amount == null || !isFinite(amount)) return "";
    if (Math.abs(amount - Math.round(amount)) < 0.005 && amount >= 10) {
      return "$" + Math.round(amount).toLocaleString("en-US");
    }
    return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatTry(amount, rate) {
    if (!rate || !isFinite(amount)) return "";
    var lira = amount * rate;
    if (lira >= 1000) return "≈ ₺" + (Math.round(lira / 10) * 10).toLocaleString("en-US");
    return "≈ ₺" + Math.round(lira).toLocaleString("en-US");
  }

  function formatIstanbul(iso) {
    var date = iso ? new Date(iso) : new Date();
    if (isNaN(date.getTime())) date = new Date();
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Istanbul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
    } catch (e) {
      return date.toISOString().slice(11, 16);
    }
  }

  function rarityClass(rarity) {
    var key = String(rarity || "").trim().toLowerCase();
    var map = {
      manga: "manga", sp: "sp", aa: "aa", alt: "aa", "alt art": "aa",
      "alternate art": "aa", "full art": "aa", sir: "sp", sar: "sp",
      tr: "sp", sec: "sp", sa: "sp", sr: "sp", chr: "aa", ir: "aa", ar: "aa"
    };
    if (map[key]) return map[key];
    var first = key.split(/\s+/)[0] || "";
    return map[first] || "";
  }

  function uniqueValues(cards, key) {
    var out = [];
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      var value = (cards[i][key] || "").toString().trim();
      if (key === "lang") value = value.toUpperCase();
      if (key === "variant") value = (cards[i].variant || cards[i].rarity || "").toString().trim();
      if (value && !seen[value]) {
        seen[value] = true;
        out.push(value);
      }
    }
    if (key === "lang") {
      out.sort(function (a, b) {
        var da = LANG_ORDER.hasOwnProperty(a) ? LANG_ORDER[a] : 9;
        var db = LANG_ORDER.hasOwnProperty(b) ? LANG_ORDER[b] : 9;
        return da - db || a.localeCompare(b);
      });
    }
    return out;
  }

  function hasReverse(cards) {
    return cards.some(function (c) { return /reverse\s*holo/i.test(c.variant || c.rarity || ""); });
  }

  function hasDates(cards) {
    return cards.some(function (c) { return c.released; });
  }

  function searchBlob(card) {
    return [card.name, card.lang, card.rarity, card.variant, card.set, card.id].join(" ").toLowerCase();
  }

  function quote(q) { return encodeURIComponent(q); }

  function searchTerms(card) {
    var bits = [card.name, (card.set || "").replace(" · ", " ")];
    var variant = card.variant || "";
    if (variant && variant.toLowerCase() !== "standard") bits.push(variant);
    if (card.lang === "JP") bits.push("japanese");
    if (card.lang === "CN") bits.push("chinese");
    return bits.filter(Boolean).join(" ");
  }

  function marketLinks(card) {
    var q = searchTerms(card);
    var tcg = card.tcgUrl || (card.productId ? "https://www.tcgplayer.com/product/" + card.productId : "");
    if (!tcg) tcg = "https://www.tcgplayer.com/search/pokemon/product?q=" + quote(q);
    return {
      tcg: tcg,
      ebaySold: "https://www.ebay.com/sch/i.html?_nkw=" + quote(q) + "&LH_Sold=1&LH_Complete=1",
      ebay: "https://www.ebay.com/sch/i.html?_nkw=" + quote(q),
      pc: "https://www.pricecharting.com/search-products?q=" + quote(q) + "&type=prices",
      cm: "https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=" + quote(q)
    };
  }

  function parsePrice(value) {
    if (value == null) return null;
    var raw = String(value).trim();
    if (!raw || raw === "—" || raw === "tap for links") return null;
    var cleaned = raw.replace(/[^0-9.,-]/g, "");
    if (!cleaned) return null;
    if (cleaned.indexOf(",") !== -1) cleaned = cleaned.replace(/,/g, "");
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  /* ---- subtype matching, same rules as prices.py ---- */

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

  function applyPriceToCard(card, payloads, pidCounts) {
    var pid = card.productId ? String(card.productId) : "";
    if (!pid) return null;
    var unique = pidCounts[pid] === 1;
    var row = pickPriceRow(card, payloads[pid], unique);
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
      headlineNote: "TCGplayer " + amount.kind,
      try: formatTry(amount.value, fxRate),
      value: amount.value,
      subtype: subName(row),
      kind: amount.kind,
      range: range
    };
  }

  /* ---- FX + price fetch ---- */

  function loadFx() {
    if (fxReady) return fxReady;
    fxReady = (function next(i) {
      if (i >= FX_URLS.length) return Promise.resolve(null);
      return fetch(FX_URLS[i], { mode: "cors" }).then(function (res) {
        if (!res.ok) throw new Error("fx " + res.status);
        return res.json();
      }).then(function (data) {
        var rates = data.rates || data;
        var rate = rates && Number(rates.TRY);
        if (rate > 0) {
          fxRate = rate;
          return rate;
        }
        return next(i + 1);
      }).catch(function () { return next(i + 1); });
    })(0);
    return fxReady;
  }

  function chunks(ids, size) {
    var out = [];
    for (var i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }

  function fetchPriceChunk(ids) {
    var url = PRICE_URL + "?v=" + encodeURIComponent(PRICE_VER) + "&ids=" + encodeURIComponent(ids.join(","));
    return fetch(url, { mode: "cors" }).then(function (res) {
      if (!res.ok) throw new Error("prices " + res.status);
      return res.json();
    });
  }

  function fetchPrices(ids, onChunk) {
    var unique = [];
    var seen = {};
    ids.forEach(function (id) {
      if (id && !seen[id]) { seen[id] = true; unique.push(String(id)); }
    });
    var groups = chunks(unique, CHUNK);
    var cursor = 0;
    var running = 0;
    var limit = 2;
    var merged = {};
    var updatedAt = "";
    var failed = 0;

    return new Promise(function (resolve) {
      if (!groups.length) { resolve({ prices: merged, updatedAt: updatedAt, failed: 0 }); return; }
      function kick() {
        while (running < limit && cursor < groups.length) {
          (function (group) {
            running++;
            fetchPriceChunk(group).then(function (payload) {
              var prices = (payload && payload.prices) || {};
              Object.keys(prices).forEach(function (k) { merged[k] = prices[k]; });
              if (payload && payload.updatedAt) updatedAt = payload.updatedAt;
              if (onChunk) onChunk(merged, updatedAt);
            }).catch(function () {
              failed += group.length;
            }).then(function () {
              running--;
              if (cursor >= groups.length && running === 0) {
                resolve({ prices: merged, updatedAt: updatedAt, failed: failed });
              } else {
                kick();
              }
            });
          })(groups[cursor++]);
        }
      }
      kick();
    });
  }

  /* ---- rendering ---- */

  function renderToolbar(cards) {
    var langs = uniqueValues(cards, "lang");
    var rarities = uniqueValues(cards, "rarity");
    var variants = uniqueValues(cards, "variant");
    var useVariantSelect = variants.length > 8 || rarities.length > 8;
    var langChips = '<button type="button" class="chip is-on" data-filter="lang" data-value="" aria-pressed="true">All</button>';
    langs.forEach(function (lang) {
      langChips += '<button type="button" class="chip" data-filter="lang" data-value="' + escapeHtml(lang) + '" aria-pressed="false">' + escapeHtml(lang) + "</button>";
    });
    if (hasReverse(cards)) {
      langChips += '<button type="button" class="chip" data-filter="hide-reverse" data-value="1" aria-pressed="false">Hide Reverse Holo</button>';
    }
    var rarityHtml = "";
    if (!useVariantSelect && rarities.length) {
      rarityHtml = '<div class="chips" role="group" aria-label="Rarity">' + rarities.map(function (r) {
        return '<button type="button" class="chip rarity-chip ' + rarityClass(r) + '" data-filter="rarity" data-value="' + escapeHtml(r) + '" aria-pressed="false">' + escapeHtml(r) + "</button>";
      }).join("") + "</div>";
    }
    var variantHtml = "";
    if (useVariantSelect && variants.length) {
      variantHtml = '<label class="variant-wrap"><span class="sr-only">Variant</span><select id="variant" aria-label="Variant">';
      variantHtml += '<option value="" selected>All variants</option>';
      variants.forEach(function (v) {
        variantHtml += '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>";
      });
      variantHtml += "</select></label>";
    }
    var sortOptions = "";
    if (hasDates(cards)) {
      sortOptions += '<option value="newest" selected>Newest</option><option value="oldest">Oldest</option>';
    }
    sortOptions += '<option value="price-desc"' + (hasDates(cards) ? "" : " selected") + '>Price high→low</option>';
    sortOptions += '<option value="price-asc">Price low→high</option><option value="name">Name</option><option value="set">Set</option>';
    var count = cards.length === 1 ? "1 card" : cards.length + " cards";
    return (
      '<div class="toolbar" id="toolbar">' +
        '<div class="toolbar-row">' +
          '<label class="sort-wrap"><span class="sr-only">Sort</span><select id="sort" aria-label="Sort">' + sortOptions + "</select></label>" +
          variantHtml +
          '<label class="search-wrap"><span class="sr-only">Filter</span><input id="filter" type="search" placeholder="Search" autocomplete="off" spellcheck="false"></label>' +
          '<div class="count" id="count">' + escapeHtml(count) + "</div>" +
        "</div>" +
        '<div class="toolbar-row wraps"><div class="chips" role="group" aria-label="Language">' + langChips + "</div>" + rarityHtml + "</div>" +
      "</div>"
    );
  }

  function tileHtml(card, index) {
    var lang = (card.lang || "").toUpperCase();
    var rarity = (card.rarity || card.variant || "").trim();
    var priced = card.price && card.price.headline;
    var headline = priced ? escapeHtml(card.price.headline) : "tap for links";
    var headlineCls = priced ? "headline" : "headline is-links";
    var side = "";
    if (priced) {
      var bits = "";
      if (card.price.headlineNote) bits += '<span class="headline-note">' + escapeHtml(card.price.headlineNote) + "</span>";
      if (card.price.try) bits += '<span class="try">' + escapeHtml(card.price.try) + "</span>";
      if (bits) side = '<div class="side">' + bits + "</div>";
    }
    var rarityHtml = "";
    if (rarity) {
      rarityHtml = '<span class="rarity ' + rarityClass(rarity) + '">' + escapeHtml(rarity) + "</span>";
    }
    var art = card.image
      ? '<div class="art"><img src="' + escapeHtml(card.image) + '" alt="' + escapeHtml((card.name || "card") + " " + lang) + '" loading="lazy" decoding="async"></div>'
      : '<div class="art"><div class="placeholder">no img</div></div>';
    var priceVal = priced ? String(card.price.value) : "";
    var setName = card.set || "";
    return (
      '<article class="tile" role="button" tabindex="0" data-idx="' + index +
      '" data-lang="' + escapeHtml(lang) + '" data-rarity="' + escapeHtml(rarity) +
      '" data-variant="' + escapeHtml(card.variant || rarity) +
      '" data-released="' + escapeHtml(card.released || "") +
      '" data-search="' + escapeHtml(searchBlob(card)) +
      '" data-name="' + escapeHtml((card.name || "").toLowerCase()) +
      '" data-set="' + escapeHtml(setName.toLowerCase()) +
      '" data-price="' + escapeHtml(priceVal) + '">' +
        art +
        '<div class="info"><div class="meta"><div class="name"><span class="name-text">' + escapeHtml(card.name || "Unknown") + "</span>" +
        (lang ? '<span class="lang">(' + escapeHtml(lang) + ")</span>" : "") + "</div>" + rarityHtml + "</div>" +
        '<div class="price-row"><div class="' + headlineCls + '">' + headline + "</div>" + side + "</div>" +
        (setName ? '<p class="set">' + escapeHtml(setName) + "</p>" : "") +
      "</div></article>"
    );
  }

  function paintResult() {
    if (!current) return;
    var cards = current.cards;
    var meta = current.meta;
    var subtitle = (meta.cards || cards.length) + " card" + ((meta.cards || cards.length) === 1 ? "" : "s") +
      " · " + cards.length + " variant" + (cards.length === 1 ? "" : "s");
    var langs = uniqueValues(cards, "lang");
    if (langs.length) subtitle += " · " + langs.join("+");
    var html = '<header><h2 class="result-title" style="font-size:22px;letter-spacing:-0.03em;margin:0 0 4px">' +
      escapeHtml(meta.name) + " · Master Set</h2><p class=\"subtitle\">" + escapeHtml(subtitle) + "</p></header>";
    html += renderToolbar(cards);
    html += '<div class="grid" id="grid">';
    for (var i = 0; i < cards.length; i++) html += tileHtml(cards[i], i);
    html += '</div><p class="empty" id="empty">No cards match these filters.</p>';
    var live = current.priceNote || "";
    html += "<footer>" + (live ? escapeHtml(live) + " " : "") +
      'Card list: <a href="https://pokecottage.com/pokemon-master-sets/' + encodeURIComponent(meta.slug || meta.key.replace(/^\d+-/, "")) +
      '" target="_blank" rel="noopener noreferrer">PokéCottage</a>. USD unless ₺. Prices only where shown.</footer>';
    $("result").innerHTML = html;
    bindGrid();
  }

  function updateTiles() {
    if (!current) return;
    var grid = $("grid");
    if (!grid) {
      paintResult();
      return;
    }
    var tiles = grid.querySelectorAll(".tile");
    for (var i = 0; i < tiles.length; i++) {
      var idx = parseInt(tiles[i].getAttribute("data-idx"), 10);
      var card = current.cards[idx];
      if (!card) continue;
      var priced = card.price && card.price.headline;
      var head = tiles[i].querySelector(".headline");
      var row = tiles[i].querySelector(".price-row");
      if (head) {
        head.textContent = priced ? card.price.headline : "tap for links";
        head.className = priced ? "headline" : "headline is-links";
      }
      if (row) {
        var side = row.querySelector(".side");
        if (side) side.remove();
        if (priced) {
          var el = document.createElement("div");
          el.className = "side";
          if (card.price.headlineNote) {
            var n = document.createElement("span");
            n.className = "headline-note";
            n.textContent = card.price.headlineNote;
            el.appendChild(n);
          }
          if (card.price.try) {
            var t = document.createElement("span");
            t.className = "try";
            t.textContent = card.price.try;
            el.appendChild(t);
          }
          row.appendChild(el);
        }
      }
      tiles[i].setAttribute("data-price", priced ? String(card.price.value) : "");
    }
    var sortEl = $("sort");
    if (sortEl && (sortEl.value === "price-desc" || sortEl.value === "price-asc")) {
      applySort();
    }
    updateCount();
  }

  var filterState = { lang: "", rarities: {}, hideReverse: false, variant: "", query: "" };

  function visibleCount(tiles) {
    return tiles.filter(function (t) { return !t.classList.contains("is-hidden"); }).length;
  }

  function updateCount() {
    var countEl = $("count");
    var grid = $("grid");
    var emptyEl = $("empty");
    if (!grid) return;
    var tiles = Array.prototype.slice.call(grid.querySelectorAll(".tile"));
    var n = visibleCount(tiles);
    if (countEl) {
      var label = n + (n === 1 ? " card" : " cards");
      if (n !== tiles.length) label = n + " of " + tiles.length;
      countEl.textContent = label;
    }
    if (emptyEl) emptyEl.classList.toggle("is-on", n === 0);
  }

  function applyFilters() {
    var grid = $("grid");
    if (!grid) return;
    var tiles = Array.prototype.slice.call(grid.querySelectorAll(".tile"));
    var rarityOn = Object.keys(filterState.rarities).filter(function (k) { return filterState.rarities[k]; });
    var q = (filterState.query || "").trim().toLowerCase();
    tiles.forEach(function (tile) {
      var okLang = !filterState.lang || tile.getAttribute("data-lang") === filterState.lang;
      var r = tile.getAttribute("data-rarity") || "";
      var okR = rarityOn.length === 0 || rarityOn.indexOf(r) !== -1;
      var v = tile.getAttribute("data-variant") || r || "";
      var vl = v.toLowerCase();
      var okRev = !filterState.hideReverse || vl.indexOf("reverse") === -1 || vl.indexOf("holo") === -1;
      var okVar = !filterState.variant || v === filterState.variant || r === filterState.variant;
      var hay = tile.getAttribute("data-search") || "";
      var okQ = !q || hay.indexOf(q) !== -1;
      tile.classList.toggle("is-hidden", !(okLang && okR && okRev && okVar && okQ));
    });
    updateCount();
  }

  function applySort() {
    var grid = $("grid");
    var sortEl = $("sort");
    if (!grid || !sortEl) return;
    var tiles = Array.prototype.slice.call(grid.querySelectorAll(".tile"));
    var mode = sortEl.value;
    tiles.sort(function (a, b) {
      if (mode === "name") {
        return (a.getAttribute("data-name") || "").localeCompare(b.getAttribute("data-name") || "") ||
          (a.getAttribute("data-set") || "").localeCompare(b.getAttribute("data-set") || "");
      }
      if (mode === "set") {
        return (a.getAttribute("data-set") || "").localeCompare(b.getAttribute("data-set") || "") ||
          (a.getAttribute("data-name") || "").localeCompare(b.getAttribute("data-name") || "");
      }
      if (mode === "newest" || mode === "oldest") {
        var da = a.getAttribute("data-released") || "";
        var db = b.getAttribute("data-released") || "";
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        if (da === db) return (a.getAttribute("data-set") || "").localeCompare(b.getAttribute("data-set") || "");
        return mode === "newest" ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
      }
      var pa = a.getAttribute("data-price");
      var pb = b.getAttribute("data-price");
      pa = pa === "" || pa == null ? null : parseFloat(pa);
      pb = pb === "" || pb == null ? null : parseFloat(pb);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return mode === "price-asc" ? pa - pb : pb - pa;
    });
    tiles.forEach(function (tile) { grid.appendChild(tile); });
  }

  function fillSheet(card) {
    var lang = (card.lang || "").toUpperCase();
    $("sheet-title").innerHTML = escapeHtml(card.name || "Card") +
      (lang ? ' <span class="lang">(' + escapeHtml(lang) + ")</span>" : "");
    var r = (card.rarity || card.variant || "").trim();
    var rarityEl = $("sheet-rarity");
    rarityEl.hidden = !r;
    rarityEl.className = "rarity " + rarityClass(r);
    rarityEl.textContent = r;
    $("sheet-set").textContent = card.set || "";
    $("sheet-set").hidden = !card.set;
    $("sheet-try").textContent = (card.price && card.price.try) || "";
    $("sheet-try").hidden = !(card.price && card.price.try);
    var art = $("sheet-art");
    var src = card.imageLarge || card.image || "";
    if (src) {
      art.classList.remove("is-empty");
      art.innerHTML = '<img src="' + escapeHtml(src) + '" alt="">';
      var img = art.querySelector("img");
      if (img && card.image && card.imageLarge && card.imageLarge !== card.image) {
        img.onerror = function () { img.onerror = null; img.src = card.image; };
      }
    } else {
      art.classList.add("is-empty");
      art.innerHTML = "";
    }
    var links = marketLinks(card);
    var rows = [];
    var tcgPrice = "—";
    var tcgNote = card.productId ? "product page" : "search";
    var tcgRange = "";
    if (card.price) {
      tcgPrice = card.price.headline;
      tcgNote = card.price.kind + (card.price.subtype ? " · " + card.price.subtype : "");
      tcgRange = card.price.range || "";
    }
    rows.push({ name: "TCGplayer", price: tcgPrice, note: tcgNote, range: tcgRange, url: links.tcg });
    rows.push({ name: "eBay sold", price: "—", note: "search", url: links.ebaySold });
    rows.push({ name: "PriceCharting", price: "—", note: "search", url: links.pc });
    rows.push({ name: "Cardmarket", price: "—", note: "search", url: links.cm });
    $("sheet-markets").innerHTML = rows.map(function (m) {
      var body = '<span class="market-name">' + escapeHtml(m.name) +
        (m.url ? '<span class="market-go">↗</span>' : "") + "</span>" +
        '<span class="market-price">' + escapeHtml(m.price || "—") + "</span>" +
        (m.note ? '<span class="market-note">' + escapeHtml(m.note) + "</span>" : "") +
        (m.range ? '<span class="market-range">' + escapeHtml(m.range) + "</span>" : "");
      if (m.url) {
        return '<a class="market" href="' + escapeHtml(m.url) + '" target="_blank" rel="noopener noreferrer">' + body + "</a>";
      }
      return '<div class="market">' + body + "</div>";
    }).join("");
    var out = [];
    if (links.pc) out.push('<a href="' + escapeHtml(links.pc) + '" target="_blank" rel="noopener noreferrer">Open on PriceCharting</a>');
    if (links.ebaySold) out.push('<a href="' + escapeHtml(links.ebaySold) + '" target="_blank" rel="noopener noreferrer">Open on eBay</a>');
    $("sheet-links").innerHTML = out.join("");
  }

  function openSheet(idx) {
    if (!current || !current.cards[idx]) return;
    fillSheet(current.cards[idx]);
    var overlay = $("overlay");
    overlay.classList.add("is-on");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-locked");
    $("sheet-close").focus();
  }
  function closeSheet() {
    var overlay = $("overlay");
    overlay.classList.remove("is-on");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-locked");
  }

  function bindGrid() {
    filterState = { lang: "", rarities: {}, hideReverse: false, variant: "", query: "" };
    var grid = $("grid");
    if (!grid) return;
    var tiles = Array.prototype.slice.call(grid.querySelectorAll(".tile"));
    tiles.forEach(function (tile) {
      tile.addEventListener("click", function (ev) {
        if (ev.target.closest && ev.target.closest("a")) return;
        openSheet(parseInt(tile.getAttribute("data-idx"), 10));
      });
      tile.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openSheet(parseInt(tile.getAttribute("data-idx"), 10));
        }
      });
    });
    document.querySelectorAll("#toolbar .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var kind = chip.getAttribute("data-filter");
        var value = chip.getAttribute("data-value") || "";
        if (kind === "lang") {
          filterState.lang = value;
          document.querySelectorAll('#toolbar .chip[data-filter="lang"]').forEach(function (c) {
            var on = c === chip;
            c.classList.toggle("is-on", on);
            c.setAttribute("aria-pressed", on ? "true" : "false");
          });
        } else if (kind === "rarity") {
          var on = !chip.classList.contains("is-on");
          chip.classList.toggle("is-on", on);
          chip.setAttribute("aria-pressed", on ? "true" : "false");
          filterState.rarities[value] = on;
        } else if (kind === "hide-reverse") {
          filterState.hideReverse = !filterState.hideReverse;
          chip.classList.toggle("is-on", filterState.hideReverse);
          chip.setAttribute("aria-pressed", filterState.hideReverse ? "true" : "false");
        }
        applyFilters();
      });
    });
    var sortEl = $("sort");
    if (sortEl) sortEl.addEventListener("change", applySort);
    var variantEl = $("variant");
    if (variantEl) variantEl.addEventListener("change", function () {
      filterState.variant = variantEl.value || "";
      applyFilters();
    });
    var filterEl = $("filter");
    if (filterEl) filterEl.addEventListener("input", function () {
      filterState.query = filterEl.value || "";
      applyFilters();
    });
    applySort();
    applyFilters();
  }

  $("overlay").addEventListener("click", function (ev) {
    if (ev.target === $("overlay")) closeSheet();
  });
  $("sheet-close").addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") {
      if ($("overlay").classList.contains("is-on")) closeSheet();
      else hideSuggest();
    }
  });

  /* ---- search / load ---- */

  function setStatus(text, isError) {
    var el = $("status");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function hideSuggest() {
    var box = $("suggest");
    box.hidden = true;
    box.classList.remove("is-on");
    box.innerHTML = "";
    activeSuggest = -1;
    suggestItems = [];
  }

  function showSuggest(query) {
    var box = $("suggest");
    var ranked = rankedSpecies(query, 8);
    suggestItems = ranked.map(function (r) { return r.item; });
    if (!suggestItems.length) { hideSuggest(); return; }
    box.innerHTML = suggestItems.map(function (item, i) {
      var meta = (item.variants || item.cards || 0) + " cards";
      if (item.number) meta = "#" + item.number + " · " + meta;
      return '<button type="button" role="option" data-i="' + i + '"' +
        (i === 0 ? ' aria-selected="true"' : ' aria-selected="false"') +
        '><span class="s-name">' + escapeHtml(item.name) + '</span><span class="s-meta">' + escapeHtml(meta) + "</span></button>";
    }).join("");
    box.hidden = false;
    box.classList.add("is-on");
    activeSuggest = 0;
    box.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      btn.addEventListener("click", function () {
        pickSpecies(suggestItems[parseInt(btn.getAttribute("data-i"), 10)]);
      });
    });
  }

  function moveSuggest(dir) {
    if (!suggestItems.length) return;
    activeSuggest = (activeSuggest + dir + suggestItems.length) % suggestItems.length;
    $("suggest").querySelectorAll("button").forEach(function (btn, i) {
      btn.setAttribute("aria-selected", i === activeSuggest ? "true" : "false");
      if (i === activeSuggest) btn.scrollIntoView({ block: "nearest" });
    });
  }

  function pickSpecies(item) {
    if (!item) return;
    $("q").value = item.name;
    hideSuggest();
    loadSpecies(item);
  }

  function submitQuery() {
    var q = $("q").value.trim();
    if (!q) return;
    if (activeSuggest >= 0 && suggestItems[activeSuggest]) {
      pickSpecies(suggestItems[activeSuggest]);
      return;
    }
    var ranked = rankedSpecies(q, 1);
    if (ranked.length && ranked[0].score >= 40) {
      pickSpecies(ranked[0].item);
    } else {
      setStatus("No Pokémon named like that in the catalog.", true);
    }
  }

  function applyFetchedPrices(payloads, updatedAt, started) {
    if (!current) return;
    current.payloads = payloads;
    var pidCounts = {};
    current.cards.forEach(function (c) {
      if (c.productId) pidCounts[String(c.productId)] = (pidCounts[String(c.productId)] || 0) + 1;
    });
    var priced = 0;
    current.cards.forEach(function (card) {
      card.price = applyPriceToCard(card, payloads, pidCounts);
      if (card.price) priced++;
    });
    var elapsed = started ? Math.max(0, Date.now() - started) : 0;
    var when = formatIstanbul(updatedAt || Date.now());
    current.priceNote = "Prices live from TCGplayer · " + when + ".";
    current.priced = priced;
    var footerLive = $("result").querySelector("footer");
    paintOrPatch(priced, elapsed, when);
    return { priced: priced, elapsed: elapsed, when: when };
  }

  function paintOrPatch(priced, elapsed, when) {
    var status = (priced || 0) + " priced · prices live from TCGplayer · " + when;
    if (elapsed) status += " (" + (elapsed / 1000).toFixed(1) + "s)";
    setStatus(status);
    if ($("grid")) updateTiles();
    else paintResult();
    var footer = $("result").querySelector("footer");
    if (footer && current && current.priceNote) {
      // rebuild footer text prefix
    }
    // Always refresh footer via a light paint of footer only
    if (footer && current) {
      var slug = current.meta.slug || (current.meta.key || "").replace(/^\d+-/, "");
      footer.innerHTML = escapeHtml(current.priceNote + " ") +
        'Card list: <a href="https://pokecottage.com/pokemon-master-sets/' + encodeURIComponent(slug) +
        '" target="_blank" rel="noopener noreferrer">PokéCottage</a>. USD unless ₺. Prices only where shown.';
    }
  }

  var loadToken = 0;

  function loadSpecies(item) {
    var token = ++loadToken;
    closeSheet();
    current = null;
    setStatus("Loading " + item.name + "…");
    $("result").innerHTML = '<p class="page-msg">Loading ' + escapeHtml(item.name) + "…</p>";
    if (history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(item.slug || item.key));
    var started = Date.now();
    Promise.all([
      fetch("data/" + encodeURIComponent(item.key) + ".json", { cache: "default" }).then(function (res) {
        if (!res.ok) throw new Error("data " + res.status);
        return res.json();
      }),
      loadFx()
    ]).then(function (parts) {
      if (token !== loadToken) return;
      var data = parts[0];
      var cards = (data.cards || []).map(function (c) { return Object.assign({}, c); });
      current = {
        meta: {
          key: data.key || item.key,
          name: data.name || item.name,
          slug: data.slug || item.slug || (item.key || "").replace(/^\d+-/, ""),
          cards: data.counts && data.counts.cards,
          variants: cards.length
        },
        cards: cards,
        payloads: {},
        priced: 0,
        priceNote: ""
      };
      paintResult();
      setStatus("Fetching live prices…");
      var ids = cards.map(function (c) { return c.productId; }).filter(Boolean);
      var t0 = Date.now();
      return fetchPrices(ids, function (partial, updatedAt) {
        if (token !== loadToken) return;
        applyFetchedPrices(partial, updatedAt, t0);
      }).then(function (result) {
        if (token !== loadToken) return;
        var summary = applyFetchedPrices(result.prices, result.updatedAt, t0);
        if (result.failed && summary) {
          setStatus(summary.priced + " priced · some price requests failed · " + summary.when, true);
        }
        current.elapsedMs = Date.now() - t0;
      });
    }).catch(function (err) {
      if (token !== loadToken) return;
      setStatus("Could not load " + item.name + ".", true);
      $("result").innerHTML = '<p class="page-msg">Could not load that master set.</p>';
      console.error(err);
    });
  }

  function findByHash(hash) {
    var raw = decodeURIComponent((hash || "").replace(/^#/, "")).trim();
    if (!raw) return null;
    var folded = fold(raw);
    for (var i = 0; i < speciesIndex.length; i++) {
      var it = speciesIndex[i];
      if (it.key === raw || it.slug === raw || fold(it.name) === folded || String(it.number) === raw) return it;
    }
    var ranked = rankedSpecies(raw, 1);
    return ranked.length && ranked[0].score >= 50 ? ranked[0].item : null;
  }

  function bindSearch() {
    var input = $("q");
    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 1) { hideSuggest(); return; }
      showSuggest(q);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); moveSuggest(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSuggest(-1); }
      else if (ev.key === "Enter") { ev.preventDefault(); submitQuery(); }
      else if (ev.key === "Escape") { hideSuggest(); }
    });
    input.addEventListener("blur", function () {
      setTimeout(hideSuggest, 150);
    });
  }

  function boot() {
    bindSearch();
    setStatus("Loading catalog…");
    fetch("data/index.json").then(function (res) {
      if (!res.ok) throw new Error("index " + res.status);
      return res.json();
    }).then(function (data) {
      speciesIndex = data.species || data || [];
      setStatus(speciesIndex.length + " Pokémon in the catalog. Type a name to start.");
      var fromHash = findByHash(location.hash);
      if (fromHash) pickSpecies(fromHash);
    }).catch(function (err) {
      setStatus("Could not load the catalog.", true);
      console.error(err);
    });
    loadFx();
    window.addEventListener("hashchange", function () {
      var item = findByHash(location.hash);
      if (item && (!current || current.meta.key !== item.key)) pickSpecies(item);
    });
  }

  boot();
})();
