/* PullfolioSupabase: keeps My binder in a Pullfolio account
   (docs/SITE-PLAN.md §2.3, Phase B). Each person's binder is one row of the
   `binders` table in Supabase (supabase/schema.sql), holding the same file
   the GitHub sync writes, less the saved daily prices. After "Delete my
   data" the row holds a mark instead, which stops the person's other
   devices (read() below). The row's `version` plays the part of GitHub's
   sha: a save names the version it started from, and the database refuses
   it if another device saved in between. Sync.run() (collection-sync.js)
   then reads again, merges and saves, as it does for GitHub.

   Plain fetch to Supabase's REST API, no supabase-js and no build step. The
   project's public key and the signed-in person's access token go in
   headers, never in a URL. The access token comes from a function, so the
   sign-in module can refresh it.

   No DOM here; tests/collection-supabase.test.js runs it against a stand-in
   for the REST API and save_binder(). */
(function (root, factory) {
  // The module paths also resolve from tests/ (tests/test_js_modules.py).
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../search/collection-core.js"), require("../search/collection-sync.js"));
  } else root.PullfolioSupabase = factory(root.PullfolioCore, root.PullfolioSync);
})(typeof window !== "undefined" ? window : this, function (core, sync) {
  "use strict";

  var SyncError = sync.SyncError; // the same errors as the GitHub sync, so the panel reads both alike
  var TABLE = "/rest/v1/binders";
  var SAVE = "/rest/v1/rpc/save_binder";
  var DELETE = "/rest/v1/rpc/delete_my_binder";
  // The SQLSTATE save_binder() raises for a doc it won't keep: not a binder,
  // or over 10 MB. The REST API sends it back as HTTP 400 { code }.
  var REFUSED = "22023";

  /* ---- the project's settings ---- */

  // "https://<ref>.supabase.co", or Supabase running on this computer. "" if
  // it isn't one of those.
  function cleanUrl(text) {
    var s = String(text || "").trim().replace(/\/+$/, "").toLowerCase();
    return /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/.test(s) ? s : "";
  }

  // A JWT's claims, unchecked: only Supabase can check the signature.
  function claims(token) {
    var m = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(String(token || ""));
    if (!m) return null;
    try {
      var b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var c = JSON.parse(sync.fromBase64(b64));
      return c && typeof c === "object" ? c : null;
    } catch (e) {
      return null;
    }
  }

  // Only the public key may sit in the page: the anon key (a JWT whose role
  // is "anon") or a newer publishable key ("sb_publishable_…"). The
  // service_role or secret key gets past every row rule, so it gives "" and
  // is never sent.
  function cleanKey(text) {
    var s = String(text || "").trim();
    if (/^sb_publishable_[A-Za-z0-9_-]{8,200}$/.test(s)) return s;
    var c = claims(s);
    return c && c.role === "anon" ? s : "";
  }

  // The signed-in person's access token: a JWT for the "authenticated" role.
  function cleanAccess(text) {
    var s = String(text || "").trim();
    var c = s.length <= 16384 ? claims(s) : null;
    return c && c.role === "authenticated" ? s : "";
  }

  function isVersion(v) {
    return typeof v === "number" && v >= 1 && v <= 9007199254740991 && Math.floor(v) === v;
  }

  /* ---- the row ---- */

  // The binder without the saved daily prices. They stay on each device (and
  // in backups) but are never sent to the account or taken from it, so a
  // binder stays far below the 10 MB limit (plan §2.3). Leaving them out also
  // keeps a row's text steady: Postgres reorders a jsonb object's keys, and
  // in the prices those keys are card ids.
  function withoutPrices(doc) {
    var out = {};
    Object.keys(doc).forEach(function (k) { if (k !== "history") out[k] = doc[k]; });
    return out;
  }

  // "Delete my data" (delete_my_binder() in supabase/schema.sql) leaves a
  // mark with no cards, { format, version, deletedAt, cleared }, where
  // `cleared` is the row's version at that moment. A binder started after it
  // carries `cleared` along. Both give that version, 0 when there's none.
  function clearedAt(doc) {
    var v = doc && doc.cleared;
    return isVersion(v) ? v : 0;
  }
  function isMark(doc) {
    return !!doc && typeof doc.deletedAt === "string" && !Array.isArray(doc.copies);
  }

  // The rows a read gets back. The row rule lets a person see only their own
  // row, so more than one means the rule is off and every binder is
  // readable: kind "public", like a GitHub repo that isn't private.
  function own(rows) {
    if (!Array.isArray(rows)) throw new SyncError("server");
    if (rows.length > 1) throw new SyncError("public");
    var row = rows[0] || null;
    if (row && !isVersion(row.version)) throw new SyncError("server");
    return row;
  }

  /* ---- talking to Supabase ---- */

  // kind, from what Supabase answered.
  function failure(status, body) {
    if (status === 401 || status === 403) return new SyncError("token", status);
    if (status === 429) return new SyncError("rate", status);
    if (status === 400 && body && body.code === REFUSED) return new SyncError("format", status);
    return new SyncError("server", status);
  }

  // project: { url, anonKey }.
  // accessToken(refused): the signed-in person's access token, or a promise
  //   of it; "" when nobody is signed in. `refused` is true when Supabase
  //   just turned the last one away (they expire after an hour), so the
  //   sign-in module can refresh it.
  // client.seen(): the version of this account's binder this device last
  //   synced at, 0 if it never did (PullfolioAccount's seen()). It tells a
  //   device holding cards from before a "Delete my data" from a new one.
  function Client(project, accessToken, fetchFn) {
    project = project || {};
    this.url = cleanUrl(project.url);
    this.key = cleanKey(project.anonKey);
    this.accessToken = typeof accessToken === "function" ? accessToken : function () { return ""; };
    // The page's fetch, looked up when called.
    this.fetch = fetchFn || function (url, init) { return fetch(url, init); };
    this.seen = function () { return 0; };
    this.cleared = 0; // from the last read, carried into the next save
  }

  // One request. A 401 asks for a fresh token and tries once more.
  Client.prototype.call = function (method, path, data) {
    var self = this;
    if (!this.url || !this.key) return Promise.reject(new SyncError("token"));
    function attempt(refused) {
      return Promise.resolve().then(function () {
        return self.accessToken(refused);
      }).then(null, function (err) {
        throw err instanceof SyncError ? err : new SyncError("token");
      }).then(function (raw) {
        var token = cleanAccess(raw);
        if (!token) throw new SyncError("token");
        var init = {
          method: method,
          cache: "no-store", // a cached read would carry an old version
          headers: { apikey: self.key, Authorization: "Bearer " + token, Accept: "application/json" }
        };
        if (data) {
          init.headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(data);
        }
        return self.fetch(self.url + path, init).then(null, function () {
          throw new SyncError("offline");
        });
      }).then(function (res) {
        if (res.ok) {
          if (res.status === 204) return null;
          return res.json().then(null, function () { throw new SyncError("server", res.status); });
        }
        if (res.status === 401 && !refused) return attempt(true);
        return Promise.resolve().then(function () { return res.json(); }).then(null, function () { return null; })
          .then(function (body) { throw failure(res.status, body); });
      });
    }
    return attempt(false);
  };

  // Before the first sync: signed in, and the table answers.
  // Resolves { version } ("" before the first save).
  Client.prototype.check = function () {
    return this.call("GET", TABLE + "?select=version&limit=2").then(function (rows) {
      var row = own(rows);
      return { version: row ? String(row.version) : "" };
    });
  };

  // { sha, text } as Sync.run() expects: sha is the row's version as text,
  // text the binder file. { sha: "", text: "" } before the first save, and
  // { sha, text: "" } for a deletion mark this device may start over (its
  // first save replaces the mark).
  //
  // A device that synced this account before the deletion (seen() is below
  // the mark's `cleared`) holds cards that were deleted. Its read fails with
  // kind "deleted" instead, so it clears its copy rather than uploading it
  // again. err.mark is true when the row is still just the mark (the page
  // then signs out), false when a new binder was started since.
  Client.prototype.read = function () {
    var self = this;
    return this.call("GET", TABLE + "?select=doc,version&limit=2").then(function (rows) {
      var row = own(rows);
      self.cleared = 0;
      if (!row) return { sha: "", text: "" };
      if (!row.doc || typeof row.doc !== "object" || Array.isArray(row.doc)) throw new SyncError("format");
      var cleared = clearedAt(row.doc);
      var last = Number(self.seen()) || 0;
      if (cleared && last > 0 && last < cleared) {
        var err = new SyncError("deleted");
        err.mark = isMark(row.doc);
        err.version = row.version;
        throw err;
      }
      self.cleared = cleared;
      if (isMark(row.doc)) return { sha: String(row.version), text: "" };
      return { sha: String(row.version), text: JSON.stringify(withoutPrices(row.doc)) };
    });
  };

  // Saves the file Sync.run() made, if the row is still at version `sha`
  // ("" when there was no row). Resolves { sha: the new version }. When
  // another device saved in between, save_binder() returns null: kind
  // "conflict", and Sync.run() reads, merges and tries again. The commit
  // message GitHub gets has nowhere to go here. The saved daily prices are
  // left out, and a deletion's `cleared` is kept.
  Client.prototype.write = function (text, sha) {
    var doc = null;
    try { doc = JSON.parse(text); } catch (e) { doc = null; }
    if (!doc || typeof doc !== "object" || doc.format !== core.FORMAT) return Promise.reject(new SyncError("format"));
    doc = withoutPrices(doc);
    delete doc.cleared;
    delete doc.deletedAt;
    if (this.cleared) doc.cleared = this.cleared;
    var expected = /^[1-9][0-9]{0,14}$/.test(String(sha || "")) ? Number(sha) : 0;
    return this.call("POST", SAVE, { doc: doc, expected_version: expected }).then(function (version) {
      if (version === null) throw new SyncError("conflict");
      if (!isVersion(version)) throw new SyncError("server");
      return { sha: String(version) };
    });
  };

  // "Delete my data": delete_my_binder() replaces the binder with the mark
  // and raises the version, so every other device stops (read() above).
  // Deleting the sign-in itself needs a server-side function
  // (supabase/README.md). Resolves { removed } (false when there was no
  // binder, only a mark or nothing).
  Client.prototype.remove = function () {
    return this.call("POST", DELETE, {}).then(function (gone) {
      return { removed: gone === true };
    });
  };

  /* ---- signing out empties this device (collection.js) ---- */

  // A short fingerprint of what the account holds of a binder: its cards,
  // removals, settings and catalog stamp (sync.body), not when it was
  // written. A device keeps the one it last saved, so it can tell later
  // whether it has changes the account hasn't seen.
  function docSig(doc) {
    var s = sync.body(doc, null);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return s.length.toString(36) + "." + h.toString(36);
  }

  // True while the binder here has changes the account hasn't seen. Never
  // saved from this device (savedSig ""): any card here counts.
  function unsaved(doc, savedSig) {
    if (savedSig) return docSig(doc) !== savedSig;
    return !!(doc && doc.copies && doc.copies.length);
  }

  // What signing out does to this device's binder, by why it happened:
  //   "signout"   the Sign out button: clear (signOutFlow saved first, or
  //               the person chose to sign out anyway);
  //   "expired"   Supabase refused the sign-in (it ran out, or the person
  //               was signed out everywhere): clear, unless something isn't
  //               in the account yet: then keep it and say so;
  //   "other-tab" another tab signed out and did the clearing: read the
  //               binder again;
  //   "deleted", "deleted-elsewhere": "Delete my data" already cleared.
  function afterSignOut(reason, isUnsaved) {
    if (reason === "signout") return "clear";
    if (reason === "expired") return isUnsaved ? "keep" : "clear";
    if (reason === "other-tab") return "reload";
    return "none";
  }

  // The Sign out button. What isn't in the account yet is saved first; only
  // then is this device cleared and signed out. A save that can't finish
  // clears nothing: it resolves "ask", and the person chooses.
  //   o.unsaved(): true while there are changes the account hasn't seen
  //   o.save(): one save to the account (resolves either way)
  //   o.leave(): clears this device and signs out
  //   o.force: "Sign out anyway"
  // Resolves "out" or "ask". Two saves at most: the first may only finish
  // one that was already under way.
  function signOutFlow(o) {
    var saves = 0;
    function leave() { return Promise.resolve(o.leave()).then(function () { return "out"; }); }
    function attempt() {
      if (o.force || !o.unsaved()) return leave();
      if (saves >= 2) return Promise.resolve("ask");
      saves++;
      return Promise.resolve().then(o.save).then(attempt, function () { return o.unsaved() ? "ask" : leave(); });
    }
    return attempt();
  }

  return {
    cleanUrl: cleanUrl,
    cleanKey: cleanKey,
    cleanAccess: cleanAccess,
    docSig: docSig,
    unsaved: unsaved,
    afterSignOut: afterSignOut,
    signOutFlow: signOutFlow,
    SyncError: SyncError,
    Client: Client
  };
});
