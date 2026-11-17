/* ImageFallback: when a card picture from PokéCottage's image server fails
   to load (the server is down, or it stops serving other sites), show
   TCGplayer's picture of the same product instead, and when that fails too,
   TCGdex's picture of the card. When every stand-in fails, or there is none,
   the picture is hidden, so the card back under it shows.
   docs/SITE-PLAN.md §4, docs/OWN-CATALOG-SWITCH.md.

   One listener on the whole page catches the failures, so the binders, card
   files, search results and My binder all get it. The page tells it each
   card's product id and TCGdex picture (data/<key>.json's "tcgdex",
   "en/swsh/swsh4/030") with remember() as cards load.

   TCGplayer has one picture per product, so a reverse holo or a stamped
   printing falls back to the plain card. A product without a picture gets
   TCGplayer's "no image" placeholder or an error, and then TCGdex's. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ImageFallback = factory();
    root.ImageFallback.install(root.document);
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var SOURCE = /^https:\/\/pokecottagecdn\.com\//;
  var TCGPLAYER = "https://tcgplayer-cdn.tcgplayer.com/product/";
  var TCGDEX = "https://assets.tcgdex.net/";
  var KNOWN = /^https:\/\/(pokecottagecdn\.com|tcgplayer-cdn\.tcgplayer\.com|assets\.tcgdex\.net)\//;
  var PID = /^\d{1,12}$/;
  var DEX = /^(en|ja)\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/;
  // After this many PokéCottage pictures fail in a row, src() skips it.
  var DOWN_AFTER = 3;

  function isSource(url) { return SOURCE.test(String(url || "")); }

  // TCGplayer's picture of a product: 1000 for the card page, 400 for a
  // binder pocket (PokéCottage's are 733×1024 and 360 wide).
  function tcgplayer(pid, large) {
    pid = String(pid || "");
    return PID.test(pid) ? TCGPLAYER + pid + (large ? "_in_1000x1000.jpg" : "_in_400x400.jpg") : "";
  }

  // TCGdex's picture of a card: 600×825 for the card page, 245×337 for a pocket.
  function tcgdex(path, large) {
    path = String(path || "");
    return DEX.test(path) ? TCGDEX + path + (large ? "/high.webp" : "/low.webp") : "";
  }

  // A PokéCottage picture -> its stand-ins in order; a stand-in -> the next.
  var chains = {};
  var nextOf = {};
  // cards: [{ image, imageLarge, productId, tcgdex }], as in data/<key>.json
  // and My binder's copies.
  function remember(cards) {
    (cards || []).forEach(function (c) {
      if (!c) return;
      [[c.image, false], [c.imageLarge, true]].forEach(function (pair) {
        var url = pair[0];
        if (!isSource(url)) return;
        var list = [tcgplayer(c.productId, pair[1]), tcgdex(c.tcgdex, pair[1])].filter(Boolean);
        if (!list.length) return;
        chains[url] = list;
        for (var i = 0; i + 1 < list.length; i++) nextOf[list[i]] = list[i + 1];
      });
    });
  }

  // The stand-in for a picture that failed, "" when there's none: the first
  // for a PokéCottage picture, the next one for a stand-in.
  function fallbackFor(url) {
    url = String(url || "");
    if (isSource(url)) return (chains[url] || [])[0] || "";
    return nextOf[url] || "";
  }

  var streak = 0;
  function down() { return streak >= DOWN_AFTER; }

  // For pictures the page loads itself (preloads, the large scan): the
  // stand-in once PokéCottage keeps failing, else the URL as it is.
  function src(url) { return (down() && fallbackFor(url)) || url; }

  function urlOf(img) { return img.getAttribute("src") || img.currentSrc || img.src || ""; }

  function onError(event) {
    var img = event && event.target;
    if (!img || img.tagName !== "IMG") return;
    var url = urlOf(img);
    if (!KNOWN.test(url)) return;
    if (isSource(url)) streak++;
    var alt = fallbackFor(url);
    // Without a stand-in the page's own handler runs, as before. The picture
    // is hidden first: a binder pocket has no handler, and Chrome and Safari
    // would draw a broken-image icon over the card back. A later load that
    // works shows it again (onLoad).
    if (!alt) {
      img.setAttribute("data-broken", "1");
      if (img.style) img.style.visibility = "hidden";
      return;
    }
    // Otherwise it must not: some hide or remove the picture.
    event.stopPropagation();
    img.setAttribute("data-fallback", alt.indexOf(TCGDEX) === 0 ? "tcgdex" : "tcgplayer");
    if (img.style && img.style.visibility === "hidden") img.style.visibility = "";
    img.src = alt;
  }

  function onLoad(event) {
    var img = event && event.target;
    if (!img || img.tagName !== "IMG") return;
    if (img.getAttribute("data-broken") !== null) {
      if (img.removeAttribute) img.removeAttribute("data-broken");
      if (img.style) img.style.visibility = "";
    }
    if (isSource(urlOf(img))) streak = 0;
  }

  var installed = false;
  // Capture phase: error and load events don't bubble, and this runs before
  // the picture's own onerror.
  function install(doc) {
    if (installed || !doc || !doc.addEventListener) return;
    installed = true;
    doc.addEventListener("error", onError, true);
    doc.addEventListener("load", onLoad, true);
  }

  return {
    tcgplayer: tcgplayer,
    tcgdex: tcgdex,
    remember: remember,
    fallbackFor: fallbackFor,
    src: src,
    down: down,
    install: install,
    // for tests
    _onError: onError,
    _onLoad: onLoad
  };
});
