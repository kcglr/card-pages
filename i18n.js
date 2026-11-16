/* Site language: English and Turkish. Static markup marks its text with
   data-i18n (text), data-i18n-html (trusted markup) or
   data-i18n-attr="attr:key;attr:key"; scripts call CardI18n.t(key, vars).
   The choice comes from ?lang=, then the saved choice, then the browser. */
(function (root) {
  "use strict";
  var BRAND = "Pullfolio";
  var LANGS = ["en", "tr"];
  var STORE = "site-lang";

  var STRINGS = {
    en: {
      "title.home": "{brand} — every Pokémon card in one binder",
      "title.species": "{name} cards · {brand}",
      "brand.home": "{brand} home",
      "skip": "Skip to the binder",
      "nav.label": "Main navigation",
      "nav.find": "Find a Pokémon",
      "nav.guide": "How prices work",
      "lang.label": "Site language",
      "hero.title": "Every Pokémon card, filed in <mark>one binder</mark>.",
      "hero.and": "Pokémon and",
      "hero.rest": "printings in English, Japanese and Chinese. Look one up, flip through its pages, and pull out any card to see what it sells for.",
      "search.title": "Whose binder should we open?",
      "search.submit": "Open binder",
      "search.placeholder": "Type a Pokémon…",
      "search.matches": "Matching Pokémon",
      "search.none": "No Pokémon called “{q}”",
      "welcome.note": "Type a name or pick a Pokémon to open its binder.",
      "guide.summary": "How prices and links work",
      "guide.h1": "Prices on the stickers",
      "guide.p1": "The sticker on a sleeve is the TCGplayer market price in USD. Pull the card out to see an approximate lira conversion. Availability varies by language and printing; a sleeve without a sticker has no price yet.",
      "guide.h2": "The exact printing",
      "guide.p2": "Pull a card out to open its PriceCharting, Cardmarket or Collectr page. When no exact page is known you get a search instead. eBay links keep sold and active listings apart.",
      "guide.h3": "Handling the binder",
      "guide.p3": "Turn pages with the arrows, the page corners, your arrow keys or a swipe. Click a card to pull it out, then move over it, or press and slide on a phone, to tilt it in the light.",
      "footer.note": "An independent fan project for Pokémon TCG collectors. Not affiliated with Nintendo, The Pokémon Company or any marketplace.",
      "sheet.close": "Put the card back",
      "tilt.pointer": "Move over the card to tilt it",
      "tilt.touch": "Press and slide on the card to tilt it",

      "result.dex": "No. {n}",
      "result.master": "Master set",
      "result.back": "Find another Pokémon",
      "result.hint": "Pick a card to pull it out of its sleeve.",
      "count.cards": { one: "{n} card", other: "{n} cards" },
      "count.printings": { one: "{n} printing", other: "{n} printings" },
      "count.of": "{n} of {total}",
      "toolbar.sort": "Sort",
      "toolbar.variant": "Variant",
      "toolbar.allVariants": "All variants",
      "toolbar.filter": "Filter",
      "toolbar.filterHint": "Filter by set, number or rarity…",
      "toolbar.rarity": "Rarity",
      "toolbar.hideReverse": "Hide reverse holo",
      "sort.newest": "Newest first",
      "sort.oldest": "Oldest first",
      "sort.priceDesc": "Price high→low",
      "sort.priceAsc": "Price low→high",
      "sort.name": "Name",
      "sort.set": "Set",
      "tabs.label": "Language",
      "tabs.all": "All",
      "empty": "No cards match these filters.",
      "card.fallback": "Card",
      "card.noPrice": "no price yet",
      "footer.prices": "Prices live from TCGplayer · {time}.",
      "footer.list": "Card list:",
      "footer.rest": "USD unless ₺. Prices only where shown.",

      "binder.loading": "Opening the binder…",
      "binder.stuck": "This binder would not open. Check your connection and try again.",
      "binder.empty": "Empty binder",
      "binder.pages": "Pages {a}–{b} of {n}",
      "binder.page": "Page {a} of {n}",
      "binder.prev": "Previous page",
      "binder.prevPair": "Previous pages",
      "binder.next": "Next page",
      "binder.nextPair": "Next pages",
      "binder.jump": "Jump to page",

      "market.productPage": "product page",
      "market.search": "search",
      "kind.market": "market",
      "kind.mid": "mid",
      "kind.low": "low",
      "market.ebaySold": "eBay sold",
      "market.ebaySoldNote": "sold listings for this printing",
      "market.ebay": "eBay listings",
      "market.ebayNote": "active listings for this printing",
      "link.exact": "exact card page",
      "link.loading": "Finding exact card page…",
      "link.notFound": "No exact match found",
      "link.unavailable": "Card lookup unavailable",
      "link.none": "Exact card link unavailable",
      "link.pcOpen": "Open card on PriceCharting",
      "link.pcSearch": "Search PriceCharting",
      "link.cmOpen": "Open card on Cardmarket",
      "link.cmSearch": "Search Cardmarket",
      "link.collectr": "View price on Collectr",
      "link.ebaySold": "View eBay sold listings",

      "status.catalog": "Loading catalog…",
      "status.catalogFailed": "Could not load the catalog.",
      "status.noMatch": "No Pokémon named like that in the catalog.",
      "status.loading": "Loading {name}…",
      "status.loadFailed": "Could not load {name}.",
      "status.fetching": "Fetching live prices…",
      "status.priced": "{n} priced · prices live from TCGplayer · {time}{elapsed}",
      "status.partial": "{n} priced · some price requests failed · {time}"
    },
    tr: {
      "title.home": "{brand} — tüm Pokémon kartları tek bir klasörde",
      "title.species": "{name} kartları · {brand}",
      "brand.home": "{brand} ana sayfa",
      "skip": "Klasöre geç",
      "nav.label": "Ana menü",
      "nav.find": "Pokémon bul",
      "nav.guide": "Fiyatlar nasıl çalışır?",
      "lang.label": "Site dili",
      "hero.title": "Tüm Pokémon kartları, <mark>tek bir klasörde</mark>.",
      "hero.and": "Pokémon ve",
      "hero.rest": "baskı; İngilizce, Japonca ve Çince. Birini ara, sayfalarını çevir ve kaç para ettiğini görmek için istediğin kartı kılıfından çıkar.",
      "search.title": "Kimin klasörünü açalım?",
      "search.submit": "Klasörü aç",
      "search.placeholder": "Bir Pokémon yaz…",
      "search.matches": "Eşleşen Pokémonlar",
      "search.none": "“{q}” diye bir Pokémon yok",
      "welcome.note": "Klasörünü açmak için bir isim yaz ya da bir Pokémon seç.",
      "guide.summary": "Fiyatlar ve bağlantılar nasıl çalışır?",
      "guide.h1": "Kılıftaki etiketler",
      "guide.p1": "Kılıftaki sarı etiket, kartın USD cinsinden TCGplayer piyasa fiyatıdır. Kartı çıkarınca yaklaşık TL karşılığını da görürsün. Fiyat bulunması dile ve baskıya göre değişir; etiketi olmayan kartın henüz fiyatı yok.",
      "guide.h2": "Tam baskı",
      "guide.p2": "Kartın PriceCharting, Cardmarket veya Collectr sayfasını açmak için onu kılıfından çıkar. Tam sayfa bilinmiyorsa onun yerine bir arama bağlantısı çıkar. eBay bağlantıları satılmış ve aktif ilanları ayrı tutar.",
      "guide.h3": "Klasörü kullanmak",
      "guide.p3": "Sayfaları oklarla, sayfa köşeleriyle, klavyedeki yön tuşlarıyla ya da yana kaydırarak çevir. Bir karta tıklayıp çıkar; ışıkta eğmek için imleci üzerinde gezdir, telefonda basılı tutup kaydır.",
      "footer.note": "Pokémon TCG koleksiyoncuları için bağımsız bir hayran projesi. Nintendo, The Pokémon Company veya herhangi bir pazar yeriyle bağlantısı yoktur.",
      "sheet.close": "Kartı geri koy",
      "tilt.pointer": "Eğmek için imleci kartın üzerinde gezdir",
      "tilt.touch": "Eğmek için karta basılı tutup kaydır",

      "result.dex": "No. {n}",
      "result.master": "Master set",
      "result.back": "Başka bir Pokémon bul",
      "result.hint": "Kılıfından çıkarmak için bir kart seç.",
      "count.cards": "{n} kart",
      "count.printings": "{n} baskı",
      "count.of": "{n} / {total}",
      "toolbar.sort": "Sırala",
      "toolbar.variant": "Varyant",
      "toolbar.allVariants": "Tüm varyantlar",
      "toolbar.filter": "Süz",
      "toolbar.filterHint": "Set, numara veya nadirliğe göre süz…",
      "toolbar.rarity": "Nadirlik",
      "toolbar.hideReverse": "Reverse holoları gizle",
      "sort.newest": "Önce en yeni",
      "sort.oldest": "Önce en eski",
      "sort.priceDesc": "Fiyat yüksek→düşük",
      "sort.priceAsc": "Fiyat düşük→yüksek",
      "sort.name": "İsim",
      "sort.set": "Set",
      "tabs.label": "Dil",
      "tabs.all": "Tümü",
      "empty": "Bu filtrelere uyan kart yok.",
      "card.fallback": "Kart",
      "card.noPrice": "henüz fiyat yok",
      "footer.prices": "Fiyatlar TCGplayer'dan canlı · {time}.",
      "footer.list": "Kart listesi:",
      "footer.rest": "₺ yazmayan fiyatlar USD. Fiyat yalnızca gösterilen kartlarda var.",

      "binder.loading": "Klasör açılıyor…",
      "binder.stuck": "Bu klasör açılmadı. Bağlantını kontrol edip tekrar dene.",
      "binder.empty": "Boş klasör",
      "binder.pages": "Sayfa {a}–{b} / {n}",
      "binder.page": "Sayfa {a} / {n}",
      "binder.prev": "Önceki sayfa",
      "binder.prevPair": "Önceki sayfalar",
      "binder.next": "Sonraki sayfa",
      "binder.nextPair": "Sonraki sayfalar",
      "binder.jump": "Sayfaya git",

      "market.productPage": "ürün sayfası",
      "market.search": "arama",
      "kind.market": "piyasa",
      "kind.mid": "orta",
      "kind.low": "en düşük",
      "market.ebaySold": "eBay satılanlar",
      "market.ebaySoldNote": "bu baskının satılmış ilanları",
      "market.ebay": "eBay ilanları",
      "market.ebayNote": "bu baskının aktif ilanları",
      "link.exact": "tam kart sayfası",
      "link.loading": "Tam kart sayfası aranıyor…",
      "link.notFound": "Tam eşleşme bulunamadı",
      "link.unavailable": "Kart araması şu an çalışmıyor",
      "link.none": "Tam kart bağlantısı yok",
      "link.pcOpen": "Kartı PriceCharting'de aç",
      "link.pcSearch": "PriceCharting'de ara",
      "link.cmOpen": "Kartı Cardmarket'te aç",
      "link.cmSearch": "Cardmarket'te ara",
      "link.collectr": "Fiyatı Collectr'da gör",
      "link.ebaySold": "eBay'de satılmış ilanları gör",

      "status.catalog": "Katalog yükleniyor…",
      "status.catalogFailed": "Katalog yüklenemedi.",
      "status.noMatch": "Katalogda bu isimde bir Pokémon yok.",
      "status.loading": "{name} yükleniyor…",
      "status.loadFailed": "{name} yüklenemedi.",
      "status.fetching": "Canlı fiyatlar alınıyor…",
      "status.priced": "{n} fiyatlı · fiyatlar TCGplayer'dan canlı · {time}{elapsed}",
      "status.partial": "{n} fiyatlı · bazı fiyat istekleri başarısız · {time}"
    }
  };

  function choose() {
    var param = /[?&]lang=([a-z]{2})\b/i.exec(root.location.search);
    if (param && LANGS.indexOf(param[1].toLowerCase()) !== -1) return param[1].toLowerCase();
    try {
      var saved = root.localStorage.getItem(STORE);
      if (LANGS.indexOf(saved) !== -1) return saved;
    } catch (e) { /* storage blocked: fall through */ }
    var prefs = root.navigator.languages || [root.navigator.language || ""];
    for (var i = 0; i < prefs.length; i++) {
      var code = String(prefs[i] || "").slice(0, 2).toLowerCase();
      if (LANGS.indexOf(code) !== -1) return code;
    }
    return "en";
  }

  var lang = choose();
  var listeners = [];

  function t(key, vars) {
    var entry = STRINGS[lang][key];
    if (entry == null) entry = STRINGS.en[key];
    if (entry == null) return key;
    if (typeof entry === "object") entry = vars && Number(vars.n) === 1 && entry.one != null ? entry.one : entry.other;
    return entry.replace(/\{(\w+)\}/g, function (match, name) {
      if (vars && vars[name] != null) return String(vars[name]);
      return name === "brand" ? BRAND : match;
    });
  }

  function locale() { return lang === "tr" ? "tr-TR" : "en-US"; }

  function num(value) { return Number(value || 0).toLocaleString(locale()); }

  function apply(scope) {
    scope = scope || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    scope.querySelectorAll("[data-i18n-html]").forEach(function (el) { el.innerHTML = t(el.getAttribute("data-i18n-html")); });
    scope.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var parts = pair.split(":");
        if (parts.length === 2) el.setAttribute(parts[0].trim(), t(parts[1].trim()));
      });
    });
    if (scope === document) {
      document.documentElement.lang = lang;
      document.querySelectorAll("[data-set-lang]").forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.getAttribute("data-set-lang") === lang ? "true" : "false");
      });
    }
  }

  function setLang(next) {
    if (LANGS.indexOf(next) === -1 || next === lang) return;
    lang = next;
    try { root.localStorage.setItem(STORE, lang); } catch (e) { /* not saved; still switches */ }
    apply(document);
    listeners.forEach(function (fn) { fn(lang); });
  }

  root.CardI18n = {
    brand: BRAND,
    t: t,
    num: num,
    locale: locale,
    apply: apply,
    setLang: setLang,
    lang: function () { return lang; },
    onChange: function (fn) { listeners.push(fn); }
  };

  document.querySelectorAll("[data-set-lang]").forEach(function (btn) {
    btn.addEventListener("click", function () { setLang(btn.getAttribute("data-set-lang")); });
  });
  apply(document);
})(window);
