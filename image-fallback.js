/* ImageFallback: when a card picture from PokéCottage's image server fails
   to load (the server is down, or it stops serving other sites), show
   TCGplayer's picture of the same product instead. docs/SITE-PLAN.md §4.

   One listener on the whole page catches the failures, so the binders, card
   files, search results and My binder all get it. The page tells it each
   card's product id with remember() as cards load.

   TCGplayer has one picture per product, so a reverse holo or a stamped
   printing falls back to the plain card. A product without a picture gets
   TCGplayer's "no image" placeholder. */
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
  var PID = /^\d{1,12}$/;
  // After this many PokéCottage pictures fail in a row, src() skips it.
  var DOWN_AFTER = 3;

  function isSource(url) { return SOURCE.test(String(url || "")); }
  function isLarge(url) { return /__large\.[a-z]+$/i.test(String(url || "")); }

  // TCGplayer's picture of a product: 717×1000 for a large scan, 400 wide for
  // a binder thumbnail (PokéCottage's are 733×1024 and 360 wide).
  function tcgplayer(pid, large) {
    pid = String(pid || "");
    return PID.test(pid) ? TCGPLAYER + pid + (large ? "_in_1000x1000.jpg" : "_400w.jpg") : "";
  }

  var pids = {};
  // cards: [{ image, imageLarge, productId }], as in data/<key>.json and My
  // binder's copies.
  function remember(cards) {
    (cards || []).forEach(function (c) {
      var pid = String((c && c.productId) || "");
      if (!PID.test(pid)) return;
      if (isSource(c.image)) pids[c.image] = pid;
      if (isSource(c.imageLarge)) pids[c.imageLarge] = pid;
    });
  }

  // The stand-in for a PokéCottage picture, "" when there's none.
  function fallbackFor(url) {
    return isSource(url) ? tcgplayer(pids[url], isLarge(url)) : "";
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
    if (!isSource(url) || img.getAttribute("data-fallback")) return;
    streak++;
    var alt = fallbackFor(url);
    // Without a stand-in the page's own handler runs, as before.
    if (!alt) return;
    // Otherwise it must not: some hide or remove the picture.
    event.stopPropagation();
    img.setAttribute("data-fallback", "tcgplayer");
    if (img.style && img.style.visibility === "hidden") img.style.visibility = "";
    img.src = alt;
  }

  function onLoad(event) {
    var img = event && event.target;
    if (img && img.tagName === "IMG" && isSource(urlOf(img))) streak = 0;
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
