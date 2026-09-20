# The app is coloured after its own mark

The app had three identities. The interface tokens in `src/index.css` were a cool blue-grey ramp at hue 265 with a blue `--primary`; the logo in `site/logo.svg` is warm ink `#1c1a17` on paper `#ece8e2` with an amber `#e0913a` accent; the marketing page was sage green. Nothing chose between them, so the window the user spends their day in looked like neither the thing they downloaded nor the page they downloaded it from.

The mark wins, because it is the only one of the three that is the product's name. The neutral ramp moves to hue 78 at very low chroma — the hue shared by the logo's ink and paper — and `--primary`, and with it `--ring` and every `--sidebar-*` that derives from them, becomes the logo's amber, with a lighter variant in `.dark`. `--primary-foreground` is the warm ink. `--destructive` stays where it is: a refusal is not part of a brand and must not read as one.

This is recorded in tokens only. Every surface in the app already reads `bg-primary`, `ring-ring`, `bg-card` and `bg-sidebar-accent`, so the palette is one file and no component knows a colour by name. That is the constraint this decision keeps rather than the palette itself: a future retune stays a diff to `:root` and `.dark`, and any component that hard-codes a colour is a bug.

Two things this does not cover. `Theme::background` in `src-tauri/src/lib.rs` hands the webview a first-frame colour before the document exists, and it is still an approximation of `--background` written by hand in sRGB rather than derived from it; it was one before this change too. And `site/index.html` is not part of the app bundle — bringing the marketing page to the same palette is a separate change to a separate artifact.
