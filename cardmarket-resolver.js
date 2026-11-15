(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./market-links.js"));
  else root.CardmarketResolver = factory(root.CardMarketLinks);
})(typeof window !== "undefined" ? window : this, function (links) {
  "use strict";
  // Public, CORS-enabled catalog; also works on GitHub Pages without a server.
  var API = "https://api.tcgdex.net/v2/";

  function normalize(value) {
    return String(value || "").replace(/[☆★]/g, " star ").replace(/δ/g, " delta ")
      .normalize("NFKD").replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function number(value) {
    var parts = String(value || "").split("/")[0].trim().replace(/^([A-Za-z]+)\s+(\d+)/, "$1$2").split(/\s+/);
    return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+/g, function (n) { return String(Number(n)); });
  }
  function setName(value) {
    var name = normalize(value).replace(/^ex /, "");
    return { "expedition base set": "expedition", "celebrations classic collection": "celebrations",
      "scarlet violet promos": "scarlet violet black star promos", "sword shield promos": "swsh black star promos",
      "sword shield black star promos": "swsh black star promos", "sun moon promos": "sm black star promos",
      "wizards promos": "wizards black star promos", "unseen forces unown collection": "unseen forces" }[name] || name;
  }
  function variantMatches(wanted, variant) {
    wanted = normalize(wanted).replace(/first edition/g, "1st edition");
    var kind = variant.type || "", size = variant.size || "standard", stamps = variant.stamp || [];
    var subtype = variant.subtype || "", foil = variant.foil || "";
    if (wanted === "metal card") return kind === "metal" && size === "standard" && !stamps.length;
    if (wanted === "jumbo") return size === "jumbo" && !stamps.length && !subtype;
    if (size !== "standard" || kind === "metal") return false;
    if (/^1st edition( holo)?$/.test(wanted)) return stamps.length === 1 && stamps[0] === "1st-edition" && !subtype && /^(holo|normal)$/.test(kind);
    if (wanted === "play pokemon") return stamps.length === 1 && stamps[0] === "player-rewards-program";
    if (wanted === "no symbol") return subtype === "missing-expansion-symbol" && !stamps.length;
    if (wanted === "expansion stamp") return stamps.length === 1 && stamps[0] === "set-logo" && !subtype;
    if (stamps.length || subtype) return false;
    var special = { "reverse holo": ["reverse", ["", "mirror"]], "master ball holo": ["reverse", ["masterball"]],
      "poke ball holo": ["reverse", ["pokeball"]], "cosmos holo": ["holo", ["cosmos"]] }[wanted];
    if (special) return kind === special[0] && special[1].indexOf(foil) !== -1;
    if (/^(holo|holo rare)$/.test(wanted)) return kind === "holo" && /^(|gold)$/.test(foil);
    return /^(standard|normal|non holo|)$/.test(wanted) && kind === "normal" && !foil;
  }
  function productId(variant) {
    var id = (variant.thirdParty || {}).cardmarket || ((variant.pricing || {}).cardmarket || {}).idProduct;
    return /^[1-9]\d*$/.test(String(id || "")) ? String(id) : "";
  }
  function selectProduct(card, candidate, japanese) {
    var item = links.identity(card);
    if (number(candidate.localId) !== number(item.number)) return "";
    if (!japanese && (normalize(candidate.name) !== normalize(item.name) || setName((candidate.set || {}).name) !== setName(item.set))) return "";
    var variants = candidate.variants_detailed || [], ids = new Set();
    variants.forEach(function (variant) {
      if (!variantMatches(item.variant, variant)) return;
      if (variant.languages && variant.languages.indexOf(japanese ? "ja" : "en") === -1) return;
      var id = productId(variant);
      // Reject upstream metal IDs also accidentally assigned to paper variants.
      if (variant.type !== "metal" && variants.some(function (v) { return v.type === "metal" && productId(v) === id; })) return;
      if (id) ids.add(id);
    });
    return ids.size === 1 ? Array.from(ids)[0] : "";
  }
  function createResolver(fetcher) {
    var cache = new Map();
    function request(path, attempt) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 12000);
      return Promise.resolve().then(function () {
        return fetcher(API + path, { mode: "cors", signal: controller.signal });
      }).then(function (response) {
        if (response.status === 404) return null;
        if (!response.ok) {
          var error = new Error("Catalog " + response.status);
          error.retryable = response.status >= 500;
          throw error;
        }
        return response.json();
      }).catch(function (error) {
        // One retry covers a transient connection/timeout; never retry rate limits.
        if (attempt === 0 && error.retryable !== false) {
          clearTimeout(timer);
          return request(path, 1);
        }
        throw error;
      }).finally(function () { clearTimeout(timer); });
    }
    function get(path) {
      if (cache.has(path)) return cache.get(path);
      var pending = request(path, 0).catch(function (error) {
        cache.delete(path);
        throw error;
      });
      cache.set(path, pending);
      return pending;
    }
    return async function resolve(card) {
      var item = links.identity(card);
      var result = { status: "not_found", url: "", searchUrl: links.build(card).cmSearch };
      var explicit = links.productUrl(card.cardmarketUrl || (card.sources || {}).cardmarket_url, "cm");
      if (explicit) return Object.assign(result, { status: "matched", url: explicit });
      if (!item.name || !item.number) return result;
      try {
        var candidates = [];
        if (item.lang === "ENG") {
          var briefs = await get("en/cards?name=" + encodeURIComponent(item.name)) || [];
          briefs = briefs.filter(function (b) { return normalize(b.name) === normalize(item.name) && number(b.localId) === number(item.number); });
          if (briefs.length > 12) return result;
          // Sequential detail requests keep traffic low, and are cached between cards.
          for (var brief of briefs) {
            var candidate = await get("en/cards/" + encodeURIComponent(brief.id));
            if (candidate) candidates.push(candidate);
          }
        } else if (item.lang === "JP") {
          var match = /^(\d+)-jpn_([a-zA-Z0-9]+)-[^-]+-.+$/.exec(String(card.id || ""));
          if (!match) return result;
          var japanese = await get("ja/cards/" + encodeURIComponent(match[2] + "-" + item.number.split("/")[0]));
          if (japanese && String((japanese.set || {}).id || "").toLowerCase() === match[2].toLowerCase() && (japanese.dexId || []).indexOf(Number(match[1])) !== -1) candidates.push(japanese);
        } else return result;
        var ids = new Set(candidates.map(function (c) { return selectProduct(card, c, item.lang === "JP"); }).filter(Boolean));
        if (ids.size === 1) {
          var params = new URLSearchParams({ idProduct: Array.from(ids)[0], language: item.lang === "JP" ? "7" : "1" });
          if (normalize(item.variant).replace(/first edition/g, "1st edition").indexOf("1st edition") !== -1) params.set("isFirstEd", "Y");
          if (normalize(item.variant) === "reverse holo") params.set("isReverseHolo", "Y");
          result.status = "matched";
          result.url = "https://www.cardmarket.com/en/Pokemon/Products?" + params.toString();
        }
      } catch (error) { result.status = "unavailable"; }
      return result;
    };
  }
  return { createResolver: createResolver, selectProduct: selectProduct, variantMatches: variantMatches,
    resolve: createResolver(function (url, options) { return fetch(url, options); }) };
});
