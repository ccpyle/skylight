// Map canvas renderer — same motion model and visual language as renderer.ts,
// projected onto a Web Mercator tile map instead of a blank sky canvas.
// No celestial layers. All aircraft data flows through the same useStream hook.

import {
  EMERGENCY_SQUAWKS,
  type Aircraft,
  type Config,
} from "@shared/index.js";
import { classifyGlyph, drawAircraftGlyph, GLYPH_SCALE } from "./aircraftGlyph.js";
import { AIRPORTS } from "./airports.js";
import type { TileMap } from "./tileMap.js";

const RENDER_DELAY_MS = 1150;
const KT_TO_MS = 0.514444;
const DEG = Math.PI / 180;

interface MapSample {
  t: number;
  lat: number;
  lon: number;
  track?: number;
  gs?: number;
}

interface MapTrack {
  ac: Aircraft;
  history: MapSample[];
  firstSeen: number;
  lastSeen: number;
  hasPos: boolean;
  life: number;
}

const ALT_STOPS: [number, [number, number, number]][] = [
  [0, [255, 138, 61]],
  [4000, [255, 198, 92]],
  [10000, [120, 224, 196]],
  [20000, [110, 178, 255]],
  [30000, [150, 150, 255]],
  [40000, [232, 236, 255]],
];

function altRamp(alt: number): [number, number, number] {
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (alt <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const [a1, c1] = ALT_STOPS[i];
      const f = (alt - a0) / (a1 - a0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function hexSeed(hex: string): number {
  let n = 0;
  for (let i = 0; i < hex.length; i++) n = (n * 31 + hex.charCodeAt(i)) % 360;
  return (n / 360) * Math.PI * 2;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function gcMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = (lat2 - lat1) * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

function crossTrackMiles(
  lat: number, lon: number,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 3958.8;
  const d13 = gcMiles(lat1, lon1, lat, lon) / R;
  const θ13 = bearing(lat1, lon1, lat, lon) * DEG;
  const θ12 = bearing(lat1, lon1, lat2, lon2) * DEG;
  return Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * R;
}

function localTimeAt(lon: number): string {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let m = (utcMin + (lon / 15) * 60) % 1440;
  if (m < 0) m += 1440;
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function routePlausible(ac: Aircraft, cfg: Config): boolean {
  if (ac.lat == null || ac.lon == null) return true;
  const haveCoords = ac.originLat != null || ac.destLat != null;
  if (!haveCoords) return true;

  const nearPlane = (la?: number, lo?: number) =>
    la != null && lo != null && gcMiles(ac.lat!, ac.lon!, la, lo) < 80;
  let geomOk = nearPlane(ac.originLat, ac.originLon) || nearPlane(ac.destLat, ac.destLon);
  if (!geomOk && ac.originLat != null && ac.originLon != null && ac.destLat != null && ac.destLon != null) {
    geomOk = Math.abs(crossTrackMiles(ac.lat, ac.lon, ac.originLat, ac.originLon, ac.destLat, ac.destLon)) < 130;
  } else if (!geomOk && (ac.originLat == null || ac.destLat == null)) {
    geomOk = true;
  }
  if (!geomOk) return false;

  const alt = ac.altBaro ?? ac.altGeom;
  const localTraffic = gcMiles(ac.lat, ac.lon, cfg.centerLat, cfg.centerLon) < 30;
  const localAirport = (la?: number, lo?: number) =>
    la != null && lo != null && gcMiles(cfg.centerLat, cfg.centerLon, la, lo) < 45;
  if (localTraffic && alt != null && alt < 12000 && ac.baroRate != null && Math.abs(ac.baroRate) > 250) {
    if (ac.baroRate > 0) {
      if (ac.originLat != null && !localAirport(ac.originLat, ac.originLon)) return false;
    } else {
      if (ac.destLat != null && !localAirport(ac.destLat, ac.destLon)) return false;
    }
  }
  return true;
}

function deadReckonLL(
  lat: number,
  lon: number,
  trackDeg: number | undefined,
  gsKt: number | undefined,
  dtSec: number,
): { lat: number; lon: number } {
  if (trackDeg == null || gsKt == null || gsKt <= 0) return { lat, lon };
  const dist = gsKt * KT_TO_MS * dtSec;
  const t = trackDeg * DEG;
  return {
    lat: lat + (dist * Math.cos(t)) / 110540,
    lon: lon + (dist * Math.sin(t)) / (111320 * Math.cos(lat * DEG)),
  };
}

interface Visible {
  tr: MapTrack;
  lat: number;
  lon: number;
  px: number;
  py: number;
  heading: number;
  alpha: number;
  color: [number, number, number];
  emergency: boolean;
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  private tileMap: TileMap;
  private tracks = new Map<string, MapTrack>();
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private prevFrame = 0;
  private nextFrameDue = 0;
  private frameT = 0;
  private placedBoxes: { x: number; y: number; w: number; h: number }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private getConfig: () => Config,
    tileMap: TileMap,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.tileMap = tileMap;
    this.resize();
  }

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const fps = this.getConfig().maxFps;
      if (fps > 0) {
        const interval = 1000 / fps;
        if (this.nextFrameDue === 0) this.nextFrameDue = now;
        if (now < this.nextFrameDue) return;
        this.nextFrameDue += interval;
        if (now - this.nextFrameDue > interval) this.nextFrameDue = now + interval;
      } else {
        this.nextFrameDue = 0;
      }
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  update(aircraft: Aircraft[]): void {
    const cfg = this.getConfig();
    const now = performance.now();
    for (const ac of aircraft) {
      if (!this.passesFilter(ac, cfg)) continue;
      const hasPos = ac.lat != null && ac.lon != null;
      let tr = this.tracks.get(ac.hex);
      if (!tr) {
        tr = { ac, history: [], firstSeen: now, lastSeen: now, hasPos, life: 0 };
        this.tracks.set(ac.hex, tr);
      }
      tr.ac = ac;
      tr.lastSeen = now;
      tr.hasPos = hasPos;
      if (hasPos) {
        const last = tr.history[tr.history.length - 1];
        if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
          tr.history.push({ t: now, lat: ac.lat!, lon: ac.lon!, track: ac.track, gs: ac.gs });
        }
      }
    }
  }

  private passesFilter(ac: Aircraft, cfg: Config): boolean {
    if (cfg.hideOnGround && ac.onGround) return false;
    const alt = ac.altBaro ?? ac.altGeom;
    if (alt != null) {
      if (alt < cfg.minAltitudeFt) return false;
      if (alt > cfg.maxAltitudeFt) return false;
    }
    return true;
  }

  private sampleAt(tr: MapTrack, tt: number, cfg: Config): { lat: number; lon: number } | null {
    const h = tr.history;
    if (h.length === 0) return null;
    if (tt <= h[0].t) return h[0];
    const last = h[h.length - 1];
    if (tt >= last.t) {
      if (!cfg.interpolate) return last;
      const dt = Math.min((tt - last.t) / 1000, cfg.maxExtrapolationSec);
      return deadReckonLL(last.lat, last.lon, last.track, last.gs, dt);
    }
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= tt && tt <= h[i].t) {
        const a = h[i - 1];
        const b = h[i];
        const f = (tt - a.t) / Math.max(1, b.t - a.t);
        return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      }
    }
    return last;
  }

  private screenHeading(tr: MapTrack, tt: number, cfg: Config): number {
    const pa = this.sampleAt(tr, tt - 400, cfg);
    const pb = this.sampleAt(tr, tt + 400, cfg);
    if (pa && pb) {
      const sa = this.tileMap.latLonToScreen(pa.lat, pa.lon, this.w, this.h);
      const sb = this.tileMap.latLonToScreen(pb.lat, pb.lon, this.w, this.h);
      if (Math.hypot(sb.x - sa.x, sb.y - sa.y) > 0.5) {
        return Math.atan2(sb.y - sa.y, sb.x - sa.x);
      }
    }
    const m = this.sampleAt(tr, tt, cfg);
    if (m && tr.ac.track != null) {
      const ahead = deadReckonLL(m.lat, m.lon, tr.ac.track, 120, 1);
      const p0 = this.tileMap.latLonToScreen(m.lat, m.lon, this.w, this.h);
      const p1 = this.tileMap.latLonToScreen(ahead.lat, ahead.lon, this.w, this.h);
      return Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    return 0;
  }

  private draw(): void {
    const cfg = this.getConfig();
    const now = performance.now();
    const frameDt = this.prevFrame ? (now - this.prevFrame) / 1000 : 0.016;
    this.prevFrame = now;
    this.frameT = now / 1000;

    if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) this.resize();

    // Dark fill, then tile layer.
    this.ctx.fillStyle = "#191a2e";
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.tileMap.drawTiles(this.ctx, this.w, this.h);

    this.drawOverlays(cfg);
    if (cfg.showAirport) this.drawAirport(cfg);

    const tt = now - RENDER_DELAY_MS;
    const visible: Visible[] = [];

    for (const [hex, tr] of this.tracks) {
      const stale = (now - tr.lastSeen) / 1000;
      if (stale > cfg.staleSec) {
        this.tracks.delete(hex);
        continue;
      }
      const keep = Math.max(cfg.trailSeconds, 6) * 1000 + 4000;
      while (tr.history.length > 2 && now - tr.history[0].t > keep) tr.history.shift();

      const target = stale > cfg.staleSec * 0.5 ? 0 : 1;
      tr.life += (target - tr.life) * Math.min(1, frameDt * 3.5);

      if (!tr.hasPos) continue;
      const pos = this.sampleAt(tr, tt, cfg);
      if (!pos) continue;

      const { x: px, y: py } = this.tileMap.latLonToScreen(pos.lat, pos.lon, this.w, this.h);
      // Skip aircraft well outside the viewport (trail/label margin).
      if (px < -250 || px > this.w + 250 || py < -250 || py > this.h + 250) continue;

      const heading = this.screenHeading(tr, tt, cfg);
      const alpha = clamp01(tr.life) * cfg.brightness;
      const alt = tr.ac.altBaro ?? tr.ac.altGeom ?? 0;
      const color = cfg.altitudeColor ? altRamp(alt) : hexToRgb(cfg.palette.glyph);
      const emergency = cfg.highlightEmergency && !!tr.ac.squawk && EMERGENCY_SQUAWKS.has(tr.ac.squawk);

      visible.push({ tr, lat: pos.lat, lon: pos.lon, px, py, heading, alpha, color, emergency });
    }

    // Farthest from config center first; nearest renders on top.
    visible.sort(
      (a, b) =>
        gcMiles(cfg.centerLat, cfg.centerLon, b.lat, b.lon) -
        gcMiles(cfg.centerLat, cfg.centerLon, a.lat, a.lon),
    );

    if (cfg.showDestArc) for (const v of visible) this.drawDestArc(cfg, v);
    for (const v of visible) this.drawTrail(cfg, v, tt);
    for (const v of visible) this.drawGlyph(cfg, v);

    const byNear = [...visible].reverse();
    this.drawLabels(cfg, byNear);
    if (cfg.theme === "focus" && byNear.length) this.drawDetailPanel(cfg, byNear[0]);
  }

  private drawOverlays(cfg: Config): void {
    if (!cfg.rangeRings) return;
    const ctx = this.ctx;
    const { x: cx, y: cy } = this.tileMap.latLonToScreen(cfg.centerLat, cfg.centerLon, this.w, this.h);
    // Pixel distance for 1 mile: measure northward to avoid Mercator distortion.
    const north1mi = this.tileMap.latLonToScreen(cfg.centerLat + 1609.34 / 110540, cfg.centerLon, this.w, this.h);
    const pxPerMile = Math.abs(north1mi.y - cy);
    if (pxPerMile <= 0) return;

    ctx.save();
    for (let mi = 1; mi <= Math.floor(cfg.radiusMiles); mi++) {
      ctx.beginPath();
      ctx.arc(cx, cy, mi * pxPerMile, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.4 * cfg.brightness);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 8]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.6 * cfg.brightness);
    ctx.fill();
    ctx.restore();
  }

  private drawAirport(cfg: Config): void {
    const ctx = this.ctx;
    const rwyRgb: [number, number, number] = [150, 180, 220];
    for (const ap of AIRPORTS) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const r of ap.runways) {
        const a = this.tileMap.latLonToScreen(r.le[0], r.le[1], this.w, this.h);
        const b = this.tileMap.latLonToScreen(r.he[0], r.he[1], this.w, this.h);
        // Derive px/m from the runway's own rendered length vs. real-world length.
        const rwyM = gcMiles(r.le[0], r.le[1], r.he[0], r.he[1]) * 1609.34;
        const rwyPx = Math.hypot(b.x - a.x, b.y - a.y);
        const pxPerM = rwyPx / Math.max(1, rwyM);
        const wpx = Math.max(2.5, r.widthFt * 0.3048 * pxPerM * 1.4);

        ctx.save();
        ctx.lineCap = "butt";
        ctx.strokeStyle = rgba(rwyRgb, 0.16 * cfg.brightness);
        ctx.lineWidth = wpx;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.strokeStyle = rgba([210, 226, 255], 0.22 * cfg.brightness);
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();

        cx += (a.x + b.x) / 2;
        cy += (a.y + b.y) / 2;
        n++;
      }
      if (n) {
        cx /= n;
        cy /= n;
        ctx.save();
        ctx.font = `300 13px ${cfg.fonts.label}`;
        ctx.fillStyle = rgba(rwyRgb, 0.5 * cfg.brightness);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        try { ctx.letterSpacing = "4px"; } catch { /* noop */ }
        ctx.fillText(ap.name, cx, cy);
        try { ctx.letterSpacing = "0px"; } catch { /* noop */ }
        ctx.restore();
      }
    }
  }

  private drawDestArc(cfg: Config, v: Visible): void {
    const ac = v.tr.ac;
    if (ac.destLat == null || ac.destLon == null) return;
    if (!routePlausible(ac, cfg)) return;
    const brgRad = bearing(v.lat, v.lon, ac.destLat, ac.destLon) * DEG;
    const stepM = cfg.radiusMiles * 1609.34 * 0.5;
    const aheadLat = v.lat + (Math.cos(brgRad) * stepM) / 110540;
    const aheadLon = v.lon + (Math.sin(brgRad) * stepM) / (111320 * Math.cos(v.lat * DEG));
    const ep = this.tileMap.latLonToScreen(aheadLat, aheadLon, this.w, this.h);
    const dx = ep.x - v.px;
    const dy = ep.y - v.py;
    const len = Math.hypot(dx, dy) || 1;
    const L = Math.min(this.w, this.h) * 0.24;
    const ex = v.px + (dx / len) * L;
    const ey = v.py + (dy / len) * L;
    const ctx = this.ctx;
    ctx.save();
    const grad = ctx.createLinearGradient(v.px, v.py, ex, ey);
    grad.addColorStop(0, rgba(v.color, 0.32 * v.alpha));
    grad.addColorStop(1, rgba(v.color, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(v.px, v.py);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }

  private drawTrail(cfg: Config, v: Visible, tt: number): void {
    if (cfg.trailSeconds <= 0) return;
    const h = v.tr.history;
    if (h.length < 2) return;
    const ctx = this.ctx;
    const windowMs = cfg.trailSeconds * 1000;
    const pts: { p: { x: number; y: number }; age: number }[] = [];
    for (const s of h) {
      if (s.t < tt - windowMs || s.t > tt) continue;
      pts.push({
        p: this.tileMap.latLonToScreen(s.lat, s.lon, this.w, this.h),
        age: (tt - s.t) / windowMs,
      });
    }
    pts.push({ p: { x: v.px, y: v.py }, age: 0 });
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = 1 - b.age;
      ctx.strokeStyle = rgba(v.color, 0.55 * f * v.alpha);
      ctx.lineWidth = 0.7 + 2.2 * f * (cfg.glyphSizePx / 14);
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y);
      ctx.lineTo(b.p.x, b.p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGlyph(cfg: Config, v: Visible): void {
    const ctx = this.ctx;
    const color = v.emergency ? hexToRgb(cfg.palette.warn) : v.color;
    const kind = classifyGlyph(v.tr.ac);
    const s = cfg.glyphSizePx * GLYPH_SCALE[kind];

    ctx.save();
    ctx.translate(v.px, v.py);
    ctx.rotate(v.heading + Math.PI / 2);

    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.7);
    halo.addColorStop(0, rgba(color, 0.16 * v.alpha));
    halo.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.7, 0, Math.PI * 2);
    ctx.fill();

    drawAircraftGlyph(ctx, kind, s, color, v.alpha, this.frameT, hexSeed(v.tr.ac.hex));
    ctx.restore();
  }

  private drawLabels(cfg: Config, nearestFirst: Visible[]): void {
    const limit =
      cfg.labelDensity === "all"
        ? nearestFirst.length
        : cfg.labelDensity === "nearestN"
          ? cfg.nearestN
          : 1;
    this.placedBoxes = [];
    for (let i = 0; i < Math.min(limit, nearestFirst.length); i++) {
      const prom = 1 - i / Math.max(1, nearestFirst.length);
      this.drawLabel(cfg, nearestFirst[i], 0.7 + 0.3 * prom);
    }
  }

  private measureLabel(
    cfg: Config,
    lines: { text: string; kind: "title" | "sub" }[],
  ): { w: number; lh: number; h: number } {
    const ctx = this.ctx;
    const lh = 16;
    let w = 0;
    for (const ln of lines) {
      ctx.font = ln.kind === "title" ? `500 14px ${cfg.fonts.label}` : `400 11px ${cfg.fonts.label}`;
      try { ctx.letterSpacing = ln.kind === "title" ? "1.5px" : "0.5px"; } catch { /* noop */ }
      w = Math.max(w, ctx.measureText(ln.text).width);
    }
    try { ctx.letterSpacing = "0px"; } catch { /* noop */ }
    return { w: w + 2, lh, h: lines.length * lh };
  }

  private collides(b: { x: number; y: number; w: number; h: number }): boolean {
    const pad = 3;
    for (const p of this.placedBoxes) {
      if (b.x - pad < p.x + p.w && b.x + b.w + pad > p.x && b.y - pad < p.y + p.h && b.y + b.h + pad > p.y)
        return true;
    }
    return false;
  }

  private labelLines(cfg: Config, ac: Aircraft): { text: string; kind: "title" | "sub" }[] {
    const f = cfg.showFields;
    const out: { text: string; kind: "title" | "sub" }[] = [];
    const title = f.flight ? (ac.flight ?? ac.hex.toUpperCase()) : ac.airline;
    if (title) out.push({ text: title, kind: "title" });

    const sub: string[] = [];
    if (f.type && (ac.typeName || ac.typeCode)) sub.push(ac.typeName ?? ac.typeCode!);
    const alt = ac.altBaro ?? ac.altGeom;
    if (f.altitude) {
      if (ac.onGround) sub.push("GND");
      else if (alt != null) sub.push(`${alt.toLocaleString("en-US")} ft`);
    }
    if (f.speed && ac.gs != null) sub.push(`${Math.round(ac.gs)} kt`);
    if (sub.length) out.push({ text: sub.join("   "), kind: "sub" });
    if (f.ownOp && ac.ownOp) out.push({ text: ac.ownOp, kind: "sub" });

    if (f.destination && ac.destination && routePlausible(ac, cfg)) {
      const head = ac.origin ? `${ac.origin} → ${ac.destination}` : `→ ${ac.destination}`;
      out.push({ text: ac.destName ? `${head}   ${ac.destName}` : head, kind: "sub" });
      if (cfg.showRouteDetail && ac.destLat != null && ac.destLon != null) {
        const bits: string[] = [`${localTimeAt(ac.destLon)} local`];
        if (ac.lat != null && ac.lon != null) {
          const mi = Math.round(gcMiles(ac.lat, ac.lon, ac.destLat, ac.destLon));
          if (mi > 1) bits.push(`${mi.toLocaleString("en-US")} mi to go`);
        }
        out.push({ text: bits.join("   ·   "), kind: "sub" });
      }
    }
    if (f.registration && ac.registration) out.push({ text: ac.registration, kind: "sub" });
    return out;
  }

  private drawLabel(cfg: Config, v: Visible, strength: number): void {
    const ctx = this.ctx;
    const lines = this.labelLines(cfg, v.tr.ac);
    if (!lines.length) return;
    const a = v.alpha * strength;
    if (a < 0.04) return;

    const { w, lh, h } = this.measureLabel(cfg, lines);
    const gap = cfg.glyphSizePx * 0.7 + 9;
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x >= 6 && b.x + b.w <= this.w - 6 && b.y >= 6 && b.y + b.h <= this.h - 6;

    const candidates = [
      { x: v.px + gap, y: v.py - gap - h },
      { x: v.px + gap, y: v.py + gap },
      { x: v.px - gap - w, y: v.py - gap - h },
      { x: v.px - gap - w, y: v.py + gap },
    ];
    let box: { x: number; y: number; w: number; h: number } | null = null;
    for (const c of candidates) {
      const b = { x: c.x, y: c.y, w, h };
      if (onScreen(b) && !this.collides(b)) { box = b; break; }
    }
    if (!box) {
      let b = { x: v.px + gap, y: v.py - gap - h, w, h };
      for (let k = 0; k < 9 && (this.collides(b) || !onScreen(b)); k++) b = { ...b, y: b.y + lh + 2 };
      box = b;
    }
    box.x = Math.max(6, Math.min(box.x, this.w - 6 - w));
    box.y = Math.max(6, Math.min(box.y, this.h - 6 - h));
    this.placedBoxes.push(box);

    const anchorX = box.x + w / 2 < v.px ? box.x + w : box.x;
    const anchorY = Math.max(box.y, Math.min(v.py, box.y + h));

    ctx.save();
    // Line from label to glyph
    ctx.strokeStyle = rgba(hexToRgb(cfg.palette.text), 0.8 * a * cfg.brightness);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(v.px, v.py);
    ctx.lineTo(anchorX, anchorY);
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 6;
    let y = box.y;
    for (const ln of lines) {
      if (ln.kind === "title") {
        ctx.font = `500 14px ${cfg.fonts.label}`;
        ctx.fillStyle = rgba([245, 247, 255], a);
        try { ctx.letterSpacing = "1.5px"; } catch { /* noop */ }
      } else {
        ctx.font = `400 11px ${cfg.fonts.label}`;
        ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.82 * a);
        try { ctx.letterSpacing = "0.5px"; } catch { /* noop */ }
      }
      ctx.fillText(ln.text, box.x, y);
      y += lh;
    }
    try { ctx.letterSpacing = "0px"; } catch { /* noop */ }
    ctx.restore();
  }

  private drawDetailPanel(cfg: Config, v: Visible): void {
    const ac = v.tr.ac;
    const x = 40;
    const y = this.h - 120;
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    try { ctx.letterSpacing = "2px"; } catch { /* noop */ }
    ctx.font = `300 34px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba([245, 247, 255], v.alpha);
    ctx.fillText(ac.flight ?? ac.hex.toUpperCase(), x, y);
    try { ctx.letterSpacing = "0.5px"; } catch { /* noop */ }
    ctx.font = `400 15px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.85 * v.alpha);
    const dpAlt = ac.altBaro ?? ac.altGeom;
    const bits = [
      ac.airline,
      ac.typeName ?? ac.typeCode,
      ac.onGround ? "on ground" : dpAlt != null ? `${dpAlt.toLocaleString("en-US")} ft` : null,
      ac.gs != null ? `${Math.round(ac.gs)} kt` : null,
      ac.origin && ac.destination && routePlausible(ac, cfg) ? `${ac.origin} → ${ac.destination}` : null,
    ].filter(Boolean);
    ctx.fillText(bits.join("    ·    "), x, y + 26);
    try { ctx.letterSpacing = "0px"; } catch { /* noop */ }
    ctx.restore();
  }
}
