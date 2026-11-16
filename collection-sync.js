/* PullfolioSync: keeps My binder in a private GitHub repo you pick
   (docs/COLLECTION-PLAN.md §2, Phase 5). The repo holds collection.json, the
   same file as a backup, price history included. Every save is a commit, so
   any earlier version can be brought back from the repo's history.

   The token is sent only to api.github.com. There's no DOM here: the panel
   is in collection.js, and tests/collection-sync.test.js runs all of this
   with a stand-in for fetch. */
(function (root, factory) {
  // The module path also resolves from tests/ (tests/test_js_modules.py).
  if (typeof module === "object" && module.exports) module.exports = factory(require("../search/collection-core.js"));
  else root.PullfolioSync = factory(root.PullfolioCore);
})(typeof window !== "undefined" ? window : this, function (core) {
  "use strict";

  var API = "https://api.github.com";
  var FILE = "collection.json";
  var TRIES = 4; // reads and writes when another device keeps saving in between

  /* ---- what you type ---- */

  // "kcglr/pullfolio-binder", or that repo's github.com address.
  function parseRepo(text) {
    var s = String(text || "").trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    var m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
    if (!m || /^\.+$/.test(m[2])) return null;
    return { owner: m[1], name: m[2], full: m[1] + "/" + m[2] };
  }

  // Fine-grained ("github_pat_…") and classic ("ghp_…") tokens; only the
  // shape is checked here, GitHub says whether it works.
  function cleanToken(text) {
    var s = String(text || "").trim();
    return /^[A-Za-z0-9_]{20,255}$/.test(s) ? s : "";
  }

  /* ---- the file ---- */

  function toBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromBase64(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // The file a device writes: a backup, one entry per line so the repo's
  // history shows which cards changed.
  function fileText(doc, history, now) {
    var file = core.exportDoc(doc, now || new Date().toISOString(), history);
    var copies = file.copies;
    file.copies = [];
    var text = JSON.stringify(file, null, 1);
    var lines = copies.map(function (c) { return " " + JSON.stringify(c); });
    return text.replace('"copies": []', '"copies": [\n' + lines.join(",\n") + "\n ]") + "\n";
  }

  // What two files are compared on: the cards, removals, settings, catalog
  // stamp and prices, not when they were written.
  function body(doc, history) {
    var file = core.exportDoc(doc, "-", history);
    delete file.exported;
    delete file.updated;
    return JSON.stringify(file);
  }

  /* ---- talking to GitHub ---- */

  // kind: "offline", "token" (refused), "access" (can't see or write the
  // repo), "public" (the repo isn't private), "rate" (GitHub is limiting),
  // "conflict" (another device saved first), "format" (collection.json isn't
  // a binder), "server" (anything else).
  function SyncError(kind, status) {
    this.name = "SyncError";
    this.kind = kind;
    this.status = status || 0;
    this.message = "sync " + kind + (status ? " " + status : "");
  }
  SyncError.prototype = Object.create(Error.prototype);

  function Client(repo, token, fetchFn) {
    this.repo = repo;
    this.token = token;
    // The page's fetch, looked up when called.
    this.fetch = fetchFn || function (url, init) { return fetch(url, init); };
  }

  Client.prototype.call = function (method, path, data) {
    var init = {
      method: method,
      cache: "no-store", // a cached read would carry an old sha
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + this.token }
    };
    if (data) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(data);
    }
    return this.fetch(API + path, init).then(null, function () {
      throw new SyncError("offline");
    }).then(function (res) {
      if (res.ok) return res.status === 204 ? null : res.json();
      var s = res.status;
      var limited = res.headers && res.headers.get && res.headers.get("x-ratelimit-remaining") === "0";
      if (s === 401) throw new SyncError("token", s);
      if (s === 429 || (s === 403 && limited)) throw new SyncError("rate", s);
      if (s === 403 || s === 404) throw new SyncError("access", s);
      if (s === 409 || s === 422) throw new SyncError("conflict", s);
      throw new SyncError("server", s);
    });
  };

  Client.prototype.base = function () {
    return "/repos/" + encodeURIComponent(this.repo.owner) + "/" + encodeURIComponent(this.repo.name);
  };

  // Before the first sync: the repo must exist, be private and be writable.
  Client.prototype.check = function () {
    return this.call("GET", this.base()).then(function (info) {
      if (!info || info["private"] !== true) throw new SyncError("public");
      if (info.permissions && info.permissions.push === false) throw new SyncError("access");
      return info;
    });
  };

  // { sha, text }, or { sha: "", text: "" } when the repo has no file yet.
  // Files over 1 MB come without content and are read as a blob.
  Client.prototype.read = function () {
    var self = this;
    return this.call("GET", this.base() + "/contents/" + FILE).then(function (file) {
      if (!file || file.type !== "file") throw new SyncError("format");
      if (file.encoding === "base64" && file.content) return { sha: file.sha, text: fromBase64(file.content) };
      return self.call("GET", self.base() + "/git/blobs/" + encodeURIComponent(file.sha)).then(function (blob) {
        return { sha: file.sha, text: blob && blob.encoding === "base64" ? fromBase64(blob.content) : "" };
      });
    }, function (err) {
      // No file yet is fine; the repo itself was checked when connecting.
      if (err.kind === "access" && err.status === 404) return { sha: "", text: "" };
      throw err;
    });
  };

  Client.prototype.write = function (text, sha, message) {
    var data = { message: message, content: toBase64(text) };
    if (sha) data.sha = sha;
    return this.call("PUT", this.base() + "/contents/" + FILE, data).then(function (res) {
      return { sha: res && res.content ? res.content.sha : "" };
    });
  };

  /* ---- one sync ---- */

  // Reads the repo's file and hands it to `take(doc, history)`, which merges
  // it into this browser (newest edit wins per card; removals win over older
  // edits). Then writes the merged binder back if the repo is behind. If
  // another device saved in between, it starts over from the new file.
  //   local(): { doc, history } as they are now, after take()
  // Resolves { sha, wrote, read } (read: the repo had a file).
  function run(client, local, take, attempt) {
    attempt = attempt || 1;
    return client.read().then(function (remote) {
      var theirs = null;
      if (remote.text) {
        var parsed = core.parseFile(remote.text);
        if (!parsed.ok) throw new SyncError("format");
        theirs = body(parsed.doc, parsed.history);
        take(parsed.doc, parsed.history);
      }
      var mine = local();
      if (theirs !== null && theirs === body(mine.doc, mine.history)) return { sha: remote.sha, wrote: false, read: !!remote.text };
      var cards = mine.doc.copies.reduce(function (n, c) { return n + c.qty; }, 0);
      return client.write(fileText(mine.doc, mine.history), remote.sha, "Pullfolio: " + cards + (cards === 1 ? " card" : " cards"))
        .then(function (w) { return { sha: w.sha, wrote: true, read: !!remote.text }; }, function (err) {
          if (err.kind === "conflict" && attempt < TRIES) return run(client, local, take, attempt + 1);
          throw err;
        });
    });
  }

  // True when merging `theirs` into `mine` would change what's here.
  function changes(mine, theirs) {
    return body(core.merge(mine, theirs), null) !== body(mine, null);
  }

  return {
    API: API,
    FILE: FILE,
    parseRepo: parseRepo,
    cleanToken: cleanToken,
    toBase64: toBase64,
    fromBase64: fromBase64,
    fileText: fileText,
    body: body,
    changes: changes,
    SyncError: SyncError,
    Client: Client,
    run: run
  };
});
