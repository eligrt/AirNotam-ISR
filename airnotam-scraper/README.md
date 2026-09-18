# AirNotam scraper

Fetches Israeli NOTAMs from the official IAA AeroInfo page and writes `notams.json`
that AirNotam.html reads. Same code runs locally and in GitHub Actions.

## Repo layout (on GitHub Pages)

```
your-repo/
├── AirNotam.html              ← the app (reads ../notams.json → set FEED to "notams.json")
├── notams.json                ← produced by the scraper, committed by the Action
└── airnotam-scraper/
    ├── scrape.mjs
    ├── package.json
    └── .github/…              ← move this to the REPO ROOT: .github/workflows/scrape.yml
```

> Note: `.github/workflows/` must sit at the **repository root**, not inside
> `airnotam-scraper/`. Move it up one level after copying.

## Test locally (do this first)

```bash
cd airnotam-scraper
npm install
npx playwright install chromium
node scrape.mjs
```

On success it writes `../notams.json` and prints `✓ Wrote N NOTAMs`.
Open AirNotam.html (with FEED pointed at that local file) to see it.

If it prints `No NOTAM blocks found`, the bot-wall blocked the headless run or the
page layout changed — tell me and we adjust (usually a longer wait or a real click flow).

## Deploy (automatic refresh)

1. Push this repo to GitHub (public, so Pages + Actions are free).
2. Move `airnotam-scraper/.github` to the repo root so the path is
   `.github/workflows/scrape.yml`.
3. Settings → Pages → deploy from `main`, root.
4. Settings → Actions → General → Workflow permissions → **Read and write**.
5. Actions tab → run "Scrape NOTAMs" once manually (workflow_dispatch) to seed
   `notams.json`.
6. In AirNotam.html set `const FEED = "notams.json";` (same-origin, no CORS).

The Action then runs every ~15 min and commits a fresh `notams.json`.

## Staleness

AirNotam judges freshness by `generatedAt` in the JSON (when scraped), not by when
you loaded the page — so a dead scraper shows as stale even though the page loaded
fine. Green <30 min, amber <3 h, red older.

⚠️ Informational tool only. Always confirm against an official pre-flight briefing.
