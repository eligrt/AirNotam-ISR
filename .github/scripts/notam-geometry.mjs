/*
 * notam-geometry.mjs · v1.00.014 · AirNotam-ISR · built by eligrt
 *
 * WHAT THIS FILE DOES
 *   scrape.yml fetches the NOTAMs from the IAA and writes notams.json.
 *   This file then reads each NOTAM's field E text and, where the text itself
 *   describes the area (coordinates), adds a "geometry" field with the real shape.
 *   The app draws that shape instead of the generic Q-line circle.
 *   NOTAMs without a usable shape are left untouched, and the app keeps drawing
 *   the Q-line circle for them, exactly as before.
 *
 * USAGE
 *   node notam-geometry.mjs notams.json            (updates the file in place)
 *   node notam-geometry.mjs in.json out.json
 *   node notam-geometry.mjs notams.json --flags flags.json   (also writes the list of NOTAMs worth a human look)
 *   (border lines are read from gis/borders.json next to the repo root; --borders <path> overrides;
 *    the route layers cvfr.json and sport.json are read from the same folder, each with its chart patch
 *    gis/<layer>-patch-*.json laid on top: see gisApplyPatch and the patch files' _readme)
 *
 * WHAT IT RECOGNISES (field E)
 *   polygon : "BTN FLW PSN 314107N0345919E 313846N0345857E ..."   (3+ points)
 *   circle  : "WI 0.3NM RADIUS CENTERED ON PSN 315941.27N0345429.55E"
 *             "PSN 314155N0344128E, RADIUS 0.6NM"   (units NM / KM / M)
 *             "... CENTERED ON PSN A AND PSN B"     (two circles)
 *   point   : "2 OBST PSN 325907.85N0353409.91E"   (one point, no radius)
 *   Coordinates in both IAA styles: 314945N0345822E and N314945E0345822,
 *   with or without seconds and decimal seconds.
 *   One NOTAM may hold several areas (e.g. a polygon AND a circle); each
 *   sentence of field E is read on its own.
 *
 * BORDER STRIPS (only when field E has no coordinates)
 *   "FM LEBANON BOUNDRAY TO 8KM SB ..."   (LEBANON / SYRIA / JORDAN / EGYPT, KM or NM)
 *   The strip runs along the border line from gis/borders.json (OSM, checked against the
 *   Interior Ministry outline), on the ISRAELI side, N km deep + 1 km safety margin.
 *   The direction word (SB / WB ...) is only a cross-check: if it points away from Israel
 *   (C1830 "EGYPT ... WB"), the strip is still drawn on the Israeli side and a note says so.
 *
 * CLOSED ROUTE LEGS (only when field E has no coordinates and is not a border strip)
 *   "CVFR RTE CLSD NOAAM-GOVRN-ZHRYA."   "ULTRALIGHT RTE CLSD NITZA-NMADD-ZASHD. ZBRCH-NIZNM-ZASHD."
 *   Each leg (two neighbouring names) is looked up in the IAA route layers gis/cvfr.json and
 *   gis/sport.json and drawn along the published route line (not a straight line).
 *   - layer: CVFR -> cvfr.json, ULTRALIGHT -> sport.json, HEL alone -> cvfr.json; if the leg is not
 *     in that layer, the other layer is used (same two points, same published route) and noted
 *   - a leg whose two points are not directly joined in the GIS is accepted only through ONE
 *     possible path of at most 3 segments, no longer than 1.3 x the straight distance
 *     (the NOTAM skipped a point in between, e.g. MCZVA-YARHV = MCZVA-SSOMR-YARHV); "via" lists them
 *   - v1.00.013 (Eli, issue #5 C2071): a point named in the middle of a published leg does not break the leg.
 *     If the NOTAM closes A-B-C, the GIS has neither A-B nor B-C, but has the published leg A-C and point B lies on it
 *     (within 0.5 km of the line), the leg A-C is drawn ("pointOn":["B"]). E.g. AHIUD-YASIF-AAKKO = AHIUD-AAKKO.
 *   - v1.00.014 (Eli, issue #4 C2080): a closed leg found in no route layer, where one end is known ONLY as an IFR point
 *     (gis/ifr.json, e.g. the offshore HEL routes GALIM-SUVAS), is drawn as a straight line between the two points
 *     ("straight":true). The other end uses its VFR position when it has one. Such a leg always gets the Q check (+3 NM).
 *     A point in no file at all (e.g. INBAR) stays in "missing".
 *   - anything after "DIVERTED" is the diversion (open), never drawn as closed. It is kept as parts with
 *     "role":"diversion" (drawn by the app as the published route, highlighted, not as a restriction):
 *       "DIVERTED VIA FRDIS-HASID."  -> the diversion is that chain
 *       "DIVERTED VIA MZDOT SOKET-MYTAR-... MMORR-ARRAD-LLMZ."  (C2040) -> the diversion is the published route
 *       through the single point MZDOT (1 or 2 segments). The chains that follow are the CLOSED legs, but only
 *       when the RTE CLSD sentence named no legs itself, MZDOT is not in those chains and is not joined in the GIS
 *       to the point right after it (which would make "MZDOT SOKET-..." a chain with a missing hyphen);
 *       otherwise nothing is guessed (Q circle + flag)
 *   - only sentences with RTE ... CLSD, and the bare lists of legs right after them, are read;
 *     ATS routes (airways) are ignored
 *   - legs that cannot be found are listed in "missing" and simply not drawn
 *   - a leg the NOTAM names whose two end points are both published points joined directly in the GIS ("exact leg")
 *     is drawn from the GIS even if it reaches outside the NOTAM's Q circle (Eli, 2026-09-30: marking an open leg
 *     as closed is far less risky than missing a closed one). GIS legs with ends off their named points are never
 *     used anyway (see loadRoutes)
 *   - a leg the parser filled in through a skipped point ("via") must stay inside the Q circle (+3 NM): if not, it is
 *     left out ("outsideQ") and flagged; the others are drawn
 *   - codes are also looked up through the chart patch's aliases (MARSB -> MRSBA, HATRU -> TZHTR on the sport layer)
 *   - a leg that uses a point / leg WITHDRAWN from the 2025 chart is still drawn, but flagged (see FLAGS)
 *
 * NAMED AIRSPACE (only when field E has no coordinates and is neither a border strip nor route legs)
 *   A sentence that STARTS with the area and says it is closed / activated / available only for someone:
 *     "CTR CLSD TO ALL FLT ..." (the CTR of field A, e.g. LLHZ)      "LLR01 ACTIVATED H24 ..."
 *     "LLHZ CTR CLSD ..."   "LLBG TMA CLSD ..."   "LLP14 CLSD ..."   "CTR AVBL FOR UAS/UAV ... ONLY"
 *   The area is drawn from the IAA GIS layers gis/ctr.json (CTR / ATZ), gis/tma.json, gis/prd.json (LLP / LLR / LLD).
 *   - codes are matched ignoring leading zeros (the NOTAM says LLR01, the GIS stores LLR1); a few ICAO codes the
 *     GIS stores under another name are mapped (AREA_ALIAS, e.g. LLGV -> GVULT)
 *   - a code with several GIS areas: every area that passes the Q check is drawn (the Q circle picks the right one
 *     when different airfields share a code, e.g. LLNV)
 *   - relative wording ("S OF LLBG TMA", "WI LLHA CTR") is not the whole area and keeps the Q circle
 *   - a named area that is not in the GIS (e.g. "LLER TRG AREA HAR BERECH CLSD", training areas are not published
 *     as GIS) keeps the Q circle and is flagged "area missing"
 *
 * GAZA STRIP BORDER STRIP ("... FM GAZA-STRIP BOUNDRAY TO 6KM OUTWARD ...", C1825)
 *   A border strip like the ones above, measured from the Gaza Strip boundary line in gis/borders.json ("gaza"),
 *   on the ISRAELI side, N km deep + 1 km safety margin (Eli, 2026-09-30, round 3). It is added as a second area of
 *   the same NOTAM (part "role":"strip"); the NOTAM's own polygon from field E stays as it is. The polygon must pass
 *   the Q check; the strip may reach the strip's width further (the IAA's Q circle covers the polygon, not the band).
 *   (Up to v1.00.009 a ring was drawn round the POLYGON's edge: a misreading, removed.)
 *   A strip that lies entirely inside the NOTAM's own polygon is NOT drawn (Eli, 2026-09-30, test round 3): in C1825
 *   the polygon is already closed and the band only says how to get approval, so drawing it would be red on red.
 *   It is noted as "stripInside" instead. A strip reaching outside the polygon is still drawn.
 *   Any other "OUTWARD" wording is flagged, not guessed.
 *
 * FLAGS (--flags): NOTAMs that probably deserved a shape but did not get a full one, so a person can look.
 *   Most Q-circle NOTAMs are correct as circles (obstacle lights, runway works...) and are NOT flagged.
 *   - "rejected"     coordinates / legs were found but failed a safety rule
 *   - "legs missing" RTE CLSD legs that are not in the GIS route layers
 *   - "outside Q"    a route leg filled in through a skipped point, reaching outside the NOTAM's Q circle: left out,
 *                    the rest drawn (exact legs are never checked against the Q circle)
 *   - "withdrawn"    a route leg that uses a point / leg withdrawn from the 2025 chart (drawn, but the patch may be wrong)
 *   - "semi-circle"  a semi-circle with no side, drawn as a full circle
 *   - "area missing" a named airspace (CTR / TMA / LLP / training area...) that is not in the GIS layers
 *   - "outward"      "... TO N KM OUTWARD" that could not be drawn (anything but the Gaza Strip boundary)
 *   - "patch"        a leg in a chart patch file refused by its distance check (a typo in the patch)
 *   - "Q/E mismatch" (v1.00.012) the NOTAM's own items disagree: the Item E area lies outside the Item Q circle
 *                    (both drawn, linked), or a border strip's direction word points away from Israel
 *   - "unfamiliar"   no shape, but the text has words that usually describe an area or a line
 *                    (RADIUS, BOUNDARY, BOUNDED, SEMI-CIRCLE, ARC, CORRIDOR, RTE CLSD, BTN FLW, PSN,
 *                    CENTERED, "WI 5NM", coordinate-like numbers); ATS airways are ignored
 *   Each flag has a "key" = kind + the exact E text, so a NOTAM re-issued with the same text is not
 *   flagged again (the workflow keeps the keys already reported).
 *
 * SAFETY RULES (any failure = no geometry, the app falls back to the Q circle)
 *   - every coordinate-looking token must parse (a typo like 3149310N rejects it)
 *   - all points inside the Tel-Aviv FIR box
 *   - polygon: 3+ distinct points, not self-crossing, not zero-area
 *   - circle radius between 10 m and 50 NM
 *   - the whole shape must lie inside the NOTAM's own Q-line circle (+1.5 NM slack),
 *     so a misread number can never move a restriction somewhere else.
 *     v1.00.012 (Eli, issue #7 C2099): when the Item E shape reaches outside the Q circle, it is no longer
 *     rejected: the E shape is drawn as the main area AND the Q circle is kept as a second, linked area
 *     ("role":"q"), so whichever of the two is wrong, the pilot still sees the other. Marked with
 *     "mismatch":{"kind":"q-e","distNm":20.7} (Q centre to the E area's anchor) and flagged "Q/E mismatch".
 *   - "SEMI-CIRCLE TO EAST" (or NORTH / SOUTH / WEST) becomes a half circle on that side;
 *     a semi-circle with no clear direction is drawn as a full circle (never smaller than the real area)
 *
 * OUTPUT (added to the NOTAM object; coordinates are [lat, lon] like Leaflet)
 *   "geometry": {
 *     "source": "e_text",
 *     "parts": [ {"type":"polygon","coords":[[lat,lon],...]},
 *                {"type":"circle","center":[lat,lon],"radiusNm":0.3},
 *                {"type":"circle","center":[lat,lon],"radiusNm":2.4,"half":"E"},   // semi-circle, side N/E/S/W
 *                {"type":"point","coord":[lat,lon]} ],
 *     "anchor": [lat,lon],          // a point inside the main part (for the map dot)
 *     "note": "semi-circle drawn as full circle"   (only when the side is not stated)
 *   }
 *   border strip: "source":"border", "border":"lebanon", "km":8, "marginKm":1,
 *                 "parts":[{"type":"polygon","coords":[...],"fill":"nonzero"}], "note" when the
 *                 text's direction was ignored
 *   closed route legs: "source":"route",
 *                 "parts":[{"type":"line","coords":[[lat,lon],...],"leg":"NOAAM-GOVRN","layer":"cvfr",
 *                           "via":["SSOMR"] (only when a skipped point was filled in),
 *                           "pointOn":["YASIF"] (v1.00.013: a named point lying on this published leg),
 *                           "straight":true (v1.00.014: no published route, straight line to an IFR point),
 *                           "otherLayer":true (only when found in the other layer)}, ...],
 *                 "missing":["AFULA-EITAN"] (only when some legs could not be found)
 *                 diversion: extra parts {"type":"line","role":"diversion","coords":[...],"leg":"MYTAR-MZDOT",
 *                 "layer":"cvfr","t":"BR · CIVIL"} and "diversionNames":["מיתר","מצודות","עין גדי"] (GIS Hebrew names)
 *   named airspace: "source":"named", "areas":[{"code":"LLHZ","kind":"CTR","name":"הרצליה"}],
 *                 "parts":[{"type":"polygon","coords":[...]}, ...]
 *   Gaza strip:   extra part {"type":"polygon","role":"strip","coords":[...],"fill":"nonzero"}
 *                 and "strip":{"border":"gaza","km":6,"marginKm":1,"of":"GAZA-STRIP"};
 *                 when the strip lies entirely inside the NOTAM's own polygon: no extra part, only
 *                 "stripInside":{"border":"gaza","km":6,"marginKm":1,"of":"GAZA-STRIP"}
 *   mismatch (v1.00.012): "mismatch":{"kind":"q-e","distNm":20.7}  (Item E area outside the Q circle; extra part
 *                 {"type":"circle","role":"q","center":[lat,lon],"radiusNm":1} = the Q circle) or
 *                 "mismatch":{"kind":"e-dir","border":"egypt","width":"6KM","dir":"WB"}  (border strip direction word
 *                 points away from Israel). The app shows a gold box in the popup and lists them under "אי התאמה Q/E".
 *   "geometryReject": "reason"      // only when coordinates / route legs were found but rejected
 *   "geometryFlag": {"kind":"legs missing","reason":"..."}   // only on flagged NOTAMs (see FLAGS);
 *                                   the test copy lists them under "לבדיקה" and shows the reason
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIR = { latMin: 29.0, latMax: 34.0, lonMin: 33.5, lonMax: 36.5 };
const Q_SLACK_NM = 1.5;   // Q centre is given in whole minutes (up to ~1.3 NM off) and the radius is rounded
const ROUTE_Q_SLACK_NM = 3; // route legs: published GIS lines may bend a little outside the IAA's circle (C2028 AFULA-EITAN)

// ── coordinates ──────────────────────────────────────────────────────────────
// style A: 314945N0345822E  |  315941.27N0345429.55E  |  3149N03458E   (trailing E may be missing)
// style B: N314945E0345822
const RX_A = /(?<![\dA-Z])(\d{4}|\d{6})(\.\d+)?N\s?(\d{5}|\d{7})(\.\d+)?E?(?![\d.])/g;
const RX_B = /(?<![\dA-Z])N(\d{4}|\d{6})(\.\d+)?E(\d{5}|\d{7})(\.\d+)?(?![\d.])/g;
// anything that looks like a coordinate: used to catch typos that the strict patterns skip
const RX_LOOSE = /\d{4,}(\.\d+)?N\s?\d{5,}|N\d{4,}E\d{5,}/g;

function dms(deg, rest, frac) {
  // rest = "MM" or "MMSS"; frac = ".ss" on the last field
  const m = parseInt(rest.slice(0, 2), 10);
  let s = rest.length === 4 ? parseInt(rest.slice(2, 4), 10) : 0;
  let mm = m;
  if (frac) { if (rest.length === 4) s += parseFloat(frac); else mm += parseFloat(frac); }
  if (mm >= 60 || s >= 60) return NaN;
  return deg + mm / 60 + s / 3600;
}
function parseLat(d, frac) { return dms(parseInt(d.slice(0, 2), 10), d.slice(2), frac); }
function parseLon(d, frac) { return dms(parseInt(d.slice(0, 3), 10), d.slice(3), frac); }

function findCoords(text) {
  const out = [];
  for (const rx of [RX_A, RX_B]) {
    rx.lastIndex = 0; let m;
    while ((m = rx.exec(text))) {
      const lat = parseLat(m[1], m[2]), lon = parseLon(m[3], m[4]);
      out.push({ at: m.index, end: m.index + m[0].length, lat, lon });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── geometry helpers (flat-earth NM around a reference, fine at these sizes) ──
function nmVec(ref, p) {
  const k = Math.cos(ref[0] * Math.PI / 180);
  return [(p[1] - ref[1]) * 60 * k, (p[0] - ref[0]) * 60];
}
function distNm(a, b) { const [x, y] = nmVec(a, b); return Math.hypot(x, y); }
function segCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4;
}
function selfCrossing(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;          // neighbours share a vertex
    if (segCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
  }
  return false;
}
function areaNm2(pts) {
  const ref = pts[0], v = pts.map(p => nmVec(ref, p)); let a = 0;
  for (let i = 0; i < v.length; i++) { const [x1, y1] = v[i], [x2, y2] = v[(i + 1) % v.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// a point guaranteed inside the polygon: vertex average if inside, else middle of the widest
// horizontal chord through that latitude
function polyAnchor(poly) {
  const c = [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  if (inside(c, poly)) return c;
  const xs = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > c[0]) !== (yj > c[0])) xs.push(xi + (c[0] - yi) * (xj - xi) / (yj - yi));
  }
  xs.sort((a, b) => a - b); let best = null, w = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; best = [c[0], (xs[i] + xs[i + 1]) / 2]; }
  return best || poly[0];
}
const r6 = x => Math.round(x * 1e6) / 1e6;
const RP = p => [r6(p[0]), r6(p[1])];

// ── field E → parts ─────────────────────────────────────────────────────────
const RX_RADIUS = /(?:(\d+(?:\.\d+)?)\s?(NM|KM|M)\s+RADIUS|RADIUS\s+(?:OF\s+)?(\d+(?:\.\d+)?)\s?(NM|KM|M))\b/g;
const TO_NM = { NM: 1, KM: 1 / 1.852, M: 1 / 1852 };

function parseE(eText) {
  // drop the F) / G) tail; split into sentences (a period followed by space / end / ")")
  const text = String(eText || "").toUpperCase().replace(/\s+F\)\s.*$/s, "");
  const sentences = text.split(/\.(?=\s|$|\))/);
  const parts = []; let semi = false;
  for (const s of sentences) {
    const coords = findCoords(s);
    const loose = (s.match(RX_LOOSE) || []).length;
    if (!coords.length && !loose) continue;
    if (loose !== coords.length) return { reject: "unreadable coordinate (typo?)" };
    if (coords.some(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lon))) return { reject: "coordinate out of range (minutes/seconds >= 60)" };
    const radii = [...s.matchAll(RX_RADIUS)].map(m => parseFloat(m[1] || m[3]) * TO_NM[m[2] || m[4]]);
    const uniq = [...new Set(radii.map(r => r.toFixed(4)))];
    let half = null;
    if (/SEMI-?CIRCLE/.test(s)) {
      const d = s.match(/SEMI-?CIRCLE\s+(?:TO\s+(?:THE\s+)?)?(NORTH|EAST|SOUTH|WEST)\b/);
      if (d) half = d[1][0]; else semi = true;
    }
    if (uniq.length > 1) return { reject: "several different radii in one sentence" };
    if (radii.length) {
      coords.forEach(c => parts.push(Object.assign({ type: "circle", center: [c.lat, c.lon], radiusNm: radii[0] }, half ? { half } : {})));
    } else if (coords.length >= 3) {
      let pts = coords.map(c => [c.lat, c.lon]);
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
      if (same(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);          // closing point repeated
      pts = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
      parts.push({ type: "polygon", coords: pts });
    } else if (coords.length === 1) {
      parts.push({ type: "point", coord: [coords[0].lat, coords[0].lon] });
    } else {
      return { reject: "two points without a radius (line?)" };
    }
  }
  return { parts, semi };
}

function allPoints(part) {
  if (part.type === "polygon") return part.coords;
  if (part.type === "point") return [part.coord];
  // circle: centre plus 4 edge points
  const [la, lo] = part.center, dLat = part.radiusNm / 60, dLon = part.radiusNm / 60 / Math.cos(la * Math.PI / 180);
  return [part.center, [la + dLat, lo], [la - dLat, lo], [la, lo + dLon], [la, lo - dLon]];
}

// ── border strips ────────────────────────────────────────────────────────────
// a point well inside Israel near each border: tells which side of the line is ours
const BORDER_REF = { lebanon: [33.03, 35.25], syria: [33.00, 35.70], jordan: [30.50, 35.05], egypt: [30.50, 34.60], gaza: [31.42, 34.56] };
const DIR_VEC = { NB: [0, 1], SB: [0, -1], EB: [1, 0], WB: [-1, 0] };            // [east, north]
const STRIP_MARGIN_KM = 1;
const RX_BORDER = /\bFM\s+(LEBANON|SYRIA|JORDAN|EGYPT)\s+BO?UND[AR]{2,3}Y\s+TO\s+(\d+(?:\.\d+)?)\s?(KM|NM)\b\s*(NB|SB|EB|WB)?/;
let BORDERS = null;                                                               // id -> [[lat,lon],...]
export function loadBorders(path) {
  const fc = JSON.parse(readFileSync(path, "utf8")); BORDERS = {};
  for (const f of fc.features) BORDERS[f.properties.id] = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}
const KX = lat => 111.32 * Math.cos(lat * Math.PI / 180), KY = 110.574;          // km per degree
function kmVec(a, b) { const m = (a[0] + b[0]) / 2; return [(b[1] - a[1]) * KX(m), (b[0] - a[0]) * KY]; }
function segDistKm(p, a, b) {
  const [x1, y1] = kmVec(p, a), [x2, y2] = kmVec(p, b), dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L2)) : 0;
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}
function lineDistKm(p, line) { let d = Infinity; for (let i = 0; i < line.length - 1; i++) d = Math.min(d, segDistKm(p, line[i], line[i + 1])); return d; }
function densify(line, stepKm) {
  const out = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const [dx, dy] = kmVec(line[i], line[i + 1]), n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepKm));
    for (let k = 1; k <= n; k++) out.push([line[i][0] + (line[i + 1][0] - line[i][0]) * k / n, line[i][1] + (line[i + 1][1] - line[i][1]) * k / n]);
  }
  return out;
}
function rdp(pts, tolKm) {                                                        // Douglas-Peucker simplification
  if (pts.length < 3) return pts;
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDistKm(pts[i], pts[0], pts[pts.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
  if (dmax <= tolKm) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), tolKm).slice(0, -1).concat(rdp(pts.slice(idx), tolKm));
}
function borderStrip(text) {
  const m = String(text || "").toUpperCase().match(RX_BORDER);
  if (!m) return null;
  const g = buildStrip(m[1].toLowerCase(), parseFloat(m[2]) * (m[3] === "NM" ? 1.852 : 1), m[4] || null);
  if (g && g.geometry && g.geometry.note && m[4]) g.geometry.mismatch = { kind: "e-dir", border: m[1].toLowerCase(), width: m[2] + m[3], dir: m[4] };   // v1.00.012
  return g;
}
// one border strip: along the border line "id", on the Israeli side, km deep + the safety margin (also used for Gaza)
function buildStrip(id, km, dirWord) {
  if (!BORDERS || !BORDERS[id]) return { reject: `border line "${id}" not available` };
  if (!(km >= 0.5 && km <= 30)) return { reject: "implausible strip width" };
  const W = km + STRIP_MARGIN_KM, line = densify(BORDERS[id], 0.25);
  // which side is Israel: sign of the cross product at the segment nearest the reference point
  const ref = BORDER_REF[id]; let best = Infinity, bi = 0;
  for (let i = 0; i < line.length - 1; i++) { const d = segDistKm(ref, line[i], line[i + 1]); if (d < best) { best = d; bi = i; } }
  const [ax, ay] = kmVec(line[bi], line[bi + 1]), [rx, ry] = kmVec(line[bi], ref);
  const side = (ax * ry - ay * rx) > 0 ? 1 : -1;                                  // +1: Israel on the left of the line's direction
  const offs = [], sum = [0, 0];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const [tx, ty] = kmVec(a, b), L = Math.hypot(tx, ty) || 1, nx = -ty / L * side, ny = tx / L * side;
    sum[0] += nx; sum[1] += ny;
    const p = line[i], q = [p[0] + ny * W / KY, p[1] + nx * W / KX(p[0])];
    if (lineDistKm(q, line) >= W * 0.98) offs.push(q);                            // drop points folded back inside a bend
  }
  const inner = rdp(offs, 0.06), edge = rdp(line, 0.06);
  const coords = edge.concat(inner.reverse());
  const mid = line[Math.floor(line.length / 2)], a = line[Math.floor(line.length / 2) - 1], b = line[Math.floor(line.length / 2) + 1];
  const [tx, ty] = kmVec(a, b), L = Math.hypot(tx, ty) || 1;
  const anchor = [mid[0] + (tx / L * side) * (W / 2) / KY, mid[1] + (-ty / L * side) * (W / 2) / KX(mid[0])];
  const g = { source: "border", border: id, km: Math.round(km * 100) / 100, marginKm: STRIP_MARGIN_KM,
    parts: [{ type: "polygon", coords: coords.map(RP), fill: "nonzero" }], anchor: RP(anchor) };
  if (dirWord && (sum[0] * DIR_VEC[dirWord][0] + sum[1] * DIR_VEC[dirWord][1]) < 0)
    g.note = `text says ${dirWord}, which points away from Israel; drawn on the Israeli side`;
  for (const q of coords) if (q[0] < FIR.latMin || q[0] > FIR.latMax || q[1] < FIR.lonMin || q[1] > FIR.lonMax) return { reject: "strip outside the FIR" };
  return { geometry: g };
}

// ── closed route legs ────────────────────────────────────────────────────────
// ROUTES[layer] = { seg: Map "A|B" -> [[lat,lon],...] from A to B, adj: Map A -> Set(B) }
let ROUTES = null;
let IFR_PTS = null;                                                                // v1.00.014: IFR point positions only (no airways)
const ROUTE_LAYERS = ["cvfr", "sport"];
export const PATCH_ERRORS = [];                                                   // refused patch legs, reported as flags
// ── GIS patch (gis/<layer>-patch-*.json laid over gis/<layer>.json) ──
// Keep this function IDENTICAL in notam-geometry.mjs, AirNotam-ISR.html and AirNotam-ISR-test.html.
// d = {r: route lines, p: points} as in gis/sport.json / cvfr.json (coordinates [lon,lat]); P = the patch file.
// keepWithdrawn: the NOTAM parser keeps withdrawn points / legs (marked w:1) so an older NOTAM still resolves;
// the app drops them, so no pilot plans along a route that is no longer on the chart.
// Returns the patched copy; d._alias = the patch's aliases, d._patchErrors = legs refused by the distance check.
export function gisApplyPatch(d, P, keepWithdrawn){
  d = JSON.parse(JSON.stringify(d)); d._alias = {}; d._patchErrors = [];
  if(!P) return d;
  const dms = s => { const m = String(s).match(/(\d+)\D+(\d+)\D+(\d+(?:\.\d+)?)/); if(!m) throw new Error("bad coordinate " + s); return +m[1] + m[2] / 60 + m[3] / 3600; };
  const pt = {}; d.p.features.forEach(f => { pt[f.properties.c] = f; });
  const ends = f => String(f.properties.c || "").split(" - ").map(s => s.trim());
  const nmLen = line => { let s = 0; for(let i = 0; i < line.length - 1; i++){ const [x1, y1] = line[i], [x2, y2] = line[i + 1];
    s += Math.hypot((x2 - x1) * 60 * Math.cos((y1 + y2) / 2 * Math.PI / 180), (y2 - y1) * 60); } return s; };
  const drop = (arr, f) => { if(keepWithdrawn) f.properties.w = 1; else arr.splice(arr.indexOf(f), 1); };
  const pp = P.points || {}, lg = P.legs || {};
  (pp.add || []).forEach(a => {
    const f = { type: "Feature", geometry: { type: "Point", coordinates: [dms(a.E), dms(a.N)] }, properties: { n: a.name, c: a.code, t: a.type } };
    if(pt[a.code]) Object.assign(pt[a.code], f); else { d.p.features.push(f); pt[a.code] = f; } });
  (pp.move || []).forEach(m => {
    const f = pt[m.code]; if(!f) return;
    const old = f.geometry.coordinates.slice(), nw = [dms(m.E), dms(m.N)];
    f.geometry.coordinates = nw; if(m.type) f.properties.t = m.type; if(m.name) f.properties.n = m.name;
    d.r.features.forEach(r => { if(!ends(r).includes(m.code)) return;          // the leg's end on the old spot moves with the point
      r.geometry.coordinates.forEach(part => { const a = part[0], b = part[part.length - 1];
        const da = Math.hypot(a[0] - old[0], a[1] - old[1]), db = Math.hypot(b[0] - old[0], b[1] - old[1]);
        if(da <= db) part[0] = nw.slice(); else part[part.length - 1] = nw.slice(); }); }); });
  (pp.rename || []).forEach(n => {
    const f = pt[n.from]; if(!f) return;
    f.properties.c = n.to; if(n.name) f.properties.n = n.name; pt[n.to] = f; delete pt[n.from];
    d.r.features.forEach(r => { const e = ends(r); if(e.includes(n.from)) r.properties.c = e.map(c => c === n.from ? n.to : c).join(" - "); });
    d._alias[n.from] = n.to; });
  (pp.type || []).forEach(t => { if(pt[t.code]) pt[t.code].properties.t = t.type; });
  (pp.name || []).forEach(t => { if(pt[t.code]) pt[t.code].properties.n = t.name; });
  Object.assign(d._alias, P.aliases || {});
  (lg.add || []).forEach(l => {
    const [a, b] = l.leg.split("-"), A = pt[a], B = pt[b];
    const line = l.coords ? l.coords.map(([la, lo]) => [lo, la]) : (A && B ? [A.geometry.coordinates.slice(), B.geometry.coordinates.slice()] : null);
    if(!line){ d._patchErrors.push(`${l.leg}: point not found`); return; }
    const len = nmLen(line);
    if(l.nm != null && Math.abs(len - l.nm) > 0.3){ d._patchErrors.push(`${l.leg}: ${len.toFixed(2)} NM from the coordinates, chart says ${l.nm} NM`); return; }
    d.r.features.push({ type: "Feature", geometry: { type: "MultiLineString", coordinates: [line] },
      properties: { n: `${A ? A.properties.n : a}-${B ? B.properties.n : b}`, c: `${a} - ${b}`, t: l.status || "", patch: 1 } }); });
  (lg.withdraw || []).forEach(l => {
    const [a, b] = l.leg.split("-");
    d.r.features.filter(r => { const e = ends(r); return (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a); })
      .forEach(r => drop(d.r.features, r)); });
  (pp.withdraw || []).forEach(w => { const f = pt[w.code]; if(f) drop(d.p.features, f); });
  return d;
}

export function loadRoutes(dir) {
  ROUTES = {};
  for (const id of ROUTE_LAYERS) {
    let d = JSON.parse(readFileSync(`${dir}/${id}.json`, "utf8"));
    for (const pf of readdirSync(dir).filter(f => f.startsWith(`${id}-patch-`) && f.endsWith(".json")).sort()) {
      try { d = gisApplyPatch(d, JSON.parse(readFileSync(`${dir}/${pf}`, "utf8")), true);
            d._patchErrors.forEach(e => PATCH_ERRORS.push(`${pf}: ${e}`)); }
      catch (e) { PATCH_ERRORS.push(`${pf}: could not be applied (${e.message}); the layer is used without it`); }
    }
    const seg = new Map(), adj = new Map(), pts = new Map(), names = new Map(), segT = new Map(), wSeg = new Set(), wPts = new Set();
    for (const f of d.p.features) { const [lon, lat] = f.geometry.coordinates; pts.set(f.properties.c, [lat, lon]); names.set(f.properties.c, String(f.properties.n || "").replace(/\*/g, "").trim()); if (f.properties.w) wPts.add(f.properties.c); }
    const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
    const off = (p, q) => Math.hypot(...kmVec(p, q));
    for (const f of d.r.features) {
      const ends = String(f.properties.c || "").split(" - ").map(s => s.trim());
      if (ends.length !== 2 || !ends[0] || !ends[1]) continue;
      let line = f.geometry.coordinates.flat().map(([lon, lat]) => [lat, lon]);    // MultiLineString with one part
      if (line.length < 2) continue;
      const [a, b] = ends, pa = pts.get(a), pb = pts.get(b), s = line[0], e = line[line.length - 1];
      // the GIS stores about a quarter of the segments end-to-start: turn them round by the named points
      const fwd = (pa ? off(s, pa) : 0) + (pb ? off(e, pb) : 0), rev = (pa ? off(e, pa) : 0) + (pb ? off(s, pb) : 0);
      if (rev < fwd) line = line.slice().reverse();
      if (Math.min(fwd, rev) > 0.5 * ((pa ? 1 : 0) + (pb ? 1 : 0))) continue;   // ends not on the named points: GIS error, never used
      if (!seg.has(`${a}|${b}`)) seg.set(`${a}|${b}`, line);
      if (!seg.has(`${b}|${a}`)) seg.set(`${b}|${a}`, line.slice().reverse());
      if (!segT.has(`${a}|${b}`)) { segT.set(`${a}|${b}`, f.properties.t || ""); segT.set(`${b}|${a}`, f.properties.t || ""); }
      if (f.properties.w) { wSeg.add(`${a}|${b}`); wSeg.add(`${b}|${a}`); }
      link(a, b); link(b, a);
    }
    ROUTES[id] = { seg, adj, pts, names, segT, wSeg, wPts, alias: d._alias || {} };
  }
  IFR_PTS = new Map();
  try { for (const f of JSON.parse(readFileSync(`${dir}/ifr.json`, "utf8")).p.features) { const [lon, lat] = f.geometry.coordinates; IFR_PTS.set(f.properties.c, [lat, lon]); } }
  catch (e) { IFR_PTS = new Map(); }
}
const al = (layer, c) => ROUTES[layer].alias[c] || c;                           // chart patch aliases (per layer)
function lineKm(line) { let d = 0; for (let i = 0; i < line.length - 1; i++) d += Math.hypot(...kmVec(line[i], line[i + 1])); return d; }
// one leg A-B in one layer: the published segment, or the single short path through skipped points
function findLeg(layer, a, b) {
  const { seg, adj } = ROUTES[layer]; a = al(layer, a); b = al(layer, b);
  if (seg.has(`${a}|${b}`)) return { coords: seg.get(`${a}|${b}`) };
  if (!adj.has(a) || !adj.has(b)) return null;
  const paths = [], walk = p => {
    const last = p[p.length - 1];
    if (last === b) { paths.push(p); return; }
    if (p.length > 3) return;                                                     // at most 3 segments
    for (const n of adj.get(last)) if (!p.includes(n)) walk(p.concat(n));
  };
  walk([a]);
  if (paths.length !== 1) return null;                                           // none, or ambiguous
  const p = paths[0]; let coords = [];
  for (let i = 0; i < p.length - 1; i++) coords = coords.concat(i ? seg.get(`${p[i]}|${p[i + 1]}`).slice(1) : seg.get(`${p[i]}|${p[i + 1]}`));
  const straight = Math.hypot(...kmVec(coords[0], coords[coords.length - 1]));
  if (!(straight > 0) || lineKm(coords) > 1.3 * straight) return null;           // a detour, not the same leg
  return { coords, via: p.slice(1, -1) };
}
const RX_CHAIN = /\b[A-Z][A-Z0-9]{3,4}(?:-[A-Z][A-Z0-9]{3,4})+\b/g;
function chainLegs(chains, layers, legs, seen) {
  for (const ch of chains) {
    const names = ch.split("-");
    for (let i = 0; i < names.length - 1; i++) {
      const a = names[i], b = names[i + 1], key = [a, b].sort().join("|");
      if (seen.has(key)) continue; seen.add(key);
      legs.push({ a, b, layers });
    }
  }
}
function isChainList(s) { return !!(s.match(RX_CHAIN) || []).length && !s.replace(RX_CHAIN, "").replace(/[\s,;)]/g, ""); }
function resolveLeg(a, b, pref) {
  for (const layer of pref.concat(ROUTE_LAYERS.filter(l => !pref.includes(l)))) {
    const r = findLeg(layer, a, b);
    if (r) {
      const R = ROUTES[layer], A = al(layer, a), B = al(layer, b), seq = [A].concat(r.via || [], [B]);
      const wd = seq.filter(c => R.wPts.has(c));                                  // withdrawn points / segments this leg uses
      for (let i = 0; i < seq.length - 1; i++) if (R.wSeg.has(`${seq[i]}|${seq[i + 1]}`)) wd.push(`${seq[i]}-${seq[i + 1]}`);
      return Object.assign({ type: "line", coords: r.coords.map(RP), leg: `${a}-${b}`, layer, t: R.segT.get(`${A}|${r.via ? r.via[0] : B}`) || "" },
                           r.via ? { via: r.via } : {}, pref.includes(layer) ? {} : { otherLayer: true }, wd.length ? { withdrawn: wd } : {});
    }
  }
  return null;
}
// v1.00.013: A-B-C where B is only a point lying on the published leg A-C (within ON_LEG_KM): that leg
const ON_LEG_KM = 0.5;
function pointOnLeg(a, b, c, pref) {
  for (const layer of pref.concat(ROUTE_LAYERS.filter(l => !pref.includes(l)))) {
    const R = ROUTES[layer], A = al(layer, a), B = al(layer, b), C = al(layer, c), line = R.seg.get(`${A}|${C}`), pb = R.pts.get(B);
    if (!line || !pb || lineDistKm(pb, line) > ON_LEG_KM) continue;
    const wd = [A, B, C].filter(x => R.wPts.has(x)); if (R.wSeg.has(`${A}|${C}`)) wd.push(`${A}-${C}`);
    return Object.assign({ type: "line", coords: line.map(RP), leg: `${a}-${c}`, layer, t: R.segT.get(`${A}|${C}`) || "", pointOn: [b] },
                         pref.includes(layer) ? {} : { otherLayer: true }, wd.length ? { withdrawn: wd } : {});
  }
  return null;
}
// v1.00.014: a leg to a point known only as an IFR point: straight line (VFR position first for the other end)
function straightLeg(a, b, pref) {
  if (!IFR_PTS || !IFR_PTS.size) return null;
  const order = pref.concat(ROUTE_LAYERS.filter(l => !pref.includes(l)));
  const vfr = c => { for (const l of order) { const q = ROUTES[l].pts.get(al(l, c)); if (q) return q; } return null; };
  const va = vfr(a), vb = vfr(b);
  if (va && vb) return null;                                                      // both VFR points: not this rule
  const pa = va || IFR_PTS.get(a), pb = vb || IFR_PTS.get(b);
  if (!pa || !pb) return null;
  return { type: "line", coords: [pa, pb].map(RP), leg: `${a}-${b}`, layer: pref[0] || "cvfr", t: "", straight: true };
}
const ptName = (layer, c) => ROUTES[layer].names.get(al(layer, c)) || c;
function routeLegs(notam) {
  const text = String(notam.eText || "").toUpperCase().replace(/\s+F\)\s.*$/s, "");
  if (!/\bRTE\b/.test(text) || !/\bCLSD\b/.test(text) || /\bATS\s+RTE\b/.test(text)) return null;
  if (!ROUTES) return { reject: "route layers not available" };
  const cut = text.search(/\bDIVERT/), closedPart = cut < 0 ? text : text.slice(0, cut), divPart = cut < 0 ? "" : text.slice(cut);
  const legs = [], seen = new Set();
  let layers = null, lastLayers = ["cvfr"];                                      // layers of the last "RTE ... CLSD" sentence
  for (const s of closedPart.split(/\.(?=\s|$|\))/)) {
    const chains = s.match(RX_CHAIN) || [];
    if (/\bRTE\b/.test(s) && /\bCLSD\b/.test(s)) {
      const w = [...s.matchAll(/\b(CVFR|ULTRALIGHT|HEL)\b/g)].map(m => m[1]);
      layers = [...new Set(w.map(x => x === "ULTRALIGHT" ? "sport" : "cvfr"))];
      if (!layers.length) layers = ["cvfr"];
      lastLayers = layers;
    } else if (!(layers && isChainList(s))) { layers = null; continue; }        // some other sentence: stop reading legs
    chainLegs(chains, layers, legs, seen);
  }
  // ── the diversion (open) ──
  const divParts = []; let divNames = null;
  const via = divPart.match(/^DIVERT\w*\s+VIA\s+([\s\S]*)$/);
  if (via) {
    const rest = via[1], sents = rest.split(/\.(?=\s|$|\))/);
    const lead = sents[0].trim().match(/^([A-Z][A-Z0-9]{3,4})(?![A-Z0-9-])\s*([\s\S]*)$/);
    if (/^[A-Z][A-Z0-9]{3,4}-/.test(sents[0].trim())) {
      // "DIVERTED VIA FRDIS-HASID." : the diversion is the chain(s) of that sentence
      const dl = []; chainLegs(sents[0].match(RX_CHAIN) || [], lastLayers, dl, new Set());
      const found = dl.map(({ a, b, layers: pr }) => resolveLeg(a, b, pr));
      if (found.length && found.every(Boolean)) {
        found.forEach(p => divParts.push(Object.assign(p, { role: "diversion" })));
        const ch = sents[0].match(RX_CHAIN)[0].split("-");
        divNames = ch.map(c => ptName(found[0].layer, c));
      }
    } else if (lead && !legs.length) {
      // "DIVERTED VIA MZDOT SOKET-MYTAR-.... MMORR-ARRAD-LLMZ." : MZDOT names the diversion route,
      // the chains after it are the closed legs (the RTE CLSD sentence named none)
      const X = lead[1];
      const layer = lastLayers.concat(ROUTE_LAYERS).find(l => ROUTES[l].adj.has(al(l, X)));
      const XX = layer ? al(layer, X) : X, nb = layer ? [...ROUTES[layer].adj.get(XX)] : [];
      const after = [lead[2]].concat(sents.slice(1)), closedChains = [];
      for (const s of after) { if (!s.trim()) continue; if (!isChainList(s)) break; closedChains.push(...s.match(RX_CHAIN)); }
      // ambiguous if X is itself in the chains, or X links to the very next point ("MZDOT SOKET-..." read as MZDOT-SOKET-...)
      const first = closedChains.length ? closedChains[0].split("-")[0] : null;
      const touches = closedChains.some(ch => ch.split("-").some(c => c === X || al(layer || "cvfr", c) === XX)) || (first && nb.includes(al(layer || "cvfr", first)));
      if (layer && (nb.length === 1 || nb.length === 2) && closedChains.length && !touches) {
        chainLegs(closedChains, lastLayers, legs, seen);
        const S = ROUTES[layer].seg, seq = nb.length === 2 ? [nb[0], XX, nb[1]] : [XX, nb[0]];
        for (let i = 0; i < seq.length - 1; i++)
          divParts.push({ type: "line", role: "diversion", coords: S.get(`${seq[i]}|${seq[i + 1]}`).map(RP), leg: `${seq[i]}-${seq[i + 1]}`,
                          layer, t: ROUTES[layer].segT.get(`${seq[i]}|${seq[i + 1]}`) || "" });
        divNames = seq.map(c => ptName(layer, c));
      }
    }
  }
  if (!legs.length) return null;
  const parts = [], missing = [];
  const res = legs.map(({ a, b, layers: pref }) => resolveLeg(a, b, pref));
  for (let i = 0; i < legs.length - 1; i++) {                                     // v1.00.013: A-B + B-C both missing, B on the leg A-C
    if (res[i] || res[i + 1] || legs[i].b !== legs[i + 1].a) continue;
    const hit = pointOnLeg(legs[i].a, legs[i].b, legs[i + 1].b, legs[i].layers);
    if (hit) { res[i] = hit; res[i + 1] = false; i++; }
  }
  legs.forEach(({ a, b, layers: pref }, i) => { if (res[i] === null) res[i] = straightLeg(a, b, pref); });   // v1.00.014
  legs.forEach(({ a, b }, i) => { if (res[i]) parts.push(res[i]); else if (res[i] !== false) missing.push(`${a}-${b}`); });
  if (!parts.length) return { reject: `no closed leg found in the route layers (${missing.join(", ")})` };
  const qp = notam.qLine?.position || notam.position;
  const inQ = q => !(qp && qp.lat != null && qp.lon != null && qp.radiusNm != null) || distNm([qp.lat, qp.lon], q) <= qp.radiusNm + ROUTE_Q_SLACK_NM;
  const inFir = q => q[0] >= FIR.latMin && q[0] <= FIR.latMax && q[1] >= FIR.lonMin && q[1] <= FIR.lonMax;
  for (const p of parts) for (const q of p.coords) if (!inFir(q)) return { reject: "route leg outside the FIR" };
  // a leg reaching outside the NOTAM's own Q circle is left out (and flagged), the other legs are still drawn;
  // only if every leg is outside is the NOTAM rejected (back to the Q circle)
  // exact leg = both named end points are published points of that layer, joined directly (no skipped point filled in):
  // drawn even outside the Q circle (round 3 rule). Only legs filled in through a skipped point get the Q check.
  const exact = p => { const [a, b] = p.leg.split("-"), R = ROUTES[p.layer];
                       return !p.via && !p.straight && R.pts.has(al(p.layer, a)) && R.pts.has(al(p.layer, b)); };
  const outQ = parts.filter(p => !exact(p) && !p.coords.every(inQ)).map(p => p.leg);
  if (outQ.length === parts.length) return { reject: `route legs reach outside the Q-line circle (${outQ.join(", ")})` };
  for (let i = parts.length - 1; i >= 0; i--) if (outQ.includes(parts[i].leg)) parts.splice(i, 1);
  // the diversion must pass the same checks, or it is simply not drawn (the closed legs stay)
  const divOk = divParts.length && divParts.every(p => p.coords.every(q => inFir(q) && inQ(q)));
  // map dot: halfway along the longest closed leg
  const main = parts.slice().sort((x, y) => lineKm(y.coords) - lineKm(x.coords))[0].coords;
  let half = lineKm(main) / 2, anchor = main[0];
  for (let i = 0; i < main.length - 1; i++) {
    const d = Math.hypot(...kmVec(main[i], main[i + 1]));
    if (d >= half) { const t = d ? half / d : 0; anchor = [main[i][0] + (main[i + 1][0] - main[i][0]) * t, main[i][1] + (main[i + 1][1] - main[i][1]) * t]; break; }
    half -= d;
  }
  const g = { source: "route", parts: divOk ? parts.concat(divParts) : parts, anchor: RP(anchor) };
  if (divOk && divNames) g.diversionNames = divNames;
  if (missing.length) g.missing = missing;
  if (outQ.length) g.outsideQ = outQ;
  return { geometry: g };
}

// ── named airspace (CTR / ATZ / TMA / LLP / LLR / LLD) ──────────────────────
// AREAS[kind] = Map normalised code -> [{name, kind, polys:[[[lat,lon],...],...]}]
let AREAS = null;
const AREA_ALIAS = { LLGV: "GVULT", LLPL: "LL59" };                              // ICAO code -> the code the GIS uses
const normCode = c => String(c || "").toUpperCase().replace(/^(LL[PRD])0+(?=\d)/, "$1");   // LLR01 -> LLR1
export function loadAreas(dir) {
  AREAS = { CTR: new Map(), TMA: new Map(), PRD: new Map() };
  for (const [file, kind] of [["ctr", "CTR"], ["tma", "TMA"], ["prd", "PRD"]]) {
    const fc = JSON.parse(readFileSync(`${dir}/${file}.json`, "utf8"));
    for (const f of fc.features || []) {
      const c = normCode(f.properties.c); if (!c) continue;
      const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map(p => p[0]) : [];
      if (!polys.length) continue;
      if (!AREAS[kind].has(c)) AREAS[kind].set(c, []);
      AREAS[kind].get(c).push({ name: String(f.properties.n || "").trim(), kind: f.properties.k || f.properties.t || kind,
        polys: polys.map(r => r.map(([lon, lat]) => [lat, lon])) });
    }
  }
}
// the area must be the subject of the sentence: "CTR CLSD", "LLHZ CTR CLSD", "LLR01 ACTIVATED", "LLER TRG AREA HAR BERECH CLSD"
const RX_AREA_VERB = String.raw`\s+(?:IS\s+)?(?:CLSD|CLOSED|ACTIVATED|ACTIVE|ACT|AVBL\s+FOR\b[^.]*\bONLY)\b`;
const RX_NAMED = [
  { kind: "CTR", rx: new RegExp(String.raw`^(?:THE\s+)?(?:(LL[A-Z0-9]{2})\s+)?(?:CTR|ATZ)` + RX_AREA_VERB) },
  { kind: "TMA", rx: new RegExp(String.raw`^(?:THE\s+)?(?:(LL[A-Z0-9]{2})\s+)?TMA` + RX_AREA_VERB) },
  { kind: "PRD", rx: new RegExp(String.raw`^(?:THE\s+)?(LL[PRD]\s?\d+)` + RX_AREA_VERB) },
  { kind: "TRG", rx: new RegExp(String.raw`^(?:THE\s+)?((?:LL[A-Z0-9]{2}\s+)?TRG\s+AREA\b[^.]*?)` + RX_AREA_VERB) },
];
function namedArea(notam) {
  const text = String(notam.eText || "").toUpperCase().replace(/\s+F\)\s.*$/s, "");
  let hit = null;
  for (const s0 of text.split(/\.(?=\s|$|\))/)) {
    const s = s0.trim();
    for (const { kind, rx } of RX_NAMED) { const m = s.match(rx); if (m) { hit = { kind, raw: (m[1] || "").replace(/\s+/g, " ").trim() }; break; } }
    if (hit) break;
  }
  if (!hit) return null;
  if (hit.kind === "TRG") return { reject: `named area not in the GIS layers: ${hit.raw}`, missingArea: hit.raw };
  let code = hit.raw.replace(/\s+/g, "");
  if (!code) code = String(notam.location || "").toUpperCase();                   // "CTR CLSD": the CTR of field A
  const label = `${code || "?"} ${hit.kind === "PRD" ? "" : hit.kind}`.trim();
  if (!AREAS) return { reject: "airspace layers not available", missingArea: label };
  const key = normCode(AREA_ALIAS[code] || code);
  const cands = (AREAS[hit.kind === "PRD" ? "PRD" : hit.kind].get(key)) || [];
  if (!cands.length) return { reject: `named area not in the GIS layers: ${label}`, missingArea: label };
  const qp = notam.qLine?.position || notam.position;
  const inQ = q => !(qp && qp.lat != null && qp.lon != null && qp.radiusNm != null) || distNm([qp.lat, qp.lon], q) <= qp.radiusNm + Q_SLACK_NM;
  const inFir = q => q[0] >= FIR.latMin && q[0] <= FIR.latMax && q[1] >= FIR.lonMin && q[1] <= FIR.lonMax;
  const ok = cands.filter(a => a.polys.every(r => r.every(q => inFir(q) && inQ(q))));
  if (!ok.length) return { reject: `named area ${label} reaches outside the Q-line circle`, missingArea: label };
  const parts = [], areas = [];
  for (const a of ok) { areas.push({ code: key, kind: a.kind, name: a.name }); for (const r of a.polys) parts.push({ type: "polygon", coords: r.map(RP) }); }
  const main = parts.slice().sort((x, y) => areaNm2(y.coords) - areaNm2(x.coords))[0];
  return { geometry: { source: "named", areas, parts, anchor: RP(polyAnchor(main.coords)) } };
}

// ── "FM GAZA-STRIP BOUNDRAY TO N KM OUTWARD": a border strip from the Gaza Strip boundary line (Israeli side) ──
const RX_OUTWARD = /\bFM\s+([A-Z][A-Z -]*?)\s+BO?UND[AR]{2,3}Y\s+TO\s+(\d+(?:\.\d+)?)\s?(KM|NM)\s+OUTWARDS?\b/;
function outwardStrip(notam) {
  const text = String(notam.eText || "").toUpperCase().replace(/\s+F\)\s.*$/s, "");
  const m = text.match(RX_OUTWARD);
  if (!m) return /\bOUTWARDS?\b/.test(text) ? { flag: "OUTWARD wording not understood" } : null;
  if (!/^GAZA[\s-]*STRIP$/.test(m[1].trim())) return { flag: `OUTWARD strip from "${m[1].trim()}": no boundary line for it` };
  const r = buildStrip("gaza", parseFloat(m[2]) * (m[3] === "NM" ? 1.852 : 1), null);
  if (r.reject) return { flag: "Gaza Strip border strip: " + r.reject };
  const g = r.geometry;
  return { part: g.parts[0], strip: { border: "gaza", km: g.km, marginKm: g.marginKm, of: m[1].trim() } };
}

// point inside a polygon (ray casting, [lat,lon])
function inPolygon(q, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > q[0]) !== (yj > q[0]) && q[1] < (xj - xi) * (q[0] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function geometryFor(notam) {
  const r = parseE(notam.eText);
  if (r.reject) return { reject: r.reject };
  const parts = r.parts;
  if (!parts.length) return borderStrip(notam.eText) || routeLegs(notam) || namedArea(notam);   // no coordinates: border strip, route legs or a named area
  for (const p of parts) {
    for (const q of allPoints(p)) {
      if (q[0] < FIR.latMin || q[0] > FIR.latMax || q[1] < FIR.lonMin || q[1] > FIR.lonMax) return { reject: "point outside the FIR" };
    }
    if (p.type === "circle" && (p.radiusNm < 10 / 1852 || p.radiusNm > 50)) return { reject: "implausible radius" };
    if (p.type === "polygon") {
      if (p.coords.length < 3) return { reject: "polygon with fewer than 3 distinct points" };
      if (areaNm2(p.coords) < 1e-6) return { reject: "polygon with no area" };
      if (selfCrossing(p.coords)) return { reject: "polygon edges cross each other" };
    }
  }
  const qp = notam.qLine?.position || notam.position;
  let qOut = false;                                                  // v1.00.012: E shape outside the Q circle = Q/E mismatch, both drawn
  if (qp && qp.lat != null && qp.lon != null && qp.radiusNm != null) {
    const c = [qp.lat, qp.lon], lim = qp.radiusNm + Q_SLACK_NM;
    qOut = parts.some(p => allPoints(p).some(q => distNm(c, q) > lim));
  }
  // "FM GAZA-STRIP BOUNDRAY TO N KM OUTWARD": the Gaza border strip, as a second area (must pass the same checks)
  let strip = null, stripFlag = null, stripInside = null;
  const ow = outwardStrip(notam);
  if (ow && ow.part) {
    const c = qp && qp.lat != null && qp.lon != null && qp.radiusNm != null ? [qp.lat, qp.lon] : null;
    const bad = ow.part.coords.some(q => q[0] < FIR.latMin || q[0] > FIR.latMax || q[1] < FIR.lonMin || q[1] > FIR.lonMax
      || (c && distNm(c, q) > qp.radiusNm + Q_SLACK_NM + (ow.strip.km + ow.strip.marginKm) / 1.852));   // the polygon passed the Q check; the strip adds its width
    if (bad) stripFlag = "Gaza Strip border strip reaches outside the Q-line circle, not drawn"; else strip = ow;
    // entirely inside one of the NOTAM's own polygons: that area already covers it, so it is not drawn (only noted)
    if (strip && parts.some(p => p.type === "polygon" && ow.part.coords.every(q => inPolygon(q, p.coords)))) { stripInside = ow.strip; strip = null; }
  } else if (ow && ow.flag) stripFlag = ow.flag;
  // main part = the biggest; its anchor is where the app puts the map dot
  const size = p => p.type === "polygon" ? areaNm2(p.coords) : p.type === "circle" ? Math.PI * p.radiusNm ** 2 : 0;
  const main = parts.slice().sort((a, b) => size(b) - size(a))[0];
  let anchor = main.type === "polygon" ? polyAnchor(main.coords) : main.type === "circle" ? main.center : main.coord;
  if (main.type === "circle" && main.half) {                         // half circle: dot inside the half, not on its straight edge
    const d = main.radiusNm * 0.45 / 60, k = Math.cos(anchor[0] * Math.PI / 180);
    anchor = { N: [anchor[0] + d, anchor[1]], S: [anchor[0] - d, anchor[1]], E: [anchor[0], anchor[1] + d / k], W: [anchor[0], anchor[1] - d / k] }[main.half];
  }
  const g = {
    source: "e_text",
    parts: parts.map(p => p.type === "polygon" ? { type: "polygon", coords: p.coords.map(RP) }
      : p.type === "circle" ? Object.assign({ type: "circle", center: RP(p.center), radiusNm: Math.round(p.radiusNm * 1e4) / 1e4 }, p.half ? { half: p.half } : {})
      : { type: "point", coord: RP(p.coord) }),
    anchor: RP(anchor),
  };
  if (strip) { g.parts.push({ type: "polygon", role: "strip", coords: strip.part.coords, fill: "nonzero" }); g.strip = strip.strip; }
  if (stripFlag) g.stripFlag = stripFlag;
  if (stripInside) g.stripInside = stripInside;
  if (r.semi) g.note = "semi-circle drawn as full circle";
  if (qOut) {                                                        // v1.00.012: keep the Q circle too, linked to the E area
    g.parts.push({ type: "circle", role: "q", center: RP([qp.lat, qp.lon]), radiusNm: qp.radiusNm });
    g.mismatch = { kind: "q-e", distNm: Math.round(distNm([qp.lat, qp.lon], anchor) * 10) / 10 };
  }
  return { geometry: g };
}

// ── flags: what deserves a human look (see FLAGS above) ─────────────────────
const AREA_WORDS = [
  ["RADIUS", /\bRADIUS\b/], ["BOUNDARY", /\bBO?UND[AR]{2,3}Y\b/], ["BOUNDED", /\bBOUNDED\b/], ["SEMI-CIRCLE", /\bSEMI-?CIRCLE\b/],
  ["ARC", /\bARC\b/], ["CORRIDOR", /\bCORRIDOR\b/], ["RTE CLSD", /\bRTE\b[^.]*\bCLSD\b/],
  ["BTN FLW", /\bBTN\s+(?:THE\s+)?(?:FLW|FOLLOWING)\b/], ["PSN", /\bPSN\b/], ["CENTERED", /\bCENT(?:ER|RE)D\b/],
  ["distance", /\bWI\s+\d+(?:\.\d+)?\s?(?:NM|KM|M)\b|\d+(?:\.\d+)?\s?(?:NM|KM)\s+(?:FM|OF|AROUND)\b/],
  ["coordinates", RX_LOOSE],
];
export function flagsFor(notams) {
  const out = [];
  const add = (n, kind, reason) => out.push({ key: kind + "|" + String(n.eText || "").replace(/\s+/g, " ").trim(),
    id: n.id, kind, reason, qLine: n.qLine || null, fromDate: n.fromDate || null, toDate: n.toDate || null, eText: n.eText || "" });
  for (const n of notams) {
    const t = String(n.eText || "").toUpperCase(), g = n.geometry;
    if (n.geometryReject && /^named area /.test(n.geometryReject)) { add(n, "area missing", n.geometryReject); continue; }
    if (n.geometryReject) { add(n, "rejected", n.geometryReject); continue; }
    if (g && g.stripFlag) { add(n, "outward", g.stripFlag); continue; }
    if (g && g.missing) { add(n, "legs missing", "route legs not in the GIS: " + g.missing.join(", ")); continue; }
    if (g && g.outsideQ) { add(n, "outside Q", "route legs reach outside the NOTAM's Q circle, not drawn: " + g.outsideQ.join(", ")); continue; }
    const wd = g && g.parts ? [...new Set(g.parts.flatMap(p => p.withdrawn || []))] : [];
    if (wd.length) { add(n, "withdrawn", "uses what the 2025 chart withdrew: " + wd.join(", ")); continue; }
    if (g && g.mismatch && g.mismatch.kind === "q-e") { const q = n.qLine?.position || n.position || {};
      add(n, "Q/E mismatch", `Item Q position (${q.lat},${q.lon} r=${q.radiusNm}NM) does not cover the Item E area: ${g.mismatch.distNm} NM apart; both drawn, linked`); continue; }
    if (g && g.mismatch && g.mismatch.kind === "e-dir") {
      add(n, "Q/E mismatch", `Item E: "${g.mismatch.width} ${g.mismatch.dir}" from the ${g.mismatch.border.toUpperCase()} boundary points away from Israel; strip drawn on the Israeli side`); continue; }
    if (g && g.note === "semi-circle drawn as full circle") { add(n, "semi-circle", "semi-circle with no side, drawn as a full circle"); continue; }
    if (g || !t || /\bATS\s+RTE\b/.test(t)) continue;
    const hits = AREA_WORDS.filter(([, rx]) => { rx.lastIndex = 0; return rx.test(t); }).map(([w]) => w);
    if (hits.length) add(n, "unfamiliar", "no shape, but the text has: " + hits.join(", "));
  }
  return out;
}

export function addGeometry(notams) {
  const stats = { shaped: 0, rejected: 0, none: 0 };
  for (const n of notams) {
    delete n.geometry; delete n.geometryReject; delete n.geometryFlag;
    let res = null;
    try { res = geometryFor(n); } catch (e) { res = { reject: "parser error: " + e.message }; }
    if (res?.geometry) { n.geometry = res.geometry; stats.shaped++; }
    else if (res?.reject) { n.geometryReject = res.reject; stats.rejected++; }
    else stats.none++;
  }
  for (const f of flagsFor(notams)) { const n = notams.find(x => x.id === f.id && (x.eText || "") === f.eText); if (n) n.geometryFlag = { kind: f.kind, reason: f.reason }; }
  return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), bi = args.indexOf("--borders");
  const bpath = bi >= 0 ? args.splice(bi, 2)[1] : fileURLToPath(new URL("../../gis/borders.json", import.meta.url));
  const fi = args.indexOf("--flags"), fpath = fi >= 0 ? args.splice(fi, 2)[1] : null;
  const [inp, outp = inp] = args;
  if (!inp) { console.error("usage: node notam-geometry.mjs notams.json [out.json] [--borders gis/borders.json]"); process.exit(1); }
  try { loadBorders(bpath); } catch (e) { console.log(`notam-geometry: no border lines (${e.message}); border strips skipped`); }
  const gdir = bpath.replace(/[\\/][^\\/]*$/, "");                                // route layers sit next to borders.json
  try { loadRoutes(gdir); } catch (e) { console.log(`notam-geometry: no route layers (${e.message}); closed route legs skipped`); }
  try { loadAreas(gdir); } catch (e) { console.log(`notam-geometry: no airspace layers (${e.message}); named areas skipped`); }
  const data = JSON.parse(readFileSync(inp, "utf8"));
  const list = Array.isArray(data) ? data : data.notams;
  const stats = addGeometry(list);
  writeFileSync(outp, JSON.stringify(data, null, 2));
  console.log(`notam-geometry: ${stats.shaped} shaped, ${stats.rejected} rejected, ${stats.none} without a shape`);
  if (fpath) {
    const flags = flagsFor(list).concat(PATCH_ERRORS.map(e => ({ key: "patch|" + e, id: "-", kind: "patch", reason: e, eText: e })));
    writeFileSync(fpath, JSON.stringify(flags, null, 2));
    console.log(`notam-geometry: ${flags.length} flagged for a look`);
    for (const f of flags) console.log(`  ${f.id}  [${f.kind}]  ${f.reason}`);
  }
}
