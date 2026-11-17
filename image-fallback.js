/* ImageFallback: when a card picture from TCGdex's image server fails to
   load (TCGdex has no picture of that card, or the server is down), show
   TCGplayer's picture of the same product instead. A TCGplayer picture that
   fails, or a TCGdex one with no product to fall back to, is hidden, so the
   card back under it shows. docs/CARD-LIST-OPTIONS.md §6.4.

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

  var SOURCE = /^https:\/\/assets\.tcgdex\.net\//;
  var TCGPLAYER = "https://tcgplayer-cdn.tcgplayer.com/product/";
  var KNOWN = /^https:\/\/(assets\.tcgdex\.net|tcgplayer-cdn\.tcgplayer\.com)\//;
  var PID = /^\d{1,12}$/;
  // After this many TCGdex pictures fail in a row, src() skips it.
  var DOWN_AFTER = 3;

  function isSource(url) { return SOURCE.test(String(url || "")); }
  function isLarge(url) { return /\/high\.[a-z]+$/i.test(String(url || "")); }

  // TCGplayer's picture of a product: 1000 for the card page, 400 for a
  // binder pocket (TCGdex's are 600×825 and 245×337).
  function tcgplayer(pid, large) {
    pid = String(pid || "");
    return PID.test(pid) ? TCGPLAYER + pid + (large ? "_in_1000x1000.jpg" : "_in_400x400.jpg") : "";
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

  // The stand-in for a TCGdex picture, "" when there's none.
  function fallbackFor(url) {
    return isSource(url) ? tcgplayer(pids[url], isLarge(url)) : "";
  }

  var streak = 0;
  function down() { return streak >= DOWN_AFTER; }

  // For pictures the page loads itself (preloads, the large scan): the
  // stand-in once TCGdex keeps failing, else the URL as it is.
  function src(url) { return (down() && fallbackFor(url)) || url; }

  function urlOf(img) { return img.getAttribute("src") || img.currentSrc || img.src || ""; }

  function onError(event) {
    var img = event && event.target;
    if (!img || img.tagName !== "IMG") return;
    var url = urlOf(img);
    if (!KNOWN.test(url)) return;
    if (isSource(url)) streak++;
    var alt = img.getAttribute("data-fallback") ? "" : fallbackFor(url);
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
    img.setAttribute("data-fallback", "tcgplayer");
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
