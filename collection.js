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
  var $ = function (id) { return document.getElementById(id); };

  var api = { fxRate: function () { return null; }, speciesName: function (key) { return key; } };
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
  function toast(text, undo) {
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
      (undo ? '<button type="button" class="mine-toast-undo">' + esc(t("undo")) + "</button>" : "");
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
    if (copies.some(function (c) { return c.unmatched; })) html += '<p class="mine-note is-warn">' + esc(t("own.unmatched")) + "</p>";
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
    html += '<details class="mine-extra is-wide"' + (copy && (copy.value || copy.note) ? " open" : "") + "><summary>" + esc(t("own.extra")) + "</summary>" +
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
    if (focus === "slip") {
      var first = box.querySelector("select, input");
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
    var doc = core.exportDoc(Store.model().doc);
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
    toast(t("backup.loaded", { n: num(Store.model().count()) }));
    ensureRates();
  }

  /* ---- My binder's summary card ---- */

  function backupDue(local) {
    if (!Store.model().count()) return false;
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
    var cover = [];
    if (s.loading) cover.push(t("sheet.priceLoading"));
    else {
      if (s.unpriced) cover.push(plural("sum.unpriced", s.unpriced));
      if (s.gradedRaw) cover.push(plural("sum.raw", s.gradedRaw));
      if (s.mine) cover.push(plural("sum.mine", s.mine));
      if (s.unconverted) cover.push(plural("sum.unconverted", s.unconverted));
    }
    if (s.unmatched) cover.push(plural("sum.unmatched", s.unmatched));
    if (cover.length) html += '<div class="mine-sum-notes"><p>' + esc(cover.join(" · ")) + "</p></div>";
    var local = Store.model().doc.local;
    var due = backupDue(local);
    html += '<div class="mine-sum-tools">' +
      (rate ? '<button type="button" class="mine-chip' + (inLira ? " is-on" : "") + '" data-sum="lira" aria-pressed="' + inLira + '">' + esc(t("sum.inLira")) + "</button>" : "") +
      '<span class="mine-backup' + (due ? " is-due" : "") + '">' +
        esc(local && local.backupAt ? t("backup.last", { date: day(local.backupAt) }) : t("backup.never")) + "</span>" +
      '<button type="button" class="mine-chip' + (due ? " is-due" : "") + '" data-sum="backup">' + esc(t("backup.download")) + "</button>" +
      '<button type="button" class="mine-chip" data-sum="import">' + esc(t("backup.load")) + "</button>" +
      '<button type="button" class="mine-chip" data-sum="csv">' + esc(t("backup.csv")) + "</button>" +
      "</div>" +
      (Store.volatile ? '<p class="mine-note is-warn">' + esc(t("store.volatile")) + "</p>" : "") +
      '<div data-mine-import aria-live="polite">' + importHtml() + "</div>";
    return html;
  }

  var lastSummary = null;
  function renderSummary(stats) {
    if (stats) lastSummary = stats;
    var box = $("mine-summary");
    if (!box || !lastSummary) return;
    box.innerHTML = summaryHtml(lastSummary);
  }

  // The empty binder's help, with a way to bring a backup back.
  function emptyHtml() {
    return '<div class="mine-empty"><p>' + esc(t("mine.empty")) + "</p>" +
      '<div class="mine-sum-tools"><button type="button" class="mine-chip" data-sum="import">' + esc(t("backup.load")) + "</button></div>" +
      (Store.volatile ? '<p class="mine-note is-warn">' + esc(t("store.volatile")) + "</p>" : "") +
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
  });

  Store.onChange(function (reason) {
    if (shown && !slip) render();
    if (reason !== "rates") renderSummary();
    if (reason === "load") ensureRates();
  });

  root.PullfolioMine = {
    init: function (hooks) { Object.keys(hooks || {}).forEach(function (k) { api[k] = hooks[k]; }); },
    pocketInfo: pocketInfo,
    showCard: showCard,
    updateCard: updateCard,
    hideCard: hideCard,
    isEditing: function () { return !!slip; },
    renderSummary: renderSummary,
    emptyHtml: emptyHtml,
    toast: toast,
    relabel: function () {
      if (shown && !slip) render();
      renderSummary();
      if (pendingImport) showImport(pendingImport);
    },
    ensureRates: ensureRates
  };
})(window);
