(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else factory().install(root.document, root);
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  function position(x, y, rect) {
    var clamp = function (v) { return Math.max(-1, Math.min(1, v)); };
    var dx = clamp((x - rect.left) / rect.width * 2 - 1);
    var dy = clamp((y - rect.top) / rect.height * 2 - 1);
    // The edge under the pointer recedes, like pressing on a physical card.
    return { x: -dy * 13, y: dx * 13, lightX: (dx + 1) * 50, lightY: (dy + 1) * 50,
      shadowX: -dx * 6, shadowY: 6 - dy * 4 };
  }
  function install(doc, win) {
    var reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
    var active = null, frame = 0, point = null, suppress = null;
    function target(node) { return node && node.closest ? node.closest(".tile, .sheet-art") : null; }
    function reset() {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      if (active) {
        active.art.classList.remove("is-tilting");
        ["x", "y", "scale", "shadow-x", "shadow-y", "light-x", "light-y"].forEach(function (key) {
          active.art.style.removeProperty("--tilt-" + key);
        });
      }
      active = null;
    }
    function move(event) {
      if (reduced.matches || event.isPrimary === false) { reset(); return; }
      var tile = target(event.target);
      if (!tile || (event.pointerType === "touch" && event.type !== "pointerdown" && !active)) return;
      if (!active || active.tile !== tile) {
        reset();
        var art = tile.matches(".sheet-art") ? tile : tile.querySelector(".art");
        if (!art || !art.querySelector("img")) return;
        active = { tile: tile, art: art, rect: art.getBoundingClientRect(), id: event.pointerId,
          touch: event.pointerType === "touch", startX: event.clientX, startY: event.clientY, moved: false };
      }
      if (event.pointerId !== active.id) return;
      if (active.touch && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 8) active.moved = true;
      point = position(event.clientX, event.clientY, active.rect);
      if (!frame) frame = win.requestAnimationFrame(function () {
        frame = 0;
        if (!active) return;
        active.art.classList.add("is-tilting");
        var style = active.art.style;
        style.setProperty("--tilt-x", point.x.toFixed(2) + "deg");
        style.setProperty("--tilt-y", point.y.toFixed(2) + "deg");
        style.setProperty("--tilt-scale", ".975");
        style.setProperty("--tilt-light-x", point.lightX + "%");
        style.setProperty("--tilt-light-y", point.lightY + "%");
        style.setProperty("--tilt-shadow-x", point.shadowX + "px");
        style.setProperty("--tilt-shadow-y", point.shadowY + "px");
      });
    }
    function end() {
      if (active && active.touch && active.moved) suppress = { tile: active.tile, until: Date.now() + 500 };
      reset();
    }
    doc.addEventListener("pointerover", function (event) { if (event.pointerType !== "touch") move(event); }, { passive: true });
    doc.addEventListener("pointerdown", move, { passive: true });
    doc.addEventListener("pointermove", move, { passive: true });
    doc.addEventListener("pointerout", function (event) {
      if (active && !active.tile.contains(event.relatedTarget)) end();
    }, { passive: true });
    doc.addEventListener("pointerup", end, { passive: true });
    doc.addEventListener("pointercancel", end, { passive: true });
    doc.addEventListener("click", function (event) {
      if (event.detail && suppress && Date.now() < suppress.until && target(event.target) === suppress.tile) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      suppress = null;
      reset();
    }, true);
    doc.addEventListener("scroll", reset, { passive: true, capture: true });
    doc.addEventListener("visibilitychange", reset);
    win.addEventListener("blur", reset);
    win.addEventListener("resize", reset);
    reduced.addEventListener("change", reset);
    return { reset: reset };
  }
  return { position: position, install: install };
});
