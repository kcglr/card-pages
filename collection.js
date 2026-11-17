/* PullfolioMine: the collection's interface. The "In my binder" section of a
   pulled-out card (with its add and edit slip), the undo strip, backups, and
   My binder's summary card. app.js owns the binders and calls in here; the
   logic is in collection-core.js and the storage in collection-store.js. */
(function (root) {
  "use strict";
  var core = root.PullfolioCore;
  var Store = root.PullfolioStore;
  var i18n = root.CardI18n;
  var t = i18n.t;
  var num = i18n.num;
  var formatUsd = root.PricePick.formatUsd;
  var Hist = root.PullfolioHistory;
  var $ = function (id) { return document.getElementById(id); };

  var api = { fxRate: function () { return null; }, speciesName: function (key) { return key; }, filterTo: function () {}, relink: function () {} };
  var history = null; // the saved price history, once read (Store.readHistory)
  // The weekly market prices of the cards in My binder, from the Pokémon's
  // history files (price-history.js), as a price history like the saved one.
  var market = { sig: "", loading: false, history: null };
  // The summary card's drawer: which panel is open and each panel's choice.
  var shelf = { open: "", by: "set", range: "all", days: "7" };
  var shown = null; // { card, ctx } of the pulled-out card
  var slip = null; // { uid } while the slip is open; uid "" adds a copy
  var LIRA_STORE = "pullfolio.mine.lira";
  var COND_NAMES = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function plural(key, n) { return t(key, { n: num(n) }); }
  function lira(usd, rate) {
    rate = rate || api.fxRate();
    if (!rate || !isFinite(usd)) return "";
    var v = usd * rate;
    return "₺" + num(Math.abs(v) >= 1000 ? Math.round(v / 10) * 10 : Math.round(v));
  }
  function liraAmount(v) { return "₺" + num(Math.abs(v) >= 1000 ? Math.round(v / 10) * 10 : Math.round(v)); }
  function signed(text, n) { return (n > 0 ? "+" : n < 0 ? "−" : "") + text; }
  function pct(p) {
    if (p == null || !isFinite(p)) return "";
    return (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p * 100).toLocaleString(i18n.locale(), { maximumFractionDigits: 1 }) + "%";
  }
  function money(cur, amount) {
    if (cur === "TRY") return liraAmount(amount);
    if (cur === "EUR") return "€" + amount.toLocaleString(i18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return formatUsd(amount);
  }
  function day(iso) {
    if (!iso) return "";
    var d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(i18n.locale(), { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Istanbul" });
  }
  function today() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function cardName(card) { return card.name || (card.snap && card.snap.name) || t("card.fallback"); }
  function wantsLira() {
    try { return root.localStorage.getItem(LIRA_STORE) === "1"; } catch (e) { return false; }
  }

  /* ---- exchange rates for prices paid in lira or euros ---- */

  var rateCache = {};
  function ratesOn(date) {
    var key = !date || date >= today() ? "latest" : date;
    if (!rateCache[key]) {
      rateCache[key] = fetch("https://api.frankfurter.dev/v1/" + key + "?from=USD&to=TRY,EUR", { mode: "cors" }).then(function (res) {
        if (!res.ok) throw new Error("rates " + res.status);
        return res.json();
      }).then(function (data) {
        return data && data.rates ? { rates: data.rates, date: data.date || "" } : null;
      }).catch(function () {
        delete rateCache[key];
        return null;
      });
    }
    return rateCache[key];
  }

  // Fills in the dollar and lira sums of any price paid that lacks them.
  function ensureRates() {
    Store.model().all().forEach(function (copy) {
      if (!core.needsRate(copy.paid)) return;
      ratesOn(copy.bought).then(function (found) {
        if (!found) return;
        var now = Store.model().get(copy.uid);
        if (!now || !core.needsRate(now.paid)) return;
        var paid = core.convertPaid(now.paid, found.rates, found.date);
        if (JSON.stringify(paid) !== JSON.stringify(now.paid)) Store.update(copy.uid, { paid: paid }, "rates");
      });
    });
  }

  /* ---- the undo strip ---- */

  var toastTimer = 0;
  // `undo` is the strip's button; `label` names it when it isn't an undo.
  function toast(text, undo, label) {
    var el = $("mine-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "mine-toast";
      el.className = "mine-toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    clearTimeout(toastTimer);
    el.innerHTML = '<span class="mine-toast-text">' + esc(text) + "</span>" +
      (undo ? '<button type="button" class="mine-toast-undo">' + esc(label || t("undo")) + "</button>" : "");
    el.classList.add("is-on");
    if (undo) {
      el.querySelector("button").addEventListener("click", function () {
        undo();
        hideToast();
      });
    }
    toastTimer = setTimeout(hideToast, undo ? 8000 : 4000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    var el = $("mine-toast");
    if (el) el.classList.remove("is-on");
  }

  /* ---- what a pocket shows ---- */

  // { qty, slab } for a catalog card: how many you have and, for a graded
  // copy, its slab ("PSA 10").
  function pocketInfo(card) {
    var copies = Store.model().copiesFor(card);
    if (!copies.length) return null;
    var qty = 0;
    var slab = "";
    copies.forEach(function (c) {
      qty += c.qty;
      if (!slab) slab = core.gradeLabel(c);
    });
    return { qty: qty, slab: slab };
  }

  /* ---- the card file's "In my binder" section ---- */

  function condText(copy) {
    if (copy.cond.kind === "graded") {
      return core.gradeLabel(copy) + (copy.cond.cert ? " · " + t("own.certShort", { n: copy.cond.cert }) : "");
    }
    return copy.cond.grade;
  }

  // The printings beside this one: same language, set and number, other variants.
  function siblings(card, cards) {
    var set = card.setName || String(card.set || "").split(" · ")[0];
    return (cards || []).filter(function (c) {
      return (c.lang || "") === (card.lang || "") && (c.cardNumber || "") === (card.cardNumber || "") &&
        (c.setName || String(c.set || "").split(" · ")[0]) === set;
    });
  }

  function sectionHtml() {
    var card = shown.card;
    var copies = Store.model().copiesFor(card);
    var html = '<h3 class="sheet-label" id="sheet-mine-label">' + esc(t("own.label")) + "</h3>";
    if (slip) return html + slipHtml();
    if (!copies.length) {
      return html + '<button type="button" class="mine-add" data-mine="add">' + plusIcon() + esc(t("own.add")) + "</button>";
    }
    var qty = copies.reduce(function (n, c) { return n + c.qty; }, 0);
    var unit = shown.ctx.price ? shown.ctx.price.value : 0;
    var value = 0;
    var valued = 0;
    var paid = 0;
    var paidValue = 0;
    copies.forEach(function (c) {
      var v = core.unitValue(c, unit ? { value: unit } : null);
      if (v) { value += v.value * c.qty; valued += c.qty; }
      if (c.paid && c.paid.usd != null) {
        paid += c.paid.usd * c.qty;
        if (v) paidValue += v.value * c.qty;
      }
    });
    var otherSpecies = copies.filter(function (c) { return c.species !== shown.ctx.species; })[0];
    html += '<p class="mine-have"><span class="mine-have-tick" aria-hidden="true"></span>' + esc(plural("own.in", qty)) + "</p>";
    if (otherSpecies) html += '<p class="mine-note">' + esc(t("own.savedFrom", { name: api.speciesName(otherSpecies.species) })) + "</p>";
    var lost = copies.filter(function (c) { return c.unmatched; })[0];
    if (lost) {
      html += '<p class="mine-note is-warn">' + esc(t("own.unmatched")) + "</p>" +
        '<p class="mine-more"><button type="button" class="mine-textbtn" data-mine="relink" data-uid="' + esc(lost.uid) + '">' + esc(t("own.find")) + "</button></p>";
    }
    html += '<ul class="mine-copies">' + copies.map(function (c) {
      var bits = [];
      if (c.paid) bits.push(t("own.paidEach", { price: money(c.paid.cur, c.paid.amount) }));
      if (c.bought) bits.push(day(c.bought));
      if (c.value) bits.push(t("own.myValueIs", { price: formatUsd(c.value) }));
      return '<li class="mine-copy"><span class="mine-copy-qty">×' + num(c.qty) + '</span><span class="mine-copy-main"><span class="mine-copy-cond" lang="en">' +
        esc(condText(c)) + "</span>" + (bits.length ? '<span class="mine-copy-meta">' + esc(bits.join(" · ")) + "</span>" : "") +
        (c.note ? '<span class="mine-copy-note">' + esc(c.note) + "</span>" : "") + "</span>" +
        '<span class="mine-copy-acts"><button type="button" class="mine-mini" data-mine="edit" data-uid="' + esc(c.uid) + '">' + esc(t("own.edit")) + "</button>" +
        '<button type="button" class="mine-mini" data-mine="remove" data-uid="' + esc(c.uid) + '">' + esc(t("own.remove")) + "</button></span></li>";
    }).join("") + "</ul>";
    // No market price and no value of your own: say so, and offer one.
    var bare = shown.ctx.waiting ? null : copies.filter(function (c) { return !core.unitValue(c, unit ? { value: unit } : null); })[0];
    if (bare) {
      html += '<p class="mine-note">' + esc(t("own.unpriced")) + ' <button type="button" class="mine-textbtn" data-mine="myvalue" data-uid="' +
        esc(bare.uid) + '">' + esc(t("own.setValue")) + "</button></p>";
    }
    if (valued) {
      var gain = paid ? paidValue - paid : 0;
      html += '<p class="mine-worth">' + esc(t("own.worth", { n: num(valued), value: formatUsd(Math.round(value * 100) / 100) })) +
        (paid ? " · " + esc(t("own.paidTotal", { price: formatUsd(Math.round(paid * 100) / 100) })) +
          ' · <span class="' + (gain < 0 ? "is-loss" : "is-gain") + '">' + esc(signed(formatUsd(Math.abs(Math.round(gain * 100) / 100)), gain)) + "</span>" : "") + "</p>";
    }
    html += '<p class="mine-more"><button type="button" class="mine-textbtn" data-mine="add">' + esc(t("own.another")) + "</button>" +
      (copies.length > 1 ? '<button type="button" class="mine-textbtn" data-mine="remove-all">' + esc(t("own.removeAll")) + "</button>" : "") + "</p>";
    return html;
  }

  function plusIcon() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges"><path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z" fill="currentColor"/></svg>';
  }

  function option(value, label, on, extra) {
    return '<option value="' + esc(value) + '"' + (on ? " selected" : "") + (extra || "") + ">" + esc(label) + "</option>";
  }

  function slipHtml() {
    var card = shown.card;
    var copy = slip.uid ? Store.model().get(slip.uid) : null;
    // A copy saved under another Pokémon (a tag-team card) keeps its printing.
    var printings = shown.ctx.cards && (!copy || copy.species === shown.ctx.species) ? siblings(card, shown.ctx.cards) : [];
    var currentId = copy ? copy.card : card.id;
    var cond = copy ? copy.cond : { kind: "raw", grade: "NM" };
    var cur = copy && copy.paid ? copy.paid.cur : (Store.model().doc.settings.currency || (i18n.lang() === "tr" ? "TRY" : "USD"));
    var amount = copy && copy.paid ? copy.paid.amount.toLocaleString(i18n.locale(), { maximumFractionDigits: 2, useGrouping: false }) : "";
    var bought = copy ? copy.bought : today();
    var noDate = !!copy && !copy.bought;
    var id = "slip-" + Math.random().toString(36).slice(2, 7);
    var html = '<form class="mine-slip" id="mine-slip" novalidate>' +
      '<p class="mine-slip-head">' + esc(t(copy ? "own.editTitle" : "own.addTitle")) + "</p>" +
      '<div class="mine-slip-grid">';
    if (printings.length > 1) {
      html += '<label class="mine-field is-wide"><span class="mine-field-label">' + esc(t("own.printing")) + "</span>" +
        '<select name="printing" lang="en">' + printings.map(function (p) {
          return option(p.id, (p.lang || "") + " · " + (p.variant || p.rarity || "—") + (p.price && p.price.headline ? " · " + p.price.headline : ""), p.id === currentId);
        }).join("") + "</select></label>";
    }
    html += '<div class="mine-field"><span class="mine-field-label" id="' + id + '-qty">' + esc(t("own.qty")) + "</span>" +
      '<div class="mine-stepper"><button type="button" data-step="-1" aria-label="' + esc(t("own.less")) + '">−</button>' +
      '<input name="qty" inputmode="numeric" autocomplete="off" aria-labelledby="' + id + '-qty" value="' + esc(copy ? copy.qty : 1) + '">' +
      '<button type="button" data-step="1" aria-label="' + esc(t("own.more")) + '">+</button></div></div>';
    html += '<fieldset class="mine-field is-wide"><legend class="mine-field-label">' + esc(t("own.condition")) + "</legend>" +
      '<div class="mine-seg">' +
        '<label><input type="radio" name="kind" value="raw"' + (cond.kind !== "graded" ? " checked" : "") + "><span>" + esc(t("own.raw")) + "</span></label>" +
        '<label><input type="radio" name="kind" value="graded"' + (cond.kind === "graded" ? " checked" : "") + "><span>" + esc(t("own.graded")) + "</span></label>" +
      "</div>" +
      '<div class="mine-conds" data-kind="raw"' + (cond.kind === "graded" ? " hidden" : "") + ">" + core.CONDITIONS.map(function (c) {
        return '<label class="mine-cond" title="' + esc(t("cond." + c)) + '"><input type="radio" name="grade" value="' + c + '"' +
          ((cond.kind !== "graded" ? cond.grade : "NM") === c ? " checked" : "") + '><span lang="en">' + c + '</span><span class="sr-only">' + esc(t("cond." + c)) + "</span></label>";
      }).join("") + "</div>" +
      '<div class="mine-graded" data-kind="graded"' + (cond.kind === "graded" ? "" : " hidden") + ">" +
        '<label><span class="mine-field-label">' + esc(t("own.grader")) + '</span><select name="by" lang="en">' + core.GRADERS.map(function (g) {
          return option(g, g === "Other" ? t("own.otherGrader") : g, cond.by ? cond.by === g : g === "PSA");
        }).join("") + "</select></label>" +
        '<label><span class="mine-field-label">' + esc(t("own.grade")) + '</span><select name="slabgrade" lang="en">' + core.GRADES.map(function (g) {
          return option(g, g, cond.kind === "graded" ? cond.grade === g : g === "10");
        }).join("") + "</select></label>" +
        '<label><span class="mine-field-label">' + esc(t("own.cert")) + '</span><input name="cert" autocomplete="off" inputmode="numeric" maxlength="30" value="' + esc(cond.cert || "") + '"></label>' +
      "</div></fieldset>";
    html += '<div class="mine-field"><label class="mine-field-label" for="' + id + '-paid">' + esc(t("own.paid")) + "</label>" +
      '<div class="mine-money"><input id="' + id + '-paid" name="paid" inputmode="decimal" autocomplete="off" placeholder="' + esc(t("own.paidHint")) + '" value="' + esc(amount) + '">' +
      '<select name="cur" aria-label="' + esc(t("own.currency")) + '">' + option("USD", "$ USD", cur === "USD") + option("TRY", "₺ TRY", cur === "TRY") + option("EUR", "€ EUR", cur === "EUR") + "</select></div></div>";
    html += '<div class="mine-field"><label class="mine-field-label" for="' + id + '-date">' + esc(t("own.date")) + "</label>" +
      '<input type="date" id="' + id + '-date" name="bought" max="' + today() + '" value="' + esc(noDate ? "" : bought) + '"' + (noDate ? " disabled" : "") + ">" +
      '<label class="mine-check"><input type="checkbox" name="nodate"' + (noDate ? " checked" : "") + "><span>" + esc(t("own.dateUnknown")) + "</span></label></div>";
    html += '<details class="mine-extra is-wide"' + (copy && (copy.value || copy.note) || slip.focus === "value" ? " open" : "") + "><summary>" + esc(t("own.extra")) + "</summary>" +
      '<div class="mine-extra-grid"><label class="mine-field"><span class="mine-field-label">' + esc(t("own.myValue")) + "</span>" +
      '<input name="value" inputmode="decimal" autocomplete="off" placeholder="$" value="' + esc(copy && copy.value ? copy.value : "") + '">' +
      '<span class="mine-field-help">' + esc(t("own.myValueHelp")) + "</span></label>" +
      '<label class="mine-field"><span class="mine-field-label">' + esc(t("own.note")) + '</span><textarea name="note" rows="2" maxlength="500">' + esc(copy ? copy.note : "") + "</textarea></label></div></details>";
    html += "</div>" +
      '<p class="mine-error" role="alert" hidden></p>' +
      '<div class="mine-slip-acts"><button type="submit" class="mine-save">' + esc(t("own.save")) + "</button>" +
      '<button type="button" class="mine-textbtn" data-mine="cancel">' + esc(t("own.cancel")) + "</button></div></form>";
    return html;
  }

  function render(focus) {
    var box = $("sheet-mine");
    if (!box || !shown) return;
    box.innerHTML = sectionHtml();
    if (focus === "slip" || focus === "value") {
      var first = box.querySelector(focus === "value" ? 'input[name="value"]' : "select, input");
      if (first) first.focus({ preventScroll: true });
      box.scrollIntoView({ block: "nearest" });
    } else if (focus) {
      var target = box.querySelector(focus);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function readSlip(form) {
    var lang = i18n.lang();
    var data = {};
    var qty = Math.floor(Number(String(form.qty.value).replace(/[^\d]/g, "")));
    if (!(qty >= 1 && qty <= core.MAX_QTY)) return { error: t("own.errQty", { n: core.MAX_QTY }) };
    data.qty = qty;
    var kind = form.querySelector('input[name="kind"]:checked').value;
    if (kind === "graded") {
      data.cond = { kind: "graded", by: form.by.value, grade: form.slabgrade.value, cert: form.cert.value };
    } else {
      var grade = form.querySelector('input[name="grade"]:checked');
      data.cond = { kind: "raw", grade: grade ? grade.value : "NM" };
    }
    var typed = form.paid.value.trim();
    var amount = typed ? core.parseAmount(typed, lang) : null;
    if (typed && !amount) return { error: t("own.errPrice"), field: "paid" };
    data.paid = amount ? { amount: amount, cur: form.cur.value } : null;
    data.bought = form.nodate.checked ? "" : (form.bought.value || "");
    if (data.bought && data.bought > today()) return { error: t("own.errDate"), field: "bought" };
    var valueText = form.value.value.trim();
    var value = valueText ? core.parseAmount(valueText, lang) : null;
    if (valueText && !value) return { error: t("own.errPrice"), field: "value" };
    data.value = value;
    data.note = form.note.value;
    var printing = form.printing ? form.printing.value : "";
    data.printing = printing;
    return { data: data };
  }

  function save(form) {
    var read = readSlip(form);
    var error = form.querySelector(".mine-error");
    if (read.error) {
      error.hidden = false;
      error.textContent = read.error;
      if (read.field && form[read.field]) form[read.field].focus();
      return;
    }
    var d = read.data;
    var card = shown.card;
    var ctx = shown.ctx;
    var old = slip.uid ? Store.model().get(slip.uid) : null;
    var chosen = d.printing || (old ? old.card : card.id);
    var target = card;
    if (chosen !== card.id && ctx.cards) target = ctx.cards.filter(function (c) { return c.id === chosen; })[0] || card;
    var counts = ctx.cards ? core.pidCounts(ctx.cards) : null;
    var fields = { qty: d.qty, cond: d.cond, bought: d.bought, value: d.value, note: d.note };
    // A new copy, or another printing picked: file it under that card.
    if (!old || chosen !== old.card) {
      fields.card = target.id;
      fields.species = ctx.species;
      fields.snap = counts ? core.snapOf(target, counts) : core.snapOf(target);
    }
    // A price paid keeps its converted sums only while amount, currency and date stay.
    if (d.paid) {
      var keep = old && old.paid && old.paid.amount === d.paid.amount && old.paid.cur === d.paid.cur && old.bought === d.bought;
      fields.paid = keep ? old.paid : { amount: d.paid.amount, cur: d.paid.cur };
      if (Store.model().doc.settings.currency !== d.paid.cur) Store.setSetting("currency", d.paid.cur);
    } else {
      fields.paid = null;
    }
    slip = null;
    if (old) {
      Store.update(old.uid, fields);
      toast(t("undo.saved", { name: cardName(target) }));
    } else {
      var added = Store.add(fields);
      if (added) toast(t("undo.added", { name: cardName(target) }), function () { Store.remove(added.uid); });
    }
    ensureRates();
    render(".mine-add, .mine-textbtn");
  }

  function removeCopies(uids) {
    var gone = uids.map(function (uid) { return Store.remove(uid); }).filter(Boolean);
    if (!gone.length) return;
    toast(t("undo.removed", { name: cardName(gone[0].snap) }), function () {
      gone.forEach(function (copy) { Store.restore(copy); });
    });
  }

  function bindSection() {
    var box = $("sheet-mine");
    if (!box || box.getAttribute("data-bound")) return;
    box.setAttribute("data-bound", "1");
    box.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-mine], [data-step]");
      if (!btn || !shown) return;
      if (btn.hasAttribute("data-step")) {
        var input = box.querySelector('input[name="qty"]');
        var n = Math.floor(Number(input.value)) || 1;
        input.value = String(Math.max(1, Math.min(core.MAX_QTY, n + Number(btn.getAttribute("data-step")))));
        return;
      }
      var act = btn.getAttribute("data-mine");
      if (act === "add") { slip = { uid: "" }; render("slip"); }
      else if (act === "edit") { slip = { uid: btn.getAttribute("data-uid") }; render("slip"); }
      else if (act === "myvalue") { slip = { uid: btn.getAttribute("data-uid"), focus: "value" }; render("value"); }
      else if (act === "relink") api.relink(btn.getAttribute("data-uid"));
      else if (act === "cancel") { slip = null; render(".mine-add, .mine-textbtn"); }
      else if (act === "remove") removeCopies([btn.getAttribute("data-uid")]);
      else if (act === "remove-all") removeCopies(Store.model().copiesFor(shown.card).map(function (c) { return c.uid; }));
    });
    box.addEventListener("change", function (ev) {
      var form = ev.target.form;
      if (!form) return;
      if (ev.target.name === "kind") {
        var graded = ev.target.value === "graded";
        form.querySelector('[data-kind="raw"]').hidden = graded;
        form.querySelector('[data-kind="graded"]').hidden = !graded;
      } else if (ev.target.name === "nodate") {
        form.bought.disabled = ev.target.checked;
      }
    });
    box.addEventListener("submit", function (ev) {
      ev.preventDefault();
      save(ev.target);
    });
    // Escape closes the slip before it closes the card.
    box.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && slip) {
        ev.stopPropagation();
        slip = null;
        render(".mine-add, .mine-textbtn");
      }
    }, true);
  }

  // ctx: { species, speciesNo, price (one copy's market price or null),
  // cards (the Pokémon's catalog cards, for the printing switcher; may come later) }
  function showCard(card, ctx) {
    var sameCard = shown && shown.card === card;
    shown = { card: card, ctx: ctx || {} };
    if (!sameCard) slip = null;
    bindSection();
    render();
  }
  function updateCard(ctx) {
    if (!shown) return;
    if (ctx) Object.keys(ctx).forEach(function (k) { shown.ctx[k] = ctx[k]; });
    if (!slip) render();
  }
  function hideCard() {
    shown = null;
    slip = null;
  }

  /* ---- backups ---- */

  function stamp() { return today(); }

  function saveFile(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadBackup(quiet) {
    var doc = core.exportDoc(Store.model().doc, null, history);
    saveFile("pullfolio-binder-" + stamp() + ".json", JSON.stringify(doc, null, 1), "application/json");
    Store.markBackup();
    if (!quiet) toast(t("backup.done"));
  }

  function downloadCsv() {
    saveFile("pullfolio-binder-" + stamp() + ".csv", "﻿" + core.toCsv(Store.model().doc), "text/csv;charset=utf-8");
  }

  var pendingImport = null;

  function pickImport() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { showImport({ ok: false, error: "size" }); return; }
      var reader = new FileReader();
      reader.onload = function () { showImport(core.parseFile(String(reader.result || ""))); };
      reader.onerror = function () { showImport({ ok: false, error: "json" }); };
      reader.readAsText(file);
    });
    input.click();
  }

  function importHtml() {
    if (!pendingImport) return "";
    var r = pendingImport;
    if (!r.ok) {
      return '<div class="mine-import is-error" role="alert"><p>' + esc(t("backup.err." + r.error)) + "</p>" +
        '<button type="button" class="mine-textbtn" data-sum="import-cancel">' + esc(t("own.cancel")) + "</button></div>";
    }
    var have = Store.model().count();
    return '<div class="mine-import" role="group" aria-label="' + esc(t("backup.load")) + '"><p>' +
      esc(t("backup.found", { cards: num(r.summary.cards), species: num(r.summary.species), date: day(r.summary.saved) || "—" })) + "</p>" +
      (have ? '<p class="mine-import-help">' + esc(t("backup.choose", { n: num(have) })) + "</p>" : "") +
      '<div class="mine-import-acts">' +
      (have ? '<button type="button" class="mine-save" data-sum="import-merge">' + esc(t("backup.merge")) + "</button>" +
        '<button type="button" class="mine-chip" data-sum="import-replace">' + esc(t("backup.replace")) + "</button>"
        : '<button type="button" class="mine-save" data-sum="import-replace">' + esc(t("backup.use")) + "</button>") +
      '<button type="button" class="mine-textbtn" data-sum="import-cancel">' + esc(t("own.cancel")) + "</button></div></div>";
  }

  function showImport(result) {
    pendingImport = result;
    var boxes = document.querySelectorAll("[data-mine-import]");
    boxes.forEach(function (box) {
      box.innerHTML = importHtml();
      var first = box.querySelector("button");
      if (first) first.focus({ preventScroll: true });
    });
  }

  function finishImport(mode) {
    var r = pendingImport;
    pendingImport = null;
    if (!r || !r.ok) { showImport(null); return; }
    if (mode === "replace" && Store.model().count()) downloadBackup(true); // what was here, just in case
    if (mode === "merge") Store.mergeIn(r.doc);
    else Store.replace(r.doc);
    // Saved prices are facts about the cards, not part of the choice: both
    // ways keep this browser's and add the backup's.
    if (r.history) {
      history = core.mergeHistory(history, r.history);
      Store.writeHistory(history);
      scheduleSync();
    }
    toast(t("backup.loaded", { n: num(Store.model().count()) }));
    ensureRates();
  }

  /* ---- sync with a private GitHub repo (plan §2, Phase 5) ---- */

  // { repo: "owner/name", token, remember, at } where `at` is the last good
  // sync. Kept in localStorage, or only for this tab's session when
  // "Remember on this device" is off.
  var Sync = root.PullfolioSync;
  var SYNC_STORE = "pullfolio.sync";
  var SYNC_DELAY = 5000; // after the last change
  var RETRY_DELAY = 120000;
  var syncCfg = loadSync();
  var syncState = ""; // "", "busy", "ok" or a SyncError kind
  var syncDraft = { repo: "", token: "", remember: true, error: "" };
  var syncTimer = 0;
  var syncing = null;
  var syncAgain = false;
  var syncApplying = false; // merging the repo's file in: not a change to send back
  var syncFirst = false; // the first sync after connecting says what came in

  function loadSync() {
    var raw = null;
    var remember = true;
    try {
      raw = root.localStorage.getItem(SYNC_STORE);
      if (!raw) { raw = root.sessionStorage.getItem(SYNC_STORE); remember = false; }
    } catch (e) { return null; }
    try { raw = raw ? JSON.parse(raw) : null; } catch (e) { raw = null; }
    var repo = raw && Sync.parseRepo(raw.repo);
    var token = raw && Sync.cleanToken(raw.token);
    if (!repo || !token) return null;
    return { repo: repo.full, token: token, remember: remember, at: typeof raw.at === "string" ? raw.at : "" };
  }

  function saveSync() {
    try {
      root.localStorage.removeItem(SYNC_STORE);
      root.sessionStorage.removeItem(SYNC_STORE);
      if (syncCfg) {
        (syncCfg.remember ? root.localStorage : root.sessionStorage).setItem(SYNC_STORE,
          JSON.stringify({ repo: syncCfg.repo, token: syncCfg.token, at: syncCfg.at }));
      }
    } catch (e) { /* kept for this page only */ }
  }

  function client(cfg) {
    return new Sync.Client(Sync.parseRepo(cfg.repo), cfg.token);
  }

  function scheduleSync(delay) {
    if (!syncCfg) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, delay == null ? SYNC_DELAY : delay);
  }

  // The repo's file is merged in (Sync.run calls this), and saved prices with it.
  function takeRemote(doc, hist) {
    var before = Store.model().count();
    if (Sync.changes(Store.model().doc, doc)) {
      syncApplying = true;
      try { Store.mergeIn(doc); } finally { syncApplying = false; }
    }
    if (hist) {
      var merged = core.mergeHistory(history, hist);
      if (JSON.stringify(merged) !== JSON.stringify(history)) {
        history = merged;
        Store.writeHistory(history);
      }
    }
    var added = Store.model().count() - before;
    if (syncFirst && added > 0) toast(t("sync.pulled", { n: num(added), repo: syncCfg.repo }));
  }

  function syncNow() {
    clearTimeout(syncTimer);
    syncTimer = 0;
    if (!syncCfg) return Promise.resolve();
    if (syncing) { syncAgain = true; return syncing; }
    var cfg = syncCfg;
    setSyncState("busy");
    syncing = Store.ready.then(function () {
      return Sync.run(client(cfg), function () { return { doc: Store.model().doc, history: history }; }, takeRemote);
    }).then(function () {
      if (syncCfg !== cfg) return;
      cfg.at = new Date().toISOString();
      saveSync();
      setSyncState("ok");
    }, function (err) {
      if (syncCfg !== cfg) return;
      var kind = err && err.kind && err.kind !== "conflict" ? err.kind : "server";
      if (!err || !err.kind) console.error(err);
      setSyncState(kind);
      // A network or GitHub hiccup is tried again; anything else needs you.
      if (kind === "offline" || kind === "rate" || kind === "server") scheduleSync(RETRY_DELAY);
    }).then(function () {
      syncing = null;
      syncFirst = false;
      if (syncAgain) { syncAgain = false; scheduleSync(1000); }
    });
    return syncing;
  }

  function setSyncState(state) {
    syncState = state;
    drawSync();
  }

  function connectSync(form) {
    var repo = Sync.parseRepo(form.repo.value);
    var token = Sync.cleanToken(form.token.value);
    syncDraft = { repo: form.repo.value, token: form.token.value, remember: form.remember.checked, error: "" };
    if (!repo) syncDraft.error = t("sync.err.repoShape");
    else if (!token) syncDraft.error = t("sync.err.tokenShape");
    if (syncDraft.error) { drawSync('[name="' + (repo ? "token" : "repo") + '"]'); return; }
    var cfg = { repo: repo.full, token: token, remember: form.remember.checked, at: "" };
    setSyncState("busy");
    Promise.resolve().then(function () { return client(cfg).check(); }).then(function () {
      syncCfg = cfg;
      syncDraft = { repo: "", token: "", remember: true, error: "" };
      saveSync();
      syncFirst = true;
      return syncNow().then(function () { drawSync("[data-sync-status]"); });
    }, function (err) {
      syncState = "";
      syncDraft.error = t("sync.err." + (err && err.kind && err.kind !== "conflict" ? err.kind : "server"));
      drawSync('[name="' + (err && err.kind === "token" ? "token" : "repo") + '"]');
    });
  }

  function disconnectSync() {
    clearTimeout(syncTimer);
    syncCfg = null;
    syncState = "";
    saveSync();
    toast(t("sync.offDone"));
    drawSync(accountsOn ? "[data-acct-advanced] > summary" : '[data-sum="shelf"][data-val="sync"]');
  }

  // "14:05" today, else the date.
  function syncWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(d);
    return date === today() ? d.toLocaleTimeString(i18n.locale(), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }) : day(iso);
  }

  function syncStatusText() {
    if (!syncCfg) return "";
    if (syncState === "busy") return t("sync.busy");
    if (syncState && syncState !== "ok") return t("sync.err." + syncState);
    return syncCfg.at ? t("sync.ok", { time: syncWhen(syncCfg.at) }) : "";
  }
  function syncTrouble() { return !!syncCfg && !!syncState && syncState !== "ok" && syncState !== "busy"; }

  function repoUrl(full) {
    var r = Sync.parseRepo(full);
    return r ? "https://github.com/" + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.name) : "";
  }

  function link(href, text) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + "</a>";
  }

  // The panel behind the "Sync with GitHub" chip. Once accounts are on there
  // is no chip: GitHub sync is under "Advanced" in the account card.
  function syncHtml() { return githubHtml(); }

  // fixedId: the form's field ids where the panel is redrawn only when its
  // HTML changes (the account card); else a new one each time, as before.
  function githubHtml(fixedId) {
    if (syncCfg) {
      var url = repoUrl(syncCfg.repo);
      return '<div class="mine-sync">' +
        '<p class="mine-sync-on">' + esc(t("sync.on")) + " " + link(url, syncCfg.repo) + "</p>" +
        '<p class="mine-sync-status' + (syncTrouble() ? " is-warn" : "") + '" data-sync-status tabindex="-1" role="status">' + esc(syncStatusText()) + "</p>" +
        '<div class="mine-more"><button type="button" class="mine-chip" data-sum="sync-now"' + (syncState === "busy" ? " disabled" : "") + ">" + esc(t("sync.now")) + "</button>" +
        '<button type="button" class="mine-textbtn" data-sum="sync-off">' + esc(t("sync.off")) + "</button></div>" +
        '<p class="mine-note">' + esc(t("sync.history")) + " " + link(url + "/commits", t("sync.versions")) + "</p></div>";
    }
    var id = fixedId || "sync-" + Math.random().toString(36).slice(2, 7);
    var busy = syncState === "busy";
    return '<div class="mine-sync">' +
      '<p class="mine-sync-intro">' + esc(t("sync.intro")) + "</p>" +
      '<ol class="mine-sync-steps">' +
        "<li>" + esc(t("sync.step1")) + " " + link("https://github.com/new", t("sync.step1link")) + "</li>" +
        "<li>" + esc(t("sync.step2")) + " " + link("https://github.com/settings/personal-access-tokens/new", t("sync.step2link")) + "</li>" +
        "<li>" + esc(t("sync.step3")) + "</li>" +
      "</ol>" +
      '<form class="mine-slip mine-sync-form" data-sync-form novalidate>' +
        '<div class="mine-slip-grid">' +
          '<label class="mine-field" for="' + id + '-repo"><span class="mine-field-label">' + esc(t("sync.repoLabel")) + "</span>" +
            '<input id="' + id + '-repo" name="repo" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(t("sync.repoHint")) + '" value="' + esc(syncDraft.repo) + '"></label>' +
          '<label class="mine-field" for="' + id + '-token"><span class="mine-field-label">' + esc(t("sync.tokenLabel")) + "</span>" +
            '<input id="' + id + '-token" name="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(syncDraft.token) + '"></label>' +
          '<div class="mine-field is-wide"><label class="mine-check"><input type="checkbox" name="remember"' + (syncDraft.remember ? " checked" : "") + "><span>" + esc(t("sync.remember")) + "</span></label>" +
            '<span class="mine-field-help">' + esc(t("sync.rememberHelp")) + "</span></div>" +
        "</div>" +
        '<p class="mine-error" role="alert"' + (syncDraft.error ? "" : " hidden") + ">" + esc(syncDraft.error) + "</p>" +
        '<div class="mine-slip-acts"><button type="submit" class="mine-save"' + (busy ? " disabled" : "") + ">" + esc(t(busy ? "sync.checking" : "sync.connect")) + "</button></div>" +
      "</form>" +
      '<p class="mine-note">' + esc(t("sync.privacy")) + "</p></div>";
  }

  // The panel is in the summary card, or under the empty binder's help;
  // once accounts are on, in the account card at the top instead.
  function drawSync(focus) {
    if (accountsOn && shelf.open === "sync") shelf.open = "";
    drawTopButton();
    renderSummary();
    var empty = document.querySelector("[data-mine-sync-empty]");
    if (empty) {
      var open = shelf.open === "sync";
      empty.innerHTML = open ? syncHtml() : "";
      empty.hidden = !open;
      var chip = document.querySelector('.mine-empty [data-sum="shelf"][data-val="sync"]');
      if (chip) chip.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (focus) {
      var el = document.querySelector("#mine-account " + focus + ", [data-mine-sync-empty] " + focus + ", #mine-summary " + focus);
      if (el) el.focus({ preventScroll: true });
    }
  }

  document.addEventListener("submit", function (ev) {
    if (!ev.target.matches || !ev.target.matches("[data-sync-form]")) return;
    ev.preventDefault();
    connectSync(ev.target);
  });
  // What's typed survives the summary card being redrawn (prices arriving).
  document.addEventListener("input", function (ev) {
    var form = ev.target.form;
    if (!form || !form.matches("[data-sync-form]")) return;
    syncDraft.repo = form.repo.value;
    syncDraft.token = form.token.value;
    syncDraft.remember = form.remember.checked;
  });
  document.addEventListener("change", function (ev) {
    var form = ev.target.form;
    if (form && form.matches("[data-sync-form]") && ev.target.name === "remember") syncDraft.remember = ev.target.checked;
  });
  // A save waiting to go out goes now if the page is put away.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && syncTimer) syncNow();
    if (document.visibilityState === "hidden" && acct.timer) acctNow();
  });
  root.addEventListener("online", function () {
    if (syncCfg && syncState === "offline") scheduleSync(0);
    if (acct.state === "offline") scheduleAcct(0);
  });

  /* ---- a Pullfolio account: sign in with Google to save (supabase/README.md) ---- */

  // Shown only after ?accounts=1 was opened on this device, while Google
  // sign-in is in testing (account.js). Searching and flipping through
  // binders never needs an account; signing in only adds saving.
  var Supa = root.PullfolioSupabase;
  var Account = root.PullfolioAccount;
  var account = Account && Supa ? Account.create() : null;
  var accountsOn = !!account && account.enabled();
  // { uid, at, sig }: this device's last good sync with the account, and the
  // fingerprint of the binder it saved (Supa.docSig), to tell unsaved changes.
  var ACCT_AT = "pullfolio.account.at";
  var acct = {
    state: "", // "", "busy", "ok" or a SyncError kind, as syncState
    at: "",
    timer: 0,
    syncing: null,
    again: false,
    applying: false, // merging the account's binder in: not a change to send back
    first: false, // the first sync after signing in says what came in
    going: false, // on the way to Google
    confirm: false, // "Delete my data?" is showing
    deleting: false,
    stopped: false, // while deleting: nothing more goes up
    advanced: false, // the GitHub panel is open
    menu: false, // the account card's "More" is open
    focusPending: false, // the top bar's account button was used: focus the card once drawn
    leaving: false, // Sign out: saving first
    leaveAsk: false, // the save before signing out couldn't finish: asking
    uid: "", // who is (or was last) signed in here
    outDone: null, // what a sign-out does to this device, once done
    note: "", // why this device was signed out (an i18n key)
    noteMore: "", // and a second line to it (an i18n key)
    error: ""
  };

  function acctUser() { return account ? account.user() : null; }
  function sameUser(user) { var u = acctUser(); return !!u && !!user && u.id === user.id; }

  function readSaved(uid) {
    var v = null;
    try { v = JSON.parse(root.localStorage.getItem(ACCT_AT) || "null"); } catch (e) { v = null; }
    if (!uid || !v || v.uid !== uid) return { at: "", sig: "" };
    return { at: typeof v.at === "string" ? v.at : "", sig: typeof v.sig === "string" ? v.sig : "" };
  }
  function readAcctAt() { var user = acctUser(); return user ? readSaved(user.id).at : ""; }
  function writeAcctAt(uid, at, sig) {
    try {
      if (uid) root.localStorage.setItem(ACCT_AT, JSON.stringify({ uid: uid, at: at, sig: sig || "" }));
      else root.localStorage.removeItem(ACCT_AT);
    } catch (e) { /* shown for this page only */ }
  }
  // Changes here the account hasn't seen (any tab's: they share the binder).
  function hasUnsaved(uid) { return Supa.unsaved(Store.model().doc, readSaved(uid).sig); }
  acct.at = readAcctAt();
  acct.uid = acctUser() ? acctUser().id : "";

  function acctClient(uid) {
    var c = new Supa.Client(Account.PROJECT, function (refused) { return account.accessToken(refused); });
    c.seen = function () { return account.seen(uid); };
    return c;
  }

  function scheduleAcct(delay) {
    if (!account || !account.signedIn() || acct.stopped) return;
    clearTimeout(acct.timer);
    acct.timer = setTimeout(acctNow, delay == null ? SYNC_DELAY : delay);
  }

  // The account's binder is merged in (Sync.run calls this). Saved daily
  // prices don't travel with an account (collection-supabase.js).
  function takeAccount(doc) {
    // Signed out meanwhile (another tab): nothing comes in any more.
    if (!acctUser()) throw new Sync.SyncError("token");
    var before = Store.model().count();
    if (Sync.changes(Store.model().doc, doc)) {
      acct.applying = true;
      try { Store.mergeIn(doc); } finally { acct.applying = false; }
    }
    var added = Store.model().count() - before;
    if (acct.first && added > 0) toast(plural("account.pulled", added));
  }

  function acctNow() {
    clearTimeout(acct.timer);
    acct.timer = 0;
    var user = acctUser();
    if (!user || acct.stopped) return Promise.resolve();
    if (acct.syncing) { acct.again = true; return acct.syncing; }
    setAcctState("busy");
    var sent = ""; // the fingerprint of what this save sends
    acct.syncing = Store.ready.then(function () {
      return Sync.run(acctClient(user.id), function () {
        var doc = Store.model().doc;
        sent = Supa.docSig(doc);
        return { doc: doc, history: null };
      }, takeAccount);
    }).then(function (r) {
      if (!sameUser(user)) return;
      account.markSeen(user.id, r.sha);
      acct.at = new Date().toISOString();
      writeAcctAt(user.id, acct.at, sent);
      setAcctState("ok");
    }, function (err) {
      var kind = err && err.kind && err.kind !== "conflict" ? err.kind : "server";
      if (kind === "deleted") { deletedElsewhere(user, !!err.mark); return; }
      if (!sameUser(user)) return; // signed out meanwhile
      if (!err || !err.kind) console.error(err);
      setAcctState(kind);
      // A network or Supabase hiccup is tried again; anything else needs you.
      if (kind === "offline" || kind === "rate" || kind === "server") scheduleAcct(RETRY_DELAY);
    }).then(function () {
      acct.syncing = null;
      acct.first = false;
      if (acct.again) { acct.again = false; scheduleAcct(1000); }
    });
    return acct.syncing;
  }

  function setAcctState(state) {
    acct.state = state;
    drawSync();
  }

  // After "Delete my data", here or on another device: this device's binder
  // goes, with its saved prices. GitHub sync is turned off here too, or it
  // would bring every card back (the file in the GitHub repo stays).
  function clearHere(uid) {
    clearTimeout(acct.timer);
    acct.timer = 0;
    acct.again = false;
    clearTimeout(syncTimer);
    syncTimer = 0;
    if (syncCfg) { syncCfg = null; syncState = ""; saveSync(); }
    history = null;
    market = { sig: "", loading: false, history: null };
    pendingImport = null;
    acct.applying = true;
    try { Store.clear(); } finally { acct.applying = false; }
    if (uid) account.forget(uid);
    acct.at = "";
    writeAcctAt("", "");
  }

  // This device synced the account before its binder was deleted somewhere
  // else (collection-supabase.js read()). Just the mark: clear and sign out.
  // A new binder started since: clear, then take the new one.
  function deletedElsewhere(user, mark) {
    clearHere(user.id);
    acct.state = "";
    if (mark) {
      acct.note = "account.deletedElsewhere";
      account.signOut("local", "deleted-elsewhere");
      toast(t("account.deletedElsewhere"));
    } else {
      toast(t("account.restarted"));
      acct.first = true;
      scheduleAcct(0);
    }
    drawSync();
  }

  function signInWithGoogle() {
    if (!account || acct.going) return;
    acct.going = true;
    acct.error = "";
    acct.note = "";
    drawSync('[data-sum="acct-in"]');
    account.signIn().then(null, function (err) {
      console.error(err);
      acct.going = false;
      acct.error = t("account.err.signin", { why: t("account.err.noCrypto") });
      drawSync('[data-sum="acct-in"]');
    });
  }

  // Sign out: what isn't in the account yet is saved first; then the sign-in
  // ends here and this device's binder is cleared (signing in again brings
  // it back). A save that can't finish clears nothing: the card asks
  // (leaveAskHtml). force: "Sign out anyway".
  function signOutHere(force) {
    var user = acctUser();
    if (!user || acct.leaving) return;
    acct.leaving = true;
    acct.leaveAsk = false;
    acct.error = "";
    clearTimeout(acct.timer);
    acct.timer = 0;
    drawSync('[data-sum="acct-out"]');
    Supa.signOutFlow({
      force: !!force,
      unsaved: function () { return hasUnsaved(user.id); },
      save: function () { return acctNow(); },
      leave: function () { return leaveHere(); }
    }).then(function (result) {
      acct.leaving = false;
      if (result === "ask") {
        acct.leaveAsk = true;
        acct.menu = true;
        drawSync('[data-sum="acct-stay"]');
      }
    }, function (err) {
      console.error(err);
      acct.leaving = false;
      drawSync('[data-sum="acct-out"]');
    });
  }

  function leaveHere() {
    var git = !!syncCfg;
    return account.signOut("local").then(function () {
      return acct.outDone; // afterOut() cleared this device
    }).then(function () {
      return Store.flush(); // the other tabs read it now
    }).then(function () {
      toast(t("account.signedOut") + (git ? " " + t("account.signedOutGit") : ""));
      drawSync('[data-sum="acct-in"]');
    });
  }

  // After a sign-out, what happens to this device's binder (Supa.afterSignOut).
  function afterOut(reason, uid) {
    var plan = Supa.afterSignOut(reason, hasUnsaved(uid));
    if (plan === "clear") {
      var git = !!syncCfg;
      clearHere(uid);
      if (reason === "expired") {
        acct.note = "account.expiredCleared";
        acct.noteMore = git ? "account.signedOutGit" : "";
      }
    } else if (plan === "keep") {
      acct.note = "account.expiredKept";
      acct.noteMore = "";
    } else if (plan === "reload") {
      return Store.reload().then(function () { drawSync(); });
    }
    drawSync();
  }

  // "Delete my data": the account's binder becomes the mark (stopping every
  // other device), this device's copy goes, and the sign-in ends everywhere.
  function deleteMyData() {
    var user = acctUser();
    if (!user || acct.deleting) return;
    acct.deleting = true;
    acct.stopped = true;
    acct.error = "";
    clearTimeout(acct.timer);
    drawSync('[data-sum="acct-delete-yes"]');
    var c = acctClient(user.id);
    (acct.syncing || Promise.resolve()).then(function () {
      return c.remove();
    }).then(function () {
      clearHere(user.id);
      return account.signOut("global", "deleted");
    }).then(function () {
      acct.deleting = false;
      acct.stopped = false;
      acct.confirm = false;
      acct.menu = false;
      acct.state = "";
      acct.note = "";
      toast(t("account.deleted"));
      drawSync('[data-sum="acct-in"]');
    }, function (err) {
      acct.deleting = false;
      acct.stopped = false;
      acct.error = t("account.err." + (err && err.kind && err.kind !== "conflict" ? err.kind : "server"));
      drawSync('[data-sum="acct-delete-yes"]');
      scheduleAcct();
    });
  }

  function acctStatusText() {
    if (acct.state === "busy") return t("account.busy");
    if (acct.state && acct.state !== "ok") return t("account.err." + acct.state);
    return acct.at ? t("account.ok", { time: syncWhen(acct.at) }) : "";
  }
  function acctTrouble() { return !!acct.state && acct.state !== "ok" && acct.state !== "busy"; }

  function who(user) {
    if (user.name && user.email) return user.name + " (" + user.email + ")";
    return user.email || user.name || "—";
  }

  function confirmDeleteHtml() {
    return '<div class="mine-import is-error" role="group" aria-label="' + esc(t("account.delete")) + '">' +
      "<p>" + esc(t("account.deleteAsk")) + "</p>" +
      (syncCfg ? '<p class="mine-import-help">' + esc(t("account.deleteGit")) + "</p>" : "") +
      (acct.error ? '<p class="mine-error" role="alert">' + esc(acct.error) + "</p>" : "") +
      '<div class="mine-import-acts mine-more">' +
        '<button type="button" class="mine-save" data-sum="acct-delete-yes"' + busyAttr(acct.deleting) + ">" +
          esc(t(acct.deleting ? "account.deleting" : "account.deleteYes")) + "</button>" +
        '<button type="button" class="mine-chip" data-sum="acct-download">' + esc(t("account.download")) + "</button>" +
        '<button type="button" class="mine-textbtn" data-sum="acct-delete-no"' + busyAttr(acct.deleting) + ">" + esc(t("own.cancel")) + "</button>" +
      "</div></div>";
  }

  // The account card at the top of My binder, once accounts are on. Signed
  // out: a line, the Google button and the privacy note. Signed in: one row
  // saying how saving is going, with the rest under "More". GitHub sync stays
  // tucked under "Advanced" either way.
  function initial(user) {
    var s = String((user && (user.name || user.email)) || "").replace(/^[\s"'(]+/, "");
    return (s.charAt(0) || "?").toUpperCase();
  }

  function acctShortText() {
    if (acct.state === "busy") return t("account.busyShort");
    if (acctTrouble()) return t("account.troubleShort");
    return acct.at ? t("account.okShort", { time: syncWhen(acct.at) }) : "";
  }

  function advancedHtml() {
    return '<details class="mine-extra acct-extra" data-acct-advanced' + (acct.advanced ? " open" : "") + "><summary>" + esc(t("account.advanced")) + "</summary>" +
      '<div class="acct-github">' + githubHtml("acct-sync") + "</div></details>";
  }

  // Buttons that are busy say so with aria-disabled, so focus stays on them.
  function busyAttr(busy) { return busy ? ' aria-disabled="true"' : ""; }

  // Sign out couldn't save first: nothing is cleared until the person says.
  function leaveAskHtml() {
    return '<div class="mine-import is-error" role="group" aria-label="' + esc(t("account.signOut")) + '">' +
      "<p>" + esc(t("account.leaveAsk")) + "</p>" +
      '<p class="mine-import-help">' + esc(t("account.leaveHelp")) + "</p>" +
      '<div class="mine-import-acts mine-more">' +
        '<button type="button" class="mine-save" data-sum="acct-download">' + esc(t("account.leaveDownload")) + "</button>" +
        '<button type="button" class="mine-chip" data-sum="acct-leave-anyway">' + esc(t("account.leaveAnyway")) + "</button>" +
        '<button type="button" class="mine-textbtn" data-sum="acct-stay">' + esc(t("account.stay")) + "</button>" +
      "</div></div>";
  }

  function accountCardHtml() {
    var user = acctUser();
    var html;
    if (!user) {
      html = '<div class="acct-card is-out"><div class="acct-main">' +
        '<p class="acct-line">' + esc(t("account.short")) + "</p>" +
        '<button type="button" class="mine-save acct-google" data-sum="acct-in"' + busyAttr(acct.going) + ">" +
          esc(t(acct.going ? "account.going" : "account.google")) + "</button></div>";
      if (acct.note) {
        html += '<p class="mine-sync-status is-warn" role="status">' + esc(t(acct.note)) + (acct.noteMore ? " " + esc(t(acct.noteMore)) : "") + "</p>";
        // Signed out with changes the account hasn't seen: they stay here.
        if (acct.note === "account.expiredKept") {
          html += '<div class="mine-more"><button type="button" class="mine-chip" data-sum="acct-download">' + esc(t("account.leaveDownload")) + "</button></div>";
        }
      }
      if (acct.error) html += '<p class="mine-error" role="alert">' + esc(acct.error) + "</p>";
      return html + '<p class="acct-privacy">' + esc(t("account.privacy")) + "</p>" + advancedHtml() + "</div>";
    }
    var trouble = acctTrouble();
    html = '<div class="acct-card is-in"><div class="acct-row">' +
      '<span class="acct-avatar" aria-hidden="true">' + esc(initial(user)) + "</span>" +
      '<p class="acct-who" data-acct-status tabindex="-1"><span class="acct-name">' + esc(t("account.as", { who: user.name || user.email || "—" })) + "</span>" +
        '<span class="acct-state' + (trouble ? " is-warn" : "") + '" role="status">' + esc(acctShortText()) + "</span></p>" +
      '<div class="acct-acts">' +
        '<button type="button" class="mine-chip" data-sum="acct-now"' + busyAttr(acct.state === "busy") + ">" + esc(t("account.now")) + "</button>" +
        '<button type="button" class="mine-chip acct-more" data-sum="acct-menu" aria-expanded="' + acct.menu + '" aria-controls="acct-menu">' +
          esc(t("account.more")) + '<span class="acct-caret" aria-hidden="true"></span></button>' +
      "</div></div>";
    if (trouble) html += '<p class="mine-sync-status is-warn">' + esc(acctStatusText()) + "</p>";
    if (acct.error && !acct.confirm) html += '<p class="mine-error" role="alert">' + esc(acct.error) + "</p>";
    html += '<div class="acct-menu" id="acct-menu" role="group" aria-label="' + esc(t("account.menu")) + '"' + (acct.menu ? "" : " hidden") + ">";
    if (acct.confirm) html += confirmDeleteHtml();
    else if (acct.leaveAsk) html += leaveAskHtml();
    else {
      html += '<div class="mine-more">' +
        '<button type="button" class="mine-chip" data-sum="acct-download">' + esc(t("account.download")) + "</button>" +
        '<button type="button" class="mine-textbtn" data-sum="acct-out"' + busyAttr(acct.leaving) + ">" + esc(t(acct.leaving ? "account.signingOut" : "account.signOut")) + "</button>" +
        '<button type="button" class="mine-textbtn" data-sum="acct-delete">' + esc(t("account.delete")) + "</button></div>";
    }
    return html + '<p class="acct-privacy">' + esc(t("account.pricesStay")) + "</p>" + advancedHtml() + "</div></div>";
  }

  // Drawn under My binder's title (app.js paintResult draws the header);
  // redrawn only when something in it changed, with focus kept.
  var drawnCard = { box: null, html: "" };
  function drawAccountCard() {
    if (!accountsOn) return;
    var box = $("mine-account");
    if (!box) {
      var head = document.querySelector("#result .result-header.is-mine");
      if (!head) return;
      box = document.createElement("section");
      box.className = "mine-summary mine-acct";
      box.id = "mine-account";
      box.tabIndex = -1;
      head.parentNode.insertBefore(box, head.nextSibling);
    }
    box.setAttribute("aria-label", t("account.card"));
    var html = accountCardHtml();
    if (drawnCard.box !== box || drawnCard.html !== html) {
      var focus = acct.focusPending ? "" : focusKey(document.activeElement, box);
      box.innerHTML = html;
      drawnCard = { box: box, html: html };
      var again = focus ? box.querySelector(focus) : null;
      if (again) again.focus({ preventScroll: true });
    }
    if (acct.focusPending) {
      acct.focusPending = false;
      (box.querySelector(acctUser() ? "[data-acct-status]" : '[data-sum="acct-in"]') || box).focus({ preventScroll: true });
    }
  }

  // The top bar's way in (index.html): "Sign in", or your initial with a dot
  // for how saving is going. Hidden, and the page as before, while accounts
  // are off.
  var PERSON_ICON = '<svg class="acct-link-icon" viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges">' +
    '<path d="M6 1h4v1h1v5h-1v1H6V7H5V2h1z"/><path d="M4 9h8v1h1v1h1v4H2v-4h1v-1h1z"/></svg>';
  function acctDot() {
    if (acct.state === "busy") return "is-busy";
    if (acctTrouble()) return "is-warn";
    return acct.at ? "is-ok" : "";
  }
  var topDrawn = "";
  function drawTopButton() {
    var btn = $("acct-link");
    if (document.body) document.body.classList.toggle("has-accounts", accountsOn);
    if (!btn) return;
    btn.hidden = !accountsOn;
    if (!accountsOn) return;
    var user = acctUser();
    var html, label;
    if (!user) {
      html = PERSON_ICON + '<span class="acct-link-text">' + esc(t("account.signInShort")) + "</span>";
      label = t("account.topOut");
      btn.removeAttribute("title");
    } else {
      var dot = acctDot();
      var state = acctStatusText();
      html = '<span class="acct-link-initial" aria-hidden="true">' + esc(initial(user)) + "</span>" +
        (dot ? '<span class="acct-dot ' + dot + '" aria-hidden="true"></span>' : "");
      label = t("account.topIn", { who: user.name || user.email || "" }) + (state ? ". " + state : "");
      btn.title = label;
    }
    btn.classList.toggle("is-in", !!user);
    if (topDrawn !== html) btn.innerHTML = topDrawn = html;
    btn.setAttribute("aria-label", label);
  }

  // The top bar's button opens My binder (app.js, data-open-mine) with the
  // account card focused: the Google button, or "Signed in as" with More open.
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-open-account]");
    if (!btn || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    acct.focusPending = true;
    if (acctUser()) acct.menu = true;
    // Already in My binder: app.js only scrolls up, so draw it here.
    setTimeout(function () { if (acct.focusPending && $("mine-account")) drawAccountCard(); }, 0);
  });

  // Escape puts the delete question away, then "More".
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape" || !(ev.target.closest && ev.target.closest("#mine-account"))) return;
    if (acct.confirm && !acct.deleting) {
      acct.confirm = false;
      acct.error = "";
      drawSync('[data-sum="acct-delete"]');
    } else if (acct.leaveAsk) {
      acct.leaveAsk = false;
      drawSync('[data-sum="acct-out"]');
    } else if (acct.menu && !acct.confirm) {
      acct.menu = false;
      drawSync('[data-sum="acct-menu"]');
    } else return;
    ev.preventDefault();
  });

  // The GitHub panel stays open across redraws (toggle doesn't bubble).
  document.addEventListener("toggle", function (ev) {
    if (ev.target.matches && ev.target.matches("[data-acct-advanced]")) acct.advanced = ev.target.open;
  }, true);

  if (account) {
    account.onChange(function (event, detail) {
      if (event === "in") {
        accountsOn = true;
        acct.uid = acctUser().id;
        acct.at = readAcctAt();
        acct.note = "";
        acct.noteMore = "";
        acct.error = "";
        acct.first = true;
        acct.menu = false;
        scheduleAcct(0);
      } else if (event === "out") {
        clearTimeout(acct.timer);
        acct.timer = 0;
        acct.state = "";
        acct.at = "";
        acct.menu = false;
        acct.confirm = false;
        acct.leaveAsk = false;
        var uid = acct.uid;
        acct.outDone = Store.ready.then(function () { return afterOut(detail, uid); });
      } else if (event === "error") {
        acct.going = false;
        var why = { expired: "account.err.slow", offline: "account.err.signinOffline", refused: "account.err.refused" }[detail];
        acct.error = t("account.err.signin", { why: why ? t(why) : detail });
      }
      drawSync();
    });
    // Another tab signed in, refreshed or signed out.
    root.addEventListener("storage", function (ev) {
      if (ev.key === null || ev.key === "pullfolio.account") account.reload();
    });
    // Coming back from Google: the account card says what happened.
    account.finish().then(function (result) {
      if (!result) return;
      accountsOn = true;
      acct.focusPending = true;
      if (result === "in") toast(t("account.welcome", { who: who(acctUser()) }));
      drawSync();
    });
  }
  drawTopButton();

  function chipLabel() { return t(syncCfg ? "sync.chipOn" : "sync.chip"); }

  /* ---- My binder's summary card ---- */

  function backupDue(local) {
    if (!Store.model().count()) return false;
    if (syncCfg && syncCfg.at && Date.now() - new Date(syncCfg.at).getTime() < 14 * 864e5) return false;
    if (acctUser() && acct.at && Date.now() - new Date(acct.at).getTime() < 14 * 864e5) return false;
    if (!local || !local.backupAt) return true;
    var age = Date.now() - new Date(local.backupAt).getTime();
    return local.changes >= 20 || age > 14 * 864e5;
  }

  // s: core.totals() plus { priceTime, unmatched, loading }
  function summaryHtml(s) {
    var rate = api.fxRate();
    var inLira = wantsLira() && !!rate;
    var value = inLira ? liraAmount(s.value * rate) : formatUsd(s.value);
    var other = inLira ? formatUsd(s.value) : lira(s.value, rate);
    var html = '<div class="mine-sum-main"><div class="mine-total"><p class="mine-total-label">' + esc(t("sum.value")) + "</p>" +
      '<p class="mine-total-value">' + esc(s.cards ? value : "—") + "</p>" +
      (s.cards && other ? '<p class="mine-total-other">' + esc((inLira ? "" : "≈ ") + other) + "</p>" : "") + "</div>";
    html += '<dl class="mine-sum-facts">';
    var cost = inLira ? (s.costTry ? liraAmount(s.costTry) : "") : (s.cost ? formatUsd(s.cost) : "");
    html += '<div><dt>' + esc(t("sum.paid")) + "</dt><dd>" + esc(cost || "—") + "</dd></div>";
    var gainCards = inLira ? s.gainCardsTry : s.gainCards;
    if (gainCards) {
      var g = inLira ? s.gainValueBasis * rate - s.gainCostTry : s.gain;
      var base = inLira ? s.gainCostTry : s.gainCost;
      var gText = inLira ? liraAmount(Math.abs(g)) : formatUsd(Math.abs(Math.round(g * 100) / 100));
      html += '<div><dt>' + esc(t("sum.gain")) + '</dt><dd class="' + (g < 0 ? "is-loss" : "is-gain") + '">' + esc(signed(gText, g)) +
        ' <span class="mine-pct">' + esc(pct(base > 0 ? g / base : null)) + "</span></dd>" +
        '<dd class="mine-sub">' + esc(plural("sum.gainOver", gainCards)) + "</dd></div>";
    } else {
      html += '<div><dt>' + esc(t("sum.gain")) + '</dt><dd>—</dd><dd class="mine-sub">' + esc(t("sum.gainNone")) + "</dd></div>";
    }
    html += "</dl></div>";
    // Notes that name a group of cards show just those cards when clicked.
    var cover = [];
    if (s.loading) cover.push([t("sheet.priceLoading")]);
    else {
      if (s.unpriced) cover.push([plural("sum.unpriced", s.unpriced), "noPrice"]);
      if (s.gradedRaw) cover.push([plural("sum.raw", s.gradedRaw), "graded"]);
      if (s.mine) cover.push([plural("sum.mine", s.mine)]);
      if (s.unconverted) cover.push([plural("sum.unconverted", s.unconverted)]);
    }
    if (s.unmatched) cover.push([plural("sum.unmatched", s.unmatched), "unmatched"]);
    if (cover.length) html += '<div class="mine-sum-notes"><p>' + cover.map(function (c) {
      return c[1] ? '<button type="button" class="mine-note-link" data-sum="filter" data-kind="' + c[1] + '">' + esc(c[0]) + "</button>" : esc(c[0]);
    }).join(" · ") + "</p></div>";
    if (s.cards) html += shelfTabsHtml() + (shelf.open && shelf.open !== "sync" ? '<div class="mine-shelf" id="mine-shelf" role="region" aria-label="' +
      esc(t(shelfLabel(shelf.open))) + '">' + shelfHtml(s) + "</div>" : "");
    var local = Store.model().doc.local;
    var due = backupDue(local);
    var syncOpen = shelf.open === "sync";
    // The open panel says how sync is doing; the row then shows the last
    // backup. How an account is saving is in the account card at the top.
    var synced = syncOpen ? "" : syncStatusText();
    var trouble = syncTrouble();
    html += '<div class="mine-sum-tools">' +
      (rate ? '<button type="button" class="mine-chip' + (inLira ? " is-on" : "") + '" data-sum="lira" aria-pressed="' + inLira + '">' + esc(t("sum.inLira")) + "</button>" : "") +
      '<span class="mine-backup' + (due || (synced && trouble) ? " is-due" : "") + '">' +
        esc(synced || (local && local.backupAt ? t("backup.last", { date: day(local.backupAt) }) : t("backup.never"))) + "</span>" +
      '<button type="button" class="mine-chip' + (due ? " is-due" : "") + '" data-sum="backup">' + esc(t("backup.download")) + "</button>" +
      '<button type="button" class="mine-chip" data-sum="import">' + esc(t("backup.load")) + "</button>" +
      '<button type="button" class="mine-chip" data-sum="csv">' + esc(t("backup.csv")) + "</button>" +
      (accountsOn ? "" : '<button type="button" class="mine-chip' + (syncOpen ? " is-on" : "") + '" data-sum="shelf" data-val="sync" aria-expanded="' + syncOpen + '"' +
        (syncOpen ? ' aria-controls="mine-sync-panel"' : "") + ">" + esc(chipLabel()) + "</button>") +
      "</div>" +
      (syncOpen ? '<div class="mine-shelf" id="mine-sync-panel" role="region" aria-label="' + esc(t("sync.chip")) + '">' + syncHtml() + "</div>" : "") +
      (Store.volatile ? '<p class="mine-note is-warn">' + esc(t("store.volatile")) + "</p>" : "") +
      '<div data-mine-import aria-live="polite">' + importHtml() + "</div>";
    return html;
  }

  /* ---- the summary card's drawer: Breakdown, Value over time, Top movers ---- */

  var SHELVES = [["breakdown", "shelf.breakdown"], ["history", "shelf.history"], ["movers", "movers.title"]];
  function shelfLabel(name) {
    for (var i = 0; i < SHELVES.length; i++) if (SHELVES[i][0] === name) return SHELVES[i][1];
    return "";
  }

  function shelfTabsHtml() {
    return '<div class="mine-shelf-tabs">' + SHELVES.map(function (s) {
      var on = shelf.open === s[0];
      return '<button type="button" class="mine-chip mine-tab' + (on ? " is-on" : "") + '" data-sum="shelf" data-val="' + s[0] +
        '" aria-expanded="' + on + '"' + (on ? ' aria-controls="mine-shelf"' : "") + ">" + esc(t(s[1])) + "</button>";
    }).join("") + "</div>";
  }

  // A row of pressed/unpressed choices inside a panel.
  function segHtml(act, options, on, label) {
    return '<div class="mine-choices" role="group" aria-label="' + esc(label) + '">' + options.map(function (o) {
      var is = String(on) === o[0];
      return '<button type="button" class="mine-chip' + (is ? " is-on" : "") + '" data-sum="' + act + '" data-val="' + o[0] +
        '" aria-pressed="' + is + '">' + esc(t(o[1])) + "</button>";
    }).join("") + "</div>";
  }

  // Amounts in the panels follow the summary's "Show in ₺".
  function amount(usd) {
    var rate = api.fxRate();
    return wantsLira() && rate ? liraAmount(usd * rate) : formatUsd(usd);
  }
  function shareText(p) {
    return t("by.share", { n: p > 0 && p < 0.01 ? "<1" : num(Math.round(p * 100)) });
  }

  function shelfHtml(s) {
    if (shelf.open === "breakdown") return breakdownHtml(s);
    ensureMarket(s);
    if (shelf.open === "history") return historyHtml();
    return moversHtml(s);
  }

  // Loads the history files of the Pokémon in My binder (once each) and
  // turns them into each card's weekly market price. Run again when the
  // cards change, or when today's price names a different subtype.
  function ensureMarket(s) {
    if (!Hist) return;
    var cards = {};
    Store.model().all().forEach(function (c) {
      if (cards[c.card] || !c.snap.pid) return;
      cards[c.card] = { copy: c, price: s.priceOf ? s.priceOf(c) : null };
    });
    var ids = Object.keys(cards).sort();
    var sig = ids.map(function (id) {
      var e = cards[id];
      return e.copy.species + "/" + id + "/" + ((e.price && e.price.subtype) || "");
    }).join(",");
    if (sig === market.sig) return;
    market.sig = sig;
    var keys = [];
    ids.forEach(function (id) {
      var k = cards[id].copy.species;
      if (k && keys.indexOf(k) === -1) keys.push(k);
    });
    if (!keys.length) {
      market.history = null;
      market.loading = false;
      return;
    }
    market.loading = true;
    Promise.all(keys.map(function (k) { return Hist.load(k); })).then(function (loaded) {
      if (market.sig !== sig) return;
      var files = {};
      keys.forEach(function (k, i) { files[k] = loaded[i]; });
      market.history = Hist.toHistory(ids.map(function (id) {
        var c = cards[id].copy;
        var file = files[c.species];
        var card = { productId: c.snap.pid, variant: c.snap.variant, rarity: c.snap.rarity, name: c.snap.name, price: cards[id].price };
        return { id: id, points: file ? Hist.cardPoints(card, file, c.snap.pidUnique) : [] };
      }));
      market.loading = false;
      if (shelf.open === "history" || shelf.open === "movers") renderSummary();
    });
  }

  // This browser's saved prices with the weekly market prices under them
  // (a day both have keeps this browser's).
  var merged = { mine: null, theirs: null, history: null };
  function chartHistory() {
    var theirs = market.history && market.history.days.length ? market.history : null;
    if (!theirs) return history;
    if (merged.history && merged.mine === history && merged.theirs === theirs) return merged.history;
    merged = { mine: history, theirs: theirs, history: core.mergeHistory(history, theirs) };
    return merged.history;
  }

  // Breakdown (§4.4): rows by set (grouped by language), language or
  // Pokémon, biggest value first. A row filters the binder to its cards.
  var LANG_ORDER = ["ENG", "JP", "CN"];
  function langRank(lang) {
    var i = LANG_ORDER.indexOf(lang);
    return i === -1 ? LANG_ORDER.length : i;
  }

  function breakdownHtml(s) {
    var b = core.breakdown(Store.model().all(), s.priceOf, shelf.by);
    var rows = b.rows.slice();
    if (shelf.by === "set") {
      rows.sort(function (x, y) {
        return langRank(x.lang) - langRank(y.lang) || (x.lang < y.lang ? -1 : x.lang > y.lang ? 1 : 0) || y.value - x.value || y.cards - x.cards;
      });
    }
    var top = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0);
    var html = segHtml("by", [["set", "by.set"], ["lang", "by.lang"], ["pokemon", "by.pokemon"]], shelf.by, t("shelf.breakdown"));
    html += '<ul class="mine-rows">';
    var lastLang = null;
    rows.forEach(function (r) {
      if (shelf.by === "set" && r.lang !== lastLang) {
        lastLang = r.lang;
        html += '<li class="mine-rows-head" lang="en">' + esc(r.lang || "—") + "</li>";
      }
      var name = shelf.by === "lang" ? r.lang || "—" : shelf.by === "pokemon" ? api.speciesName(r.species) : r.set || "—";
      var share = b.total > 0 ? r.value / b.total : 0;
      var cards = plural("count.cards", r.cards);
      var value = r.value ? amount(r.value) : "—";
      var part = r.value ? shareText(share) : "";
      html += '<li><button type="button" class="mine-row" data-sum="filter" data-kind="' + shelf.by + '" data-val="' + esc(r.key) +
        '" aria-label="' + esc(t("by.row", { name: name, cards: cards, value: value })) + '">' +
        '<span class="mine-row-name"' + (shelf.by === "lang" ? ' lang="en"' : "") + ">" + esc(name) + "</span>" +
        '<span class="mine-row-cards">' + esc(cards) + "</span>" +
        '<span class="mine-row-value">' + esc(value) + "</span>" +
        '<span class="mine-row-share">' + esc(part) + "</span>" +
        '<span class="mine-row-bar" aria-hidden="true"><span' + (r.value && r.value === top ? ' class="is-top"' : "") +
        ' style="width:' + (share * 100).toFixed(1) + '%"></span></span>' +
        "</button></li>";
    });
    html += "</ul>";
    if (b.unpriced) html += '<p class="mine-shelf-note">' + esc(plural("sum.unpriced", b.unpriced)) + "</p>";
    return html;
  }

  // Value over time (§4.3): what the cards you have now were worth each
  // week, from their market prices since they were first priced (and this
  // browser's own saved days), against all you paid for them.
  var RANGES = [["30", "range.30"], ["90", "range.90"], ["365", "range.365"], ["all", "range.all"]];
  var ALONG = { allAlong: true };

  function historyHtml() {
    var copies = Store.model().all();
    var h = chartHistory();
    var to = today();
    var from = shelf.range === "all" ? core.firstDay(h, copies, ALONG) || to : core.shiftDay(to, -Number(shelf.range));
    if (from > to) from = to;
    var series = core.valueSeries(h, copies, from, to, ALONG);
    var lastV = series.value.length ? series.value[series.value.length - 1].value : null;
    var lastC = series.cost[series.cost.length - 1].value;
    var html = segHtml("range", RANGES, shelf.range, t("shelf.history")) +
      '<div class="mine-legend"><span class="mine-key is-value">' + esc(t("history.value")) + " <b>" + esc(lastV != null ? formatUsd(lastV) : "—") + "</b></span>" +
      (lastC ? '<span class="mine-key is-cost">' + esc(t("history.paid")) + " <b>" + esc(formatUsd(lastC)) + "</b></span>" : "") + "</div>";
    var loading = market.loading ? '<p class="mine-shelf-note">' + esc(t("history.loading")) + "</p>" : "";
    if (!series.value.length) {
      return html + (loading || '<p class="mine-shelf-note">' + esc(t("history.none")) + "</p>");
    }
    var marketDays = market.history && market.history.days;
    var note = marketDays && marketDays.length ?
      t("history.market", { date: day(marketDays[0].date) }) :
      t("history.note", { date: day(h.days[0].date) });
    return html + chartHtml(series, from, to, lastV, lastC) + loading +
      '<p class="mine-shelf-note">' + esc(note) + "</p>";
  }

  function dayNumber(date) { return Math.round(new Date(date + "T00:00:00Z").getTime() / 864e5); }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }
  // Whole dollars on the scale, cents when it tops out under $10.
  function usdShort(v, max) { return max < 10 ? formatUsd(v) : "$" + num(Math.round(v)); }

  // The chart stretches to the card's width: the lines are SVG with
  // non-scaling strokes, the labels HTML, and the 4 px grid the frame's
  // background, so text and lines stay the same size on a phone. `caption`
  // is what a screen reader hears (the binder's summary by default).
  function chartHtml(series, from, to, lastV, lastC, caption) {
    // Each day is a slot, today's included, so the last step has a width.
    var x0 = dayNumber(from);
    var x1 = dayNumber(to) + 1;
    if (x1 <= x0) x0 = x1 - 1;
    var max = niceMax(Math.max.apply(null, series.value.concat(series.cost).map(function (p) { return p.value; }).concat([0])));
    function X(d) { return Math.round((dayNumber(d) - x0) / (x1 - x0) * 1000 * 10) / 10; }
    function Y(v) { return Math.round((96 - v / max * 92) * 10) / 10; }
    function steps(points) {
      if (!points.length) return "";
      var d = "M" + X(points[0].date) + " " + Y(points[0].value);
      for (var i = 1; i < points.length; i++) d += "H" + X(points[i].date) + "V" + Y(points[i].value);
      return d + "H1000";
    }
    var grid = [0, max / 2, max];
    var label = caption || t("history.summary", { date: day(to), value: lastV != null ? formatUsd(lastV) : "—", paid: lastC ? formatUsd(lastC) : "—" });
    return '<figure class="mine-chart"><div class="mine-chart-plot">' +
      grid.map(function (v) { return '<span class="mine-chart-y" style="--y:' + Y(v) + '">' + esc(usdShort(v, max)) + "</span>"; }).join("") +
      '<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      grid.map(function (v) { return '<line x1="0" x2="1000" y1="' + Y(v) + '" y2="' + Y(v) + '" class="mine-chart-rule"/>'; }).join("") +
      '<path class="mine-chart-cost" d="' + steps(series.cost) + '"/>' +
      '<path class="mine-chart-value" d="' + steps(series.value) + '"/>' +
      "</svg></div>" +
      '<div class="mine-chart-x"><span>' + esc(day(from)) + "</span><span>" + esc(day(to)) + "</span></div>" +
      '<figcaption class="sr-only">' + esc(label) + "</figcaption></figure>";
  }

  // A printing's market price over time for the card file, from [{ date,
  // usd }] (the last one today's): the chart and where the prices come from.
  // Empty without two points to draw.
  function priceChartHtml(points) {
    if (!points || points.length < 2) return "";
    var from = points[0].date;
    var to = points[points.length - 1].date;
    var usd = points.map(function (p) { return p.usd; });
    var last = usd[usd.length - 1];
    var caption = t("sheet.historySummary", {
      from: day(from), to: day(to), first: formatUsd(usd[0]), last: formatUsd(last),
      low: formatUsd(Math.min.apply(null, usd)), high: formatUsd(Math.max.apply(null, usd))
    });
    var series = { value: points.map(function (p) { return { date: p.date, value: p.usd }; }), cost: [] };
    return chartHtml(series, from, to, last, 0, caption) +
      '<p class="sheet-history-note">' + esc(t("sheet.historyNote", { date: day(from) })) + "</p>";
  }

  // Top movers (§4.5): price now against the market price a week, 30 days
  // or a year back, by the change in dollars times the copies you own.
  function moversHtml(s) {
    var byCard = {};
    Store.model().all().forEach(function (c) {
      var e = byCard[c.card] || (byCard[c.card] = { id: c.card, qty: 0, now: 0, snap: c.snap });
      e.qty += c.qty;
      var p = s.priceOf ? s.priceOf(c) : null;
      if (p && p.value > 0) e.now = p.value;
    });
    var cards = Object.keys(byCard).map(function (k) { return byCard[k]; });
    var r = core.movers(chartHistory(), cards, today(), Number(shelf.days));
    var html = segHtml("days", [["7", "range.7"], ["30", "range.30"], ["365", "range.365"]], shelf.days, t("movers.title"));
    if (!r.ready) {
      if (market.loading) return html + '<p class="mine-shelf-note">' + esc(t("history.loading")) + "</p>";
      return html + '<p class="mine-shelf-note">' + esc(t(shelf.days === "365" ? "movers.wait365" : shelf.days === "30" ? "movers.wait30" : "movers.wait")) +
        (r.first ? " " + esc(t("movers.first", { date: day(r.first) })) : "") + "</p>";
    }
    return html + '<p class="mine-shelf-note">' + esc(t("movers.since", { date: day(r.since) })) + "</p>" +
      '<div class="mine-movers">' + moverList("movers.up", r.up, byCard) + moverList("movers.down", r.down, byCard) + "</div>";
  }

  function moverList(key, items, byCard) {
    var html = '<section class="mine-mover-col"><h4>' + esc(t(key)) + "</h4>";
    if (!items.length) return html + '<p class="mine-shelf-note">' + esc(t("movers.none")) + "</p></section>";
    html += "<ol>";
    items.forEach(function (x) {
      var snap = byCard[x.id].snap;
      html += '<li class="mine-mover">' +
        (snap.img ? '<img src="' + esc(snap.img) + '" alt="" loading="lazy" decoding="async" width="36" height="50">' : '<span class="mine-mover-img"></span>') +
        '<span class="mine-mover-text"><b>' + esc(snap.name) + "</b>" +
        "<span>" + esc([snap.set, snap.no, snap.variant].filter(Boolean).join(" · ") + (x.qty > 1 ? " · ×" + num(x.qty) : "")) + "</span>" +
        "<span>" + esc(amount(x.old) + " → " + amount(x.now)) + "</span></span>" +
        '<span class="mine-mover-change ' + (x.change > 0 ? "is-gain" : "is-loss") + '">' + esc(signed(amount(Math.abs(x.change)), x.change)) +
        "<small>" + esc(pct(x.pct)) + "</small></span></li>";
    });
    return html + "</ol></section>";
  }

  // Today's prices for the cards in My binder ({ cardId: usd }), saved once a
  // day for the chart and the movers.
  function recordPrices(prices, usdTry) {
    (history ? Promise.resolve(history) : Store.readHistory()).then(function (h) {
      history = core.recordDay(h, today(), prices, usdTry);
      Store.writeHistory(history);
      if (shelf.open) renderSummary();
      scheduleSync();
    });
  }

  // Redraws the card and puts focus back on the control that was used.
  function rerender(selector) {
    renderSummary();
    var el = selector ? document.querySelector(selector) : null;
    if (el) el.focus({ preventScroll: true });
  }

  // Where focus was in the summary card, so a redraw (prices arriving, a
  // sync) can put it back: a sync form field, the sync status or a button.
  function focusKey(el, box) {
    if (!el || !box.contains(el)) return "";
    if (el.name && el.form && el.form.matches("[data-sync-form]")) return '[data-sync-form] [name="' + el.name + '"]';
    if (el.hasAttribute("data-sync-status")) return "[data-sync-status]";
    if (el.hasAttribute("data-acct-status")) return "[data-acct-status]";
    if (el.matches("[data-acct-advanced] > summary")) return "[data-acct-advanced] > summary";
    var act = el.getAttribute("data-sum");
    if (!act) return "";
    var val = el.getAttribute("data-val");
    var kind = el.getAttribute("data-kind");
    var q = function (v) { return root.CSS && root.CSS.escape ? root.CSS.escape(v) : v.replace(/["\\]/g, "\\$&"); };
    return '[data-sum="' + q(act) + '"]' + (val ? '[data-val="' + q(val) + '"]' : "") + (kind ? '[data-kind="' + q(kind) + '"]' : "");
  }

  var lastSummary = null;
  function renderSummary(stats) {
    if (stats) lastSummary = stats;
    drawAccountCard();
    var box = $("mine-summary");
    if (!box || !lastSummary) return;
    var focus = focusKey(document.activeElement, box);
    box.innerHTML = summaryHtml(lastSummary);
    if (focus) {
      var again = box.querySelector(focus);
      if (again) again.focus({ preventScroll: true });
    }
  }

  // The empty binder's help, with a way to bring a backup back.
  function emptyHtml() {
    return '<div class="mine-empty"><p>' + esc(t("mine.empty")) + "</p>" +
      '<div class="mine-sum-tools"><button type="button" class="mine-chip" data-sum="import">' + esc(t("backup.load")) + "</button>" +
      (accountsOn ? "" : '<button type="button" class="mine-chip" data-sum="shelf" data-val="sync" aria-expanded="' + (shelf.open === "sync") + '">' +
        esc(chipLabel()) + "</button>") + "</div>" +
      (Store.volatile ? '<p class="mine-note is-warn">' + esc(t("store.volatile")) + "</p>" : "") +
      '<div class="mine-shelf" data-mine-sync-empty' + (shelf.open === "sync" ? ">" + syncHtml() : " hidden>") + "</div>" +
      '<div data-mine-import aria-live="polite">' + importHtml() + "</div></div>";
  }

  // The summary card's and the empty state's buttons, wherever they are drawn.
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-sum]");
    if (!btn) return;
    var act = btn.getAttribute("data-sum");
    if (act === "lira") {
      try { root.localStorage.setItem(LIRA_STORE, wantsLira() ? "0" : "1"); } catch (e) { /* not remembered */ }
      renderSummary();
      var again = document.querySelector('[data-sum="lira"]');
      if (again) again.focus({ preventScroll: true });
    } else if (act === "backup") downloadBackup(false);
    else if (act === "csv") downloadCsv();
    else if (act === "import") pickImport();
    else if (act === "import-cancel") showImport(null);
    else if (act === "import-merge") finishImport("merge");
    else if (act === "import-replace") finishImport("replace");
    else if (act === "shelf") {
      var name = btn.getAttribute("data-val");
      shelf.open = shelf.open === name ? "" : name;
      drawSync('[data-sum="shelf"][data-val="' + name + '"]');
    } else if (act === "sync-now") syncNow();
    else if (act === "sync-off") disconnectSync();
    else if (act === "acct-in") signInWithGoogle();
    else if (act === "acct-now") { if (acct.state !== "busy") acctNow(); }
    else if (act === "acct-menu") {
      if (acct.deleting) return;
      acct.menu = !acct.menu;
      if (!acct.menu) { acct.confirm = false; acct.leaveAsk = false; acct.error = ""; }
      drawSync('[data-sum="acct-menu"]');
    }
    else if (act === "acct-out") signOutHere(false);
    else if (act === "acct-leave-anyway") signOutHere(true);
    else if (act === "acct-stay") {
      acct.leaveAsk = false;
      drawSync('[data-sum="acct-out"]');
    }
    else if (act === "acct-download") downloadBackup(false);
    else if (act === "acct-delete") {
      acct.confirm = true;
      acct.error = "";
      drawSync('[data-sum="acct-delete-no"]');
    } else if (act === "acct-delete-no") {
      if (acct.deleting) return;
      acct.confirm = false;
      acct.error = "";
      drawSync('[data-sum="acct-delete"]');
    } else if (act === "acct-delete-yes") deleteMyData();
    else if (act === "by" || act === "range" || act === "days") {
      shelf[act] = btn.getAttribute("data-val");
      rerender('[data-sum="' + act + '"][data-val="' + shelf[act] + '"]');
    } else if (act === "filter") {
      // A breakdown row or a note: show just those cards in the binder below.
      var kind = btn.getAttribute("data-kind");
      var key = btn.getAttribute("data-val");
      shelf.open = "";
      renderSummary();
      api.filterTo(kind, key);
    }
  });

  // Escape puts the drawer away.
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape" || !shelf.open || !(ev.target.closest && ev.target.closest("#mine-summary"))) return;
    var name = shelf.open;
    shelf.open = "";
    rerender('[data-sum="shelf"][data-val="' + name + '"]');
  });

  Store.readHistory().then(function (h) {
    history = h;
    if (shelf.open) renderSummary();
  });

  Store.onChange(function (reason) {
    if (shown && !slip) render();
    if (reason !== "rates") renderSummary();
    if (reason === "load") ensureRates();
    // Opening the site syncs; another tab's save is that tab's to send.
    if (reason === "load") { scheduleSync(1500); scheduleAcct(1500); }
    // Another tab saved: its saved prices may have changed too (a "Delete my
    // data" there clears them).
    else if (reason === "reload") Store.readHistory().then(function (h) { history = h; });
    // What one sync merged in still goes to the other.
    else if (reason !== "backup" && reason !== "clear") {
      if (!syncApplying) scheduleSync();
      if (!acct.applying) scheduleAcct();
    }
  });

  root.PullfolioMine = {
    init: function (hooks) { Object.keys(hooks || {}).forEach(function (k) { api[k] = hooks[k]; }); },
    pocketInfo: pocketInfo,
    showCard: showCard,
    updateCard: updateCard,
    hideCard: hideCard,
    isEditing: function () { return !!slip; },
    accountsOn: function () { return accountsOn; },
    renderSummary: renderSummary,
    emptyHtml: emptyHtml,
    toast: toast,
    recordPrices: recordPrices,
    chartHtml: chartHtml,
    priceChartHtml: priceChartHtml,
    today: today,
    syncNow: syncNow,
    relabel: function () {
      if (shown && !slip) render();
      drawSync();
      if (pendingImport) showImport(pendingImport);
    },
    ensureRates: ensureRates
  };
})(window);
