/*
 * notam-geometry.mjs · v1.00.002 · AirNotam-ISR · built by eligrt
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
 * SAFETY RULES (any failure = no geometry, the app falls back to the Q circle)
 *   - every coordinate-looking token must parse (a typo like 3149310N rejects it)
 *   - all points inside the Tel-Aviv FIR box
 *   - polygon: 3+ distinct points, not self-crossing, not zero-area
 *   - circle radius between 10 m and 50 NM
 *   - the whole shape must lie inside the NOTAM's own Q-line circle (+1.5 NM slack),
 *     so a misread number can never move a restriction somewhere else
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
 *   "geometryReject": "reason"      // only when coordinates were found but rejected
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIR = { latMin: 29.0, latMax: 34.0, lonMin: 33.5, lonMax: 36.5 };
const Q_SLACK_NM = 1.5;   // Q centre is given in whole minutes (up to ~1.3 NM off) and the radius is rounded

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

export function geometryFor(notam) {
  const r = parseE(notam.eText);
  if (r.reject) return { reject: r.reject };
  const parts = r.parts;
  if (!parts.length) return null;                                   // nothing in the text: not our business
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
  if (qp && qp.lat != null && qp.lon != null && qp.radiusNm != null) {
    const c = [qp.lat, qp.lon], lim = qp.radiusNm + Q_SLACK_NM;
    for (const p of parts) for (const q of allPoints(p)) {
      if (distNm(c, q) > lim) return { reject: `shape reaches outside the Q-line circle (${distNm(c, q).toFixed(1)} > ${lim} NM)` };
    }
  }
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
  if (r.semi) g.note = "semi-circle drawn as full circle";
  return { geometry: g };
}

export function addGeometry(notams) {
  const stats = { shaped: 0, rejected: 0, none: 0 };
  for (const n of notams) {
    delete n.geometry; delete n.geometryReject;
    let res = null;
    try { res = geometryFor(n); } catch (e) { res = { reject: "parser error: " + e.message }; }
    if (res?.geometry) { n.geometry = res.geometry; stats.shaped++; }
    else if (res?.reject) { n.geometryReject = res.reject; stats.rejected++; }
    else stats.none++;
  }
  return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inp, outp = inp] = process.argv.slice(2);
  if (!inp) { console.error("usage: node notam-geometry.mjs notams.json [out.json]"); process.exit(1); }
  const data = JSON.parse(readFileSync(inp, "utf8"));
  const list = Array.isArray(data) ? data : data.notams;
  const stats = addGeometry(list);
  writeFileSync(outp, JSON.stringify(data, null, 2));
  console.log(`notam-geometry: ${stats.shaped} shaped, ${stats.rejected} rejected, ${stats.none} without coordinates`);
}
