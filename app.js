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

  var speciesIndex = [];
  var current = null; // { meta, cards, payloads, updatedAt }
  var fxRate = null;
  var fxReady = null;
  var activeSuggest = -1;
  var suggestItems = [];
  var activeCard = null;

  var $ = function (id) { return document.getElementById(id); };
  var i18n = window.CardI18n;
  var t = i18n.t;
  var num = i18n.num;

  function countText(key, n) { return t(key, { n: num(n) }); }

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
    return "≈ ₺" + num(lira >= 1000 ? Math.round(lira / 10) * 10 : Math.round(lira));
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

  function marketLinks(card) {
    return window.CardMarketLinks.build(card);
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

  var binder = null;
  var animating = false;
  var filterState = { lang: "", rarities: {}, hideReverse: false, variant: "", query: "" };

  // Markup for text that follows the site language: CardI18n.apply() re-reads
  // the data-i18n key when the language changes.
  function said(tag, key, attrs) {
    return "<" + tag + (attrs ? " " + attrs : "") + ' data-i18n="' + key + '">' + escapeHtml(t(key)) + "</" + tag + ">";
  }
  function saidAttr(attr, key) {
    return " " + attr + '="' + escapeHtml(t(key)) + '" data-i18n-attr="' + attr + ":" + key + '"';
  }

  function renderToolbar(cards) {
    var rarities = uniqueValues(cards, "rarity");
    var variants = uniqueValues(cards, "variant");
    var useVariantSelect = variants.length > 8 || rarities.length > 8;
    var chips = "";
    if (!useVariantSelect) {
      chips += rarities.map(function (r) {
        return '<button type="button" class="chip rarity-chip ' + rarityClass(r) + '" data-filter="rarity" data-value="' + escapeHtml(r) + '" aria-pressed="false">' + escapeHtml(r) + "</button>";
      }).join("");
    }
    if (hasReverse(cards)) {
      chips += said("button", "toolbar.hideReverse", 'type="button" class="chip" data-filter="hide-reverse" data-value="1" aria-pressed="false"');
    }
    var variantHtml = "";
    if (useVariantSelect && variants.length) {
      variantHtml = '<label class="variant-wrap">' + said("span", "toolbar.variant", 'class="sr-only"') +
        '<select id="variant">' + said("option", "toolbar.allVariants", 'value="" selected') +
        variants.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>"; }).join("") +
        "</select></label>";
    }
    var dated = hasDates(cards);
    var sortOptions = (dated ? said("option", "sort.newest", 'value="newest" selected') + said("option", "sort.oldest", 'value="oldest"') : "") +
      said("option", "sort.priceDesc", 'value="price-desc"' + (dated ? "" : " selected")) +
      said("option", "sort.priceAsc", 'value="price-asc"') + said("option", "sort.name", 'value="name"') + said("option", "sort.set", 'value="set"');
    return (
      '<div class="toolbar" id="toolbar">' +
        '<div class="toolbar-row">' +
          '<label class="sort-wrap">' + said("span", "toolbar.sort", 'class="sr-only"') + '<select id="sort">' + sortOptions + "</select></label>" +
          variantHtml +
          '<label class="search-wrap">' + said("span", "toolbar.filter", 'class="sr-only"') +
          '<input id="filter" type="search"' + saidAttr("placeholder", "toolbar.filterHint") + ' autocomplete="off" spellcheck="false"></label>' +
          '<div class="count" id="count"></div>' +
        "</div>" +
        (chips ? '<div class="toolbar-row wraps"><div class="chips" role="group"' + saidAttr("aria-label", "toolbar.rarity") + ">" + chips + "</div></div>" : "") +
      "</div>"
    );
  }

  // Language filters are the divider tabs on the binder's top edge.
  function renderLangTabs(cards) {
    var tabs = said("button", "tabs.all", 'type="button" class="chip tab is-on" data-filter="lang" data-value="" aria-pressed="true"');
    uniqueValues(cards, "lang").forEach(function (lang) {
      tabs += '<button type="button" class="chip tab tab-' + escapeHtml(lang.toLowerCase()) + '" data-filter="lang" data-value="' +
        escapeHtml(lang) + '" aria-pressed="false">' + escapeHtml(lang) + "</button>";
    });
    return '<div class="binder-tabs" role="group"' + saidAttr("aria-label", "tabs.label") + ">" + tabs + "</div>";
  }

  function describeCard(card) {
    var lang = (card.lang || "").toUpperCase();
    var price = (card.price && card.price.headline) || "";
    var name = card.name || t("card.fallback");
    return {
      key: String(card.ref),
      name: name,
      image: card.image || "",
      lang: lang,
      price: price,
      label: [name, lang, (card.variant || card.rarity || "").trim(), card.set, price || t("card.noPrice")]
        .filter(Boolean).join(", ")
    };
  }

  function speciesArt(number) {
    return number ? "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/" +
      encodeURIComponent(number) + ".png" : "";
  }

  function closedBinder(title, noteKey, extra) {
    return '<div class="welcome-state' + (extra ? " " + extra : "") + '"><div class="closed-binder"><span class="cover-tape">' +
      escapeHtml(title) + "</span>" + said("span", noteKey, 'class="cover-note"') +
      '<img class="cover-badge" src="assets/pullfolio-mark.svg" alt="" width="56" height="56"></div></div>';
  }

  function paintResult() {
    if (!current) return;
    var cards = current.cards;
    var meta = current.meta;
    var art = speciesArt(meta.number);
    $("result").innerHTML =
      '<header class="result-header">' +
        (art ? '<img class="result-art" src="' + escapeHtml(art) + '" alt="" width="112" height="112" onerror="this.remove()">' : "") +
        '<div class="result-heading"><p class="result-dex" id="result-dex"></p><h2 class="result-title">' + escapeHtml(meta.name) +
        '</h2><p class="subtitle" id="result-sub"></p></div>' +
        said("p", "result.hint", 'class="result-hint"') +
      "</header>" +
      renderToolbar(cards) +
      '<div class="binder-wrap"><div class="binder-stack">' + renderLangTabs(cards) + '<div id="binder"></div></div>' +
      said("p", "empty", 'class="empty" id="empty"') + "</div>" +
      '<footer id="result-footer"></footer>';
    renderResultText();
    renderFooter();
    if (binder) binder.destroy();
    binder = new window.CardBinder($("binder"), { describe: describeCard, onPick: pullCard });
    bindToolbar();
    showCards(false);
    binder.openCover(meta.name);
  }

  // The result text that carries numbers; redrawn when the language changes.
  function renderResultText() {
    if (!current || !$("result-sub")) return;
    var meta = current.meta;
    var cards = current.cards;
    var langs = uniqueValues(cards, "lang");
    $("result-dex").textContent = meta.number ? t("result.dex", { n: String(meta.number).padStart(3, "0") }) : t("result.master");
    $("result-sub").textContent = countText("count.cards", meta.cards || cards.length) + " · " +
      countText("count.printings", cards.length) + (langs.length ? " · " + langs.join(" · ") : "");
    updateCount();
  }

  function updateCount() {
    if (!current || !$("count")) return;
    var total = current.cards.length;
    var shown = current.shown == null ? total : current.shown;
    $("count").textContent = shown === total ? countText("count.cards", total) : t("count.of", { n: num(shown), total: num(total) });
  }

  function renderFooter() {
    var footer = $("result-footer");
    if (!footer || !current) return;
    var slug = current.meta.slug || (current.meta.key || "").replace(/^\d+-/, "");
    footer.innerHTML = (current.priceTime ? escapeHtml(t("footer.prices", { time: current.priceTime })) + " " : "") +
      escapeHtml(t("footer.list")) + ' <a href="https://pokecottage.com/pokemon-master-sets/' + encodeURIComponent(slug) +
      '" target="_blank" rel="noopener noreferrer">PokéCottage</a>. ' + escapeHtml(t("footer.rest"));
  }

  function compareCards(mode) {
    function text(card, key) { return String(card[key] || "").toLowerCase(); }
    return function (a, b) {
      if (mode === "name") return text(a, "name").localeCompare(text(b, "name")) || text(a, "set").localeCompare(text(b, "set"));
      if (mode === "set") return text(a, "set").localeCompare(text(b, "set")) || text(a, "name").localeCompare(text(b, "name"));
      if (mode === "newest" || mode === "oldest") {
        var da = a.released || "";
        var db = b.released || "";
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        if (da === db) return text(a, "set").localeCompare(text(b, "set"));
        return mode === "newest" ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
      }
      var pa = a.price ? a.price.value : null;
      var pb = b.price ? b.price.value : null;
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return mode === "price-asc" ? pa - pb : pb - pa;
    };
  }

  function visibleCards() {
    var rarityOn = Object.keys(filterState.rarities).filter(function (k) { return filterState.rarities[k]; });
    var q = filterState.query.trim().toLowerCase();
    var list = current.cards.filter(function (card) {
      var rarity = (card.rarity || card.variant || "").trim();
      var variant = card.variant || rarity;
      var lower = variant.toLowerCase();
      return (!filterState.lang || (card.lang || "").toUpperCase() === filterState.lang) &&
        (!rarityOn.length || rarityOn.indexOf(rarity) !== -1) &&
        (!filterState.hideReverse || lower.indexOf("reverse") === -1 || lower.indexOf("holo") === -1) &&
        (!filterState.variant || variant === filterState.variant || rarity === filterState.variant) &&
        (!q || searchBlob(card).indexOf(q) !== -1);
    });
    return list.sort(compareCards($("sort") ? $("sort").value : ""));
  }

  // Re-files the binder after a filter, sort or price change.
  function showCards(fromStart) {
    if (!binder || !current) return;
    var list = visibleCards();
    binder.setCards(list, { keepPage: !fromStart, deal: fromStart });
    current.shown = list.length;
    updateCount();
    $("empty").classList.toggle("is-on", !list.length);
  }

  function updateTiles() {
    if (!current) return;
    if (!binder || !$("binder")) { paintResult(); return; }
    var mode = $("sort") ? $("sort").value : "";
    if (mode === "price-desc" || mode === "price-asc") showCards(false);
    else binder.refresh();
  }

  function fillSheetText(card) {
    var lang = (card.lang || "").toUpperCase();
    $("sheet-title").innerHTML = escapeHtml(card.name || t("card.fallback")) +
      (lang ? ' <span class="lang">(' + escapeHtml(lang) + ")</span>" : "");
    var r = (card.rarity || card.variant || "").trim();
    var rarityEl = $("sheet-rarity");
    rarityEl.hidden = !r;
    rarityEl.className = "rarity " + rarityClass(r);
    rarityEl.textContent = r;
    $("sheet-set").textContent = card.set || "";
    $("sheet-set").hidden = !card.set;
    var lira = card.price ? formatTry(card.price.value, fxRate) : "";
    $("sheet-try").textContent = lira;
    $("sheet-try").hidden = !lira;
  }

  function fillSheet(card) {
    fillSheetText(card);
    var art = $("sheet-art");
    var small = card.image || card.imageLarge || "";
    if (small) {
      art.classList.remove("is-empty");
      art.innerHTML = '<img src="' + escapeHtml(small) + '" alt="">';
      // Start with the image already in the binder, then sharpen to the large scan.
      if (card.imageLarge && card.imageLarge !== small) {
        var large = new Image();
        large.onload = function () {
          var img = art.querySelector("img");
          if (activeCard === card && img) img.src = card.imageLarge;
        };
        large.src = card.imageLarge;
      }
    } else {
      art.classList.add("is-empty");
      art.innerHTML = "";
    }
    fillMarkets(card);
  }

  function linkNote(exactUrl, status) {
    if (exactUrl) return t("link.exact");
    return t({ loading: "link.loading", not_found: "link.notFound", unavailable: "link.unavailable" }[status] || "link.none");
  }

  function fillMarkets(card) {
    var links = marketLinks(card);
    var rows = [];
    var tcgPrice = "—";
    var tcgNote = t(links.tcgDirect ? "market.productPage" : "market.search");
    var tcgRange = "";
    if (card.price) {
      tcgPrice = card.price.headline;
      tcgNote = t("kind." + card.price.kind) + (card.price.subtype ? " · " + card.price.subtype : "");
      tcgRange = card.price.range || "";
    }
    rows.push({ name: "TCGplayer", price: tcgPrice, note: tcgNote, range: tcgRange, url: links.tcg });
    rows.push({ name: t("market.ebaySold"), price: "—", note: t("market.ebaySoldNote"), url: links.ebaySold });
    rows.push({ name: t("market.ebay"), price: "—", note: t("market.ebayNote"), url: links.ebay });
    var pcStatus = card.pcResolution && card.pcResolution.status;
    rows.push({ name: "PriceCharting", price: "—", note: linkNote(links.pc, pcStatus), url: links.pc });
    var cmStatus = card.cmResolution && card.cmResolution.status;
    rows.push({ name: "Cardmarket", price: "—", note: linkNote(links.cm, cmStatus), url: links.cm });
    rows.push({ name: "Collectr", price: "—", note: t(links.collectr ? "link.collectr" : "link.none"), url: links.collectr });
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
    function link(url, key) {
      out.push('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t(key)) + "</a>");
    }
    if (links.pc) link(links.pc, "link.pcOpen");
    else if (pcStatus !== "loading") link(links.pcSearch, "link.pcSearch");
    if (links.cm) link(links.cm, "link.cmOpen");
    else if (cmStatus !== "loading") link(links.cmSearch, "link.cmSearch");
    if (links.collectr) link(links.collectr, "link.collectr");
    if (links.ebaySold) link(links.ebaySold, "link.ebaySold");
    $("sheet-links").innerHTML = out.join("");
  }

  function resolveCardLinks(card) {
    resolveMarketLink(card, "pc", "pricecharting");
    resolveMarketLink(card, "cm", "cardmarket");
  }

  function resolveMarketLink(card, market, endpoint) {
    var stateKey = market + "Resolution";
    if (!current || marketLinks(card)[market] || (card[stateKey] && card[stateKey].status !== "unavailable")) return;
    var local = ["127.0.0.1", "localhost", "[::1]"].indexOf(location.hostname) !== -1;
    // Pages uses the saved PriceCharting catalog and TCGdex's public Cardmarket IDs.
    if (!local && (market !== "cm" || !window.CardmarketResolver)) return;
    card[stateKey] = { status: "loading" };
    fillMarkets(card);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    var url = "api/" + endpoint + "?species=" + encodeURIComponent(current.meta.key) + "&card=" + encodeURIComponent(card.id);
    var request = local ? fetch(url, { signal: controller.signal }).then(function (res) {
      if (!res.ok) throw new Error("Card lookup " + res.status);
      return res.json();
    }) : window.CardmarketResolver.resolve(card);
    request.then(function (result) {
      card[stateKey] = result;
    }).catch(function () {
      card[stateKey] = { status: "unavailable" };
    }).then(function () {
      clearTimeout(timeout);
      if (activeCard === card) fillMarkets(card);
    });
  }

  // Pull the card out of its sleeve and lay it on the inspect stage.
  function pullCard(card, pocket) {
    if (!card || activeCard || animating) return;
    activeCard = card;
    fillSheet(card);
    var art = $("sheet-art");
    var overlay = $("overlay");
    var thumb = pocket && pocket.querySelector(".pk-card img");
    art.classList.remove("is-landing");
    art.classList.add("is-waiting");
    overlay.classList.add("is-on");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-locked");
    binder.markOut(String(card.ref));
    $("sheet-close").focus({ preventScroll: true });
    animating = true;
    window.CardBinder.pullOut(pocket, art, thumb ? thumb.currentSrc || thumb.src : "").then(function (fly) {
      var img = art.querySelector("img");
      var ready = img && img.decode ? img.decode().catch(function () {}) : Promise.resolve();
      return ready.then(function () {
        animating = false;
        if (fly) fly.remove();
        if (activeCard !== card) return;
        art.classList.remove("is-waiting");
        if (fly) art.classList.add("is-landing");
      });
    });
    resolveCardLinks(card);
  }

  // Fly the card back into its pocket. `instant` skips the animation.
  function closeSheet(instant) {
    if (!activeCard || (animating && !instant)) return;
    var card = activeCard;
    activeCard = null;
    var overlay = $("overlay");
    var art = $("sheet-art");
    var img = art.querySelector("img");
    var pocket = binder ? binder.pocketFor(String(card.ref)) : null;
    var thumb = pocket && pocket.querySelector(".pk-card img");
    function finish() {
      animating = false;
      overlay.classList.remove("is-on", "is-closing");
      overlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("is-locked");
      art.classList.remove("is-waiting", "is-landing");
      if (binder) binder.markOut(null);
      if (pocket && pocket.isConnected && !instant) pocket.focus({ preventScroll: true });
    }
    if (instant || !pocket || !img || art.classList.contains("is-empty")) {
      document.querySelectorAll(".card-fly").forEach(function (fly) { fly.remove(); });
      finish();
      return;
    }
    animating = true;
    art.classList.remove("is-landing");
    overlay.classList.add("is-closing");
    window.CardBinder.putBack(pocket, art, thumb ? thumb.currentSrc || thumb.src : img.src).then(finish, finish);
    art.classList.add("is-waiting");
  }

  function bindToolbar() {
    filterState = { lang: "", rarities: {}, hideReverse: false, variant: "", query: "" };
    document.querySelectorAll("#result .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var kind = chip.getAttribute("data-filter");
        var value = chip.getAttribute("data-value") || "";
        if (kind === "lang") {
          filterState.lang = value;
          document.querySelectorAll('#result .chip[data-filter="lang"]').forEach(function (c) {
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
        showCards(true);
      });
    });
    $("sort").addEventListener("change", function () { showCards(true); });
    var variantEl = $("variant");
    if (variantEl) variantEl.addEventListener("change", function () {
      filterState.variant = variantEl.value || "";
      showCards(true);
    });
    $("filter").addEventListener("input", function () {
      filterState.query = $("filter").value || "";
      showCards(true);
    });
  }

  $("overlay").addEventListener("click", function (ev) {
    if (ev.target === $("overlay")) closeSheet(false);
  });
  $("sheet-close").addEventListener("click", function () { closeSheet(false); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") {
      if (activeCard) closeSheet(false);
      else hideSuggest();
    } else if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && binder && !activeCard && $("binder") &&
        !(ev.target.closest && ev.target.closest("input, select, textarea"))) {
      ev.preventDefault();
      binder.turn(ev.key === "ArrowRight" ? 1 : -1);
    }
  });

  /* ---- search / load ---- */

  // The status line is kept as a key and values so a language switch can
  // redraw it. Numbers follow the language's grouping; functions are called.
  var lastStatus = null;

  function setStatus(key, vars, isError) {
    lastStatus = key ? { key: key, vars: vars || {}, isError: !!isError } : null;
    renderStatus();
  }

  function renderStatus() {
    var el = $("status");
    var vars = {};
    if (lastStatus) Object.keys(lastStatus.vars).forEach(function (name) {
      var value = lastStatus.vars[name];
      vars[name] = typeof value === "function" ? value() : typeof value === "number" ? num(value) : value;
    });
    el.textContent = lastStatus ? t(lastStatus.key, vars) : "";
    el.classList.toggle("is-error", !!(lastStatus && lastStatus.isError));
  }

  function hideSuggest() {
    var box = $("suggest");
    $("q").setAttribute("aria-expanded", "false");
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
      var meta = countText("count.cards", item.variants || item.cards || 0);
      if (item.number) meta = "#" + item.number + " · " + meta;
      var sprite = item.number ? '<img class="s-sprite" data-sprite="' + escapeHtml(item.number) +
        '" alt="" width="32" height="32" onerror="this.style.visibility=\'hidden\'">' : "";
      return '<button type="button" role="option" data-i="' + i + '"' +
        (i === 0 ? ' aria-selected="true"' : ' aria-selected="false"') +
        ">" + sprite + '<span class="s-name">' + escapeHtml(item.name) + '</span><span class="s-meta">' + escapeHtml(meta) + "</span></button>";
    }).join("");
    fitSprites(box);
    box.hidden = false;
    $("q").setAttribute("aria-expanded", "true");
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
      setStatus("status.noMatch", null, true);
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
    current.priceTime = when;
    current.priced = priced;
    setStatus("status.priced", {
      n: priced,
      time: when,
      elapsed: function () {
        return elapsed >= 50 ? " (" + (elapsed / 1000).toLocaleString(i18n.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " s)" : "";
      }
    });
    updateTiles();
    renderFooter();
    return { priced: priced, elapsed: elapsed, when: when };
  }

  var loadToken = 0;
  var titleName = "";

  function loadSpecies(item) {
    var token = ++loadToken;
    document.querySelectorAll('[data-species]').forEach(function (button) {
      button.classList.toggle('is-selected', button.getAttribute('data-species') === item.slug);
      button.setAttribute('aria-pressed', button.getAttribute('data-species') === item.slug ? 'true' : 'false');
    });
    titleName = item.name;
    document.title = t("title.species", { name: item.name });
    closeSheet(true);
    if (binder) binder.destroy();
    binder = null;
    current = null;
    setStatus("status.loading", { name: item.name });
    $("result").innerHTML = closedBinder(item.name, "binder.loading", "is-loading");
    // Bring the binder into view so its cover is seen opening.
    var top = $("result").getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.5) $("result").scrollIntoView({ block: "start" });
    if (history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(item.slug || item.key));
    Promise.all([
      fetch("data/" + encodeURIComponent(item.key) + ".json", { cache: "default" }).then(function (res) {
        if (!res.ok) throw new Error("data " + res.status);
        return res.json();
      }),
      loadFx(),
      fetch("links/" + encodeURIComponent(item.key) + ".json?v=20261116r3").then(function (res) {
        if (!res.ok) return {};
        return res.json();
      }).catch(function () { return {}; })
    ]).then(function (parts) {
      if (token !== loadToken) return;
      var data = parts[0];
      var savedLinks = parts[2] || {};
      var cards = (data.cards || []).map(function (c, i) {
        return Object.assign({}, c, savedLinks[c.id] || {}, { ref: i });
      });
      current = {
        meta: {
          key: data.key || item.key,
          name: data.name || item.name,
          number: data.number || item.number,
          slug: data.slug || item.slug || (item.key || "").replace(/^\d+-/, ""),
          cards: data.counts && data.counts.cards,
          variants: cards.length
        },
        cards: cards,
        payloads: {},
        priced: 0,
        priceTime: ""
      };
      paintResult();
      setStatus("status.fetching");
      var ids = cards.map(function (c) { return c.productId; }).filter(Boolean);
      var t0 = Date.now();
      return fetchPrices(ids, function (partial, updatedAt) {
        if (token !== loadToken) return;
        applyFetchedPrices(partial, updatedAt, t0);
      }).then(function (result) {
        if (token !== loadToken) return;
        var summary = applyFetchedPrices(result.prices, result.updatedAt, t0);
        if (result.failed && summary) {
          setStatus("status.partial", { n: summary.priced, time: summary.when }, true);
        }
        current.elapsedMs = Date.now() - t0;
      });
    }).catch(function (err) {
      if (token !== loadToken) return;
      setStatus("status.loadFailed", { name: item.name }, true);
      $("result").innerHTML = closedBinder(item.name, "binder.stuck", "is-stuck");
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
    if ($("search-submit")) $("search-submit").addEventListener("click", submitQuery);
    document.querySelectorAll('[data-species]').forEach(function (button) {
      button.disabled = true;
      button.addEventListener('click', function () {
        var item = findByHash('#' + button.getAttribute('data-species'));
        if (item) pickSpecies(item);
      });
    });
    document.querySelectorAll('[data-focus-search]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        input.scrollIntoView({ block: 'center' });
        input.focus({ preventScroll: true });
      });
    });
    document.querySelectorAll('[data-open-guide]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        var guide = $('market-guide');
        guide.open = true;
        guide.scrollIntoView({ block: 'start' });
        guide.querySelector('summary').focus({ preventScroll: true });
      });
    });
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

  /* ---- sprites ---- */

  // PokeAPI sprites sit in a 96px frame with uneven empty margins: Charizard
  // fills it, Pikachu uses half. Crop each to its figure and scale that to a
  // fixed square, so every sprite shows at the same size.
  var SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/";
  var SPRITE_SIZE = 96;
  var fittedSprites = {};

  function cropSprite(raw) {
    var w = raw.naturalWidth;
    var h = raw.naturalHeight;
    var source = document.createElement("canvas");
    source.width = w;
    source.height = h;
    var ctx = source.getContext("2d");
    ctx.drawImage(raw, 0, 0);
    var alpha = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (alpha[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return raw.src;
    var bw = maxX - minX + 1;
    var bh = maxY - minY + 1;
    var scale = (SPRITE_SIZE - 4) / Math.max(bw, bh);
    var dw = Math.round(bw * scale);
    var dh = Math.round(bh * scale);
    var out = document.createElement("canvas");
    out.width = out.height = SPRITE_SIZE;
    var octx = out.getContext("2d");
    octx.imageSmoothingEnabled = scale < 1; // keep pixel art crisp when enlarging
    octx.drawImage(source, minX, minY, bw, bh, Math.round((SPRITE_SIZE - dw) / 2), Math.round((SPRITE_SIZE - dh) / 2), dw, dh);
    return out.toDataURL("image/png");
  }

  function fitSprites(scope) {
    (scope || document).querySelectorAll("img[data-sprite]").forEach(function (img) {
      var src = SPRITE_BASE + encodeURIComponent(img.getAttribute("data-sprite")) + ".png";
      img.removeAttribute("data-sprite");
      if (!fittedSprites[src]) fittedSprites[src] = new Promise(function (resolve) {
        var raw = new Image();
        raw.crossOrigin = "anonymous";
        raw.onload = function () {
          try { resolve(cropSprite(raw)); } catch (e) { resolve(src); }
        };
        raw.onerror = function () { resolve(src); }; // let the <img> try, and hide itself if it fails
        raw.src = src;
      });
      fittedSprites[src].then(function (url) { img.src = url; });
    });
  }

  /* ---- language ---- */

  var catalogTotals = null;

  function renderCatalogCounts() {
    if (!catalogTotals) return;
    if ($("catalog-species")) $("catalog-species").textContent = num(catalogTotals.species);
    if ($("catalog-printings")) $("catalog-printings").textContent = num(catalogTotals.printings);
  }

  // CardI18n has already swapped every data-i18n text; redraw the rest.
  function relabel() {
    document.title = titleName ? t("title.species", { name: titleName }) : t("title.home");
    renderStatus();
    renderCatalogCounts();
    renderResultText();
    renderFooter();
    if (binder) {
      binder.updateNav();
      binder.refresh();
    }
    if (activeCard) {
      fillSheetText(activeCard);
      fillMarkets(activeCard);
    }
    if (suggestItems.length) showSuggest($("q").value.trim());
  }

  function boot() {
    bindSearch();
    fitSprites(document.querySelector(".quick-picks"));
    i18n.onChange(relabel);
    setStatus("status.catalog");
    fetch("data/index.json").then(function (res) {
      if (!res.ok) throw new Error("index " + res.status);
      return res.json();
    }).then(function (data) {
      speciesIndex = data.species || data || [];
      catalogTotals = {
        species: speciesIndex.length,
        printings: (data.counts || {}).variants || speciesIndex.reduce(function (total, item) { return total + Number(item.variants || 0); }, 0)
      };
      renderCatalogCounts();
      document.querySelectorAll('[data-species]').forEach(function (button) { button.disabled = false; });
      setStatus("status.ready", { n: speciesIndex.length });
      var fromHash = findByHash(location.hash);
      if (fromHash) pickSpecies(fromHash);
    }).catch(function (err) {
      setStatus("status.catalogFailed", null, true);
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
