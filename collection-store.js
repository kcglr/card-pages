/* PullfolioStore: keeps the collection in this browser (IndexedDB database
   "pullfolio"), with the last fetched prices beside it so My binder opens
   with values at once. If IndexedDB is blocked (some private windows) the
   collection lives in memory only and `volatile` says so.

   The kcglr.github.io origin is shared by every Pages site of the account,
   so everything here is named "pullfolio". Other open tabs of the site hear
   about each save and reload the collection. */
(function (root) {
  "use strict";
  var core = root.PullfolioCore;
  var DB_NAME = "pullfolio";
  var STORE = "kv";
  var DOC_KEY = "collection";
  var PRICE_KEY = "prices";
  var HISTORY_KEY = "history"; // a price record per day (Value over time, Top movers)
  var SAVE_DELAY = 250;
  var memHistory = null; // the history while IndexedDB is unavailable

  var db = null;
  var model = new core.Model();
  var listeners = [];
  var saveTimer = 0;
  var persisted = false;
  var channel = null;
  var tabId = Math.random().toString(36).slice(2);

  function openDb() {
    return new Promise(function (resolve) {
      var req;
      try {
        if (!root.indexedDB) { resolve(null); return; }
        req = root.indexedDB.open(DB_NAME, 1);
      } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function run(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!db) { reject(new Error("no database")); return; }
      var tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      var req = fn(tx.objectStore(STORE));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error("transaction failed")); };
    });
  }
  function read(key) { return run("readonly", function (s) { return s.get(key); }); }
  function write(key, value) { return run("readwrite", function (s) { return s.put(value, key); }); }

  function emit(reason) {
    listeners.forEach(function (fn) {
      try { fn(reason); } catch (e) { console.error(e); }
    });
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!db) return Promise.resolve(false);
    return write(DOC_KEY, JSON.parse(JSON.stringify(model.doc))).then(function () {
      if (channel) channel.postMessage({ from: tabId, type: "saved" });
      return true;
    }).catch(function (err) { console.error(err); return false; });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
    // Ask the browser to keep this site's storage when space runs low.
    if (!persisted && db && root.navigator && root.navigator.storage && root.navigator.storage.persist) {
      persisted = true;
      root.navigator.storage.persist().catch(function () {});
    }
  }

  function changed(reason) {
    scheduleSave();
    emit(reason);
  }

  function reload() {
    if (!db) return Promise.resolve();
    return read(DOC_KEY).then(function (doc) {
      model = new core.Model(doc || null);
      emit("reload");
    }).catch(function (err) { console.error(err); });
  }

  var ready = openDb().then(function (opened) {
    db = opened;
    if (!db) return;
    db.onversionchange = function () { db.close(); db = null; };
    try {
      channel = new BroadcastChannel("pullfolio");
      channel.onmessage = function (ev) {
        if (ev.data && ev.data.from !== tabId && ev.data.type === "saved") reload();
      };
    } catch (e) { channel = null; }
    return read(DOC_KEY).then(function (doc) {
      if (doc) model = new core.Model(doc);
    });
  }).catch(function (err) {
    console.error(err);
  }).then(function () {
    Store.volatile = !db;
    emit("load");
  });

  // Saving can't wait for the timer when the page goes away.
  root.addEventListener("pagehide", function () { if (saveTimer) flush(); });
  root.document.addEventListener("visibilitychange", function () {
    if (root.document.visibilityState === "hidden" && saveTimer) flush();
  });

  var Store = {
    ready: ready,
    volatile: false,
    model: function () { return model; },
    onChange: function (fn) { listeners.push(fn); },
    add: function (fields) {
      var copy = model.add(fields, new Date().toISOString());
      if (copy) changed("add");
      return copy;
    },
    update: function (uid, fields, reason) {
      var copy = model.update(uid, fields, new Date().toISOString());
      if (copy) changed(reason || "update");
      return copy;
    },
    remove: function (uid) {
      var copy = model.remove(uid, new Date().toISOString());
      if (copy) changed("remove");
      return copy;
    },
    restore: function (copy) {
      var back = model.restore(copy, new Date().toISOString());
      if (back) changed("restore");
      return back;
    },
    replace: function (doc) { model.replace(doc, new Date().toISOString()); changed("replace"); },
    mergeIn: function (doc) { model.mergeIn(doc, new Date().toISOString()); changed("merge"); },
    // Catalog fixes (§5 of the plan): saved quietly, without counting as a
    // change the backup reminder should hear about.
    patch: function (patches, catalog) {
      var changes = model.doc.local ? model.doc.local.changes : 0;
      patches.forEach(function (p) { model.update(p.uid, p.fields, new Date().toISOString()); });
      if (catalog) model.doc.catalog = catalog;
      if (model.doc.local) model.doc.local.changes = changes;
      if (patches.length || catalog) changed("catalog");
    },
    markBackup: function () {
      model.doc.local = { backupAt: new Date().toISOString(), changes: 0 };
      changed("backup");
    },
    setSetting: function (name, value) {
      model.doc.settings[name] = value;
      changed("settings");
    },
    flush: flush,
    // The last prices fetched for the collection: { payloads, updatedAt }.
    readPrices: function () {
      return ready.then(function () { return db ? read(PRICE_KEY) : null; }).catch(function () { return null; });
    },
    writePrices: function (payloads, updatedAt) {
      if (!db) return Promise.resolve();
      return write(PRICE_KEY, { payloads: payloads, updatedAt: updatedAt || "", savedAt: new Date().toISOString() })
        .catch(function () {});
    },
    // The price history, always cleaned on the way in.
    readHistory: function () {
      return ready.then(function () { return db ? read(HISTORY_KEY) : memHistory; })
        .catch(function () { return null; })
        .then(function (h) { return core.cleanHistory(h); });
    },
    writeHistory: function (history) {
      memHistory = history;
      if (!db) return Promise.resolve();
      return write(HISTORY_KEY, history).catch(function (err) { console.error(err); });
    }
  };

  root.PullfolioStore = Store;
})(window);
