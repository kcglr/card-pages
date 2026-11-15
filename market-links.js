(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CardMarketLinks = factory();
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function identity(card) {
    var parts = String(card.set || "").split(" · ");
    return {
      name: card.name || "",
      set: card.setName || card.set_name || parts.slice(0, -1).join(" · ") || parts[0],
      number: card.displayCardNumber || card.cardNumber || card.card_number || (parts.length > 1 ? parts[parts.length - 1] : ""),
      lang: String(card.lang || "").toUpperCase(),
      variant: card.variant || card.rarity || ""
    };
  }

  function searchTerms(card) {
    var c = identity(card);
    var variant = /^(standard|normal)$/i.test(c.variant) ? "" : c.variant;
    var lang = { ENG: "English", JP: "Japanese", CN: "Chinese" }[c.lang] || c.lang;
    return [c.name, c.number, c.set, variant, lang].filter(Boolean).join(" ");
  }

  function productUrl(value, market) {
    try {
      var url = new URL(value);
      var hosts = { pc: ["www.pricecharting.com", "pricecharting.com"], tcg: ["www.tcgplayer.com", "tcgplayer.com"], cm: ["www.cardmarket.com", "cardmarket.com"], collectr: ["app.getcollectr.com"] };
      var paths = { pc: /^\/game\/[^/]+\/[^/]+\/?$/, tcg: /^\/product\/[1-9]\d*(?:\/|$)/, cm: /^\/en\/(Pokemon|OnePiece)\/Products\/Singles\/[^/]+\/[^/]+/, collectr: /^\/explore\/product\/[1-9]\d*(?:\/[^/]+)?\/?$/ };
      var productIdLink = market === "cm" && /^\/(?:en\/)?Pokemon\/Products\/?$/.test(url.pathname) && /^[1-9]\d*$/.test(url.searchParams.get("idProduct") || "");
      return url.protocol === "https:" && hosts[market].indexOf(url.hostname) !== -1 && (paths[market].test(url.pathname) || productIdLink) ? url.href : "";
    } catch (e) { return ""; }
  }

  function pricechartingTerms(card) {
    var c = identity(card);
    var number = c.number.trim().replace(/^([A-Za-z]+)\s+(\d+)/, "$1$2");
    if (!/^[RGB]\/RGB$/i.test(number)) number = number.split("/")[0].replace(/\d+/g, function (n) { return String(Number(n)); });
    var variant = /^(standard|normal|holo|holo rare)$/i.test(c.variant) ? "" : c.variant;
    return [c.name, number, c.set, { JP: "Japanese", CN: "Chinese" }[c.lang] || "", variant].filter(Boolean).join(" ");
  }

  function build(card) {
    var c = identity(card);
    var q = encodeURIComponent(searchTerms(card));
    var sources = card.sources || {};
    var pid = String(card.productId || card.product_id || "");
    var tcg = /^[1-9]\d*$/.test(pid) ? "https://www.tcgplayer.com/product/" + pid : productUrl(card.tcgUrl || sources.tcgplayer_url, "tcg");
    var collectr = productUrl(card.collectrUrl || sources.collectr_url, "collectr");
    // Collectr's public product route accepts the TCGplayer product ID and
    // redirects to its canonical card slug. No API key or scraped prices.
    if (!collectr && tcg) collectr = "https://app.getcollectr.com/explore/product/" + new URL(tcg).pathname.split("/")[2];
    var resolution = card.pcResolution || {};
    var pc = productUrl(resolution.url || card.pricechartingUrl || sources.pricecharting_url, "pc");
    var cm = productUrl((card.cmResolution || {}).url || card.cardmarketUrl || sources.cardmarket_url, "cm");
    // Cardmarket searches catalog names, not eBay-style seller descriptions.
    var cmQuery = [c.name, c.number.split("/")[0]].filter(Boolean).join(" ");
    return {
      tcg: tcg || "https://www.tcgplayer.com/search/pokemon/product?q=" + q,
      tcgDirect: !!tcg,
      collectr: collectr,
      ebaySold: "https://www.ebay.com/sch/i.html?_nkw=" + q + "&LH_Sold=1&LH_Complete=1",
      ebay: "https://www.ebay.com/sch/i.html?_nkw=" + q,
      pc: pc,
      pcSearch: "https://www.pricecharting.com/search-products?q=" + encodeURIComponent(pricechartingTerms(card)) + "&type=prices",
      cm: cm,
      cmSearch: "https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=" + encodeURIComponent(cmQuery),
      cmDirect: !!cm
    };
  }

  return { build: build, identity: identity, searchTerms: searchTerms, pricechartingTerms: pricechartingTerms, productUrl: productUrl };
});
