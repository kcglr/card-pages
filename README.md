# card-pages

The published site of **Pullfolio**, a binder for Pokémon TCG collectors:
https://kcglr.github.io/card-pages/

- **App:** `index.html`, the scripts, styles and `assets/`. Released by hand
  from the source repo (`release.json` names the version).
- **Data:** `data/` and `details/` (the card list), `links/`, `history/` and
  `ids/` are rebuilt each Monday; `prices/` every day. Both come from GitHub
  Actions in the source repo.
- **Sources:** card data from TCGdex (https://tcgdex.dev, MIT licence; see
  `THIRD_PARTY_NOTICES.txt`) and TCGplayer products and prices via TCGCSV
  (https://tcgcsv.com). This product uses TCGplayer data but is not endorsed
  or certified by TCGplayer.

An independent fan project. Not affiliated with Nintendo, Creatures,
GAME FREAK, The Pokémon Company or any marketplace.
