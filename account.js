/* PullfolioAccount: signing in to a Pullfolio account with Google, through
   Supabase's sign-in API, so My binder can be saved to the account
   (supabase/README.md). Searching and flipping through binders never needs
   it: nothing here runs until someone clicks "Sign in with Google", apart
   from finishing a sign-in that is coming back from Google.

   The flow is OAuth with PKCE, by hand (no supabase-js, no build step):
     1. signIn() makes a random secret (the "verifier") and keeps it in this
        tab's sessionStorage, then sends the page to Supabase's /authorize
        with a hash of it (the "challenge"). Supabase passes the person on to
        Google.
     2. Google sends them back to Supabase, and Supabase back to this page
        with ?code=… in the address.
     3. finish() trades the code and the verifier for a session: an access
        token (a JWT, good for an hour) and a refresh token. Only this tab
        knows the verifier, so a code planted in a link is useless.
   The session is kept in localStorage, so the person stays signed in, and
   accessToken() refreshes it before it runs out (and when Supabase refuses
   it). The project URL and the publishable key below are public by design.
   The service or secret key never goes anywhere near the page.

   The kcglr.github.io origin is shared by every Pages site of the account,
   so everything kept here is named "pullfolio.account…".

   No DOM here. The page makes one with create(); tests/account.test.js
   makes them with stand-ins for storage, the address bar, fetch and time. */
(function (root, factory) {
  // The module paths also resolve from tests/ (tests/test_js_modules.py).
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../search/collection-sync.js"));
  } else root.PullfolioAccount = factory(root.PullfolioSync);
})(typeof window !== "undefined" ? window : this, function (sync) {
  "use strict";

  var SyncError = sync.SyncError; // so the binder's panel reads sign-in trouble like sync trouble

  // The Pullfolio project on Supabase. Both are meant to be public: the key
  // alone can do nothing to a binder (supabase/README.md, part 4).
  var PROJECT = {
    url: "https://jdorbiqrfeuoeaekowkw.supabase.co",
    anonKey: "sb_publishable_IPFw2Z0p5lKxbxjncdiPeQ_uoI4gLSG"
  };

  var SESSION_STORE = "pullfolio.account"; // localStorage: the session
  var PENDING_STORE = "pullfolio.account.pending"; // sessionStorage: a sign-in on its way to Google and back
  var SEEN_STORE = "pullfolio.account.seen"; // localStorage: { user id: the version last synced }
  var GATE_STORE = "pullfolio.accounts"; // localStorage: 0 once ?accounts=0 was opened (accounts hidden on this device)
  var EARLY = 60; // seconds: a token this close to running out is refreshed first
  var PENDING_MAX = 15 * 60 * 1000; // a sign-in that takes longer starts again
  var SEEN_MAX = 8; // accounts a device remembers syncing

  /* ---- PKCE ---- */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  // Bytes as base64url without padding (RFC 4648 §5), as PKCE wants.
  function base64url(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
      if (i + 2 < bytes.length) out += B64[n & 63];
    }
    return out;
  }

  // 32 random bytes: a 43-letter verifier (RFC 7636 allows 43 to 128).
  function makeVerifier(crypto) {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  // The challenge Supabase gets: base64url(SHA-256(verifier)).
  function challengeFor(crypto, verifier) {
    var bytes = new TextEncoder().encode(verifier);
    return Promise.resolve(crypto.subtle.digest("SHA-256", bytes)).then(function (hash) {
      return base64url(new Uint8Array(hash));
    });
  }

  /* ---- small helpers ---- */

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

  function str(v, max) { return typeof v === "string" ? v.slice(0, max || 200) : ""; }

  // Storage that may be missing or refuse (a private window): reads give
  // null and writes are dropped, so the session lasts for this page only.
  function safe(storage) {
    return {
      get: function (k) {
        try { var v = storage && storage.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; }
      },
      set: function (k, v) {
        try { if (storage) storage.setItem(k, JSON.stringify(v)); } catch (e) { /* this page only */ }
      },
      drop: function (k) {
        try { if (storage) storage.removeItem(k); } catch (e) { /* nothing kept anyway */ }
      }
    };
  }

  // The parts of the address bar's query: { name: value }.
  function params(text) {
    var out = {};
    String(text || "").replace(/^[?#]/, "").split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("=");
      var k = i < 0 ? pair : pair.slice(0, i);
      var v = i < 0 ? "" : pair.slice(i + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) { /* not ours */ }
    });
    return out;
  }

  // A query ("?a=1&b=2") without the given names; "" when nothing is left.
  function without(search, names) {
    var kept = String(search || "").replace(/^\?/, "").split("&").filter(function (pair) {
      if (!pair) return false;
      var k = pair.split("=")[0];
      try { k = decodeURIComponent(k); } catch (e) { return true; }
      return names.indexOf(k) < 0;
    });
    return kept.length ? "?" + kept.join("&") : "";
  }

  // The query without the names Supabase adds on the way back.
  var RETURN_NAMES = ["code", "error", "error_code", "error_description", "state", "sb"];
  function withoutReturn(search) { return without(search, RETURN_NAMES); }

  // The Google profile picture, kept only from Google's own picture host
  // (lh3.googleusercontent.com) and only as a plain address; "" otherwise.
  // The page shows it with referrerpolicy="no-referrer".
  var AVATAR_RE = /^https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9\-._~\/%=+&?,:@!$;*]*$/;
  function avatarUrl(v) {
    return typeof v === "string" && v.length <= 2048 && AVATAR_RE.test(v) ? v : "";
  }

  // A session, from Supabase's answer or from storage. null if it isn't one.
  function cleanSession(raw, nowSec) {
    if (!raw || typeof raw !== "object") return null;
    var access = str(raw.access_token, 16384);
    var refresh = str(raw.refresh_token, 2048);
    var c = claims(access);
    if (!c || c.role !== "authenticated" || !c.sub || !refresh) return null;
    var expires = Number(raw.expires_at);
    if (!isFinite(expires) || expires <= 0) {
      var inSec = Number(raw.expires_in);
      expires = Number(c.exp) || (nowSec + (isFinite(inSec) && inSec > 0 ? inSec : 3600));
    }
    var u = raw.user && typeof raw.user === "object" ? raw.user : {};
    var meta = u.user_metadata && typeof u.user_metadata === "object" ? u.user_metadata :
      (c.user_metadata && typeof c.user_metadata === "object" ? c.user_metadata : {});
    var user = {
      id: str(u.id, 64) || str(c.sub, 64),
      email: str(u.email, 320) || str(c.email, 320),
      name: str(meta.full_name, 120) || str(meta.name, 120)
    };
    var avatar = avatarUrl(meta.avatar_url) || avatarUrl(meta.picture);
    if (avatar) user.avatar = avatar;
    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: Math.floor(expires),
      user: user
    };
  }

  /* ---- the account ---- */

  // opts (all optional; the page passes none):
  //   project   { url, anonKey }
  //   storage   localStorage-like (the session, the seen versions, the gate)
  //   tab       sessionStorage-like (a sign-in on its way)
  //   location  { origin, pathname, search, hash, assign(url) }
  //   history   { replaceState(state, title, url) }
  //   fetch, crypto, now (ms)
  function Account(opts) {
    opts = opts || {};
    var g = typeof window !== "undefined" ? window : {};
    this.project = opts.project || PROJECT;
    this.store = safe("storage" in opts ? opts.storage : g.localStorage);
    this.tab = safe("tab" in opts ? opts.tab : g.sessionStorage);
    this.location = opts.location || g.location;
    this.history = opts.history || g.history;
    this.crypto = opts.crypto || g.crypto;
    this.fetchFn = opts.fetch || function (url, init) { return fetch(url, init); };
    this.now = opts.now || function () { return Date.now(); };
    this.listeners = [];
    this.refreshing = null;
    this.session = cleanSession(this.store.get(SESSION_STORE), this.nowSec());
    // Whether storage keeps the session (a private window may not), so that
    // finding it gone there means another tab signed out.
    this.persisted = !!this.session;
  }

  Account.prototype.nowSec = function () { return Math.floor(this.now() / 1000); };

  // fn(event, detail): "in" (signed in, or another tab did), "out" with the
  // reason ("signout", "expired", "other-tab", "deleted"), "error" with what
  // Google or Supabase said when a sign-in failed.
  Account.prototype.onChange = function (fn) { this.listeners.push(fn); };
  Account.prototype.emit = function (event, detail) {
    this.listeners.forEach(function (fn) {
      try { fn(event, detail); } catch (e) { if (typeof console !== "undefined") console.error(e); }
    });
  };

  Account.prototype.signedIn = function () { return !!this.session; };
  Account.prototype.user = function () { return this.session ? this.session.user : null; };

  // Accounts show on every device. ?accounts=0 hides them on this device
  // (remembered, and the page is as it was before accounts); ?accounts=1
  // shows them again. A device that kept the old "1" from when they were
  // hidden by default just shows them. Signed in, they always show.
  // "?accounts=0" typed at the end of an address that has a "#" in it
  // (…/card-pages/#my-binder?accounts=0) lands after the "#", where the
  // query isn't. It counts there too, and moves in front of the "#", so the
  // page (app.js, which runs after this) still finds its own "#my-binder".
  Account.prototype.enabled = function () {
    var loc = this.location || {};
    var q = params(loc.search);
    var hash = String(loc.hash || "");
    var cut = hash.indexOf("?");
    var inHash = cut < 0 ? {} : params(hash.slice(cut + 1));
    if (inHash.accounts === "1" || inHash.accounts === "0") {
      q.accounts = inHash.accounts;
      var search = without(loc.search, ["accounts"]);
      search = (search ? search + "&" : "?") + "accounts=" + inHash.accounts;
      var rest = without(hash.slice(cut + 1), ["accounts"]);
      if (this.history && this.history.replaceState) {
        this.history.replaceState(null, "", loc.pathname + search + hash.slice(0, cut) + rest);
      }
    }
    if (q.accounts === "1") this.store.drop(GATE_STORE);
    else if (q.accounts === "0") this.store.set(GATE_STORE, 0);
    return this.store.get(GATE_STORE) !== 0 || !!this.session;
  };

  Account.prototype.keep = function (session) {
    this.session = session;
    if (session) {
      this.store.set(SESSION_STORE, session);
      this.persisted = !!this.store.get(SESSION_STORE);
    } else this.store.drop(SESSION_STORE);
  };

  // Another tab signed in, refreshed or signed out (the page calls this on
  // the "storage" event).
  Account.prototype.reload = function () {
    var before = this.session;
    var now = cleanSession(this.store.get(SESSION_STORE), this.nowSec());
    this.session = now;
    if (now) this.persisted = true;
    if (!before && now) this.emit("in");
    else if (before && !now) this.emit("out", "other-tab");
    else if (before && now && before.user.id !== now.user.id) this.emit("in");
  };

  // One request to Supabase's sign-in API. Resolves { status, body }.
  Account.prototype.auth = function (method, path, data, token) {
    var headers = { apikey: this.project.anonKey, Accept: "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    var init = { method: method, cache: "no-store", headers: headers };
    if (data) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(data);
    }
    return Promise.resolve().then(function () {
      return this.fetchFn(this.project.url + path, init);
    }.bind(this)).then(null, function () {
      throw new SyncError("offline");
    }).then(function (res) {
      if (res.status === 204) return { status: 204, body: null };
      return Promise.resolve().then(function () { return res.json(); })
        .then(null, function () { return null; })
        .then(function (body) { return { status: res.status, body: body }; });
    });
  };

  // Where Google sends people back: this page, without its query. It must be
  // on the project's list of redirect URLs (supabase/README.md, part 3).
  Account.prototype.redirectTo = function () {
    return this.location.origin + this.location.pathname;
  };

  // Off to Google. Resolves once the page is on its way (tests: once
  // location.assign was called). prompt=select_account (Supabase passes it
  // on) makes Google ask which account every time, so a second Google
  // account can sign in on a browser that remembers the first. Nobody is
  // signed out of Google for it.
  Account.prototype.signIn = function () {
    var self = this;
    var verifier = makeVerifier(this.crypto);
    return challengeFor(this.crypto, verifier).then(function (challenge) {
      self.tab.set(PENDING_STORE, {
        verifier: verifier,
        back: str(self.location.search, 2000) + str(self.location.hash, 2000),
        at: self.now()
      });
      var url = self.project.url + "/auth/v1/authorize?provider=google" +
        "&redirect_to=" + encodeURIComponent(self.redirectTo()) +
        "&code_challenge=" + encodeURIComponent(challenge) +
        "&code_challenge_method=s256" +
        "&prompt=select_account";
      self.location.assign(url);
    });
  };

  // On every page load: finishes a sign-in coming back from Google. Resolves
  // "in", "error" or "" (nothing to finish). Only a sign-in this tab started
  // in the last 15 minutes is finished; any other ?code= is left alone.
  Account.prototype.finish = function () {
    var self = this;
    var pending = this.tab.get(PENDING_STORE);
    var q = params(this.location.search);
    var h = params(this.location.hash);
    var error = q.error || h.error ? str(q.error_description || q.error || h.error_description || h.error, 300) : "";
    if (!pending || (!q.code && !error)) return Promise.resolve("");
    this.tab.drop(PENDING_STORE);
    // The address goes back to what it was before Google: no code in it.
    var back = str(pending.back, 4000);
    var cut = back.indexOf("#");
    var search = cut < 0 ? back : back.slice(0, cut);
    var hash = cut < 0 ? "" : back.slice(cut);
    if (this.history && this.history.replaceState) {
      this.history.replaceState(null, "", this.location.pathname + withoutReturn(search) + hash);
    }
    var fresh = typeof pending.at === "number" && this.now() - pending.at < PENDING_MAX && typeof pending.verifier === "string";
    if (error || !fresh) {
      this.emit("error", error || "expired");
      return Promise.resolve("error");
    }
    return this.auth("POST", "/auth/v1/token?grant_type=pkce", { auth_code: q.code, code_verifier: pending.verifier })
      .then(function (r) {
        var session = r.status === 200 ? cleanSession(r.body, self.nowSec()) : null;
        if (!session) {
          self.emit("error", str(r.body && (r.body.error_description || r.body.msg || r.body.error), 300) || "refused");
          return "error";
        }
        self.keep(session);
        self.emit("in");
        return "in";
      }, function (err) {
        self.emit("error", err && err.kind || "offline");
        return "error";
      });
  };

  // The access token for a request, refreshed first when it is about to run
  // out or Supabase just refused it (`refused`). "" when signed out. Rejects
  // with SyncError "offline", "rate" or "server" when a refresh couldn't
  // reach Supabase; the session is kept for the next try.
  Account.prototype.accessToken = function (refused) {
    // Another tab may have refreshed, signed in or signed out meanwhile.
    var stored = cleanSession(this.store.get(SESSION_STORE), this.nowSec());
    if (stored && (!this.session || stored.access_token !== this.session.access_token)) {
      this.session = stored;
      refused = false; // the token Supabase refused isn't the one we have now
    } else if (!stored && this.session && this.persisted) {
      this.session = null;
      this.emit("out", "other-tab");
    }
    var s = this.session;
    if (!s) return Promise.resolve("");
    if (!refused && s.expires_at - EARLY > this.nowSec()) return Promise.resolve(s.access_token);
    return this.refresh();
  };

  // One refresh at a time, shared by everyone asking.
  Account.prototype.refresh = function () {
    var self = this;
    if (this.refreshing) return this.refreshing;
    var s = this.session;
    if (!s) return Promise.resolve("");
    this.refreshing = this.auth("POST", "/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token })
      .then(function (r) {
        var session = r.status === 200 ? cleanSession(r.body, self.nowSec()) : null;
        if (session) {
          self.keep(session);
          return session.access_token;
        }
        if (r.status === 429) throw new SyncError("rate", 429);
        if (r.status >= 500 || r.status === 0) throw new SyncError("server", r.status);
        // Refused: signed out on every device, or the refresh token was used
        // up. A tab that refreshed at the same moment may have stored a new one.
        var stored = cleanSession(self.store.get(SESSION_STORE), self.nowSec());
        if (stored && stored.refresh_token !== s.refresh_token) {
          self.session = stored;
          return stored.access_token;
        }
        self.keep(null);
        self.emit("out", "expired");
        return "";
      }).then(function (token) {
        self.refreshing = null;
        return token;
      }, function (err) {
        self.refreshing = null;
        throw err;
      });
    return this.refreshing;
  };

  // Signs out. scope "global" ends the sign-in on every device ("Delete my
  // data"), "local" only here (Sign out). This device forgets the session
  // whatever Supabase answers. What happens to the binder here is the page's
  // to decide on the "out" event (collection.js afterOut()).
  Account.prototype.signOut = function (scope, reason) {
    var self = this;
    if (!this.session) return Promise.resolve(false);
    var token = this.session.expires_at - EARLY > this.nowSec() ? Promise.resolve(this.session.access_token) : this.refresh();
    return token.then(function (access) {
      if (!access) return { status: 401 };
      return self.auth("POST", "/auth/v1/logout?scope=" + (scope === "global" ? "global" : "local"), null, access);
    }).then(null, function () { return { status: 0 }; }).then(function (r) {
      var wasIn = !!self.session;
      self.keep(null);
      if (wasIn) self.emit("out", reason || "signout");
      return r.status === 204 || r.status === 200;
    });
  };

  /* ---- what this device last synced, per account ---- */

  // The version of the account's binder this device last synced at, 0 if it
  // never did. It outlives signing out while cards from the account stay
  // here (signed out with unsaved changes): a device that synced before a
  // "Delete my data" must still know, the next time anyone signs in here.
  // When signing out clears the binder here, the page forgets it.
  Account.prototype.seen = function (uid) {
    var all = this.store.get(SEEN_STORE);
    var v = all && typeof all === "object" ? Number(all[uid]) : 0;
    return isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  Account.prototype.markSeen = function (uid, version) {
    var v = Number(version);
    if (!uid || !isFinite(v) || v < 1) return;
    var all = this.store.get(SEEN_STORE);
    all = all && typeof all === "object" && !Array.isArray(all) ? all : {};
    delete all[uid];
    var keep = {};
    Object.keys(all).slice(-(SEEN_MAX - 1)).forEach(function (k) { keep[k] = all[k]; });
    keep[uid] = Math.floor(v);
    this.store.set(SEEN_STORE, keep);
  };
  Account.prototype.forget = function (uid) {
    var all = this.store.get(SEEN_STORE);
    if (!all || typeof all !== "object" || !(uid in all)) return;
    delete all[uid];
    this.store.set(SEEN_STORE, all);
  };

  function create(opts) { return new Account(opts); }

  return {
    PROJECT: PROJECT,
    create: create,
    Account: Account,
    // for tests
    base64url: base64url,
    challengeFor: challengeFor,
    cleanSession: cleanSession,
    avatarUrl: avatarUrl,
    withoutReturn: withoutReturn
  };
});
