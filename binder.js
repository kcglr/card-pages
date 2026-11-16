/* CardBinder: lays cards out in 3x3 binder pages, turns pages, and pulls cards
   out of their pockets. Two facing pages on wide screens, one page on phones.
   Layout lives in theme.css; the spread reports one or two pages per view
   through its --per-view custom property. */
(function (root) {
  "use strict";
  var PER_PAGE = 9;
  var LIFT = 0.46; // how far a card slides out of its sleeve before it flies

  function reducedMotion() {
    return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function chevron(path) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  function t(key, vars) {
    return root.CardI18n ? root.CardI18n.t(key, vars) : key;
  }
  function node(tag, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function Binder(host, options) {
    this.host = host;
    this.opts = options || {};
    this.cards = [];
    this.byKey = {};
    this.page = 0;
    this.out = null;
    this.flip = null;
    this.preloaded = {};
    this.suppressClickUntil = 0;
    host.innerHTML =
      '<div class="binder">' +
        '<div class="spread">' +
          '<div class="slot left"></div>' +
          '<div class="rings" aria-hidden="true"><span class="ring"></span><span class="ring"></span><span class="ring"></span></div>' +
          '<div class="slot right"></div>' +
        "</div>" +
        '<button type="button" class="turn-corner prev" tabindex="-1" aria-hidden="true"></button>' +
        '<button type="button" class="turn-corner next" tabindex="-1" aria-hidden="true"></button>' +
      "</div>" +
      '<div class="binder-nav">' +
        '<button type="button" class="nav-btn" data-turn="-1">' + chevron("M15 5l-7 7 7 7") + "</button>" +
        '<input type="range" class="page-scrub" min="0" max="0" value="0" step="1">' +
        '<button type="button" class="nav-btn" data-turn="1">' + chevron("M9 5l7 7-7 7") + "</button>" +
        '<span class="page-label" aria-live="polite"></span>' +
      "</div>";
    this.spread = host.querySelector(".spread");
    this.left = host.querySelector(".slot.left");
    this.right = host.querySelector(".slot.right");
    this.scrub = host.querySelector(".page-scrub");
    this.label = host.querySelector(".page-label");
    this.prevBtn = host.querySelector('[data-turn="-1"]');
    this.nextBtn = host.querySelector('[data-turn="1"]');
    this.perView = this.measure();
    this.bind();
  }

  Binder.prototype.measure = function () {
    return getComputedStyle(this.spread).getPropertyValue("--per-view").trim() === "1" ? 1 : 2;
  };
  Binder.prototype.pageCount = function () {
    return Math.max(1, Math.ceil(this.cards.length / PER_PAGE));
  };
  Binder.prototype.clampPage = function (page) {
    var last = this.pageCount() - 1;
    page = Math.max(0, Math.min(page, last));
    return page - page % this.perView;
  };

  Binder.prototype.pocketHtml = function (card, slot) {
    var info = this.opts.describe(card);
    var art = info.image
      ? '<img src="' + escapeHtml(info.image) + '" alt="" decoding="async" draggable="false">'
      : '<span class="pk-blank">' + escapeHtml(info.name) + "</span>";
    return '<button type="button" class="pocket' + (info.key === this.out ? " is-out" : "") +
      '" data-key="' + escapeHtml(info.key) + '" aria-label="' + escapeHtml(info.label) + '" style="--i:' + slot + '">' +
      '<span class="pk-card">' + art + "</span>" +
      '<span class="pk-sleeve" aria-hidden="true"></span>' +
      (info.lang ? '<span class="pk-lang" aria-hidden="true">' + escapeHtml(info.lang) + "</span>" : "") +
      (info.price ? '<span class="pk-price" aria-hidden="true">' + escapeHtml(info.price) + "</span>" : "") +
      "</button>";
  };

  Binder.prototype.pageEl = function (page) {
    var el = node("div", "bpage");
    var html = "";
    for (var i = 0; i < PER_PAGE; i++) {
      var card = this.cards[page * PER_PAGE + i];
      html += card ? this.pocketHtml(card, i)
        : '<div class="pocket is-empty" style="--i:' + i + '"><span class="pk-sleeve"></span></div>';
    }
    if (page < this.pageCount()) html += '<span class="page-no" aria-hidden="true">' + (page + 1) + "</span>";
    el.innerHTML = html;
    return el;
  };

  Binder.prototype.render = function (deal) {
    this.finishFlip();
    this.perView = this.measure();
    this.page = this.clampPage(this.page);
    var pages = [];
    if (this.perView === 2) {
      pages.push(this.pageEl(this.page));
      this.left.replaceChildren(pages[0]);
    } else {
      this.left.replaceChildren();
    }
    pages.push(this.pageEl(this.page + this.perView - 1));
    var cover = this.right.querySelector(".cover-flap"); // keep an opening cover swinging
    this.right.replaceChildren(pages[pages.length - 1]);
    if (cover) this.right.appendChild(cover);
    if (deal && !reducedMotion()) pages.forEach(function (page) { page.classList.add("is-dealing"); });
    this.updateNav();
    this.preload();
  };

  Binder.prototype.updateNav = function () {
    var count = this.pageCount();
    var first = this.page + 1;
    var last = Math.min(this.page + this.perView, count);
    var views = Math.ceil(count / this.perView);
    this.label.textContent = !this.cards.length ? t("binder.empty")
      : last > first ? t("binder.pages", { a: first, b: last, n: count }) : t("binder.page", { a: first, n: count });
    this.scrub.max = String(Math.max(0, views - 1));
    this.scrub.value = String(Math.floor(this.page / this.perView));
    this.scrub.disabled = views <= 1;
    this.scrub.setAttribute("aria-label", t("binder.jump"));
    this.prevBtn.disabled = this.page <= 0;
    this.nextBtn.disabled = this.page + this.perView >= count;
    this.prevBtn.setAttribute("aria-label", t(this.perView === 2 ? "binder.prevPair" : "binder.prev"));
    this.nextBtn.setAttribute("aria-label", t(this.perView === 2 ? "binder.nextPair" : "binder.next"));
    this.host.classList.toggle("at-start", this.prevBtn.disabled);
    this.host.classList.toggle("at-end", this.nextBtn.disabled);
  };

  // Warm the image cache for the neighbouring pages so a turn shows art at once.
  Binder.prototype.preload = function () {
    var from = Math.max(0, (this.page - this.perView) * PER_PAGE);
    var to = Math.min(this.cards.length, (this.page + 2 * this.perView) * PER_PAGE);
    for (var i = from; i < to; i++) {
      var src = this.opts.describe(this.cards[i]).image;
      if (src && !this.preloaded[src]) {
        this.preloaded[src] = true;
        new Image().src = src;
      }
    }
  };

  Binder.prototype.setCards = function (cards, options) {
    options = options || {};
    var self = this;
    this.cards = cards;
    this.byKey = {};
    cards.forEach(function (card) { self.byKey[self.opts.describe(card).key] = card; });
    if (!options.keepPage) this.page = 0;
    this.render(!!options.deal);
  };

  // Update price stickers and labels in place, without re-rendering pages.
  Binder.prototype.refresh = function () {
    var self = this;
    this.spread.querySelectorAll(".pocket[data-key]").forEach(function (pocket) {
      var card = self.byKey[pocket.getAttribute("data-key")];
      if (!card) return;
      var info = self.opts.describe(card);
      var sticker = pocket.querySelector(".pk-price");
      if (info.price && !sticker) {
        sticker = node("span", "pk-price");
        sticker.setAttribute("aria-hidden", "true");
        pocket.appendChild(sticker);
      }
      if (sticker && !info.price) sticker.remove();
      else if (sticker) sticker.textContent = info.price;
      pocket.setAttribute("aria-label", info.label);
    });
  };

  Binder.prototype.pocketFor = function (key) {
    this.finishFlip();
    var pockets = this.spread.querySelectorAll(".pocket[data-key]");
    for (var i = 0; i < pockets.length; i++) {
      if (pockets[i].getAttribute("data-key") === key) return pockets[i];
    }
    return null;
  };

  // Remembers which card is out so re-rendered pages keep its sleeve empty.
  // pullOut/putBack move the card itself; null clears every empty sleeve.
  Binder.prototype.markOut = function (key) {
    this.out = key;
    if (key == null) {
      this.spread.querySelectorAll(".pocket.is-out").forEach(function (pocket) { pocket.classList.remove("is-out"); });
    }
  };

  Binder.prototype.turn = function (dir) {
    this.goTo(this.page + dir * this.perView, true);
  };

  Binder.prototype.goTo = function (target, animate) {
    this.finishFlip();
    var dir = target > this.page ? 1 : -1;
    target = this.clampPage(target);
    if (target === this.page) {
      if (animate && !reducedMotion() && this.spread.animate) {
        this.spread.animate([{ transform: "none" }, { transform: "translateX(" + (-dir * 7) + "px)" }, { transform: "none" }],
          { duration: 260, easing: "ease-out" });
      }
      return;
    }
    if (!animate || reducedMotion() || !this.spread.animate) {
      this.page = target;
      this.render(false);
      return;
    }
    this.animateTurn(target, dir);
  };

  // A leaf carries the outgoing page on its front and the incoming page on its
  // back, and swings around the rings. The page underneath is already in place.
  Binder.prototype.animateTurn = function (target, dir) {
    var self = this;
    var spread = this.perView === 2;
    // A single page always swings around the rings on its left edge.
    var leaf = node("div", "leaf " + (spread ? (dir > 0 ? "fwd" : "back") : "fwd solo"));
    var front = node("div", "leaf-face front");
    var back = node("div", "leaf-face back");
    var shadeFront = node("span", "leaf-shade");
    var shadeBack = node("span", "leaf-shade");
    var newLeft = spread ? this.pageEl(target) : null;
    var newRight = this.pageEl(target + this.perView - 1);
    var done = null;
    var frames;
    if (spread && dir > 0) {
      front.appendChild(this.right.firstElementChild);
      back.appendChild(newLeft);
      this.right.replaceChildren(newRight, leaf);
      done = function () { self.left.replaceChildren(newLeft); };
      frames = [{ transform: "rotateY(0deg)" }, { transform: "rotateY(-180deg)" }];
    } else if (spread) {
      front.appendChild(this.left.firstElementChild);
      back.appendChild(newRight);
      this.left.replaceChildren(newLeft, leaf);
      done = function () { self.right.replaceChildren(newRight); };
      frames = [{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }];
    } else if (dir > 0) {
      front.appendChild(this.right.firstElementChild);
      this.right.replaceChildren(newRight, leaf);
      frames = [{ transform: "rotateY(0deg)", opacity: 1 }, { transform: "rotateY(-70deg)", opacity: 1, offset: 0.6 },
        { transform: "rotateY(-105deg)", opacity: 0 }];
    } else {
      front.appendChild(newRight);
      this.right.appendChild(leaf);
      done = function () { self.right.replaceChildren(newRight); };
      frames = [{ transform: "rotateY(-105deg)", opacity: 0 }, { transform: "rotateY(-70deg)", opacity: 1, offset: 0.4 },
        { transform: "rotateY(0deg)", opacity: 1 }];
    }
    front.appendChild(shadeFront);
    back.appendChild(shadeBack);
    leaf.appendChild(front);
    leaf.appendChild(back);

    var timing = { duration: spread ? 680 : 480, easing: "cubic-bezier(.45,.05,.25,1)", fill: "forwards" };
    var animations = [
      leaf.animate(frames, timing),
      shadeFront.animate([{ opacity: dir > 0 || spread ? 0 : 0.5 }, { opacity: dir > 0 || spread ? 0.55 : 0 }], timing),
      shadeBack.animate([{ opacity: 0.55 }, { opacity: 0 }], timing)
    ];
    var finished = false;
    function complete() {
      if (finished) return;
      finished = true;
      animations.forEach(function (animation) { animation.cancel(); });
      if (done) done();
      leaf.remove();
      if (self.flip === complete) self.flip = null;
    }
    animations[0].onfinish = complete;
    this.flip = complete;
    this.page = target;
    this.updateNav();
    this.preload();
  };

  Binder.prototype.finishFlip = function () {
    if (this.flip) this.flip();
  };

  // The front cover swings open over the first page when a binder is opened.
  Binder.prototype.openCover = function (title) {
    if (reducedMotion() || !this.spread.animate) return;
    var cover = node("div", "leaf cover-flap" + (this.perView === 2 ? "" : " solo"));
    cover.innerHTML = '<div class="leaf-face front cover-front"><span class="cover-tape">' + escapeHtml(title || "") +
      '</span><img class="cover-badge" src="assets/pullfolio-mark.svg" alt="" width="56" height="56"></div>' +
      '<div class="leaf-face back cover-inside"></div>';
    this.right.appendChild(cover);
    var animation = cover.animate([
      { transform: "rotateY(0deg)", opacity: 1 },
      { transform: "rotateY(-125deg)", opacity: 1, offset: 0.6 },
      { transform: "rotateY(-178deg)", opacity: 0 }
    ], { duration: 1100, delay: 150, easing: "cubic-bezier(.55,0,.25,1)", fill: "both" });
    animation.onfinish = function () { cover.remove(); };
  };

  Binder.prototype.bind = function () {
    var self = this;
    this.host.addEventListener("click", function (event) {
      var turn = event.target.closest("[data-turn]");
      if (turn) { self.turn(Number(turn.getAttribute("data-turn"))); return; }
      var corner = event.target.closest(".turn-corner");
      if (corner) { self.turn(corner.classList.contains("prev") ? -1 : 1); return; }
      var pocket = event.target.closest(".pocket[data-key]");
      if (!pocket || Date.now() < self.suppressClickUntil || !self.opts.onPick) return;
      self.opts.onPick(self.byKey[pocket.getAttribute("data-key")], pocket);
    });
    this.scrub.addEventListener("input", function () {
      self.goTo(Number(self.scrub.value) * self.perView, false);
    });
    // Swipe or drag sideways across the pages to turn them.
    var start = null;
    this.spread.addEventListener("pointerdown", function (event) {
      if (event.isPrimary === false || event.button > 0) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    this.spread.addEventListener("pointerup", function (event) {
      if (!start || event.pointerId !== start.id) return;
      var dx = event.clientX - start.x;
      var dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        self.suppressClickUntil = Date.now() + 400;
        self.turn(dx < 0 ? 1 : -1);
      }
    });
    this.spread.addEventListener("pointercancel", function () { start = null; });
    var timer = 0;
    this.onResize = function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (self.measure() !== self.perView) self.render(false);
      }, 120);
    };
    root.addEventListener("resize", this.onResize);
  };

  Binder.prototype.destroy = function () {
    this.finishFlip();
    root.removeEventListener("resize", this.onResize);
  };

  /* ---- pulling a card out of its pocket and putting it back ---- */

  function centerDelta(from, to) {
    return {
      x: from.left + from.width / 2 - (to.left + to.width / 2),
      y: from.top + from.height / 2 - (to.top + to.height / 2),
      scale: from.width / to.width
    };
  }
  function flyingCard(src, rect) {
    var fly = node("img", "card-fly");
    fly.src = src;
    fly.alt = "";
    fly.style.left = rect.left + "px";
    fly.style.top = rect.top + "px";
    fly.style.width = rect.width + "px";
    fly.style.height = rect.height + "px";
    document.body.appendChild(fly);
    return fly;
  }
  function pose(x, y, scale, spin, turn) {
    return "perspective(1100px) translate(" + x + "px," + y + "px) scale(" + scale + ") rotateZ(" + spin + "deg) rotateY(" + turn + "deg)";
  }

  // Slides the card up out of its sleeve, then flies it to `target`.
  // Resolves with the flying image so the caller can swap in the real one.
  Binder.pullOut = function (pocket, target, src) {
    var card = pocket && pocket.querySelector(".pk-card");
    var goal = target && target.getBoundingClientRect();
    if (!card || !src || !goal || !goal.width || reducedMotion() || !card.animate) {
      if (pocket) pocket.classList.add("is-out");
      return Promise.resolve(null);
    }
    pocket.classList.add("is-lifting");
    var lift = card.animate([{ transform: "translateY(0)" }, { transform: "translateY(-" + LIFT * 100 + "%)" }],
      { duration: 230, easing: "cubic-bezier(.3,.6,.35,1)", fill: "forwards" });
    return lift.finished.then(function () {
      var from = card.getBoundingClientRect();
      pocket.classList.add("is-out");
      pocket.classList.remove("is-lifting");
      lift.cancel();
      goal = target.getBoundingClientRect();
      var fly = flyingCard(src, goal);
      var d = centerDelta(from, goal);
      var mid = d.scale + (1 - d.scale) * 0.55;
      return fly.animate([
        { transform: pose(d.x, d.y, d.scale, 0, 0), boxShadow: "0 3px 8px rgba(0,0,0,.35)" },
        { transform: pose(d.x * 0.42, d.y * 0.42 - 70, mid, -6, 22), offset: 0.5 },
        { transform: pose(0, 0, 1, 0, 0), boxShadow: "0 34px 70px rgba(0,0,0,.5)" }
      ], { duration: 640, easing: "cubic-bezier(.25,.7,.3,1)", fill: "forwards" }).finished.then(function () { return fly; });
    });
  };

  // Flies the card from `source` back above its pocket and slides it in.
  Binder.putBack = function (pocket, source, src) {
    var card = pocket && pocket.querySelector(".pk-card");
    var from = source && source.getBoundingClientRect();
    if (!card || !src || !from || !from.width || reducedMotion() || !card.animate) {
      if (pocket) pocket.classList.remove("is-out");
      return Promise.resolve();
    }
    var rest = card.getBoundingClientRect();
    var above = { left: rest.left, top: rest.top - rest.height * LIFT, width: rest.width, height: rest.height };
    var fly = flyingCard(src, from);
    var d = centerDelta(above, from);
    return fly.animate([
      { transform: pose(0, 0, 1, 0, 0), boxShadow: "0 34px 70px rgba(0,0,0,.5)" },
      { transform: pose(d.x * 0.55, d.y * 0.55 - 50, (1 + d.scale) / 2, 5, -18), offset: 0.5 },
      { transform: pose(d.x, d.y, d.scale, 0, 0), boxShadow: "0 3px 8px rgba(0,0,0,.35)" }
    ], { duration: 520, easing: "cubic-bezier(.45,0,.25,1)", fill: "forwards" }).finished.then(function () {
      pocket.classList.remove("is-out");
      fly.remove();
      return card.animate([{ transform: "translateY(-" + LIFT * 100 + "%)" }, { transform: "translateY(0)" }],
        { duration: 240, easing: "cubic-bezier(.5,0,.75,.4)" }).finished;
    });
  };

  root.CardBinder = Binder;
})(window);
