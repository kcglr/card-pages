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
  var Store = window.PullfolioStore;
  var Mine = window.PullfolioMine;
  var Core = window.PullfolioCore;
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
    if (n.startsWith(q)) return 85; // completions are ordered by how many cards they have
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
      return b.score - a.score || (b.item.cards || 0) - (a.item.cards || 0) || (a.item.number || 0) - (b.item.number || 0);
    });
    return scored.slice(0, limit || 8);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var formatUsd = window.PricePick.formatUsd;

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

  /* ---- prices: price-pick.js has the rules, shared with My binder ---- */

  // `unique`: no other printing in the file shares the card's TCGplayer
  // product. My binder's cards carry it (pidUnique), saved from their file.
  function applyPriceToCard(card, payloads, pidCounts) {
    var pid = card.productId ? String(card.productId) : "";
    if (!pid) return null;
    var unique = card.pidUnique != null ? !!card.pidUnique : pidCounts[pid] === 1;
    return window.PricePick.price(card, payloads[pid], unique);
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
  var filterState = { langs: {}, variants: {}, species: {}, set: "", hideReverse: false, own: "", query: "" };
  var LANG_STORE = "pullfolio.langs";
  // "Mark cards I own" (collect mode): taps mark pockets instead of pulling
  // cards out. It stays on from one Pokémon's binder to the next until it is
  // turned off or the page is reloaded.
  var collecting = false;
  var COLLECT_ICON = '<svg class="collect-tick" viewBox="0 0 7 6" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" ' +
    'd="M6 0h1v1H6zM5 1h2v1H5zM0 2h1v1H0zM4 2h2v1H4zM0 3h2v1H0zM3 3h2v1H3zM1 4h3v1H1zM2 5h1v1H2z"/></svg>';

  // Markup for text that follows the site language: CardI18n.apply() re-reads
  // the data-i18n key when the language changes.
  function said(tag, key, attrs) {
    return "<" + tag + (attrs ? " " + attrs : "") + ' data-i18n="' + key + '">' + escapeHtml(t(key)) + "</" + tag + ">";
  }
  function saidAttr(attr, key) {
    return " " + attr + '="' + escapeHtml(t(key)) + '" data-i18n-attr="' + attr + ":" + key + '"';
  }

  // Sort, the variant button and the set field; the shelf for the last two
  // opens under them (see the pickers below).
  function renderToolbar(cards) {
    var mine = current && current.meta.mine;
    // In a Pokémon's binder: collect mode, then Owned and Missing (the
    // master-set checklist). My binder holds only cards you own.
    var chips = (mine ? "" :
      '<button type="button" class="chip collect-chip" data-filter="collect" aria-pressed="false">' + COLLECT_ICON + said("span", "collect.mode") + "</button>" +
      said("button", "filter.owned", 'type="button" class="chip" data-filter="own" data-value="owned" aria-pressed="false"') +
      said("button", "filter.missing", 'type="button" class="chip" data-filter="own" data-value="missing" aria-pressed="false"')) +
      (hasReverse(cards) ? said("button", "toolbar.hideReverse", 'type="button" class="chip" data-filter="hide-reverse" data-value="1" aria-pressed="false"') : "");
    var variantBtn = uniqueValues(cards, "variant").length > 1 ?
      '<button type="button" class="picker-btn" id="variant-btn" aria-haspopup="true" aria-expanded="false" aria-controls="picker">' +
        said("span", "toolbar.variant", 'class="sr-only"') + '<span class="picker-btn-label" id="variant-label" lang="en"></span>' + CARET + "</button>" : "";
    var dated = hasDates(cards);
    var speciesBtn = mine && uniqueValues(cards, "species").length > 1 ?
      '<button type="button" class="picker-btn" id="species-btn" aria-haspopup="true" aria-expanded="false" aria-controls="picker">' +
        said("span", "toolbar.species", 'class="sr-only"') + '<span class="picker-btn-label" id="species-label"></span>' + CARET + "</button>" : "";
    var sortOptions = mine ?
      said("option", "sort.value", 'value="value" selected') + said("option", "sort.gain", 'value="gain"') +
      said("option", "sort.added", 'value="added"') + said("option", "sort.dex", 'value="dex"') +
      (dated ? said("option", "sort.newest", 'value="newest"') + said("option", "sort.oldest", 'value="oldest"') : "") +
      said("option", "sort.set", 'value="set"') + said("option", "sort.name", 'value="name"') :
      (dated ? said("option", "sort.newest", 'value="newest" selected') + said("option", "sort.oldest", 'value="oldest"') : "") +
      said("option", "sort.priceDesc", 'value="price-desc"' + (dated ? "" : " selected")) +
      said("option", "sort.priceAsc", 'value="price-asc"') + said("option", "sort.name", 'value="name"') + said("option", "sort.set", 'value="set"');
    variantBtn = speciesBtn + variantBtn;
    return (
      '<div class="toolbar" id="toolbar">' +
        '<div class="toolbar-row">' +
          '<label class="sort-wrap">' + said("span", "toolbar.sort", 'class="sr-only"') + '<select id="sort">' + sortOptions + "</select></label>" +
          variantBtn +
          '<label class="search-wrap">' + said("span", "toolbar.filter", 'class="sr-only"') +
          '<input id="filter" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="picker"' +
          saidAttr("placeholder", "toolbar.filterHint") + ' autocomplete="off" spellcheck="false"></label>' +
          '<div class="count" id="count"></div>' +
        "</div>" +
        (chips ? '<div class="toolbar-row wraps"><div class="chips">' + chips + "</div></div>" : "") +
        '<div class="picker" id="picker"><div class="picker-clip"><div class="picker-card" id="picker-card"></div></div></div>' +
      "</div>"
    );
  }

  // Language filters are the divider tabs on the binder's top edge. "All"
  // shows every language; the language tabs toggle, so any mix can be picked
  // (English and Japanese without Chinese, say). The pick is remembered for
  // the next binder.
  function renderLangTabs(cards) {
    var tabs = said("button", "tabs.all", 'type="button" class="chip tab is-on" data-filter="lang" data-value="" aria-pressed="true"');
    uniqueValues(cards, "lang").forEach(function (lang) {
      tabs += '<button type="button" class="chip tab tab-' + escapeHtml(lang.toLowerCase()) + '" data-filter="lang" data-value="' +
        escapeHtml(lang) + '" aria-pressed="false"><span class="tab-tick" aria-hidden="true"></span>' + escapeHtml(lang) + "</button>";
    });
    return '<div class="binder-tabs" role="group"' + saidAttr("aria-label", "tabs.label") + ">" + tabs + "</div>";
  }

  // The back printed on a card, shown in its pocket while the scan loads.
  // Japanese cards moved from the "Pocket Monsters Card Game" back to the
  // current one with Pokémon VS (19 July 2001). Chinese cards use the
  // Japanese back, as the Asian editions do.
  var JP_BACK_SINCE = "2001-07-19";
  function cardBack(card) {
    var lang = (card.lang || "").toUpperCase();
    if (lang === "JP" && hasDate(card) && card.released < JP_BACK_SINCE) return "jp-old";
    return lang === "JP" || lang === "CN" ? "jp" : "en";
  }

  function describeCard(card) {
    var lang = (card.lang || "").toUpperCase();
    var price = (card.price && card.price.headline) || "";
    var name = card.name || t("card.fallback");
    // How many you own (by id, or the same product filed under another
    // Pokémon), and a graded copy's slab.
    var own = Mine.pocketInfo(card);
    // In My binder every card is yours: only more than one copy is marked.
    if (own && current && current.meta.mine && own.qty < 2 && !own.slab) own = null;
    else if (own && current && current.meta.mine && own.qty < 2) own = { qty: 0, slab: own.slab };
    var marking = collecting && current && !current.meta.mine;
    return {
      pressed: marking ? !!own : null,
      key: String(card.ref),
      name: name,
      image: card.image || "",
      back: cardBack(card),
      lang: lang,
      price: price,
      owned: own ? own.qty : 0,
      slab: own ? own.slab : "",
      label: [name, lang, (card.variant || card.rarity || "").trim(), card.set, price || t("card.noPrice"),
        own ? (own.qty ? t("own.pocket", { n: num(own.qty) }) + (own.slab ? " " : "") : "") + own.slab : ""]
        .filter(Boolean).join(", ")
    };
  }

  function speciesArt(number) {
    return number ? "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/" +
      encodeURIComponent(number) + ".png" : "";
  }

  var INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/></svg>';

  // A closed binder (loading, or failed to open) with a line of help under it.
  function closedBinder(title, noteKey, extra) {
    return '<div class="welcome-state' + (extra ? " " + extra : "") + '"><div class="closed-binder"><span class="cover-tape">' +
      escapeHtml(title) + '</span></div><p class="cover-info">' + INFO_ICON + said("span", noteKey) + "</p></div>";
  }

  function paintResult() {
    if (!current) return;
    var cards = current.cards;
    var meta = current.meta;
    var mine = !!meta.mine;
    var art = mine ? "" : speciesArt(meta.number);
    var fromCover = !document.body.classList.contains("is-viewing");
    document.body.classList.add("is-viewing");
    document.body.classList.toggle("is-mine", mine);
    $("search-cover").classList.remove("is-loading", "is-picked");
    var title = mine ? said("h2", "mine.title", 'class="result-title"') : '<h2 class="result-title">' + escapeHtml(meta.name) + "</h2>";
    $("result").innerHTML =
      '<header class="result-header' + (mine ? " is-mine" : "") + '">' +
        (art ? '<img class="result-art" src="' + escapeHtml(art) + '" alt="" width="112" height="112" onerror="this.remove()">' : "") +
        '<div class="result-heading">' +
          '<button type="button" class="back-home" data-go-home><span aria-hidden="true">←</span> ' + said("span", "result.back") + "</button>" +
          '<p class="result-dex" id="result-dex"></p>' + title +
          '<p class="subtitle" id="result-sub"></p>' + (mine ? "" : '<div class="own-progress" id="own-progress" hidden></div>') +
          '<p class="status result-status" id="result-status"></p></div>' +
        (mine ? "" : said("p", "result.hint", 'class="result-hint"')) +
      "</header>" +
      (mine && cards.length ? '<section class="mine-summary" id="mine-summary"' + saidAttr("aria-label", "sum.value") + "></section>" : "") +
      (mine && !cards.length ? '<div class="welcome-state mine-empty-state"><div class="closed-binder"><span class="cover-tape">' + escapeHtml(t("mine.title")) +
        "</span></div>" + Mine.emptyHtml() + "</div>" :
        renderToolbar(cards) +
        '<div class="binder-wrap' + (mine ? " is-mine" : "") + '"><div class="binder-stack">' + renderLangTabs(cards) + '<div id="binder"></div></div>' +
        said("p", "empty", 'class="empty" id="empty"') + "</div>") +
      '<footer id="result-footer"></footer>';
    renderResultText();
    renderFooter();
    renderStatus();
    if (mine) renderMineSummary();
    $("result").querySelector("[data-go-home]").addEventListener("click", function () { goHome(true); });
    if (binder) binder.destroy();
    binder = null;
    if (mine && !cards.length) {
      if (fromCover) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      return;
    }
    binder = new window.CardBinder($("binder"), { describe: describeCard, onPick: pickPocket });
    bindToolbar();
    showCards(false);
    // Coming from the cover, the hero has just been put away: start at the top so
    // the binder is seen opening.
    if (fromCover) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    binder.openCover(mine ? t("mine.title") : meta.name);
  }

  // The result text that carries numbers; redrawn when the language changes.
  function renderResultText() {
    if (!current || !$("result-sub")) return;
    var meta = current.meta;
    var cards = current.cards;
    var langs = uniqueValues(cards, "lang");
    if (meta.mine) {
      var all = Store.model().all();
      var sum = Core.totals(all, null);
      $("result-dex").textContent = t("mine.kicker");
      $("result-sub").textContent = !sum.cards ? "" : countText("sum.cards", sum.cards) + " · " + countText("sum.printings", sum.printings) + " · " +
        countText("sum.species", sum.species) + (langs.length ? " · " + langs.join(" · ") : "");
      updateCount();
      return;
    }
    $("result-dex").textContent = meta.number ? t("result.dex", { n: String(meta.number).padStart(3, "0") }) : t("result.master");
    $("result-sub").textContent = countText("count.cards", meta.cards || cards.length) + " · " +
      countText("count.printings", cards.length) + (langs.length ? " · " + langs.join(" · ") : "");
    updateCount();
    renderProgress();
  }

  // Master-set progress under the subtitle. It counts the printings shown
  // under the current filters (all but Owned and Missing), so with ENG
  // ticked it's the English set. It shows once you own one of them, or while
  // marking cards.
  function renderProgress() {
    var el = $("own-progress");
    if (!el || !current || current.meta.mine) return;
    var list = current.cards.filter(function (card) { return passes(card, "own"); });
    var p = Core.progress(list, Store.model());
    var show = p.total > 0 && (p.owned > 0 || collecting);
    el.hidden = !show;
    if (!show) return;
    el.innerHTML = '<span class="own-progress-text">' +
      escapeHtml(t("progress", { n: num(p.total), owned: num(p.owned), pct: p.pct })) + "</span>" +
      '<span class="own-progress-bar" aria-hidden="true"><span style="width:' + p.pct + '%"></span></span>';
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
    if (current.meta.mine) {
      footer.textContent = current.priceTime ? t("mine.footer", { time: current.priceTime }) : "";
      return;
    }
    var slug = current.meta.slug || (current.meta.key || "").replace(/^\d+-/, "");
    footer.innerHTML = (current.priceTime ? escapeHtml(t("footer.prices", { time: current.priceTime })) + " " : "") +
      escapeHtml(t("footer.list")) + ' <a href="https://pokecottage.com/pokemon-master-sets/' + encodeURIComponent(slug) +
      '" target="_blank" rel="noopener noreferrer">PokéCottage</a>. ' + escapeHtml(t("footer.rest"));
  }

  // A null last, the rest high to low.
  function byNumberDesc(x, y) {
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  }

  function compareCards(mode) {
    function text(card, key) { return String(card[key] || "").toLowerCase(); }
    var inner = compareSpecies(mode, text);
    // In My binder, cards missing from the latest catalog go last.
    return function (a, b) {
      return ((a.unmatched ? 1 : 0) - (b.unmatched ? 1 : 0)) || inner(a, b);
    };
  }

  function compareSpecies(mode, text) {
    return function (a, b) {
      if (mode === "value") return byNumberDesc(a.mineValue, b.mineValue) || text(a, "name").localeCompare(text(b, "name"));
      if (mode === "gain") return byNumberDesc(a.mineGain, b.mineGain) || byNumberDesc(a.mineValue, b.mineValue);
      if (mode === "added") return String(b.mineAdded || "").localeCompare(String(a.mineAdded || ""));
      if (mode === "dex") return (a.speciesNo || 0) - (b.speciesNo || 0) || String(a.released || "9").localeCompare(String(b.released || "9"));
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

  /* ---- set and variant pickers ---- */

  // The set field and the variant button open a shelf under the toolbar that
  // lists only the sets and variants this Pokémon's cards have, counted under
  // the other filters (language tabs, hidden reverse holos, the other picker).
  // The lists are worked out from the loaded cards every time they show, so a
  // catalog update changes them with no other step. The shelf pushes the
  // binder down instead of covering it, and the binder follows each pick.
  var pickerMode = "";
  var CARET = '<svg class="picker-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';

  function cardVariant(card) { return (card.variant || card.rarity || "").trim(); }
  function cardSetName(card) { return String(card.setName || String(card.set || "").split(" · ")[0]).trim(); }
  function cardSetKey(card) { return (card.lang || "").toUpperCase() + "|" + cardSetName(card); }
  function pickedVariants() {
    return Object.keys(filterState.variants).filter(function (k) { return filterState.variants[k]; });
  }
  function pickedSpecies() {
    return Object.keys(filterState.species || {}).filter(function (k) { return filterState.species[k]; });
  }
  function speciesName(key) {
    var n = Core.speciesNumber(key);
    var item = speciesByNumber[n];
    return item ? item.name : String(key || "").replace(/^\d+-/, "").replace(/-/g, " ");
  }

  // `skip` leaves one filter out, so a picker can count its own options. The
  // set list leaves out the typed text too: that narrows the list by name.
  function passes(card, skip) {
    var langOn = pickedLangs();
    var variantsOn = pickedVariants();
    var speciesOn = pickedSpecies();
    var q = skip === "set" ? "" : filterState.query.trim().toLowerCase();
    var variant = cardVariant(card);
    var lower = variant.toLowerCase();
    return (!langOn.length || langOn.indexOf((card.lang || "").toUpperCase()) !== -1) &&
      (skip === "species" || !speciesOn.length || speciesOn.indexOf(card.species) !== -1) &&
      (skip === "variant" || !variantsOn.length || variantsOn.indexOf(variant) !== -1) &&
      (!filterState.hideReverse || lower.indexOf("reverse") === -1 || lower.indexOf("holo") === -1) &&
      (skip === "own" || !filterState.own || (filterState.own === "owned") === (Store.model().qtyFor(card) > 0)) &&
      (skip === "set" || !filterState.set || cardSetKey(card) === filterState.set) &&
      (!q || searchBlob(card).indexOf(q) !== -1);
  }

  function visibleCards() {
    return current.cards.filter(function (card) { return passes(card, ""); })
      .sort(compareCards($("sort") ? $("sort").value : ""));
  }

  // Sets by language (binder-tab order), newest first. A picked set stays
  // listed even when the other filters leave it empty, so it can be cleared.
  function setOptions() {
    var sets = {};
    current.cards.forEach(function (card) {
      var name = cardSetName(card);
      if (!name || !passes(card, "set")) return;
      var key = cardSetKey(card);
      var s = sets[key] || (sets[key] = { key: key, lang: (card.lang || "").toUpperCase(), name: name, n: 0, first: "" });
      s.n++;
      if (hasDate(card) && (!s.first || card.released < s.first)) s.first = card.released;
    });
    if (filterState.set && !sets[filterState.set]) {
      var parts = filterState.set.split("|");
      sets[filterState.set] = { key: filterState.set, lang: parts[0], name: parts.slice(1).join("|"), n: 0, first: "" };
    }
    return Object.keys(sets).map(function (k) { return sets[k]; }).sort(function (a, b) {
      return langRank(a.lang) - langRank(b.lang) || b.first.localeCompare(a.first) || a.name.localeCompare(b.name);
    });
  }

  // Variants, most cards first.
  function variantOptions() {
    var counts = {};
    current.cards.forEach(function (card) {
      var v = cardVariant(card);
      if (v && passes(card, "variant")) counts[v] = (counts[v] || 0) + 1;
    });
    pickedVariants().forEach(function (v) { if (!counts[v]) counts[v] = 0; });
    return Object.keys(counts).map(function (v) { return { key: v, n: counts[v] }; })
      .sort(function (a, b) { return b.n - a.n || a.key.localeCompare(b.key); });
  }

  function variantLabel() {
    var on = pickedVariants();
    if (!on.length) return t("toolbar.allVariants");
    return on.length === 1 ? on[0] : t("picker.variantsOn", { name: on[0], n: on.length - 1 });
  }

  // My binder's Pokémon, by National Dex number, counted under the other filters.
  function speciesOptions() {
    var counts = {};
    current.cards.forEach(function (card) {
      if (card.species && passes(card, "species")) counts[card.species] = (counts[card.species] || 0) + 1;
    });
    pickedSpecies().forEach(function (k) { if (!counts[k]) counts[k] = 0; });
    return Object.keys(counts).map(function (k) { return { key: k, n: counts[k], no: Core.speciesNumber(k), name: speciesName(k) }; })
      .sort(function (a, b) { return a.no - b.no || a.key.localeCompare(b.key); });
  }

  function speciesLabel() {
    var on = pickedSpecies();
    if (!on.length) return t("mine.allSpecies");
    return on.length === 1 ? speciesName(on[0]) : t("mine.speciesOn", { name: speciesName(on[0]), n: on.length - 1 });
  }

  function pickerHead(titleKey, count, canClear) {
    return '<div class="picker-head"><p class="picker-title">' + escapeHtml(t(titleKey)) + "<span>" + escapeHtml(count) + "</span></p>" +
      (canClear ? '<button type="button" class="picker-clear" data-act="clear">' + escapeHtml(t("picker.clear")) + "</button>" : "") +
      '<button type="button" class="picker-close" data-act="close" aria-label="' + escapeHtml(t("picker.close")) + '">&times;</button></div>';
  }

  function renderPicker() {
    var box = $("picker-card");
    if (!box || !pickerMode || !current) return;
    var focused = document.activeElement;
    var focusKey = focused && focused.closest && focused.closest("#picker") ? focused.getAttribute("data-key") : null;
    var html = "";
    if (pickerMode === "sets") {
      var typed = filterState.set ? "" : filterState.query.trim();
      var all = setOptions();
      var shown = typed ? all.filter(function (s) { return s.name.toLowerCase().indexOf(typed.toLowerCase()) !== -1; }) : all;
      html += pickerHead("picker.sets", t("count.sets", { n: num(all.length) }), !!filterState.set);
      if (!shown.length) {
        html += '<p class="picker-empty">' + escapeHtml(t(typed ? "picker.noSets" : "picker.none", { q: typed })) + "</p>";
      } else {
        var body = "";
        var lang = null;
        shown.forEach(function (s) {
          if (s.lang !== lang) {
            lang = s.lang;
            var inLang = shown.filter(function (x) { return x.lang === lang; }).length;
            body += '<p class="picker-group"><span class="picker-lang lang-' + escapeHtml(lang.toLowerCase()) + '">' + escapeHtml(cardLangName(lang)) +
              "</span>" + escapeHtml(t("count.sets", { n: num(inLang) })) + "</p>";
          }
          var on = s.key === filterState.set;
          body += '<button type="button" class="pick lang-' + escapeHtml(s.lang.toLowerCase()) + (on ? " is-on" : "") + '" data-key="' + escapeHtml(s.key) +
            '" aria-pressed="' + on + '"><span class="pick-name" lang="en">' + escapeHtml(s.name) + '</span><span class="pick-meta">' +
            escapeHtml((s.first ? s.first.slice(0, 4) + " · " : "") + num(s.n)) + "</span></button>";
        });
        html += '<div class="picker-list is-sets">' + body + "</div>";
      }
    } else if (pickerMode === "species") {
      var kinds = speciesOptions();
      html += pickerHead("picker.species", t("count.species", { n: num(kinds.length) }), pickedSpecies().length > 0);
      html += kinds.length ? '<div class="picker-list is-species">' + kinds.map(function (s) {
        var on = !!filterState.species[s.key];
        var icon = s.no ? '<img class="pick-icon' + (s.no > ICON_LAST ? " is-big" : "") + '" src="' + escapeHtml(iconSrc(s.no)) +
          '" alt="" width="40" height="30" draggable="false" onerror="this.style.visibility=\'hidden\'">' : "";
        return '<button type="button" class="pick' + (on ? " is-on" : "") + '" data-key="' + escapeHtml(s.key) + '" aria-pressed="' + on + '">' +
          '<span class="pick-tick" aria-hidden="true"></span>' + icon + '<span class="pick-name">' + escapeHtml(s.name) +
          '</span><span class="pick-meta">' + escapeHtml((s.no ? "#" + String(s.no).padStart(3, "0") + " · " : "") + num(s.n)) + "</span></button>";
      }).join("") + "</div>" : '<p class="picker-empty">' + escapeHtml(t("picker.none")) + "</p>";
    } else {
      var opts = variantOptions();
      html += pickerHead("picker.variants", t("count.variants", { n: num(opts.length) }), pickedVariants().length > 0);
      html += opts.length ? '<div class="picker-list is-variants">' + opts.map(function (v) {
        var on = !!filterState.variants[v.key];
        return '<button type="button" class="pick' + (on ? " is-on" : "") + '" data-key="' + escapeHtml(v.key) + '" aria-pressed="' + on + '">' +
          '<span class="pick-tick" aria-hidden="true"></span><span class="pick-name" lang="en">' + escapeHtml(v.key) + '</span><span class="pick-meta">' + num(v.n) + "</span></button>";
      }).join("") + "</div>" : '<p class="picker-empty">' + escapeHtml(t("picker.none")) + "</p>";
    }
    box.innerHTML = html;
    if (focusKey != null) {
      var again = [].filter.call(box.querySelectorAll(".pick"), function (b) { return b.getAttribute("data-key") === focusKey; })[0];
      if (again) again.focus({ preventScroll: true });
    }
  }

  function syncPickerButtons() {
    var who = $("species-btn");
    if (who) {
      who.setAttribute("aria-expanded", pickerMode === "species" ? "true" : "false");
      who.classList.toggle("is-open", pickerMode === "species");
      who.classList.toggle("is-on", pickedSpecies().length > 0);
      $("species-label").textContent = speciesLabel();
    }
    var btn = $("variant-btn");
    if (btn) {
      btn.setAttribute("aria-expanded", pickerMode === "variants" ? "true" : "false");
      btn.classList.toggle("is-open", pickerMode === "variants");
      btn.classList.toggle("is-on", pickedVariants().length > 0);
      $("variant-label").textContent = variantLabel();
    }
    var input = $("filter");
    if (input) {
      input.setAttribute("aria-expanded", pickerMode === "sets" ? "true" : "false");
      input.classList.toggle("is-set", !!filterState.set);
    }
  }

  function syncPickers() {
    syncPickerButtons();
    if (pickerMode) renderPicker();
  }

  function openPicker(mode) {
    var box = $("picker");
    if (!box || !current) return;
    pickerMode = mode;
    box.setAttribute("data-mode", mode);
    box.classList.add("is-open");
    syncPickers();
  }

  function closePicker(focusBack) {
    var box = $("picker");
    if (!box || !pickerMode) return;
    var mode = pickerMode;
    pickerMode = "";
    box.classList.remove("is-open");
    syncPickerButtons();
    var back = mode === "sets" ? $("filter") : mode === "species" ? $("species-btn") : $("variant-btn");
    if (focusBack && back) back.focus();
  }

  function bindPickers() {
    pickerMode = "";
    var input = $("filter");
    var box = $("picker");
    input.addEventListener("click", function () { if (pickerMode !== "sets") openPicker("sets"); });
    input.addEventListener("input", function () {
      filterState.set = "";
      filterState.query = input.value || "";
      if (pickerMode !== "sets" && input.value) openPicker("sets");
      showCards(true);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (pickerMode !== "sets") openPicker("sets");
        var first = box.querySelector(".pick");
        if (first) first.focus();
      } else if (ev.key === "Enter") {
        // Typing part of a set's name and pressing Enter picks the first match.
        var match = pickerMode === "sets" && filterState.query.trim() ? box.querySelector(".pick") : null;
        if (match) match.click();
        else closePicker(false);
      } else if (ev.key === "Escape" && pickerMode) {
        closePicker(false);
      }
    });
    var btn = $("variant-btn");
    if (btn) btn.addEventListener("click", function () {
      if (pickerMode === "variants") closePicker(false);
      else openPicker("variants");
    });
    var who = $("species-btn");
    if (who) who.addEventListener("click", function () {
      if (pickerMode === "species") closePicker(false);
      else openPicker("species");
    });
    box.addEventListener("click", function (ev) {
      var act = ev.target.closest("[data-act]");
      if (act) {
        if (act.getAttribute("data-act") === "close") { closePicker(true); return; }
        if (pickerMode === "sets") {
          filterState.set = "";
          filterState.query = "";
          input.value = "";
        } else if (pickerMode === "species") {
          filterState.species = {};
        } else {
          filterState.variants = {};
        }
        showCards(true);
        return;
      }
      var pick = ev.target.closest(".pick");
      if (!pick) return;
      var key = pick.getAttribute("data-key");
      if (pickerMode === "sets") {
        var off = filterState.set === key;
        filterState.set = off ? "" : key;
        filterState.query = "";
        input.value = off ? "" : key.split("|").slice(1).join("|");
        showCards(true);
        if (!off) { closePicker(false); input.focus({ preventScroll: true }); }
      } else if (pickerMode === "species") {
        filterState.species[key] = !filterState.species[key];
        showCards(true);
      } else {
        filterState.variants[key] = !filterState.variants[key];
        showCards(true);
      }
    });
    box.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); closePicker(true); return; }
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].indexOf(ev.key) === -1) return;
      ev.stopPropagation(); // not a page turn
      var picks = [].slice.call(box.querySelectorAll(".pick"));
      var i = picks.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      var next = picks[i + (ev.key === "ArrowDown" || ev.key === "ArrowRight" ? 1 : -1)];
      if (next) next.focus();
      else if (i === 0 && pickerMode === "sets") input.focus();
    });
    syncPickerButtons();
  }

  // A click anywhere outside the toolbar puts the shelf away.
  document.addEventListener("pointerdown", function (ev) {
    if (pickerMode && !(ev.target.closest && ev.target.closest("#toolbar"))) closePicker(false);
  });

  // Re-files the binder after a filter, sort or price change.
  function showCards(fromStart) {
    if (!binder || !current) return;
    var list = visibleCards();
    binder.setCards(list, { keepPage: !fromStart, deal: fromStart });
    current.shown = list.length;
    updateCount();
    syncPickers();
    renderProgress();
    $("empty").classList.toggle("is-on", !list.length);
  }

  function updateTiles() {
    if (!current) return;
    if (!binder || !$("binder")) { paintResult(); return; }
    var mode = $("sort") ? $("sort").value : "";
    if (mode === "price-desc" || mode === "price-asc" || mode === "value" || mode === "gain") showCards(false);
    else binder.refresh();
  }

  /* ---- the inspect sheet ---- */

  // Card details from build_details.py: the illustrator, the set's series, the
  // product a promo was first found in, a collector's note and better promo
  // dates. One small file per Pokémon, fetched when its binder opens.
  var DETAILS_V = "20261116r4";
  var detailsCache = {};

  function loadDetails(key) {
    if (!key) return Promise.resolve(null);
    if (!detailsCache[key]) {
      detailsCache[key] = fetch("details/" + encodeURIComponent(key) + ".json?v=" + DETAILS_V).then(function (res) {
        if (!res.ok) throw new Error("Card details " + res.status);
        return res.json();
      }).then(function (data) {
        return (data && data.cards) || {};
      }).catch(function () {
        delete detailsCache[key]; // asked again for the next card
        return null;
      });
    }
    return detailsCache[key];
  }

  function withDetails(card) {
    if (card.details || !current) return;
    var key = card.species || current.meta.key;
    loadDetails(key).then(function (map) {
      if (!current) return;
      card.details = map ? map[card.id] || {} : {};
      if (activeCard === card) fillFacts(card);
    });
  }

  function cardSpeciesNo(card) {
    return Number(card.speciesNo || (current && current.meta.number)) || 0;
  }

  function cardLangName(lang) {
    var name = t("cardlang." + lang);
    return name === "cardlang." + lang ? lang : name;
  }

  // The catalog's rarity reads "variant · official rarity" when the two differ.
  function officialRarity(card) {
    var parts = String(card.rarity || "").split(" · ");
    var official = parts.length > 1 ? parts.slice(1).join(" · ").trim() : "";
    return /^(no rarity|none)$/i.test(official) ? "" : official;
  }

  function monthDate(iso) {
    var p = iso.split("-");
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, 1))
      .toLocaleDateString(i18n.locale(), { month: "long", year: "numeric", timeZone: "UTC" });
  }

  // Promo sets date many cards with the day the set began. The details give
  // the day a promo first came out where the catalog knows it; otherwise the
  // set's start is said as such.
  function releaseHtml(card, d) {
    var iso = d.d || card.released || "";
    if (!hasDate({ released: iso })) return "";
    if (d.m) return escapeHtml(monthDate(iso));
    var n = cardSpeciesNo(card);
    var setStart = !d.d && (d.x || (n && !plausibleDate({ released: iso }, n)));
    return escapeHtml(cardDate(iso)) + (setStart ? '<span class="fact-sub">' + escapeHtml(t("fact.setStart")) + "</span>" : "");
  }

  function fillSheetText(card) {
    var lang = (card.lang || "").toUpperCase();
    var variant = (card.variant || card.rarity || "").trim();
    var n = cardSpeciesNo(card);
    $("sheet-tags").innerHTML =
      (lang ? '<span class="sheet-lang lang-' + escapeHtml(lang.toLowerCase()) + '">' + escapeHtml(cardLangName(lang)) + "</span>" : "") +
      // The catalog's variant names are English; lang keeps Turkish capitals (İ) off them.
      (variant ? '<span class="rarity ' + (rarityClass(officialRarity(card)) || rarityClass(variant)) + '" lang="en">' + escapeHtml(variant) + "</span>" : "") +
      (n ? '<span class="sheet-no">' + escapeHtml(t("dex.no", { n: String(n).padStart(3, "0") })) + "</span>" : "");
    $("sheet-title").textContent = card.name || t("card.fallback");
    fillPrice(card);
    fillFacts(card);
  }

  // One price, TCGplayer's, on a sticker, with the lira beside it. The other
  // sites are the logo tiles under it.
  function fillPrice(card) {
    var box = $("sheet-price");
    var p = card.price;
    if (!p) {
      var waiting = !!current && !current.priceTime;
      box.className = "sheet-price is-none" + (waiting ? " is-busy" : "");
      box.innerHTML = '<div class="price-tag"><span class="price-kind">' + escapeHtml(t(waiting ? "sheet.priceLoading" : "sheet.noPrice")) + "</span></div>" +
        (waiting ? "" : '<p class="price-meta">' + escapeHtml(t("sheet.noPriceNote")) + "</p>");
      return;
    }
    var lira = formatTry(p.value, fxRate);
    box.className = "sheet-price";
    box.innerHTML = '<div class="price-tag"><span class="price-kind">' + escapeHtml(t("kind." + p.kind)) + "</span>" +
      '<strong class="price-value">' + escapeHtml(p.headline) + "</strong>" +
      (lira ? '<span class="price-try">' + escapeHtml(lira) + "</span>" : "") + "</div>" +
      '<div class="price-meta"><p class="price-source"><img src="assets/markets/tcgplayer.png" alt="" width="18" height="18">' +
      escapeHtml("TCGplayer" + (p.subtype ? " · " + p.subtype : "")) + "</p>" +
      (p.range ? '<p class="price-range">' + escapeHtml(t("sheet.listed", { range: p.range })) + "</p>" : "") + "</div>";
  }

  function fillFacts(card) {
    var d = card.details || {};
    var rows = [];
    function row(key, html, size) {
      rows.push('<div class="fact' + (size ? " " + size : "") + '"><dt>' + escapeHtml(t(key)) + "</dt><dd>" + html + "</dd></div>");
    }
    var setName = card.setName || String(card.set || "").split(" · ")[0];
    if (setName) row("fact.set", '<span class="fact-set">' + escapeHtml(setName) + "</span>" + (d.s ? '<span class="fact-chip">' + escapeHtml(d.s) + "</span>" : ""), "is-full");
    if (card.cardNumber) row("fact.number", escapeHtml(card.cardNumber));
    var released = releaseHtml(card, d);
    if (released) row("fact.released", released);
    if (d.a) row("fact.artist", escapeHtml(d.a));
    else if (!card.details) row("fact.artist", '<span class="fact-wait" role="img" aria-label="' + escapeHtml(t("fact.loading")) + '"></span>');
    var official = officialRarity(card);
    if (official) row("fact.rarity", escapeHtml(official));
    if (d.f) row("fact.found", escapeHtml(d.f), "is-wide");
    $("sheet-facts").innerHTML = rows.join("");
    var note = $("sheet-note");
    note.hidden = !d.n;
    note.innerHTML = d.n ? "<strong>" + escapeHtml(t("fact.note")) + "</strong>" + escapeHtml(d.n) : "";
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
    fillSites(card);
    withDetails(card);
    showMineSection(card);
  }

  // The card file's "In my binder" section. In a Pokémon's binder its cards
  // are at hand for the printing switcher; in My binder the card's Pokémon
  // file (and its market links) load when the card is pulled out.
  function showMineSection(card) {
    var mine = current && current.meta.mine;
    Mine.showCard(card, {
      species: card.species || (current && current.meta.key),
      price: card.price || null,
      cards: mine ? null : current && current.cards
    });
    if (!mine || !card.species) return;
    Promise.all([
      fetchSpeciesFile(card.species).catch(function () { return null; }),
      card.linksLoaded ? null : fetch("links/" + encodeURIComponent(card.species) + ".json?v=20261116r3").then(function (res) {
        return res.ok ? res.json() : {};
      }).catch(function () { return {}; })
    ]).then(function (parts) {
      if (activeCard !== card) return;
      if (parts[1] && !card.linksLoaded) {
        Object.assign(card, parts[1][card.id] || {});
        card.linksLoaded = true;
        fillSites(card);
        resolveCardLinks(card);
      }
      if (parts[0] && parts[0].cards) Mine.updateCard({ cards: parts[0].cards.map(function (c) { return Object.assign({}, c, { species: card.species }); }) });
    });
  }

  // A logo tile per site. PriceCharting and Cardmarket open the exact card
  // once it is found (on this PC; on Pages, Cardmarket only) and a search until
  // then. eBay opens sold listings, the useful price there.
  function fillSites(card) {
    var links = marketLinks(card);
    function exact(url, search, status) {
      if (url) return { url: url, note: "site.exact" };
      return { url: search, note: status === "loading" ? "site.finding" : "site.search", busy: status === "loading" };
    }
    var pc = exact(links.pc, links.pcSearch, card.pcResolution && card.pcResolution.status);
    var cm = exact(links.cm, links.cmSearch, card.cmResolution && card.cmResolution.status);
    var sites = [
      { name: "TCGplayer", logo: "tcgplayer", url: links.tcg, note: links.tcgDirect ? "site.product" : "site.search" },
      { name: "eBay", logo: "ebay", url: links.ebaySold, note: "site.sold" },
      { name: "PriceCharting", logo: "pricecharting", url: pc.url, note: pc.note, busy: pc.busy },
      { name: "Cardmarket", logo: "cardmarket", url: cm.url, note: cm.note, busy: cm.busy }
    ];
    if (links.collectr) sites.push({ name: "Collectr", logo: "collectr", url: links.collectr, note: "site.card" });
    $("sheet-sites").innerHTML = sites.filter(function (s) { return s.url; }).map(function (s) {
      return '<li><a class="site' + (s.busy ? " is-busy" : "") + '" href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<img class="site-logo" src="assets/markets/' + s.logo + '.png" alt="" width="32" height="32">' +
        '<span class="site-name">' + escapeHtml(s.name) + '</span><span class="site-note">' + escapeHtml(t(s.note)) + "</span></a></li>";
    }).join("");
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
    fillSites(card);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    var url = "api/" + endpoint + "?species=" + encodeURIComponent(card.species || current.meta.key) + "&card=" + encodeURIComponent(card.id);
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
      if (activeCard === card) fillSites(card);
    });
  }

  // A tap on a pocket: in collect mode it marks the card, otherwise the card
  // is pulled out.
  function pickPocket(card, pocket) {
    if (collecting && current && !current.meta.mine) collectTap(card);
    else pullCard(card, pocket);
  }

  // "Vaporeon · Jungle 12/64 · Holo": which printing a tap marked.
  function tapName(card) {
    return [card.name || t("card.fallback"), [cardSetName(card), card.cardNumber].filter(Boolean).join(" "), cardVariant(card)]
      .filter(Boolean).join(" · ");
  }

  // Collect mode: a tap adds one ungraded Near Mint copy, or takes back the
  // copy a tap could have made. A card with details, or with more than one
  // copy, is left alone; the strip offers to pull it out instead.
  function collectTap(card) {
    if (!card || activeCard || animating) return;
    var step = Core.tapAction(Store.model().copiesFor(card));
    var name = tapName(card);
    if (step.action === "add") {
      var added = Store.add(Core.quickCopy(card, card.species || current.meta.key, Core.pidCounts(current.cards)));
      if (added) Mine.toast(t("undo.added", { name: name }), function () { Store.remove(added.uid); });
    } else if (step.action === "remove") {
      var gone = Store.remove(step.uid);
      if (gone) Mine.toast(t("undo.removed", { name: name }), function () { Store.restore(gone); });
    } else {
      Mine.toast(step.why === "many" ? t("collect.many", { n: num(step.qty) }) : t("collect.details"), function () {
        var pocket = binder && binder.pocketFor(String(card.ref));
        if (pocket) pullCard(card, pocket);
      }, t("collect.open"));
    }
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
    Mine.hideCard();
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
      // My binder waits for the card to be put back before it re-files.
      if (mineDirty && !instant && current && current.meta.mine) refileMine();
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

  function pickedLangs() {
    return Object.keys(filterState.langs).filter(function (k) { return filterState.langs[k]; });
  }

  function savedLangs() {
    try {
      var list = JSON.parse(window.localStorage.getItem(LANG_STORE) || "[]");
      return Array.isArray(list) ? list.map(String) : [];
    } catch (err) {
      return [];
    }
  }

  // Picking every language is the same as "All", and so is picking none.
  function setLangs(list) {
    var present = [];
    document.querySelectorAll('#result .chip[data-filter="lang"]').forEach(function (c) {
      var value = c.getAttribute("data-value");
      if (value && !c.hidden) present.push(value);
    });
    var picked = list.filter(function (lang) { return present.indexOf(lang) !== -1; });
    if (picked.length === present.length) picked = [];
    filterState.langs = {};
    picked.forEach(function (lang) { filterState.langs[lang] = true; });
    document.querySelectorAll('#result .chip[data-filter="lang"]').forEach(function (c) {
      var value = c.getAttribute("data-value");
      var on = value ? picked.indexOf(value) !== -1 : !picked.length;
      c.classList.toggle("is-on", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    return picked;
  }

  // The collect-mode chip and the binder's look while marking.
  function syncCollect() {
    var on = !!(collecting && current && !current.meta.mine);
    document.querySelectorAll('#result .chip[data-filter="collect"]').forEach(function (chip) {
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var wrap = document.querySelector("#result .binder-wrap");
    if (wrap) wrap.classList.toggle("is-collecting", on);
  }

  // Owned and Missing: one at a time, and a second press clears it.
  function syncOwnChips() {
    document.querySelectorAll('#result .chip[data-filter="own"]').forEach(function (chip) {
      var on = chip.getAttribute("data-value") === filterState.own;
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function bindToolbar() {
    filterState = { langs: {}, variants: {}, species: {}, set: "", hideReverse: false, own: "", query: "" };
    setLangs(savedLangs());
    syncCollect();
    syncOwnChips();
    document.querySelectorAll("#result .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var kind = chip.getAttribute("data-filter");
        var value = chip.getAttribute("data-value") || "";
        if (kind === "collect") {
          // Only how taps behave changes; the binder keeps its pages.
          collecting = !collecting;
          syncCollect();
          if (binder) binder.refresh();
          renderProgress();
          if (collecting) Mine.toast(t("collect.hint"));
          return;
        }
        if (kind === "own") {
          filterState.own = filterState.own === value ? "" : value;
          syncOwnChips();
        } else if (kind === "lang") {
          var list = pickedLangs();
          if (!value) list = [];
          else if (filterState.langs[value]) list.splice(list.indexOf(value), 1);
          else list.push(value);
          var picked = setLangs(list);
          try { window.localStorage.setItem(LANG_STORE, JSON.stringify(picked)); } catch (err) { /* not remembered */ }
        } else if (kind === "hide-reverse") {
          filterState.hideReverse = !filterState.hideReverse;
          chip.classList.toggle("is-on", filterState.hideReverse);
          chip.setAttribute("aria-pressed", filterState.hideReverse ? "true" : "false");
        }
        showCards(true);
      });
    });
    $("sort").addEventListener("change", function () { showCards(true); });
    bindPickers();
  }

  $("overlay").addEventListener("click", function (ev) {
    if (ev.target === $("overlay")) closeSheet(false);
  });
  $("sheet-close").addEventListener("click", function () { closeSheet(false); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") {
      if (activeCard) closeSheet(false); // the search field handles its own Escape
      else if (dexItem) closeDexCard();
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

  // The status shows under the hero on the cover, and under the title once a
  // binder is open.
  function renderStatus() {
    var vars = {};
    if (lastStatus) Object.keys(lastStatus.vars).forEach(function (name) {
      var value = lastStatus.vars[name];
      vars[name] = typeof value === "function" ? value() : typeof value === "number" ? num(value) : value;
    });
    ["status", "result-status"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.textContent = lastStatus ? t(lastStatus.key, vars) : "";
      el.classList.toggle("is-error", !!(lastStatus && lastStatus.isError));
    });
  }

  /* ---- the search on the cover ---- */

  // The matches drop down from the label as a list (#suggest, an ARIA listbox
  // the input points into), and the same Pokémon are printed on the cover:
  // the highlighted row's sprites bob, and pointing at a sprite highlights its
  // row. Kept short, with no scrollbar: 6 rows, or 5 on a phone.
  var speciesByNumber = {};
  var hoverItem = null;
  var coverMessage = null; // { key, vars, isError } while the cover says something other than a match
  var listOpen = false;
  var exactItem = null; // a full name typed: the cover shows only this Pokémon

  function isHome() { return !document.body.classList.contains("is-viewing"); }

  function listLimit() {
    return window.matchMedia && window.matchMedia("(max-width: 700px)").matches ? 5 : 6;
  }

  // The part of a name the user typed stays regular; the rest, the suggested
  // part, is bold, so the eye goes to what differs between the rows.
  function markMatch(name, query) {
    var plain = function (s) { return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : s.toLowerCase(); };
    var norm = "";
    var map = [];
    for (var i = 0; i < name.length; i++) {
      var c = plain(name[i]);
      for (var k = 0; k < c.length; k++) { norm += c[k]; map.push(i); }
    }
    var q = plain(query.trim());
    var at = q ? norm.indexOf(q) : -1;
    if (at < 0) return "<b>" + escapeHtml(name) + "</b>";
    var start = map[at];
    var end = map[at + q.length - 1] + 1;
    return (start ? "<b>" + escapeHtml(name.slice(0, start)) + "</b>" : "") + escapeHtml(name.slice(start, end)) +
      (end < name.length ? "<b>" + escapeHtml(name.slice(end)) + "</b>" : "");
  }

  function hideSuggest() {
    suggestItems = [];
    activeSuggest = -1;
    exactItem = null;
    $("suggest").innerHTML = "";
    closeList();
  }

  function openList() {
    if (!suggestItems.length) { closeList(); return; }
    listOpen = true;
    $("suggest").hidden = false;
    $("q").setAttribute("aria-expanded", "true");
    if (activeSuggest >= 0) $("q").setAttribute("aria-activedescendant", "suggest-" + activeSuggest);
    showActive();
  }

  function closeList() {
    listOpen = false;
    $("suggest").hidden = true;
    $("q").setAttribute("aria-expanded", "false");
    $("q").removeAttribute("aria-activedescendant");
    showActive();
  }

  function showSuggest(query, keepActive) {
    var box = $("suggest");
    var previous = suggestItems[activeSuggest];
    suggestItems = rankedSpecies(query, listLimit()).map(function (r) { return r.item; });
    if (!suggestItems.length) { hideSuggest(); return; }
    box.innerHTML = suggestItems.map(function (item, i) {
      var n = Number(item.number) || 0;
      var meta = countText("count.cards", item.cards || item.variants || 0);
      if (n) meta = "#" + String(n).padStart(3, "0") + " · " + meta;
      var icon = n ? '<img src="' + iconSrc(n) + '" alt="" width="40" height="30" draggable="false" crossorigin="anonymous"' +
        (n > ICON_LAST ? ' class="is-big"' : "") + " onerror=\"this.style.visibility='hidden'\">" : '<span class="match-blank"></span>';
      return '<li role="option" id="suggest-' + i + '" data-i="' + i + '" aria-selected="false">' + icon +
        '<span class="match-name">' + markMatch(item.name, query) + '</span><span class="match-meta">' + escapeHtml(meta) + "</span></li>";
    }).join("");
    var keep = keepActive && previous ? suggestItems.indexOf(previous) : -1;
    setActiveSuggest(keep >= 0 ? keep : 0);
    if (document.activeElement === $("q")) openList();
  }

  function setActiveSuggest(index) {
    activeSuggest = index;
    $("suggest").querySelectorAll("[role=option]").forEach(function (option, i) {
      option.setAttribute("aria-selected", i === index ? "true" : "false");
    });
    if (listOpen) $("q").setAttribute("aria-activedescendant", "suggest-" + index);
    // Moving off a fully typed name brings all the matches back onto the cover.
    if (exactItem && suggestItems[index] !== exactItem) {
      exactItem = null;
      fillCover(listNumbers(), { ripple: true });
    }
    showActive();
  }

  function listNumbers() {
    return suggestItems.map(function (item) { return Number(item.number) || 0; }).filter(Boolean);
  }

  function moveSuggest(dir) {
    if (!suggestItems.length) return;
    if (!listOpen) { openList(); return; }
    setActiveSuggest((activeSuggest + dir + suggestItems.length) % suggestItems.length);
  }

  // The strip under the label, inside its pocket: the Pokémon Enter would open
  // (or the sprite under the pointer) with its icon, number and card count; a
  // "no match" note; the binder opening; or a hint when there is nothing yet.
  function showActive() {
    var item = hoverItem || suggestItems[activeSuggest] || null;
    markActiveSprites(item && item.number);
    var tag = $("cover-match");
    var q = $("q").value.trim();
    var state = "";
    var html;
    if (coverMessage) {
      state = coverMessage.isError ? "is-error" : "is-busy";
      html = escapeHtml(t(coverMessage.key, coverMessage.vars));
    } else if (!item && q && speciesIndex.length) {
      state = "is-error";
      html = escapeHtml(t("search.none", { q: q }));
    } else if (item) {
      var n = Number(item.number) || 0;
      html = (n ? '<img class="cover-match-icon' + (n > ICON_LAST ? " is-big" : "") + '" src="' + escapeHtml(iconSrc(n)) +
          '" alt="" width="40" height="30" onerror="this.style.visibility=\'hidden\'">' : "") +
        '<span class="cover-match-name">' + escapeHtml(item.name) + "</span>" +
        (n ? '<span class="cover-match-no">#' + String(n).padStart(3, "0") + "</span>" : "") +
        '<span class="cover-match-count">' + escapeHtml(countText("count.cards", item.cards || item.variants || 0)) + "</span>" +
        (hoverItem ? "" : '<kbd class="cover-match-key">↵</kbd>');
    } else {
      state = "is-idle";
      html = escapeHtml(t("cover.hint"));
    }
    var key = state + "|" + html;
    if (tag.getAttribute("data-key") === key) return;
    tag.setAttribute("data-key", key);
    tag.className = "cover-match" + (state ? " " + state : "");
    tag.innerHTML = html;
  }

  function setCoverMessage(key, vars, isError) {
    coverMessage = key ? { key: key, vars: vars || {}, isError: !!isError } : null;
    showActive();
  }

  // Typing reprints the cover with the matches; a full name prints only that
  // Pokémon. Nothing typed brings the usual print back.
  function updateFromQuery() {
    var q = $("q").value.trim();
    cancelPendingOpen();
    closeDexCard(); // the print is about to change
    setCoverMessage(null);
    if (!q) { hideSuggest(); fillCover(COVER_CREW, { ripple: true }); showActive(); return; }
    exactItem = null;
    showSuggest(q);
    $("search-cover").classList.toggle("is-empty", !suggestItems.length && speciesIndex.length > 0);
    if (!suggestItems.length) { showActive(); return; }
    exactItem = fold(suggestItems[0].name) === fold(q) && suggestItems[0].number ? suggestItems[0] : null;
    var numbers = exactItem ? [Number(exactItem.number)] : listNumbers();
    if (numbers.length) fillCover(numbers, { ripple: true });
  }

  function pickSpecies(item, opts) {
    if (!item) return;
    closeDexCard(true);
    $("q").value = item.name;
    hoverItem = null;
    hideSuggest();
    var fromCover = isHome();
    var ready = fromCover ? turnCoverInto(item, !(opts && opts.instant)) : null;
    loadSpecies(item, ready);
  }

  function submitQuery() {
    var q = $("q").value.trim();
    if (!q || !speciesIndex.length) return;
    if (activeSuggest >= 0 && suggestItems[activeSuggest]) {
      pickSpecies(suggestItems[activeSuggest]);
      return;
    }
    var ranked = rankedSpecies(q, 1);
    if (ranked.length && ranked[0].score >= 40) pickSpecies(ranked[0].item);
    else showActive();
  }

  // Close the open binder and go back to the cover.
  function goHome(focus) {
    loadToken++;
    closeSheet(true);
    if (binder) binder.destroy();
    binder = null;
    current = null;
    titleName = "";
    document.title = t("title.home");
    document.body.classList.remove("is-viewing", "is-mine");
    $("result").innerHTML = "";
    if (history.replaceState) history.replaceState(null, "", location.pathname + location.search);
    if (speciesIndex.length) setStatus(null);
    $("q").value = "";
    hoverItem = null;
    closeDexCard(true);
    hideSuggest();
    setCoverMessage(null);
    $("search-cover").classList.remove("is-loading", "is-picked", "is-empty");
    fillCover(COVER_CREW, { ripple: false });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    if (focus) $("q").focus({ preventScroll: true });
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
    if (current.meta.mine) {
      scoreMineCards();
      renderMineSummary();
    }
    updateTiles();
    renderFooter();
    if (activeCard) fillPrice(activeCard);
    return { priced: priced, elapsed: elapsed, when: when };
  }

  var loadToken = 0;
  var titleName = "";
  var pendingOpen = 0; // the load token of a binder opening from the cover

  // Typing again while the cover is opening a binder puts it back.
  function cancelPendingOpen() {
    if (!pendingOpen || pendingOpen !== loadToken) return;
    loadToken++;
    pendingOpen = 0;
    titleName = "";
    document.title = t("title.home");
    $("search-cover").classList.remove("is-loading", "is-picked");
    if (history.replaceState) history.replaceState(null, "", location.pathname + location.search);
    if (speciesIndex.length) setStatus(null);
  }

  // coverReady: a promise for the cover's change into this Pokémon, when the
  // binder is opened from the cover; otherwise a closed binder stands in.
  function loadSpecies(item, coverReady) {
    var token = ++loadToken;
    pendingOpen = coverReady ? token : 0;
    titleName = item.name;
    paintSpritePrint(Number(item.number) || 0);
    paintPokemonTheme(Number(item.number) || 0);
    document.title = t("title.species", { name: item.name });
    closeSheet(true);
    if (binder) binder.destroy();
    binder = null;
    current = null;
    document.body.classList.remove("is-mine");
    setStatus("status.loading", { name: item.name });
    if (!coverReady) {
      $("result").innerHTML = closedBinder(item.name, "binder.loading", "is-loading");
      // Bring the binder into view so its cover is seen opening.
      var top = $("result").getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.5) $("result").scrollIntoView({ block: "start" });
    }
    if (history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(item.slug || item.key));
    loadDetails(item.key); // ready by the time a card is pulled out
    Promise.all([
      fetchSpeciesFile(item.key),
      loadFx(),
      fetch("links/" + encodeURIComponent(item.key) + ".json?v=20261116r3").then(function (res) {
        if (!res.ok) return {};
        return res.json();
      }).catch(function () { return {}; }),
      coverReady
    ]).then(function (parts) {
      if (token !== loadToken) return;
      pendingOpen = 0;
      var data = parts[0];
      var savedLinks = parts[2] || {};
      var speciesKey = data.key || item.key;
      var speciesNo = Number(data.number || item.number) || 0;
      // Each card names its own Pokémon, so My binder can mix them.
      var cards = (data.cards || []).map(function (c, i) {
        return Object.assign({}, c, savedLinks[c.id] || {}, { ref: i, species: speciesKey, speciesNo: speciesNo });
      });
      reconcileSpecies(data);
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
      pendingOpen = 0;
      setStatus("status.loadFailed", { name: item.name }, true);
      if (coverReady) {
        $("search-cover").classList.remove("is-loading", "is-picked");
        setCoverMessage("binder.stuck", null, true);
      } else {
        $("result").innerHTML = closedBinder(item.name, "binder.stuck", "is-stuck");
      }
      console.error(err);
    });
  }

  /* ---- My binder ---- */

  // The cards you own in one binder: a pocket per printing with all its
  // copies, drawn from what was saved with them (collection-core.js), so no
  // Pokémon file has to load. Prices come from the same TCGplayer service.
  var MINE_KEY = "my-binder";
  var mineDirty = false; // the collection changed while a card was out
  var mineThemeNo = 0;
  var catalogStamp = ""; // data/index.json's "updated"

  function isMineHash(hash) { return decodeURIComponent(String(hash || "").replace(/^#/, "")) === MINE_KEY; }

  function mineCards() {
    var groups = {};
    var order = [];
    Store.model().all().forEach(function (c) {
      if (!groups[c.card]) { groups[c.card] = []; order.push(c.card); }
      groups[c.card].push(c);
    });
    return order.map(function (id) {
      var copies = groups[id];
      var s = copies[0].snap;
      return {
        id: id, ref: id, name: s.name, lang: s.lang, variant: s.variant, rarity: s.rarity,
        set: [s.set, s.no].filter(Boolean).join(" · "), setName: s.set, cardNumber: s.no, released: s.released,
        image: s.img, imageLarge: s.imgL || s.img, productId: s.pid, pidUnique: s.pidUnique,
        tcgUrl: s.pid ? "https://www.tcgplayer.com/product/" + s.pid : "",
        species: copies[0].species, speciesNo: Core.speciesNumber(copies[0].species),
        mine: true, copies: copies,
        unmatched: copies.some(function (c) { return c.unmatched; }),
        mineAdded: copies.reduce(function (m, c) { return c.added > m ? c.added : m; }, "")
      };
    });
  }

  // Each pocket's value (every copy, my value first) and gain, for sorting.
  function scoreMineCards() {
    current.cards.forEach(function (card) {
      var value = null;
      var gain = null;
      card.copies.forEach(function (c) {
        var v = Core.unitValue(c, card.price);
        if (v) value = (value || 0) + v.value * c.qty;
        if (v && c.paid && c.paid.usd != null) gain = (gain || 0) + (v.value - c.paid.usd) * c.qty;
      });
      card.mineValue = value;
      card.mineGain = gain;
    });
  }

  // The Pokémon you own, most cards first: they print the cover, and the
  // first one sits on the page slider.
  function mineSpeciesNumbers() {
    var qty = {};
    Store.model().all().forEach(function (c) {
      var n = Core.speciesNumber(c.species);
      if (n) qty[n] = (qty[n] || 0) + c.qty;
    });
    return Object.keys(qty).map(Number).sort(function (a, b) { return qty[b] - qty[a] || a - b; }).slice(0, 40);
  }

  function renderMineSummary() {
    if (!current || !current.meta.mine) return;
    var byId = {};
    current.cards.forEach(function (c) { byId[c.id] = c; });
    var copies = Store.model().all();
    var priceOf = function (copy) { return byId[copy.card] ? byId[copy.card].price : null; };
    var stats = Core.totals(copies, priceOf);
    stats.priceOf = priceOf; // for the Breakdown and Top movers panels
    stats.priceTime = current.priceTime;
    stats.loading = !current.priceTime && current.cards.some(function (c) { return c.productId; });
    stats.unmatched = copies.reduce(function (n, c) { return n + (c.unmatched ? c.qty : 0); }, 0);
    Mine.renderSummary(stats);
  }

  function updateMineCount() {
    var n = Store.model().count();
    var chip = $("mine-count");
    if (chip) {
      chip.hidden = !n;
      chip.textContent = num(n);
    }
    var link = document.querySelector(".mine-link");
    if (link) link.setAttribute("aria-label", n ? t("nav.mineCount", { n: num(n) }) : t("nav.mine"));
  }

  function openMine() {
    var token = ++loadToken;
    mineDirty = false;
    closeSheet(true);
    closeDexCard(true);
    hideSuggest();
    setCoverMessage(null);
    pendingOpen = 0;
    titleName = "";
    if (binder) binder.destroy();
    binder = null;
    current = null;
    document.title = t("title.mine");
    if (history.replaceState) history.replaceState(null, "", "#" + MINE_KEY);
    loadFx().then(function () { if (token === loadToken) renderMineSummary(); });
    // The prices saved last time go on at once, so the binder opens sorted
    // by value; live ones follow.
    Promise.all([Store.ready, Store.readPrices()]).then(function (parts) {
      if (token !== loadToken) return;
      var numbers = mineSpeciesNumbers();
      mineThemeNo = numbers[0] || 0;
      paintSpritePrint(numbers.length ? numbers : 0);
      paintPokemonTheme(mineThemeNo);
      var saved = parts[1];
      current = {
        meta: { key: MINE_KEY, mine: true, name: t("mine.title"), number: 0 },
        cards: mineCards(),
        payloads: (saved && saved.payloads) || {},
        priced: 0,
        priceTime: saved && saved.updatedAt ? formatIstanbul(saved.updatedAt) : ""
      };
      current.cards.forEach(function (c) {
        c.price = applyPriceToCard(c, current.payloads, {});
        if (c.price) current.priced++;
      });
      scoreMineCards();
      mineDirty = false;
      paintResult();
      priceMine(token);
      reconcileMine(token);
    });
  }

  // Live prices for every card in My binder, kept for the next visit.
  function priceMine(token) {
    if (!current || !current.meta.mine) return;
    var ids = current.cards.map(function (c) { return c.productId; }).filter(Boolean);
    if (!ids.length) { renderMineSummary(); return; }
    var base = current.payloads || {};
    var t0 = Date.now();
    current.fetching = true;
    setStatus("status.fetching");
    renderMineSummary();
    fetchPrices(ids, function (partial, updatedAt) {
      if (token !== loadToken) return;
      applyFetchedPrices(Object.assign({}, base, partial), updatedAt, t0);
    }).then(function (result) {
      if (token !== loadToken || !current) return;
      current.fetching = false;
      var merged = Object.assign({}, base, result.prices);
      var summary = applyFetchedPrices(merged, result.updatedAt, t0);
      if (result.failed && summary) setStatus("status.partial", { n: summary.priced, time: summary.when }, true);
      var keep = {};
      ids.forEach(function (id) { if (merged[id]) keep[id] = merged[id]; });
      if (!Object.keys(result.prices).length) return;
      Store.writePrices(keep, result.updatedAt);
      // Today's price of each card goes into the history (one record a day).
      var todays = {};
      current.cards.forEach(function (c) { if (c.price && c.price.value > 0) todays[c.id] = c.price.value; });
      Mine.recordPrices(todays, fxRate);
    });
  }

  // A Breakdown row in My binder's summary: show only its cards. The other
  // filters are cleared so the binder holds exactly that row.
  function filterMineTo(kind, key) {
    if (!current || !current.meta.mine || !binder) return;
    closePicker(false);
    filterState.variants = {};
    filterState.species = {};
    filterState.set = "";
    filterState.query = "";
    filterState.hideReverse = false;
    document.querySelectorAll('#result .chip[data-filter="hide-reverse"]').forEach(function (chip) {
      chip.classList.remove("is-on");
      chip.setAttribute("aria-pressed", "false");
    });
    var input = $("filter");
    if (input) input.value = "";
    setLangs(kind === "lang" ? [key] : []);
    if (kind === "set") {
      filterState.set = key;
      if (input) input.value = key.split("|").slice(1).join("|");
    } else if (kind === "pokemon") {
      filterState.species[key] = true;
    }
    showCards(true);
    var wrap = document.querySelector("#result .binder-wrap");
    if (wrap) wrap.scrollIntoView({ block: "start", behavior: motionOff() ? "auto" : "smooth" });
  }

  // The collection changed: file the cards again, keeping the page and the
  // prices already fetched, and price any new product.
  function refileMine() {
    mineDirty = false;
    if (!current || !current.meta.mine) return;
    var payloads = current.payloads || {};
    var wasEmpty = !current.cards.length;
    current.cards = mineCards();
    current.cards.forEach(function (c) { c.price = applyPriceToCard(c, payloads, {}); });
    scoreMineCards();
    // The language tabs and the Pokémon picker follow the cards: a tab whose
    // last card went is hidden; a new language or a second Pokémon needs the
    // toolbar drawn again.
    var langs = uniqueValues(current.cards, "lang");
    var tabLangs = [];
    document.querySelectorAll('#result .chip[data-filter="lang"]').forEach(function (c) {
      var value = c.getAttribute("data-value");
      if (!value) return;
      tabLangs.push(value);
      c.hidden = langs.indexOf(value) === -1;
    });
    var redraw = langs.some(function (l) { return tabLangs.indexOf(l) === -1; }) ||
      (uniqueValues(current.cards, "species").length > 1) !== !!$("species-btn");
    if (wasEmpty !== !current.cards.length || (!binder && current.cards.length) || (binder && redraw)) {
      if (!current.cards.length) {
        setStatus(null);
        paintSpritePrint(0);
        paintPokemonTheme(0);
      }
      paintResult();
      priceMine(loadToken);
      return;
    }
    if (binder) setLangs(pickedLangs());
    if (binder) showCards(false);
    renderResultText();
    renderMineSummary();
    var missing = current.cards.filter(function (c) { return c.productId && !payloads[c.productId]; })
      .map(function (c) { return c.productId; });
    if (missing.length) {
      var token = loadToken;
      fetchPrices(missing).then(function (result) {
        if (token !== loadToken || !current) return;
        applyFetchedPrices(Object.assign({}, current.payloads, result.prices), result.updatedAt, 0);
      });
    }
  }

  // A Pokémon's file just loaded: keep your copies of its cards matched to it
  // (docs/COLLECTION-PLAN.md §5). Nothing is ever removed.
  function reconcileSpecies(data) {
    Store.ready.then(function () {
      var key = data && data.key;
      if (!key) return;
      var n = Number(data.number) || Core.speciesNumber(key);
      var copies = Store.model().all().filter(function (c) {
        return c.species === key || (n && Core.speciesNumber(c.species) === n);
      });
      if (!copies.length) return;
      var patches = Core.reconcile(copies, data);
      if (patches.length) Store.patch(patches);
    });
  }

  // After a catalog rebuild, check every Pokémon you own cards of, two files
  // at a time. The stamp is saved only when all of them were checked.
  var reconciling = false;
  function reconcileMine() {
    var stamp = catalogStamp;
    if (!stamp || reconciling || !speciesIndex.length || Store.model().doc.catalog === stamp) return;
    reconciling = true;
    var keys = [];
    Store.model().all().forEach(function (c) { if (keys.indexOf(c.species) === -1) keys.push(c.species); });
    var patches = [];
    var failed = false;
    var cursor = 0;
    function next() {
      if (cursor >= keys.length) return Promise.resolve();
      var key = keys[cursor++];
      var copies = Store.model().all().filter(function (c) { return c.species === key; });
      var item = Core.speciesFor(key, speciesIndex);
      if (!item) {
        copies.forEach(function (c) { if (!c.unmatched) patches.push({ uid: c.uid, fields: { unmatched: true } }); });
        return next();
      }
      return fetchSpeciesFile(item.key).then(function (data) {
        patches = patches.concat(Core.reconcile(copies, data));
      }).catch(function () { failed = true; }).then(next);
    }
    Promise.all([next(), next()]).then(function () {
      reconciling = false;
      if (patches.length || !failed) Store.patch(patches, failed ? "" : stamp);
    });
  }

  Store.onChange(function () {
    updateMineCount();
    if (!current) return;
    if (current.meta.mine) {
      // A card is out: re-file once it is back, so its pocket stays put.
      if (activeCard) {
        mineDirty = true;
        renderMineSummary();
        renderResultText();
        return;
      }
      refileMine();
    } else if (binder) {
      // Marks change in place. A card marked under Missing stays in its
      // pocket until the binder is next filtered, so pages don't jump.
      binder.refresh();
      renderProgress();
    }
  });

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

  var typingTimer = 0;

  function bindSearch() {
    var input = $("q");
    $("cover-search").addEventListener("submit", function (event) {
      event.preventDefault();
      // Enter straight after a keystroke: catch up with the matches first.
      if (typingTimer) { clearTimeout(typingTimer); typingTimer = 0; updateFromQuery(); }
      submitQuery();
    });
    document.querySelectorAll('[data-focus-search]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        if (!isHome()) { goHome(true); return; }
        $("search-cover").scrollIntoView({ block: 'center' });
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
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { typingTimer = 0; updateFromQuery(); }, 70);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); moveSuggest(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSuggest(-1); }
      else if (ev.key === "Escape") {
        // First Escape closes the list, the next one clears the field.
        if (listOpen) { ev.preventDefault(); closeList(); }
        else if (input.value) { ev.preventDefault(); input.value = ""; updateFromQuery(); }
      }
    });
    var head = input.closest(".cover-head");
    input.addEventListener("focus", function () {
      if (suggestItems.length) openList();
      // On a phone the keyboard takes the lower half of the screen: bring the
      // label and its list up to the top.
      if (window.matchMedia && window.matchMedia("(max-width: 700px)").matches) {
        setTimeout(function () {
          var top = $("search-cover").getBoundingClientRect().top;
          if (Math.abs(top - 10) > 4) window.scrollTo({ top: window.scrollY + top - 10, behavior: motionOff() ? "auto" : "smooth" });
        }, 280);
      }
    });
    input.addEventListener("blur", function () {
      setTimeout(function () { if (!head.contains(document.activeElement)) closeList(); }, 150);
    });
    // The list: point at a row to highlight it (and its sprites), click or tap to open.
    var list = $("suggest");
    list.addEventListener("mousedown", function (event) { event.preventDefault(); }); // keep focus in the field
    list.addEventListener("click", function (event) {
      var row = event.target.closest("[role=option]");
      if (row) pickSpecies(suggestItems[Number(row.getAttribute("data-i"))]);
    });
    list.addEventListener("pointermove", function (event) {
      if (event.pointerType === "touch") return;
      var row = event.target.closest("[role=option]");
      var i = row ? Number(row.getAttribute("data-i")) : -1;
      if (i >= 0 && i !== activeSuggest) setActiveSuggest(i);
    });
    // Every sprite on the cover is a way in: point at one to read its name (or
    // highlight its row), click or tap it for its info card. Clicking the same
    // sprite again puts the card away.
    var sprites = $("cover-sprites");
    sprites.addEventListener("click", function (event) {
      var el = event.target.closest(".cover-sprite");
      var item = el && speciesByNumber[el.getAttribute("data-n")];
      var cell = null;
      for (var i = 0; el && i < coverCells.length; i++) if (coverCells[i].el === el) cell = coverCells[i];
      if (!item || !cell) return;
      if (dexCell === cell) closeDexCard();
      else openDexCard(item, cell);
    });
    sprites.addEventListener("pointerover", function (event) {
      if (event.pointerType === "touch") return;
      var cell = event.target.closest(".cover-sprite");
      var item = (cell && speciesByNumber[cell.getAttribute("data-n")]) || null;
      var row = item && listOpen ? suggestItems.indexOf(item) : -1;
      if (row >= 0) {
        hoverItem = null;
        if (row !== activeSuggest) setActiveSuggest(row);
        return;
      }
      if (item !== hoverItem) { hoverItem = item; showActive(); }
    });
    sprites.addEventListener("pointerleave", function () {
      if (hoverItem) { hoverItem = null; showActive(); }
    });
  }

  /* ---- sprites ---- */

  var SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/";

  /* ---- the binder's sprite print ---- */

  // The binder fabric is printed with PokeAPI's pixel box icons in staggered
  // rows, like a pixel-pattern zip binder. One tile is drawn on a canvas and
  // set as --sprite-print for the open binder; a Pokémon's own binder is
  // printed with that Pokémon only.
  var ICON_BASE = SPRITE_BASE + "versions/generation-vii/icons/";
  var ICON_LAST = 807; // the icon set ends here; later Pokémon use their front sprite
  var DEX_LAST = 1025;
  // A fresh handful of Pokémon from every region on each visit: the fabric of
  // a binder before its Pokémon is known.
  var PRINT_CREW = randomCrew(40);
  // The search cover's usual print: every Pokémon in a new order on each visit,
  // so each sprite on it is a different one.
  var COVER_CREW = randomCrew(DEX_LAST);
  var COVER_SEED = (Math.random() * 4294967296) >>> 0;
  var PRINT_COLS = 8;
  var PRINT_ROWS = 8;
  var PRINT_CELL_W = 48;
  var PRINT_CELL_H = 42;
  var printIcons = {};
  var printToken = 0;
  var printUrl = "";

  function randomCrew(count) {
    var pool = [];
    for (var n = 1; n <= DEX_LAST; n++) pool.push(n);
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
    }
    return pool.slice(0, count);
  }

  function iconSrc(number) {
    return number <= ICON_LAST ? ICON_BASE + number + ".png" : SPRITE_BASE + number + ".png";
  }

  function loadIcon(number) {
    var src = iconSrc(number);
    if (!printIcons[src]) printIcons[src] = new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
    return printIcons[src];
  }

  // A repeatable random sequence, so each binder keeps the same print.
  function seededRandom(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function drawIcon(ctx, img, cx, cy, flip, scale) {
    var w = img.naturalWidth * scale;
    var h = img.naturalHeight * scale;
    ctx.save();
    ctx.translate(cx, cy);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // featured: one Pokémon's number, a list of them (My binder), or 0 for the
  // site's crew.
  function paintSpritePrint(featured) {
    var token = ++printToken;
    var numbers = Array.isArray(featured) ? featured : featured ? [featured] : PRINT_CREW;
    if (Array.isArray(featured)) featured = featured[0] || 0;
    Promise.all(numbers.map(loadIcon)).then(function (icons) {
      if (token !== printToken) return;
      var icon = {};
      numbers.forEach(function (n, i) { if (icons[i]) icon[n] = icons[i]; });
      var crew = numbers.filter(function (n) { return icon[n]; });
      if (!crew.length) { if (featured) paintSpritePrint(0); return; }
      var dpr = 2;
      var tileW = PRINT_COLS * PRINT_CELL_W;
      var tileH = PRINT_ROWS * PRINT_CELL_H;
      var canvas = document.createElement("canvas");
      canvas.width = tileW * dpr;
      canvas.height = tileH * dpr;
      var ctx = canvas.getContext("2d");
      var rand = seededRandom(featured || 151);
      var last = 0;
      for (var row = 0; row < PRINT_ROWS; row++) {
        for (var col = 0; col < PRINT_COLS; col++) {
          var pick = 0;
          while (!pick || (pick === last && crew.length > 1)) pick = crew[Math.floor(rand() * crew.length)];
          last = pick;
          var img = icon[pick];
          // Box icons are 40×30 pixel art: draw them 1:1 and crisp. A front sprite
          // (96 px) is reduced to about the same size instead.
          var big = img.naturalWidth > 48;
          ctx.imageSmoothingEnabled = big;
          var scale = dpr * (big ? 0.42 : 1);
          var cx = (col + 0.5 + (row % 2) * 0.5) * PRINT_CELL_W * dpr;
          var cy = (row + 0.5) * PRINT_CELL_H * dpr;
          var flip = rand() < 0.5;
          drawIcon(ctx, img, cx, cy, flip, scale);
          if (cx + img.naturalWidth * scale / 2 > canvas.width) drawIcon(ctx, img, cx - canvas.width, cy, flip, scale);
        }
      }
      canvas.toBlob(function (blob) {
        if (!blob || token !== printToken) return;
        var old = printUrl;
        printUrl = URL.createObjectURL(blob);
        var root = document.documentElement.style;
        root.setProperty("--sprite-print", 'url("' + printUrl + '")');
        root.setProperty("--sprite-print-size", tileW + "px " + tileH + "px");
        if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 3000);
      });
    });
  }

  /* ---- a Pokémon's own colour ---- */

  function toHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (!d) return [0, 0, l];
    var s = d / (1 - Math.abs(2 * l - 1));
    var h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function fromHsl(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(function (v) { return Math.round((v + m) * 255); });
  }

  function spritePixels(img) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    if (!w || !h) return null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return null; // a sprite served without CORS can't be read
    }
  }

  // The colour a Pokémon is known by, read from its sprite: the most common
  // hue (with its neighbours, so shading counts too), skipping the ink outline
  // and greys unless the Pokémon is mostly grey or white. It is lifted so it
  // reads on the charcoal binder. Returns "r g b" for rgb(), or "".
  var spriteColors = {};
  function spriteColor(img) {
    var key = img && (img.currentSrc || img.src);
    if (!key) return "";
    if (spriteColors[key] != null) return spriteColors[key];
    var data = spritePixels(img);
    if (!data) return "";
    var HUES = 18;
    var bins = [];
    for (var b = 0; b < HUES; b++) bins.push({ n: 0, r: 0, g: 0, b: 0 });
    var grey = { n: 0, r: 0, g: 0, b: 0 };
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      var hsl = toHsl(data[i], data[i + 1], data[i + 2]);
      if (hsl[2] < 0.14) continue;
      var bin = hsl[1] < 0.2 || hsl[2] > 0.93 ? grey : bins[Math.floor(hsl[0] / (360 / HUES)) % HUES];
      bin.n++;
      bin.r += data[i];
      bin.g += data[i + 1];
      bin.b += data[i + 2];
    }
    var best = -1;
    var bestScore = 0;
    bins.forEach(function (bin, k) {
      var score = bin.n + 0.5 * (bins[(k + HUES - 1) % HUES].n + bins[(k + 1) % HUES].n);
      if (score > bestScore) { bestScore = score; best = k; }
    });
    var pick = { n: 0, r: 0, g: 0, b: 0 };
    if (best >= 0) [best - 1, best, best + 1].forEach(function (k) {
      var bin = bins[(k + HUES) % HUES];
      pick.n += bin.n; pick.r += bin.r; pick.g += bin.g; pick.b += bin.b;
    });
    var isGrey = pick.n < grey.n * 0.4;
    if (isGrey) pick = grey;
    if (!pick.n) return (spriteColors[key] = "");
    var c = toHsl(pick.r / pick.n, pick.g / pick.n, pick.b / pick.n);
    var rgb = isGrey
      ? fromHsl(c[0], Math.min(c[1], 0.12), Math.min(0.84, Math.max(0.64, c[2])))
      : fromHsl(c[0], Math.max(c[1], 0.5), Math.min(0.7, Math.max(0.52, c[2])));
    return (spriteColors[key] = rgb.join(" "));
  }

  // The sprite cut to its drawn pixels, for the page slider's thumb: box icons
  // grow in whole steps so their pixels stay square, front sprites (after
  // #807) are scaled smoothly. Drawn facing right (forwards) and left.
  function thumbSprite(img) {
    var data = spritePixels(img);
    if (!data) return null;
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] < 24) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    var cw = x1 - x0 + 1;
    var ch = y1 - y0 + 1;
    var pixel = w <= 48;
    var MAX_W = 54;
    var MAX_H = 42;
    var k = pixel
      ? [2, 1.5, 1].filter(function (s) { return cw * s <= MAX_W && ch * s <= MAX_H; })[0] || 1
      : Math.min(1, MAX_W / cw, MAX_H / ch);
    var dpr = 2;
    var draw = function (flip) {
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(cw * k * dpr);
      canvas.height = Math.round(ch * k * dpr);
      var ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = !pixel;
      if (flip) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(img, x0, y0, cw, ch, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    };
    // Box icons look left, so the forward-walking one is the mirrored copy.
    return { right: draw(true), left: draw(false), w: Math.round(cw * k), h: Math.round(ch * k), pixel: pixel };
  }

  // A binder takes its Pokémon's colour (--poke-rgb) and puts the Pokémon on
  // its page slider (--scrub-sprite).
  var THEME_PROPS = ["--poke-rgb", "--scrub-sprite", "--scrub-sprite-back", "--scrub-sprite-size", "--scrub-sprite-y", "--scrub-render"];
  var themeToken = 0;
  function paintPokemonTheme(number) {
    var token = ++themeToken;
    var root = document.documentElement.style;
    THEME_PROPS.forEach(function (name) { root.removeProperty(name); });
    if (!number) return;
    loadIcon(number).then(function (img) {
      if (token !== themeToken || !img) return;
      var rgb = spriteColor(img);
      if (rgb) root.setProperty("--poke-rgb", rgb);
      var sprite = thumbSprite(img);
      if (!sprite) return;
      root.setProperty("--scrub-sprite", 'url("' + sprite.right + '")');
      root.setProperty("--scrub-sprite-back", 'url("' + sprite.left + '")');
      root.setProperty("--scrub-sprite-size", sprite.w + "px " + sprite.h + "px");
      root.setProperty("--scrub-sprite-y", (44 - sprite.h) + "px"); // feet on the bar
      root.setProperty("--scrub-render", sprite.pixel ? "pixelated" : "auto");
    });
  }

  /* ---- the search cover's sprites ---- */

  // The search cover is printed with real <img> sprites rather than the canvas
  // tile, so each one can change, hop and be picked on its own.
  var COVER_CELL_W = 54;
  var COVER_CELL_H = 46;
  var COVER_LABEL = { x: 0.535, y: 0.14 }; // where the search label sits; changes ripple out from here
  var coverCells = [];
  var coverShape = "";
  var coverNumbers = [];
  var coverFill = 0;
  var activeNumber = 0;

  function motionOff() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Staggered rows across the whole cover. Odd rows carry a sprite cut in half
  // at each edge, as on printed fabric. Returns true when the cells were rebuilt.
  function layoutCover() {
    var host = $("cover-sprites");
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return false;
    var cols = Math.max(5, Math.round(w / COVER_CELL_W));
    var rows = Math.max(6, Math.round(h / COVER_CELL_H));
    // The label sits in a pocket sewn into the cover, and the print stops
    // around it rather than running underneath.
    var pocket = document.querySelector(".cover-head");
    var gap = 10; // clear of the stitching
    var hole = pocket ? {
      left: pocket.offsetLeft - gap,
      top: pocket.offsetTop - gap,
      right: pocket.offsetLeft + pocket.offsetWidth + gap,
      bottom: pocket.offsetTop + pocket.offsetHeight + gap
    } : null;
    var shape = cols + "x" + rows + (hole ? ":" + [hole.left, hole.top, hole.right, hole.bottom].map(Math.round).join(",") : "");
    if (shape === coverShape) return false;
    coverShape = shape;
    var rand = seededRandom(COVER_SEED);
    var cells = [];
    for (var r = 0; r < rows; r++) {
      var shift = r % 2 ? 0.5 : 0;
      for (var c = shift ? -1 : 0; c < cols; c++) {
        var cx = (c + 0.5 + shift) / cols;
        var cy = (r + 0.5) / rows;
        var flip = rand() < 0.5;
        if (hole && cx * w + 20 > hole.left && cx * w - 20 < hole.right && cy * h + 15 > hole.top && cy * h - 15 < hole.bottom) continue;
        cells.push({ x: cx, y: cy, row: r, flip: flip, number: 0, want: 0 });
      }
    }
    var far = 0;
    cells.forEach(function (cell) {
      cell.dist = Math.sqrt(Math.pow(cell.x - COVER_LABEL.x, 2) + Math.pow((cell.y - COVER_LABEL.y) * h / w, 2));
      far = Math.max(far, cell.dist);
    });
    host.innerHTML = cells.map(function (cell) {
      return '<span class="cover-sprite' + (cell.flip ? " is-flip" : "") + '" style="left:' + (cell.x * 100).toFixed(3) +
        "%;top:" + (cell.y * 100).toFixed(3) + "%;--wave:" + (cell.dist / far).toFixed(3) +
        '"><img alt="" width="40" height="30" draggable="false" crossorigin="anonymous"></span>';
    }).join("");
    var els = host.children;
    cells.forEach(function (cell, i) {
      cell.el = els[i];
      cell.img = els[i].firstChild;
      cell.reach = cell.dist / far;
      // The sprites touching this one from the row above, so the print never
      // stacks a Pokémon on itself.
      cell.up = [];
      for (var j = i - 1; j >= 0 && cells[j].row >= cell.row - 1; j--) {
        if (cells[j].row === cell.row - 1 && Math.abs(cells[j].x - cell.x) < 0.6 / cols) cell.up.push(j);
      }
    });
    coverCells = cells;
    return true;
  }

  // Which Pokémon goes on each sprite. With enough of them to go round (the
  // usual print, a broad search) each appears once; otherwise they repeat, but
  // never next to themselves.
  function planCover(numbers) {
    var rand = seededRandom(numbers.reduce(function (s, n) { return (Math.imul(s, 31) + n) >>> 0; }, 17));
    var unique = numbers.filter(function (n, i) { return numbers.indexOf(n) === i; });
    if (unique.length >= coverCells.length) {
      for (var k = unique.length - 1; k > 0; k--) {
        var j = Math.floor(rand() * (k + 1));
        var swap = unique[k];
        unique[k] = unique[j];
        unique[j] = swap;
      }
      return unique.slice(0, coverCells.length);
    }
    var plan = [];
    coverCells.forEach(function (cell, i) {
      var avoid = cell.up.map(function (j) { return plan[j]; });
      if (i > 0 && coverCells[i - 1].row === cell.row) avoid.push(plan[i - 1]);
      var pick;
      var tries = 0;
      do { pick = numbers[Math.floor(rand() * numbers.length)]; } while (avoid.indexOf(pick) >= 0 && ++tries < 8);
      plan.push(pick);
    });
    return plan;
  }

  function setSprite(cell, number) {
    cell.number = cell.want = number;
    cell.el.setAttribute("data-n", number);
    cell.el.classList.toggle("is-active", !!activeNumber && number === activeNumber);
    cell.img.classList.toggle("is-big", number > ICON_LAST);
    cell.img.src = iconSrc(number);
  }

  // Shrink the old sprite away and pop the new one in, after `delay` ms.
  function swapSprite(cell, number, animate, delay) {
    if (cell.want === number) return;
    if (cell.anim) { cell.anim.cancel(); cell.anim = null; }
    var img = cell.img;
    if (!animate || !img.animate) { setSprite(cell, number); return; }
    var popIn = function (wait) {
      setSprite(cell, number);
      cell.anim = img.animate([
        { transform: "scale(0)" },
        { transform: "scale(1.3)", offset: 0.6 },
        { transform: "scale(1)" }
      ], { duration: 260, delay: wait || 0, easing: "ease-out", fill: "backwards" });
    };
    // An empty cell takes its sprite at once and pops in on its turn.
    if (!cell.number) { popIn(delay); return; }
    cell.want = number;
    var out = cell.anim = img.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }],
      { duration: 120, delay: delay, easing: "ease-in", fill: "forwards" });
    out.onfinish = function () {
      if (cell.want !== number) return;
      popIn();
      out.cancel();
    };
  }

  // Print the cover with these Pokémon. Each sprite changes as soon as its icon
  // has loaded (so none pops in blank), keeping its place in the ripple.
  // Resolves once every icon is in and the change has played.
  function fillCover(numbers, opts) {
    var token = ++coverFill;
    coverNumbers = numbers.slice();
    layoutCover();
    $("search-cover").classList.remove("is-empty");
    var animate = !!(opts && opts.ripple) && !motionOff();
    var started = Date.now();
    var plan = planCover(numbers);
    coverCells.forEach(function (cell, i) {
      var n = plan[i];
      loadIcon(n).then(function (img) {
        if (token !== coverFill || !img) return;
        var delay = Math.max(0, started + Math.round(cell.reach * 260) - Date.now());
        swapSprite(cell, n, animate, delay);
      });
    });
    var used = plan.filter(function (n, i) { return plan.indexOf(n) === i; });
    return Promise.all(used.map(loadIcon)).then(function () {
      return animate && token === coverFill ? wait(Math.max(0, started + 640 - Date.now()) + 120) : null;
    });
  }

  function markActiveSprites(number) {
    activeNumber = Number(number) || 0;
    coverCells.forEach(function (cell) {
      cell.el.classList.toggle("is-active", !!activeNumber && cell.number === activeNumber);
    });
  }

  // The pick: every sprite turns into the chosen Pokémon, they all jump, and the
  // cover waits (peeking) for the binder's cards.
  function turnCoverInto(item, animate) {
    var cover = $("search-cover");
    animate = animate && !motionOff();
    cover.classList.remove("is-empty", "is-loading", "is-picked");
    setCoverMessage("binder.loading");
    var n = Number(item.number) || 0;
    var swap = n ? fillCover([n], { ripple: animate }) : Promise.resolve();
    return swap.then(function () {
      if (!animate) { cover.classList.add("is-loading"); return; }
      cover.classList.add("is-picked");
      return wait(460).then(function () { cover.classList.add("is-loading"); });
    });
  }

  // Re-lay the cover when its size changes; and now and then let one sprite hop.
  function watchCover() {
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (layoutCover()) {
          closeDexCard(true); // its sprite is gone
          if (coverNumbers.length) fillCover(coverNumbers, { ripple: false });
        } else {
          placeDexCard();
        }
      }).observe($("cover-sprites"));
    }
    setInterval(function () {
      if (!isHome() || document.hidden || motionOff() || activeNumber || !coverCells.length) return;
      var cell = coverCells[Math.floor(Math.random() * coverCells.length)];
      if (cell.el.animate) cell.el.animate([
        { translate: "0 0" }, { translate: "0 -7px", offset: 0.4 }, { translate: "0 0" }
      ], { duration: 450, easing: "ease-out" });
    }, 650);
  }

  /* ---- the cover's info card ---- */

  // Clicking a sprite on the cover opens a card about that Pokémon's trading
  // cards, laid out like a game's summary screen: its in-game sprite, its first
  // and newest cards with their release dates, how many printings came out each
  // year, its sets and languages, and a button that opens its binder. A yellow
  // line runs from the card to the sprite. The facts come from the catalog file
  // the binder loads, so opening the binder from the card reuses it.
  var BW_LAST = 649; // Black and White's animated battle sprites end here
  var speciesFiles = {};
  var dexFacts = {};
  var portraitFits = {};
  var dexItem = null;
  var dexCell = null;
  var dexSide = "right"; // the card's edge the line meets
  var dexAnims = [];
  var dexClosing = null;

  function fetchSpeciesFile(key) {
    if (!speciesFiles[key]) {
      var load = speciesFiles[key] = fetch("data/" + encodeURIComponent(key) + ".json", { cache: "default" }).then(function (res) {
        if (!res.ok) throw new Error("data " + res.status);
        return res.json();
      });
      load.catch(function () { if (speciesFiles[key] === load) delete speciesFiles[key]; });
    }
    return speciesFiles[key];
  }

  function langRank(code) { return LANG_ORDER[code] != null ? LANG_ORDER[code] : 9; }

  // The year each generation's games came out in Japan, by last National Dex
  // number.
  var GEN_START = [[151, 1996], [251, 1999], [386, 2002], [493, 2006], [649, 2010], [721, 2013], [809, 2016], [905, 2019], [1025, 2022]];

  function hasDate(c) { return /^\d{4}-\d\d-\d\d$/.test(c.released || ""); }

  // A card up to a year before its Pokémon's games is kept: some Pokémon were
  // on cards (movie packs) before their games came out. Earlier than that the
  // date is a placeholder.
  function plausibleDate(c, number) {
    var year = Number(c.released.slice(0, 4));
    for (var i = 0; i < GEN_START.length; i++) {
      if (number <= GEN_START[i][0]) return year >= GEN_START[i][1] - 1;
    }
    return true;
  }

  // Promo sets give most of their cards the set's start date (a 2023 Pokémon
  // dated 2001 in "Unnumbered Promos"), so the dates come from the other sets,
  // falling back to promos and then to any dated card.
  function datedCards(all, number) {
    var dated = all.filter(hasDate);
    var plausible = dated.filter(function (c) { return plausibleDate(c, number); });
    var sets = plausible.filter(function (c) { return !/promo/i.test(c.setName || c.set || ""); });
    return sets.length ? sets : plausible.length ? plausible : dated;
  }

  // First and newest printing (on a shared date, English first), printings per
  // year, sets and languages. Totals count every card; the dates and the chart
  // use datedCards().
  function cardFacts(data, item) {
    var all = data.cards || [];
    var trusted = datedCards(all, Number(data.number || item.number) || 0);
    var first = null;
    var newest = null;
    var years = {};
    var sets = {};
    var langs = {};
    all.forEach(function (c) {
      sets[(c.lang || "") + "|" + (c.setName || c.set || "")] = true;
      if (c.lang) langs[c.lang] = (langs[c.lang] || 0) + 1;
    });
    trusted.forEach(function (c) {
      var year = Number(c.released.slice(0, 4));
      years[year] = (years[year] || 0) + 1;
      if (!first || c.released < first.released || (c.released === first.released && langRank(c.lang) < langRank(first.lang))) first = c;
      if (!newest || c.released > newest.released || (c.released === newest.released && langRank(c.lang) < langRank(newest.lang))) newest = c;
    });
    return {
      first: first,
      newest: newest,
      firstYear: first ? Number(first.released.slice(0, 4)) : 0,
      lastYear: newest ? Number(newest.released.slice(0, 4)) : 0,
      years: years,
      sets: Object.keys(sets).length,
      langs: Object.keys(langs).sort(function (a, b) { return langRank(a) - langRank(b); }).map(function (code) {
        return { code: code, n: langs[code] };
      }),
      printings: all.length,
      cards: (data.counts && data.counts.cards) || item.cards || 0
    };
  }

  function cardDate(iso) {
    var p = iso.split("-");
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])))
      .toLocaleDateString(i18n.locale(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  function portraitSrc(n) {
    return n <= BW_LAST ? SPRITE_BASE + "versions/generation-v/black-white/animated/" + n + ".gif" : SPRITE_BASE + n + ".png";
  }

  // In-game sprites come in very different sizes (a Joltik is a speck, a
  // Wailord fills its frame). Measure the drawn part of the first frame and
  // scale every Pokémon to fill the plate about the same.
  function fitPortrait(img) {
    var box = img.parentNode.clientWidth || 96;
    var key = img.currentSrc || img.src;
    var fit = portraitFits[key];
    if (!fit) {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var x0 = w, y0 = h, x1 = -1, y1 = -1;
      try {
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        var px = ctx.getImageData(0, 0, w, h).data;
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            if (px[(y * w + x) * 4 + 3] > 24) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
      } catch (err) {
        x1 = -1; // the image could not be read; show it whole
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
      fit = portraitFits[key] = { w: w, h: h, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, size: Math.max(x1 - x0 + 1, y1 - y0 + 1) };
    }
    var scale = Math.min(3, box * 0.76 / fit.size);
    img.style.width = fit.w * scale + "px";
    img.style.height = fit.h * scale + "px";
    img.style.left = box / 2 - fit.cx * scale + "px";
    img.style.top = box / 2 - fit.cy * scale + "px";
    img.classList.add("is-fitted");
  }

  function watchPortrait(img) {
    var n = Number(img.getAttribute("data-n"));
    img.addEventListener("load", function () { fitPortrait(img); });
    img.addEventListener("error", function () {
      // The animated sprite, then the still one, then the box icon.
      var next = img.src.slice(-4) === ".gif" ? SPRITE_BASE + n + ".png" : img.src !== iconSrc(n) ? iconSrc(n) : "";
      if (next) img.src = next;
    });
    if (img.complete && img.naturalWidth) fitPortrait(img);
  }

  function dexSkeleton() {
    var print = '<figure class="dex-print"><span class="dex-thumb"></span><figcaption><span class="dex-line"></span><span class="dex-line"></span><span class="dex-line is-short"></span></figcaption></figure>';
    var bars = "";
    for (var i = 0; i < 14; i++) bars += '<span class="dex-year" style="--h:' + (0.25 + 0.5 * Math.abs(Math.sin(i * 1.7))).toFixed(2) + '"></span>';
    return '<div class="dex-prints">' + print + print + '</div><span class="dex-section dex-line is-short"></span>' +
      '<div class="dex-chart is-loading">' + bars + '</div><div class="dex-axis"><span class="dex-line is-tiny"></span><span class="dex-line is-tiny"></span></div>' +
      '<p class="dex-facts"><span class="dex-line"></span></p><p class="dex-langs"><span class="dex-line is-short"></span></p>';
  }

  function dexBodyHtml(facts) {
    if (facts === false) return '<p class="dex-note">' + escapeHtml(t("dex.missing")) + "</p>";
    if (!facts) return dexSkeleton();
    if (!facts.first) return '<p class="dex-note">' + escapeHtml(t("dex.none")) + "</p>";
    var shown = facts.newest && facts.newest !== facts.first ? [["dex.first", facts.first], ["dex.newest", facts.newest]] : [["dex.first", facts.first]];
    var prints = shown.map(function (entry) {
      var c = entry[1];
      return '<figure class="dex-print">' +
        (c.image ? '<img class="dex-thumb" src="' + escapeHtml(c.image) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<span class="dex-thumb"></span>') +
        '<figcaption><span class="dex-section">' + escapeHtml(t(entry[0])) + '</span><span class="dex-set">' + escapeHtml(c.setName || c.set || "") +
        '</span><span class="dex-when">' + escapeHtml((c.cardNumber ? c.cardNumber + " · " : "") + cardDate(c.released) + " · " + t("cardlang." + c.lang)) + "</span></figcaption></figure>";
    }).join("");
    var max = 0;
    var year;
    for (year = facts.firstYear; year <= facts.lastYear; year++) max = Math.max(max, facts.years[year] || 0);
    var bars = "";
    for (year = facts.firstYear; year <= facts.lastYear; year++) {
      var n = facts.years[year] || 0;
      bars += '<span class="dex-year' + (n === max ? " is-peak" : "") + '" style="--h:' + (n / max).toFixed(3) + '" title="' +
        escapeHtml(t("dex.chart", { year: year, n: num(n) })) + '"></span>';
    }
    return '<div class="dex-prints">' + prints + "</div>" +
      '<p class="dex-section">' + escapeHtml(t("dex.years")) + "</p>" +
      '<div class="dex-chart" aria-hidden="true">' + bars + "</div>" +
      '<div class="dex-axis" aria-hidden="true"><span>' + facts.firstYear + "</span><span>" + facts.lastYear + "</span></div>" +
      '<p class="dex-facts">' + escapeHtml(countText("count.cards", facts.cards) + " · " + countText("count.printings", facts.printings) + " · " + countText("dex.sets", facts.sets)) + "</p>" +
      '<p class="dex-langs">' + facts.langs.map(function (l) {
        return '<span class="dex-lang" title="' + escapeHtml(t("cardlang." + l.code)) + '">' + escapeHtml(l.code) + " <b>" + num(l.n) + "</b></span>";
      }).join("") + "</p>";
  }

  function renderDexCard() {
    var item = dexItem;
    if (!item) return;
    var n = Number(item.number) || 0;
    var facts = dexFacts[item.key];
    var card = $("dex-card");
    card.innerHTML = '<button type="button" class="dex-close" data-dex-close aria-label="' + escapeHtml(t("dex.close")) + '">&times;</button>' +
      '<div class="dex-top"><span class="dex-portrait">' +
      (n ? '<img alt="" draggable="false" crossorigin="anonymous" data-n="' + n + '" src="' + portraitSrc(n) + '">' : "") +
      '</span><div class="dex-id"><p class="dex-no">' + escapeHtml(t("dex.no", { n: String(n).padStart(3, "0") })) + "</p>" +
      '<h2 class="dex-name" id="dex-name">' + escapeHtml(item.name) + "</h2>" +
      '<p class="dex-since" data-dex-since>' + (facts && facts.firstYear ? escapeHtml(t("dex.since", { year: facts.firstYear })) : "&nbsp;") + "</p></div></div>" +
      '<div class="dex-body" data-dex-body>' + dexBodyHtml(facts) + "</div>" +
      '<button type="button" class="dex-open" data-dex-open>' + escapeHtml(t("dex.open", { name: item.name })) +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12h13m-5-6 6 6-6 6"/></svg></button>';
    card.setAttribute("aria-label", t("dex.label", { name: item.name }));
    var img = card.querySelector(".dex-portrait img");
    if (img) watchPortrait(img);
  }

  // The card's facts arrived: swap the placeholder rows for them.
  function fillDexBody(facts) {
    var card = $("dex-card");
    var body = card.querySelector("[data-dex-body]");
    if (!body) return;
    body.innerHTML = dexBodyHtml(facts);
    card.querySelector("[data-dex-since]").innerHTML = facts && facts.firstYear ? escapeHtml(t("dex.since", { year: facts.firstYear })) : "&nbsp;";
    placeDexCard();
    if (motionOff()) return;
    play(body, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    [].forEach.call(body.querySelectorAll(".dex-year"), function (bar, i) {
      play(bar, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 320, delay: 60 + i * 14, easing: "cubic-bezier(.2,.8,.25,1)", fill: "backwards" });
    });
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

  // Beside the binder when there is room on its left, the line leaving the
  // sprite for the card's right edge; otherwise over the cover, under or above
  // the sprite. The line's points start at the sprite.
  function placeDexCard() {
    var card = $("dex-card");
    var link = $("dex-link");
    if (!dexItem || !dexCell) return;
    if (!dexCell.el.isConnected) { closeDexCard(true); return; }
    var hero = $("explore").getBoundingClientRect();
    var cover = $("search-cover").getBoundingClientRect();
    var sprite = dexCell.el.getBoundingClientRect();
    var sx = sprite.left + sprite.width / 2 - hero.left;
    var sy = sprite.top + sprite.height / 2 - hero.top;
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var gap = 34;
    var left, top, line;
    var coverLeft = cover.left - hero.left;
    if (coverLeft - gap - w >= 0) {
      dexSide = "right";
      left = coverLeft - gap - w;
      top = clamp(sy - h / 2, 0, Math.max(0, hero.height - h));
      var y = clamp(sy, top + 22, top + h - 22);
      var bend = left + w + gap / 2;
      // Sprites in the edge columns hang past the cover and are half hidden;
      // the cable then starts at the cover's edge, by the half that shows.
      var start = Math.max(sprite.left, cover.left) - hero.left - 6;
      line = y === sy ? [[start, sy], [left + w, y]] : [[start, sy], [bend, sy], [bend, y], [left + w, y]];
    } else {
      left = clamp(sx - w / 2, cover.left - hero.left + 8, cover.right - hero.left - 8 - w);
      var below = sprite.top - cover.top < cover.height * 0.45;
      dexSide = below ? "top" : "bottom";
      top = below ? sy + sprite.height / 2 + 18 : sy - sprite.height / 2 - 18 - h;
      var tx = clamp(sx, cover.left - hero.left + 12, cover.right - hero.left - 12);
      var x = clamp(tx, left + 22, left + w - 22);
      var edge = below ? top : top + h;
      var tip = below ? sy + sprite.height / 2 + 6 : sy - sprite.height / 2 - 6;
      line = x === tx ? [[tx, tip], [x, edge]] : [[tx, tip], [tx, (edge + tip) / 2], [x, (edge + tip) / 2], [x, edge]];
    }
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
    var points = line.map(function (p) { return Math.round(p[0]) + "," + Math.round(p[1]); }).join(" ");
    link.setAttribute("viewBox", "0 0 " + Math.round(hero.width) + " " + Math.round(hero.height));
    link.querySelectorAll("polyline").forEach(function (poly) { poly.setAttribute("points", points); });
  }

  function play(el, frames, opts) {
    if (!el || !el.animate) return null;
    var anim = el.animate(frames, opts);
    dexAnims.push(anim);
    return anim;
  }

  function stopDexAnims() {
    dexAnims.forEach(function (anim) { anim.cancel(); });
    dexAnims = [];
  }

  // The cable draws itself out of the sprite, then the light starts running
  // along it and the plug appears on the card.
  function drawDexLink(duration, delay) {
    var link = $("dex-link");
    var polys = link.querySelectorAll(".dex-link-halo, .dex-link-edge, .dex-link-line, .dex-link-shine");
    // The socket shows at once; the plug and the pulses once the cable is in.
    link.querySelectorAll(".dex-link-glint, .dex-link-spark, .dex-link-plug").forEach(function (el) {
      play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: (delay || 0) + duration, fill: "backwards" });
    });
    var pts = polys[0].getAttribute("points").split(" ").map(function (p) { return p.split(",").map(Number); });
    var length = 0;
    for (var i = 1; i < pts.length; i++) length += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    polys.forEach(function (poly) {
      poly.style.strokeDasharray = length + 8 + " " + (length + 8);
      var anim = play(poly, [{ strokeDashoffset: length + 8 }, { strokeDashoffset: 0 }], { duration: duration, delay: delay || 0, easing: "cubic-bezier(.4,0,.2,1)", fill: "backwards" });
      var done = function () { poly.style.strokeDasharray = ""; };
      if (anim) { anim.onfinish = done; anim.oncancel = done; } else done();
    });
  }

  // The card opens out of the edge the line meets, and its rows follow.
  function revealDexCard() {
    var card = $("dex-card");
    var from = { right: "inset(0 0 0 100%)", top: "inset(0 0 100% 0)", bottom: "inset(100% 0 0 0)" }[dexSide];
    var shift = { right: "translateX(10px)", top: "translateY(-8px)", bottom: "translateY(8px)" }[dexSide];
    play(card, [{ clipPath: from }, { clipPath: "inset(-14px)" }], { duration: 300, delay: 120, easing: "cubic-bezier(.2,.85,.25,1)", fill: "backwards" });
    [].forEach.call(card.querySelectorAll(".dex-top, .dex-body > *, .dex-open"), function (row, i) {
      play(row, [{ opacity: 0, transform: shift }, { opacity: 1, transform: "none" }], { duration: 260, delay: 190 + i * 35, easing: "cubic-bezier(.2,.8,.25,1)", fill: "backwards" });
    });
  }

  function openDexCard(item, cell) {
    if (!item || !cell) return;
    var card = $("dex-card");
    if (dexClosing) { dexClosing.cancel(); dexClosing = null; }
    var switching = !!dexItem && !card.hidden;
    var oldLeft = card.offsetLeft;
    var oldTop = card.offsetTop;
    stopDexAnims();
    if (dexCell && dexCell !== cell) dexCell.el.classList.remove("is-chosen");
    dexItem = item;
    dexCell = cell;
    cell.el.classList.remove("is-chosen");
    var glow = spriteColor(cell.img);
    if (glow) cell.el.style.setProperty("--glow", glow);
    $("dex-link").style.setProperty("--glow", glow || "255 248 214"); // the cable's pulses
    void cell.el.offsetWidth; // restart the cursor's snap
    cell.el.classList.add("is-chosen");
    $("explore").classList.add("has-dex");
    renderDexCard();
    card.hidden = false;
    $("dex-link").classList.add("is-on");
    placeDexCard();
    if (!motionOff()) {
      if (switching) {
        // Already open: glide to the new sprite and swap the contents.
        var dx = oldLeft - card.offsetLeft;
        var dy = oldTop - card.offsetTop;
        if (Math.abs(dx) + Math.abs(dy) > 1) play(card, [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.25,1)" });
        play(card.querySelector(".dex-top"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
        play(card.querySelector("[data-dex-body]"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 40, easing: "ease-out", fill: "backwards" });
        drawDexLink(200, 160);
      } else {
        drawDexLink(170, 0);
        revealDexCard();
      }
    }
    var rect = card.getBoundingClientRect();
    if (rect.bottom > window.innerHeight || rect.top < 0) card.scrollIntoView({ block: "nearest", behavior: motionOff() ? "auto" : "smooth" });
    if (dexFacts[item.key]) return;
    fetchSpeciesFile(item.key).then(function (data) {
      dexFacts[item.key] = cardFacts(data, item);
      if (dexItem === item) fillDexBody(dexFacts[item.key]);
    }, function (err) {
      console.warn(err);
      if (dexItem === item) fillDexBody(false);
    });
  }

  // Put the card away: a quick fade, or at once when the page is changing.
  function closeDexCard(quick) {
    if (!dexItem) return;
    dexItem = null;
    if (dexCell) dexCell.el.classList.remove("is-chosen");
    dexCell = null;
    $("explore").classList.remove("has-dex");
    stopDexAnims();
    var card = $("dex-card");
    var link = $("dex-link");
    var hide = function () {
      card.hidden = true;
      link.classList.remove("is-on");
    };
    if (quick || motionOff() || !card.animate) { hide(); return; }
    var out = dexClosing = card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.985)" }], { duration: 140, easing: "ease-in" });
    link.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-in" });
    out.onfinish = function () {
      if (dexClosing !== out) return;
      dexClosing = null;
      hide();
    };
  }

  function bindDexCard() {
    var card = $("dex-card");
    card.addEventListener("click", function (event) {
      if (event.target.closest("[data-dex-close]")) { closeDexCard(); return; }
      if (event.target.closest("[data-dex-open]")) {
        var item = dexItem;
        closeDexCard(true);
        pickSpecies(item);
      }
    });
    // A click anywhere else puts the card away (a sprite opens its own instead).
    document.addEventListener("pointerdown", function (event) {
      if (!dexItem || card.contains(event.target) || event.target.closest(".cover-sprite")) return;
      closeDexCard();
    });
    window.addEventListener("resize", placeDexCard);
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
    document.title = current && current.meta.mine ? t("title.mine") : titleName ? t("title.species", { name: titleName }) : t("title.home");
    if (current && current.meta.mine) current.meta.name = t("mine.title");
    renderStatus();
    updateMineCount();
    Mine.relabel();
    renderMineSummary();
    renderCatalogCounts();
    renderResultText();
    renderFooter();
    if (binder) {
      binder.updateNav();
      binder.refresh();
    }
    if (activeCard) {
      fillSheetText(activeCard);
      fillSites(activeCard);
    }
    if (binder) syncPickers();
    if (suggestItems.length) showSuggest($("q").value.trim(), true);
    else showActive();
    if (dexItem) { renderDexCard(); placeDexCard(); }
  }

  function boot() {
    bindSearch();
    bindDexCard();
    fillCover(COVER_CREW, { ripple: true });
    showActive();
    watchCover();
    i18n.onChange(relabel);
    Mine.init({ fxRate: function () { return fxRate; }, speciesName: speciesName, filterTo: filterMineTo });
    Store.ready.then(updateMineCount);
    document.addEventListener("click", function (ev) {
      var link = ev.target.closest && ev.target.closest("[data-open-mine]");
      if (!link || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      if (current && current.meta.mine) $("result").scrollIntoView({ block: "start" });
      else openMine();
    });
    // My binder needs no catalog to open.
    if (isMineHash(location.hash)) openMine();
    setStatus(isMineHash(location.hash) ? null : "status.catalog");
    fetch("data/index.json").then(function (res) {
      if (!res.ok) throw new Error("index " + res.status);
      return res.json();
    }).then(function (data) {
      catalogStamp = data.updated || "";
      speciesIndex = data.species || data || [];
      catalogTotals = {
        species: speciesIndex.length,
        printings: (data.counts || {}).variants || speciesIndex.reduce(function (total, item) { return total + Number(item.variants || 0); }, 0)
      };
      speciesIndex.forEach(function (item) {
        if (item.number && !speciesByNumber[item.number]) speciesByNumber[item.number] = item;
      });
      renderCatalogCounts();
      if (isMineHash(location.hash)) {
        // Names for the Pokémon picker, and a check against this catalog.
        if (binder) syncPickers();
        reconcileMine(loadToken);
        return;
      }
      setStatus(null);
      var fromHash = findByHash(location.hash);
      if (fromHash) pickSpecies(fromHash, { instant: true });
      else if ($("q").value.trim()) updateFromQuery(); // typed before the catalog arrived
    }).catch(function (err) {
      if (!isMineHash(location.hash)) setStatus("status.catalogFailed", null, true);
      console.error(err);
    });
    loadFx();
    window.addEventListener("hashchange", function () {
      if (!location.hash.replace(/^#/, "")) { if (!isHome()) goHome(false); return; }
      if (isMineHash(location.hash)) { if (!(current && current.meta.mine)) openMine(); return; }
      var item = findByHash(location.hash);
      if (item && (!current || current.meta.key !== item.key)) pickSpecies(item, { instant: true });
    });
  }

  boot();
})();
