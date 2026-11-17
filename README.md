# card-pages

The published site of **Pullfolio**, a binder for Pokémon TCG collectors:
https://kcglr.github.io/card-pages/

- **App:** `index.html`, the scripts, styles and `assets/`. Released by hand
  from the source repo (`release.json` names the version).
- **Data:** `data/` and `details/` (the card list), `links/` and `history/`
  are rebuilt each Monday; `prices/` every day. Both come from GitHub Actions
  in the source repo. `ids/` belongs to the standby card list and is not
  used by the app.
- **Sources:** cards and pictures from PokéCottage's master sets
  (https://pokecottage.com). Prices are our own, from TCGplayer data via
  TCGCSV (https://tcgcsv.com). This product uses TCGplayer data but is not
  endorsed or certified by TCGplayer. Stand-in pictures come from TCGplayer
  and TCGdex (https://tcgdex.dev, MIT licence; see `THIRD_PARTY_NOTICES.txt`).

- **Accounts (testing):** opening the site with `?accounts=1` shows "Sign in
  with Google" in My binder, to save a binder to an account (Supabase).
  Browsing never needs one. Only invited Google accounts can sign in for now.

An independent, non-commercial fan project. Not affiliated with Nintendo,
Creatures, GAME FREAK, The Pokémon Company or any marketplace.
