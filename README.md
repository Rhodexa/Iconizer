# Iconizer

Watermark a batch of pictures and videos with an icon, plus optional price and size tags — entirely client-side, no server processing.

1. Load an icon (transparent PNG works best).
2. Load any number of pictures and videos.
3. Pick a corner, or **Auto** to place the icon in the corner where it contrasts best
   with the background (alpha-weighted luminance difference, penalising busy areas).
4. Adjust size (% of the picture's shorter side), margin and opacity.
5. Optionally add a price and/or size tag, each in its own corner.
6. Download everything as a `.zip`, or single files from each card.
   Videos are re-recorded in real time (MP4 or WebM, depending on the browser) with their
   soundtrack, so keep the tab visible while they render.

## Deploy to GitHub Pages

Push to GitHub, then in **Settings → Pages** choose *Deploy from a branch*, branch `main`, folder `/ (root)`.

No build step. JSZip is vendored in `vendor/` so the site has no external dependencies.

## Run locally

```sh
python3 -m http.server 8000
```
