#!/usr/bin/env node
/**
 * AirNotam scraper — fetches Israeli NOTAMs from the official IAA AeroInfo page,
 * parses each ICAO-format message into structured fields, writes notams.json.
 *
 * Runs the same on your laptop and in GitHub Actions.
 *   Local:  npm install && npx playwright install chromium && node scrape.mjs
 *   CI:     handled by .github/workflows/scrape.yml
 *
 * Output: ../notams.json  (repo root, so GitHub Pages serves it next to AirNotam.html)
 */

import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "notams.json"); // repo root
const SRC = "https://ext.iaa.gov.il/aeroinfo/AeroInfo.aspx?msgType=Notam";
const TIMEOUT = 60000;

// ── ICAO NOTAM parsing ─────────────────────────────────────────────
// Q-line: FIR/Qcode/Traffic/Purpose/Scope/Lower/Upper/CoordsRadius
function parseQ(qLineText) {
  // e.g. "LLLL/QARLC/IV/NBO/E /025/030/3137N03452E007"
  const m = qLineText.match(/([A-Z]{4})\/([A-Z]{5})\/([A-Z]+)\/([A-Z]+)\s*\/([A-Z]+)\s*\/(\d{3})\/(\d{3})\/(\d{4}[NS]\d{5}[EW])(\d{3})?/);
  if (!m) return null;
  const [, fir, qcode, traffic, purpose, scope, lo, up, pos, rad] = m;
  return {
    fir, qcode, traffic, purpose, scope,
    lowerLimitFl: lo, upperLimitFl: up,
    positionToken: pos + (rad || ""),
    position: parseCoord(pos, rad ? parseInt(rad, 10) : null)
  };
}
function parseCoord(token, radiusNm) {
  // 3137N03452E -> lat 31 37', lon 034 52'
  const m = token.match(/(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])/);
  if (!m) return null;
  let lat = +m[1] + +m[2] / 60; if (m[3] === "S") lat = -lat;
  let lon = +m[4] + +m[5] / 60; if (m[6] === "W") lon = -lon;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), radiusNm, source: "q_line" };
}
function parseTimes(text) {
  const b = text.match(/\bB\)\s*(\d{10})/);
  const c = text.match(/\bC\)\s*(\d{10}|PERM)/i);
  const toISO = s => {
    if (!s || /perm/i.test(s)) return null;
    const y = 2000 + +s.slice(0, 2), mo = +s.slice(2, 4) - 1, d = +s.slice(4, 6),
          h = +s.slice(6, 8), mi = +s.slice(8, 10);
    return new Date(Date.UTC(y, mo, d, h, mi)).toISOString();
  };
  return {
    fromDate: b ? toISO(b[1]) : null,
    toDate: c ? (/perm/i.test(c[1]) ? null : toISO(c[1])) : null
  };
}
function parseNotam(raw) {
  // raw like: (C1982/26 NOTAMN\nQ) ...\nA) LLLL B) .. C) ..\nE) ...)
  const idm = raw.match(/\(?([A-Z]\d{4}\/\d{2})\s+NOTAM([NRC])(?:\s+([A-Z]\d{4}\/\d{2}))?/);
  const id = idm ? idm[1] : null;
  const notamType = idm ? idm[2] : null;
  const replaces = idm && idm[3] ? idm[3] : null;

  const qm = raw.match(/Q\)\s*([^\n]+)/);
  const qLine = qm ? parseQ(qm[1]) : null;

  const am = raw.match(/\bA\)\s*([A-Z]{4}(?:\s+[A-Z]{4})*)/);
  const location = am ? am[1].split(/\s+/)[0] : null;

  const em = raw.match(/E\)\s*([\s\S]*?)(?:\n[FG]\)|\)?\s*$)/);
  const eText = em ? em[1].replace(/\s+/g, " ").trim().replace(/\)$/, "") : "";

  const times = parseTimes(raw);
  const administrative = /CHECKLIST|TRIGGER NOTAM/i.test(eText);

  return {
    id, location,
    ...times,
    qLine,
    eText,
    position: qLine?.position || null,
    administrative,
    notamType,
    replaces,
    rawText: raw.trim()
  };
}

// ── Scrape ─────────────────────────────────────────────────────────
async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
               "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    locale: "en-US"
  });
  const page = await ctx.newPage();

  console.error("Loading IAA page (passing bot-wall)…");
  await page.goto(SRC, { waitUntil: "networkidle", timeout: TIMEOUT });
  // Radware challenge clears on a real browser; give it a moment then reload once.
  await page.waitForTimeout(4000);
  await page.goto(SRC, { waitUntil: "networkidle", timeout: TIMEOUT });

  // The NOTAM rows carry the raw ICAO text. Grab the whole rendered text and
  // extract every (Xnnnn/nn NOTAM...) block. This is robust to layout changes.
  const bodyText = await page.evaluate(() => document.body.innerText);
  await browser.close();

  // Extract NOTAM blocks: start at "(X####/##" and run to the closing ")".
  const blocks = [];
  const re = /\(([A-Z]\d{4}\/\d{2}\s+NOTAM[\s\S]*?)\)/g;
  let m;
  while ((m = re.exec(bodyText)) !== null) blocks.push("(" + m[1] + ")");

  if (!blocks.length) {
    throw new Error("No NOTAM blocks found — page layout may have changed or the wall blocked us.");
  }

  const notams = blocks.map(parseNotam).filter(n => n.id);
  // de-dupe by id (page sometimes repeats)
  const seen = new Set();
  const unique = notams.filter(n => (seen.has(n.id) ? false : seen.add(n.id)));

  return unique;
}

// ── Main ───────────────────────────────────────────────────────────
(async () => {
  const generatedAt = new Date().toISOString();
  try {
    const notams = await scrape();
    const payload = {
      generatedAt,
      source: SRC,
      disclaimer: "Informational only. Not a substitute for an official pre-flight briefing.",
      count: notams.length,
      notams
    };
    writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf-8");
    console.error(`✓ Wrote ${notams.length} NOTAMs → ${OUT}`);
  } catch (err) {
    console.error("✗ Scrape failed:", err.message);
    process.exit(1); // fail the CI run so you get notified; old JSON stays untouched
  }
})();
