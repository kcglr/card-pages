/* PullfolioCore: the collection's logic, with no DOM and no storage, so the
   node:test files can run all of it (tests/collection-core.test.js).
   docs/COLLECTION-PLAN.md describes the format and the rules.

   A collection is a list of copies. One copy entry is a batch of identical
   cards: the printing (`card`, a catalog id), how many, their condition or
   grade, what was paid and when, and a snapshot of the card's catalog facts
   (`snap`) so the collection still shows and prices it if the catalog
   changes. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PullfolioCore = factory();
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var FORMAT = "pullfolio-collection";
  var VERSION = 1;
  var CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];
  var GRADERS = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "Other"];
  var GRADES = ["Black Label 10", "Pristine 10", "10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5",
    "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"];
  var CURRENCIES = ["USD", "TRY", "EUR"];
  var MAX_QTY = 999;
  var MAX_MONEY = 10000000;
  var MAX_COPIES = 20000;
  var MAX_FILE = 20 * 1024 * 1024;
  var IMAGE_HOST = /^https:\/\/pokecottagecdn\.com\/[^\s"'<>]*$/;

  /* ---- small helpers ---- */

  function str(value, max) {
    if (value == null) return "";
    // eslint-disable-next-line no-control-regex
    return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max || 200);
  }
  function isoDay(value) {
    var s = str(value, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(s)) return "";
    var d = new Date(s + "T00:00:00Z");
    return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? "" : s;
  }
  function isoTime(value, fallback) {
    var s = str(value, 40);
    var d = s ? new Date(s) : null;
    return d && !isNaN(d.getTime()) && /^\d{4}-/.test(s) ? d.toISOString() : fallback;
  }
  function money(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n <= MAX_MONEY ? Math.round(n * 100) / 100 : null;
  }
  function rate(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n < 1e6 ? n : null;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function newer(a, b) { return String(a || "") > String(b || ""); }

  // Lower case, Turkish letters and accents folded, punctuation dropped: the
  // same folding app.js uses for names.
  function fold(value) {
    var text = String(value == null ? "" : value);
    text = text.replace(/[İI]/g, "i").replace(/ı/g, "i").toLowerCase();
    text = text.replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c");
    if (text.normalize) text = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return text.replace(/[^a-z0-9]+/g, "");
  }

  function newUid(random) {
    var rand = random || Math.random;
    var out = "c_";
    for (var i = 0; i < 10; i++) out += "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(rand() * 36));
    return out;
  }

  function speciesNumber(key) {
    var m = /^(\d+)-/.exec(String(key || ""));
    return m ? Number(m[1]) : 0;
  }

  /* ---- a card's snapshot and signature ---- */

  // How many printings in a Pokémon's file share each TCGplayer product.
  function pidCounts(cards) {
    var counts = {};
    (cards || []).forEach(function (c) {
      if (c && c.productId) counts[String(c.productId)] = (counts[String(c.productId)] || 0) + 1;
    });
    return counts;
  }

  // The catalog facts kept with a copy. `counts` is pidCounts() of the card's
  // Pokémon file, so it can still be priced without that file.
  function snapOf(card, counts) {
    var pid = /^\d{1,12}$/.test(String(card.productId || "")) ? String(card.productId) : "";
    return cleanSnap({
      name: card.name, lang: card.lang, set: card.setName || String(card.set || "").split(" · ")[0],
      no: card.cardNumber, variant: card.variant, rarity: card.rarity, released: card.released,
      pid: pid, pidUnique: pid ? (counts ? counts[pid] === 1 : !!card.pidUnique) : false,
      img: card.image, imgL: card.imageLarge
    });
  }

  function cleanSnap(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    var img = str(raw.img, 400);
    var imgL = str(raw.imgL, 400);
    var pid = str(raw.pid, 12);
    return {
      name: str(raw.name, 120),
      lang: str(raw.lang, 8).toUpperCase(),
      set: str(raw.set, 160),
      no: str(raw.no, 40),
      variant: str(raw.variant, 80),
      rarity: str(raw.rarity, 160),
      released: isoDay(raw.released),
      pid: /^\d{1,12}$/.test(pid) ? pid : "",
      pidUnique: !!raw.pidUnique && /^\d{1,12}$/.test(pid),
      img: IMAGE_HOST.test(img) ? img : "",
      imgL: IMAGE_HOST.test(imgL) ? imgL : ""
    };
  }

  // A printing as a product, so a card filed under two Pokémon (a tag-team
  // card) is one card: its TCGplayer product, variant, language, set and
  // number. Empty without a product id.
  function signature(card) {
    var pid = card.pid != null ? card.pid : card.productId;
    if (!pid) return "";
    var set = card.set != null && card.pid != null ? card.set : (card.setName || String(card.set || "").split(" · ")[0]);
    var no = card.no != null ? card.no : card.cardNumber;
    return [pid, card.variant, card.lang, fold(set), no].map(function (x) { return String(x || "").toLowerCase(); }).join("|");
  }

  /* ---- one copy entry ---- */

  function cleanCond(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    if (raw.kind === "graded") {
      var cert = str(raw.cert, 30).replace(/[^A-Za-z0-9-]/g, "");
      return {
        kind: "graded",
        by: GRADERS.indexOf(raw.by) !== -1 ? raw.by : "Other",
        grade: GRADES.indexOf(String(raw.grade)) !== -1 ? String(raw.grade) : "10",
        cert: cert
      };
    }
    return { kind: "raw", grade: CONDITIONS.indexOf(raw.grade) !== -1 ? raw.grade : "NM" };
  }

  function cleanPaid(raw) {
    if (!raw || typeof raw !== "object") return null;
    var amount = money(raw.amount);
    if (!amount) return null;
    var cur = CURRENCIES.indexOf(raw.cur) !== -1 ? raw.cur : "USD";
    var usd = cur === "USD" ? amount : money(raw.usd);
    return { amount: amount, cur: cur, usd: usd, "try": cur === "TRY" ? amount : money(raw["try"]), rateDate: isoDay(raw.rateDate) };
  }

  // Any copy, from the form, a backup or a sync, goes through here: unknown
  // fields are dropped, numbers clamped, text trimmed and image links kept
  // only on the catalog's image host. Returns null if it isn't a copy.
  function cleanCopy(raw, now, random) {
    if (!raw || typeof raw !== "object") return null;
    var card = str(raw.card, 160);
    var species = str(raw.species, 80);
    if (!card || !/^\d+-[a-z0-9-]+$/.test(species)) return null;
    var stamp = now || new Date().toISOString();
    var qty = Math.floor(Number(raw.qty));
    var uid = /^c_[a-z0-9]{6,24}$/.test(String(raw.uid || "")) ? String(raw.uid) : newUid(random);
    var moved = Array.isArray(raw.moved) ? raw.moved.slice(-10).map(function (m) { return str(m, 160); }).filter(Boolean) : [];
    var copy = {
      uid: uid,
      card: card,
      species: species,
      qty: isFinite(qty) ? Math.max(1, Math.min(MAX_QTY, qty)) : 1,
      cond: cleanCond(raw.cond),
      paid: cleanPaid(raw.paid),
      bought: isoDay(raw.bought),
      value: money(raw.value),
      note: str(raw.note, 500),
      added: isoTime(raw.added, stamp),
      updated: isoTime(raw.updated, stamp),
      snap: cleanSnap(raw.snap)
    };
    if (moved.length) copy.moved = moved;
    if (raw.unmatched) copy.unmatched = true;
    return copy;
  }

  function gradeLabel(copy) {
    var c = copy && copy.cond;
    if (!c || c.kind !== "graded") return "";
    return (c.by === "Other" ? "" : c.by + " ") + c.grade;
  }

  /* ---- the whole collection ---- */

  function emptyDoc() {
    return { format: FORMAT, version: VERSION, updated: "", catalog: "", settings: {}, copies: [], removed: [] };
  }

  // Moves an older file format forward. Version 1 is the first.
  function migrate(doc) {
    return doc;
  }

  function cleanDoc(raw, now) {
    var doc = emptyDoc();
    if (!raw || typeof raw !== "object") return doc;
    raw = migrate(raw);
    var seen = {};
    (Array.isArray(raw.copies) ? raw.copies.slice(0, MAX_COPIES) : []).forEach(function (c) {
      var copy = cleanCopy(c, now);
      if (copy && !seen[copy.uid]) { seen[copy.uid] = true; doc.copies.push(copy); }
    });
    var gone = {};
    (Array.isArray(raw.removed) ? raw.removed.slice(-MAX_COPIES) : []).forEach(function (r) {
      if (!r || !/^c_[a-z0-9]{6,24}$/.test(String(r.uid || ""))) return;
      var at = isoTime(r.at, "");
      if (at && (!gone[r.uid] || newer(at, gone[r.uid]))) gone[r.uid] = at;
    });
    doc.removed = Object.keys(gone).map(function (uid) { return { uid: uid, at: gone[uid] }; });
    doc.updated = isoTime(raw.updated, "");
    doc.catalog = str(raw.catalog, 40);
    var settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    if (CURRENCIES.indexOf(settings.currency) !== -1) doc.settings.currency = settings.currency;
    if (raw.local && typeof raw.local === "object") {
      doc.local = { backupAt: isoTime(raw.local.backupAt, ""), changes: Math.max(0, Math.floor(Number(raw.local.changes) || 0)) };
    }
    return doc;
  }

  // Two copies of the collection (this device and a backup, or another
  // device) become one: per entry the newer edit wins, and a removal wins
  // over anything older than it.
  function merge(a, b) {
    a = cleanDoc(a);
    b = cleanDoc(b);
    var gone = {};
    a.removed.concat(b.removed).forEach(function (r) {
      if (!gone[r.uid] || newer(r.at, gone[r.uid])) gone[r.uid] = r.at;
    });
    var byUid = {};
    a.copies.concat(b.copies).forEach(function (c) {
      if (!byUid[c.uid] || newer(c.updated, byUid[c.uid].updated)) byUid[c.uid] = c;
    });
    var out = emptyDoc();
    Object.keys(byUid).forEach(function (uid) {
      var c = byUid[uid];
      if (gone[uid] && !newer(c.updated, gone[uid])) return; // removed after its last edit
      delete gone[uid]; // edited (or put back) after the removal
      out.copies.push(c);
    });
    out.removed = Object.keys(gone).map(function (uid) { return { uid: uid, at: gone[uid] }; });
    out.copies.sort(function (x, y) { return x.added < y.added ? -1 : x.added > y.added ? 1 : 0; });
    out.updated = newer(a.updated, b.updated) ? a.updated : b.updated;
    out.catalog = newer(a.catalog, b.catalog) ? a.catalog : b.catalog;
    out.settings = Object.assign({}, b.settings, a.settings);
    if (a.local) out.local = a.local;
    return out;
  }

  /* ---- the model: the collection in memory, with indexes ---- */

  function Model(doc) {
    this.doc = cleanDoc(doc);
    this.reindex();
  }

  Model.prototype.reindex = function () {
    var byCard = {};
    var bySig = {};
    var byUid = {};
    this.doc.copies.forEach(function (c) {
      byUid[c.uid] = c;
      (byCard[c.card] = byCard[c.card] || []).push(c);
      var sig = signature(c.snap);
      if (sig) (bySig[sig] = bySig[sig] || []).push(c);
    });
    this.byCard = byCard;
    this.bySig = bySig;
    this.byUid = byUid;
  };

  Model.prototype.all = function () { return this.doc.copies.slice(); };
  Model.prototype.get = function (uid) { return this.byUid[uid] || null; };

  // Copies of a catalog card: by its id, else by its product signature (the
  // same card filed under another Pokémon).
  Model.prototype.copiesFor = function (card) {
    if (!card) return [];
    var own = this.byCard[card.id];
    if (own && own.length) return own.slice();
    var sig = signature(card);
    return sig && this.bySig[sig] ? this.bySig[sig].slice() : [];
  };

  Model.prototype.qtyFor = function (card) {
    return this.copiesFor(card).reduce(function (n, c) { return n + c.qty; }, 0);
  };

  Model.prototype.count = function () {
    return this.doc.copies.reduce(function (n, c) { return n + c.qty; }, 0);
  };

  Model.prototype.touch = function (now) {
    this.doc.updated = now;
    var local = this.doc.local || (this.doc.local = { backupAt: "", changes: 0 });
    local.changes = (local.changes || 0) + 1;
  };

  Model.prototype.add = function (fields, now) {
    var stamp = now || new Date().toISOString();
    var copy = cleanCopy(Object.assign({}, fields, { uid: fields.uid, added: fields.added || stamp, updated: stamp }), stamp);
    if (!copy) return null;
    if (this.byUid[copy.uid]) copy.uid = newUid();
    this.doc.copies.push(copy);
    this.doc.removed = this.doc.removed.filter(function (r) { return r.uid !== copy.uid; });
    this.touch(stamp);
    this.reindex();
    return copy;
  };

  Model.prototype.update = function (uid, fields, now) {
    var old = this.byUid[uid];
    if (!old) return null;
    var stamp = now || new Date().toISOString();
    var copy = cleanCopy(Object.assign({}, old, fields, { uid: uid, added: old.added, updated: stamp }), stamp);
    if (!copy) return null;
    this.doc.copies[this.doc.copies.indexOf(old)] = copy;
    this.touch(stamp);
    this.reindex();
    return copy;
  };

  // Returns the removed copy, for undo.
  Model.prototype.remove = function (uid, now) {
    var old = this.byUid[uid];
    if (!old) return null;
    var stamp = now || new Date().toISOString();
    this.doc.copies.splice(this.doc.copies.indexOf(old), 1);
    this.doc.removed = this.doc.removed.filter(function (r) { return r.uid !== uid; });
    this.doc.removed.push({ uid: uid, at: stamp });
    this.touch(stamp);
    this.reindex();
    return old;
  };

  // Undo of a removal: the same entry comes back, edited now so a sync keeps it.
  Model.prototype.restore = function (copy, now) {
    var stamp = now || new Date().toISOString();
    if (this.byUid[copy.uid]) return this.byUid[copy.uid];
    var back = cleanCopy(Object.assign({}, copy, { updated: stamp }), stamp);
    if (!back) return null;
    this.doc.copies.push(back);
    this.doc.copies.sort(function (x, y) { return x.added < y.added ? -1 : x.added > y.added ? 1 : 0; });
    this.doc.removed = this.doc.removed.filter(function (r) { return r.uid !== copy.uid; });
    this.touch(stamp);
    this.reindex();
    return back;
  };

  Model.prototype.replace = function (doc, now) {
    var keep = this.doc.local;
    this.doc = cleanDoc(doc);
    this.doc.local = keep;
    this.touch(now || new Date().toISOString());
    this.reindex();
  };

  Model.prototype.mergeIn = function (doc, now) {
    var keep = this.doc.local;
    this.doc = merge(this.doc, doc);
    this.doc.local = keep;
    this.touch(now || new Date().toISOString());
    this.reindex();
  };

  /* ---- collect mode: one tap per pocket ---- */

  // Nothing typed in: ungraded Near Mint, with no price paid, date, own value
  // or note. One of these with a quantity of 1 is what a tap adds.
  function isBare(copy) {
    return !!copy && copy.cond.kind === "raw" && copy.cond.grade === "NM" &&
      !copy.paid && !copy.bought && !copy.value && !copy.note;
  }

  // What a tap does to a pocket holding these copies: add one, take back the
  // single copy a tap could have made, or keep the rest. A copy with details
  // ("details") or more than one copy ("many") is never lost to a tap.
  function tapAction(copies) {
    copies = copies || [];
    if (!copies.length) return { action: "add" };
    if (copies.length === 1 && copies[0].qty === 1 && isBare(copies[0])) return { action: "remove", uid: copies[0].uid };
    var qty = copies.reduce(function (n, c) { return n + c.qty; }, 0);
    return { action: "keep", why: copies.every(isBare) ? "many" : "details", qty: qty };
  }

  // The copy a tap adds: one ungraded Near Mint card, filed under the binder
  // it was tapped in.
  function quickCopy(card, species, counts) {
    return { card: card.id, species: species, qty: 1, cond: { kind: "raw", grade: "NM" }, snap: snapOf(card, counts) };
  }

  // Master-set progress over these printings: how many you own, by id or as
  // the same product saved from another Pokémon's binder. The percentage is
  // 100 only when every one is there, and at least 1 once you own any.
  function progress(cards, model) {
    cards = cards || [];
    var owned = 0;
    cards.forEach(function (card) { if (model.qtyFor(card) > 0) owned++; });
    var total = cards.length;
    var pct = !total ? 0 : owned === total ? 100 : Math.max(owned ? 1 : 0, Math.floor(owned * 100 / total));
    return { owned: owned, total: total, pct: pct };
  }

  /* ---- staying matched when the catalog is rebuilt ---- */

  // The Pokémon a saved key points at now: the same key, else the same
  // National Dex number (its slug was renamed).
  function speciesFor(key, index) {
    var list = (index && (index.species || index)) || [];
    var n = speciesNumber(key);
    var byNumber = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i];
      if (!byNumber && n && Number(list[i].number) === n) byNumber = list[i];
    }
    return byNumber;
  }

  function one(list) { return list.length === 1 ? list[0] : null; }
  function same(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }

  // The card a saved copy is now, in its Pokémon's freshly loaded file, or
  // null. The id first, then, only where exactly one card matches: language,
  // set, number and variant; language, number, name and variant with the set
  // compared loosely; the product and variant.
  function findCard(copy, cards) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === copy.card) return { card: cards[i], rule: "id" };
    var s = copy.snap;
    var setOf = function (c) { return c.setName || String(c.set || "").split(" · ")[0]; };
    var found = one(cards.filter(function (c) {
      return same(c.lang, s.lang) && same(setOf(c), s.set) && same(c.cardNumber, s.no) && same(c.variant, s.variant);
    }));
    if (found) return { card: found, rule: "set" };
    var looseSet = fold(s.set);
    found = one(cards.filter(function (c) {
      var set = fold(setOf(c));
      return same(c.lang, s.lang) && same(c.cardNumber, s.no) && fold(c.name) === fold(s.name) && same(c.variant, s.variant) &&
        !!set && !!looseSet && (set.indexOf(looseSet) !== -1 || looseSet.indexOf(set) !== -1);
    }));
    if (found) return { card: found, rule: "name" };
    if (s.pid) {
      found = one(cards.filter(function (c) { return String(c.productId || "") === s.pid && same(c.variant, s.variant); }));
      if (found) return { card: found, rule: "product" };
    }
    return null;
  }

  // What to change on the copies saved from one Pokémon, given its file now.
  // Returns patches for Model.update(): a refreshed snapshot, a new card id
  // (the old one kept in `moved`), or the copy marked unmatched. Nothing is
  // ever removed.
  function reconcile(copies, data) {
    var cards = (data && data.cards) || [];
    var key = data && data.key;
    var counts = pidCounts(cards);
    var patches = [];
    copies.forEach(function (copy) {
      var hit = findCard(copy, cards);
      if (!hit) {
        if (!copy.unmatched) patches.push({ uid: copy.uid, fields: { unmatched: true }, kind: "unmatched" });
        return;
      }
      var snap = snapOf(hit.card, counts);
      var fields = {};
      if (JSON.stringify(snap) !== JSON.stringify(copy.snap)) fields.snap = snap;
      if (copy.unmatched) fields.unmatched = false;
      if (key && copy.species !== key) fields.species = key;
      var kind = "refresh";
      if (hit.card.id !== copy.card) {
        fields.card = hit.card.id;
        fields.moved = (copy.moved || []).concat([copy.card]);
        kind = "moved";
      }
      if (Object.keys(fields).length) patches.push({ uid: copy.uid, fields: fields, kind: kind, rule: hit.rule });
    });
    return patches;
  }

  // "Find its printing" (§5, step 5): the fields that point a copy at the
  // card you picked, and the fields that undo it. The old id goes to `moved`.
  function relink(copy, card, species, counts) {
    var fields = { card: card.id, species: species || copy.species, snap: snapOf(card, counts), unmatched: false };
    if (card.id !== copy.card) fields.moved = (copy.moved || []).concat([copy.card]);
    var undo = { card: copy.card, species: copy.species, snap: copy.snap, unmatched: !!copy.unmatched, moved: copy.moved || [] };
    return { fields: fields, undo: undo };
  }

  /* ---- what it is worth ---- */

  // One copy's value: "my value" if set, else the market price of its
  // printing (`price` from PricePick), else none.
  function unitValue(copy, price) {
    if (copy.value) return { value: copy.value, source: "mine" };
    if (price && price.value > 0) return { value: price.value, source: "market", kind: price.kind };
    return null;
  }

  // Totals for a list of copies. `priceOf(copy)` gives the printing's market
  // price or null. Gain counts only copies with both a price paid (in USD) and
  // a value; cost counts every copy with a price paid.
  function totals(copies, priceOf) {
    var t = {
      entries: copies.length, cards: 0, printings: 0, species: 0,
      value: 0, valued: 0, unpriced: 0, gradedRaw: 0, mine: 0,
      cost: 0, costTry: 0, paid: 0, unconverted: 0,
      gainValue: 0, gainCost: 0, gainValueBasis: 0, gainCostTry: 0, gainCards: 0, gainCardsTry: 0, gain: 0, gainPct: null
    };
    var printings = {};
    var species = {};
    copies.forEach(function (c) {
      var q = c.qty;
      t.cards += q;
      printings[c.card] = true;
      species[c.species] = true;
      var v = unitValue(c, priceOf ? priceOf(c) : null);
      if (v) {
        t.value += v.value * q;
        t.valued += q;
        if (v.source === "mine") t.mine += q;
        else if (c.cond.kind === "graded") t.gradedRaw += q;
      } else {
        t.unpriced += q;
      }
      if (c.paid) {
        t.paid += q;
        if (c.paid.usd != null) t.cost += c.paid.usd * q;
        else t.unconverted += q;
        if (c.paid["try"] != null) t.costTry += c.paid["try"] * q;
        if (v && c.paid.usd != null) {
          t.gainValue += v.value * q;
          t.gainCost += c.paid.usd * q;
          t.gainCards += q;
        }
        if (v && c.paid["try"] != null) {
          t.gainValueBasis += v.value * q;
          t.gainCostTry += c.paid["try"] * q;
          t.gainCardsTry += q;
        }
      }
    });
    t.printings = Object.keys(printings).length;
    t.species = Object.keys(species).length;
    ["value", "cost", "costTry", "gainValue", "gainCost", "gainValueBasis", "gainCostTry"].forEach(function (k) { t[k] = round2(t[k]); });
    t.gain = round2(t.gainValue - t.gainCost);
    t.gainPct = t.gainCost > 0 ? t.gain / t.gainCost : null;
    return t;
  }

  /* ---- breakdowns (§4.4 of the plan) ---- */

  // Copies grouped by set ("ENG|Jungle", the set picker's key), language or
  // Pokémon, each with its card count and value, highest value first.
  // Unpriced copies count as cards but add no value, and `unpriced` totals
  // them, so the rows' values add up to `total`.
  function breakdown(copies, priceOf, by) {
    var rows = {};
    var order = [];
    var out = { rows: [], total: 0, unpriced: 0, cards: 0 };
    (copies || []).forEach(function (c) {
      var lang = String(c.snap.lang || "").toUpperCase();
      var key = by === "lang" ? lang : by === "pokemon" ? c.species : lang + "|" + (c.snap.set || "");
      var row = rows[key];
      if (!row) {
        row = rows[key] = { key: key, cards: 0, value: 0, unpriced: 0, lang: lang, set: c.snap.set || "", species: c.species };
        order.push(key);
      }
      var v = unitValue(c, priceOf ? priceOf(c) : null);
      row.cards += c.qty;
      out.cards += c.qty;
      if (v) { row.value += v.value * c.qty; out.total += v.value * c.qty; }
      else { row.unpriced += c.qty; out.unpriced += c.qty; }
    });
    out.rows = order.map(function (k) { rows[k].value = round2(rows[k].value); return rows[k]; })
      .sort(function (a, b) { return b.value - a.value || b.cards - a.cards || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    out.total = round2(out.total);
    return out;
  }

  /* ---- price history (§4.3) ---- */

  // { days: [{ date, usdTry, prices: { cardId: usd } }] }, oldest first. Each
  // day keeps only the prices that changed since the day before, so a card's
  // price on a day is its latest entry on or before it.
  var MAX_DAYS = 3660;
  var BAD_KEY = /^(__proto__|constructor|prototype)$/;

  function cleanHistory(raw) {
    var out = { days: [] };
    var seen = {};
    (raw && Array.isArray(raw.days) ? raw.days.slice(-MAX_DAYS) : []).forEach(function (d) {
      var date = isoDay(d && d.date);
      if (!date || seen[date]) return;
      seen[date] = true;
      var prices = {};
      var src = d.prices && typeof d.prices === "object" ? d.prices : {};
      Object.keys(src).slice(0, MAX_COPIES).forEach(function (id) {
        var p = money(src[id]);
        if (p && id.length <= 160 && !BAD_KEY.test(id)) prices[id] = p;
      });
      out.days.push({ date: date, usdTry: rate(d.usdTry), prices: prices });
    });
    out.days.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  // Every card's price as it stood on `date`.
  function pricesOn(history, date) {
    var state = {};
    var days = (history && history.days) || [];
    for (var i = 0; i < days.length && days[i].date <= date; i++) {
      Object.assign(state, days[i].prices);
    }
    return state;
  }

  // Each day with the full set of prices known by then, and back again.
  function expandHistory(history) {
    var state = {};
    return cleanHistory(history).days.map(function (d) {
      Object.assign(state, d.prices);
      return { date: d.date, usdTry: d.usdTry, prices: Object.assign({}, state) };
    });
  }
  function compressHistory(full) {
    var last = {};
    return { days: full.map(function (d) {
      var prices = {};
      Object.keys(d.prices).forEach(function (id) {
        if (last[id] !== d.prices[id]) prices[id] = d.prices[id];
        last[id] = d.prices[id];
      });
      return { date: d.date, usdTry: d.usdTry, prices: prices };
    }) };
  }

  // Today's prices go in once a day. A later visit the same day updates
  // that day: a price it sees again stays, one back to the day before's is
  // dropped, and a card it couldn't price keeps what the first visit saw.
  function recordDay(history, date, prices, usdTry) {
    var h = cleanHistory(history);
    var day = isoDay(date);
    if (!day) return h;
    var earlier = null;
    h.days = h.days.filter(function (d) {
      if (d.date === day) { earlier = d; return false; }
      return true;
    });
    var before = pricesOn(h, day);
    var changed = earlier ? Object.assign({}, earlier.prices) : {};
    Object.keys(prices || {}).forEach(function (id) {
      var p = money(prices[id]);
      if (!p || id.length > 160 || BAD_KEY.test(id)) return;
      if (before[id] === p) delete changed[id];
      else changed[id] = p;
    });
    h.days.push({ date: day, usdTry: rate(usdTry) || (earlier && earlier.usdTry) || null, prices: changed });
    h.days.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    // A day after this one (the clock moved back) may now repeat a price.
    if (h.days[h.days.length - 1].date !== day) h = compressHistory(expandHistory(h));
    if (h.days.length > MAX_DAYS) h.days = compressHistory(expandHistory(h)).days.slice(-MAX_DAYS);
    return h;
  }

  // This browser's history and a backup's become one. On a day both have,
  // this browser's prices win.
  function mergeHistory(mine, theirs) {
    var byDate = {};
    expandHistory(theirs).forEach(function (d) { byDate[d.date] = d; });
    expandHistory(mine).forEach(function (d) {
      var o = byDate[d.date];
      byDate[d.date] = o ? { date: d.date, usdTry: d.usdTry || o.usdTry, prices: Object.assign({}, o.prices, d.prices) } : d;
    });
    var full = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
    return compressHistory(full.slice(-MAX_DAYS));
  }

  function shiftDay(date, n) {
    var d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // A copy counts from the day it was bought, else the day it was added.
  function ownedFrom(copy) { return copy.bought || String(copy.added || "").slice(0, 10); }

  function worthOn(copies, prices, date) {
    var v = 0;
    copies.forEach(function (c) {
      if (ownedFrom(c) > date) return;
      var u = unitValue(c, prices[c.card] ? { value: prices[c.card] } : null);
      if (u) v += u.value * c.qty;
    });
    return round2(v);
  }
  function paidBy(copies, date) {
    var v = 0;
    copies.forEach(function (c) {
      if (c.paid && c.paid.usd != null && ownedFrom(c) <= date) v += c.paid.usd * c.qty;
    });
    return round2(v);
  }

  // The Value over time chart between two dates: `value` has a point for
  // each day with saved prices (the day before the range, if any, starts it
  // at the left edge); `cost` steps up on each purchase date. Both count
  // only copies owned by then, so new cards step both lines up together.
  function valueSeries(history, copies, from, to) {
    var days = (history && history.days) || [];
    var state = {};
    var value = [];
    for (var i = 0; i < days.length && days[i].date <= to; i++) {
      Object.assign(state, days[i].prices);
      if (days[i].date < from) {
        var next = days[i + 1];
        if (!next || next.date > from) value.push({ date: from, value: worthOn(copies, state, from) });
        continue;
      }
      value.push({ date: days[i].date, value: worthOn(copies, state, days[i].date) });
    }
    var cost = [{ date: from, value: paidBy(copies, from) }];
    var dates = {};
    copies.forEach(function (c) {
      var d = ownedFrom(c);
      if (c.paid && c.paid.usd != null && d > from && d <= to) dates[d] = true;
    });
    Object.keys(dates).sort().forEach(function (d) { cost.push({ date: d, value: paidBy(copies, d) }); });
    return { value: value, cost: cost };
  }

  // The first day the chart can start on: the first saved prices, or the
  // first card you owned, whichever is earlier.
  function firstDay(history, copies) {
    var first = history && history.days && history.days.length ? history.days[0].date : "";
    copies.forEach(function (c) {
      var d = ownedFrom(c);
      if (d && (!first || d < first)) first = d;
    });
    return first;
  }

  // Top movers (§4.5): each card's price now ({ id, now, qty }) against its
  // price in the latest saved day at least `days` old, ranked by the change
  // times how many you own. Not ready until such a day exists.
  function movers(history, cards, today, days, limit) {
    var hist = (history && history.days) || [];
    var cutoff = shiftDay(today, -days);
    var base = "";
    for (var i = hist.length - 1; i >= 0; i--) if (hist[i].date <= cutoff) { base = hist[i].date; break; }
    if (!base) return { ready: false, first: hist.length ? hist[0].date : "" };
    var then = pricesOn(history, base);
    var list = [];
    (cards || []).forEach(function (c) {
      var old = then[c.id];
      if (!(old > 0) || !(c.now > 0) || !(c.qty > 0)) return;
      var change = round2((c.now - old) * c.qty);
      if (change) list.push({ id: c.id, old: old, now: c.now, qty: c.qty, change: change, pct: (c.now - old) / old });
    });
    var n = limit || 5;
    return {
      ready: true,
      since: base,
      up: list.filter(function (x) { return x.change > 0; }).sort(function (a, b) { return b.change - a.change; }).slice(0, n),
      down: list.filter(function (x) { return x.change < 0; }).sort(function (a, b) { return a.change - b.change; }).slice(0, n)
    };
  }

  /* ---- money typed into the form ---- */

  // "1.250,50" and "1,250.50" both mean 1250.5: with both marks, the last one
  // is the decimal mark. With one mark used once, three digits after it make
  // it the language's thousands mark ("1.250" in Turkish, "1,250" in
  // English); otherwise it is the decimal mark ("12,5", "1.25"). A mark used
  // more than once only groups thousands ("1.250.000").
  function parseAmount(text, lang) {
    var s = String(text == null ? "" : text).replace(/[\s $€₺]/g, "").replace(/(usd|try|tl|eur)$/i, "");
    if (!s || !/^[0-9]*[.,]?[0-9.,]*$/.test(s) || !/[0-9]/.test(s)) return null;
    var commas = s.split(",").length - 1;
    var dots = s.split(".").length - 1;
    var decimal = "";
    if (commas && dots) {
      decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
      if (s.split(decimal).length - 1 > 1) return null;
    } else if (commas + dots === 1) {
      var mark = commas ? "," : ".";
      var after = s.length - s.indexOf(mark) - 1;
      decimal = after === 3 && mark === (lang === "tr" ? "." : ",") ? "" : mark;
    }
    var whole = s;
    var frac = "";
    if (decimal) {
      whole = s.slice(0, s.lastIndexOf(decimal));
      frac = s.slice(s.lastIndexOf(decimal) + 1);
    }
    return money(Number((whole.replace(/[.,]/g, "") || "0") + (frac ? "." + frac : "")));
  }

  // The USD and TRY sums of a price paid, from the USD→TRY and USD→EUR rates
  // of its purchase date. Unknown sums stay null until a rate is known.
  function convertPaid(paid, rates, rateDate) {
    if (!paid) return null;
    var out = cleanPaid(paid);
    if (!out) return null;
    var tryRate = rates && rate(rates.TRY);
    var eurRate = rates && rate(rates.EUR);
    if (out.cur === "USD") out.usd = out.amount;
    else if (out.cur === "TRY" && tryRate) out.usd = round2(out.amount / tryRate);
    else if (out.cur === "EUR" && eurRate) out.usd = round2(out.amount / eurRate);
    if (out.cur === "TRY") out["try"] = out.amount;
    else if (out.usd != null && tryRate) out["try"] = round2(out.usd * tryRate);
    if (rateDate && (tryRate || eurRate)) out.rateDate = isoDay(rateDate);
    return out;
  }

  function needsRate(paid) {
    return !!paid && (paid.usd == null || paid["try"] == null);
  }

  /* ---- backups ---- */

  // The backup file. The price history goes in too (it's small), so a
  // restored binder keeps its chart and movers.
  function exportDoc(doc, now, history) {
    var clean = cleanDoc(doc);
    delete clean.local;
    clean.exported = now || new Date().toISOString();
    var h = cleanHistory(history);
    if (h.days.length) clean.history = h;
    return clean;
  }

  // A backup file someone picked: never trusted. Returns { ok, doc, summary }
  // or { ok: false, error } with error "size", "json" or "format".
  function parseFile(text) {
    if (typeof text !== "string" || text.length > MAX_FILE) return { ok: false, error: "size" };
    var raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: "json" }; }
    if (!raw || typeof raw !== "object" || raw.format !== FORMAT || !(Number(raw.version) >= 1)) return { ok: false, error: "format" };
    if (Number(raw.version) > VERSION) return { ok: false, error: "newer" };
    var doc = cleanDoc(raw);
    delete doc.local;
    var species = {};
    var cards = 0;
    doc.copies.forEach(function (c) { species[c.species] = true; cards += c.qty; });
    var history = raw.history ? cleanHistory(raw.history) : null;
    return { ok: true, doc: doc, history: history && history.days.length ? history : null, summary: { cards: cards, entries: doc.copies.length, species: Object.keys(species).length, saved: str(raw.exported || raw.updated, 40) } };
  }

  // One row per copy entry, for spreadsheets. Cells that a spreadsheet would
  // run as a formula get a leading apostrophe.
  function toCsv(doc) {
    var head = ["card", "pokemon", "name", "language", "set", "number", "variant", "quantity", "condition", "grader", "grade",
      "cert", "paid_each", "currency", "paid_each_usd", "date_bought", "my_value_usd", "note", "added"];
    function cell(v) {
      var s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var rows = cleanDoc(doc).copies.map(function (c) {
      var graded = c.cond.kind === "graded";
      return [c.card, c.species, c.snap.name, c.snap.lang, c.snap.set, c.snap.no, c.snap.variant, c.qty,
        graded ? "graded" : c.cond.grade, graded ? c.cond.by : "", graded ? c.cond.grade : "", graded ? c.cond.cert : "",
        c.paid ? c.paid.amount : "", c.paid ? c.paid.cur : "", c.paid && c.paid.usd != null ? c.paid.usd : "",
        c.bought, c.value || "", c.note, c.added].map(cell).join(",");
    });
    return [head.join(",")].concat(rows).join("\r\n") + "\r\n";
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    CONDITIONS: CONDITIONS,
    GRADERS: GRADERS,
    GRADES: GRADES,
    CURRENCIES: CURRENCIES,
    MAX_QTY: MAX_QTY,
    fold: fold,
    newUid: newUid,
    speciesNumber: speciesNumber,
    pidCounts: pidCounts,
    snapOf: snapOf,
    signature: signature,
    cleanCopy: cleanCopy,
    gradeLabel: gradeLabel,
    emptyDoc: emptyDoc,
    cleanDoc: cleanDoc,
    merge: merge,
    Model: Model,
    isBare: isBare,
    tapAction: tapAction,
    quickCopy: quickCopy,
    progress: progress,
    speciesFor: speciesFor,
    findCard: findCard,
    reconcile: reconcile,
    relink: relink,
    unitValue: unitValue,
    totals: totals,
    parseAmount: parseAmount,
    convertPaid: convertPaid,
    needsRate: needsRate,
    breakdown: breakdown,
    cleanHistory: cleanHistory,
    pricesOn: pricesOn,
    recordDay: recordDay,
    mergeHistory: mergeHistory,
    shiftDay: shiftDay,
    ownedFrom: ownedFrom,
    valueSeries: valueSeries,
    firstDay: firstDay,
    movers: movers,
    exportDoc: exportDoc,
    parseFile: parseFile,
    toCsv: toCsv
  };
});
