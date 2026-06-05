// Lightweight Web Mercator tile renderer — no external map library.
// Handles tile loading/caching, pan, zoom, and lat/lon ↔ screen-pixel conversion.

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

function latLonToGlobalPx(lat: number, lon: number, zoom: number): { gx: number; gy: number } {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const wx = (lon + 180) / 360;
  const wy = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const scale = Math.pow(2, zoom) * TILE_SIZE;
  return { gx: wx * scale, gy: wy * scale };
}

function globalPxToLatLon(gx: number, gy: number, zoom: number): { lat: number; lon: number } {
  const scale = Math.pow(2, zoom) * TILE_SIZE;
  const n = Math.PI * (1 - (2 * gy) / scale);
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lon: (gx / scale) * 360 - 180,
  };
}

type CacheVal = HTMLImageElement | "loading" | "error";

export class TileMap {
  zoom: number;
  centerLat: number;
  centerLon: number;

  private canvas: HTMLCanvasElement;
  private cache = new Map<string, CacheVal>();
  private onRedraw: () => void;
  private dragging = false;
  private lastMouse = { x: 0, y: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    centerLat: number,
    centerLon: number,
    zoom: number,
    onRedraw: () => void,
  ) {
    this.canvas = canvas;
    this.centerLat = centerLat;
    this.centerLon = centerLon;
    this.zoom = zoom;
    this.onRedraw = onRedraw;
    this.attachEvents();
  }

  private tileUrl(z: number, x: number, y: number): string {
    const s = "abc"[(x + y) % 3];
    // CartoDB Dark Matter — pairs well with bright aircraft glyphs.
    return `https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
  }

  private attachEvents(): void {
    const el = this.canvas;

    el.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      this.shiftCenter(e.clientX - this.lastMouse.x, e.clientY - this.lastMouse.y);
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomAt(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
      },
      { passive: false },
    );

    let prevTouches: { x: number; y: number }[] = [];
    el.addEventListener(
      "touchstart",
      (e) => {
        prevTouches = Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
      },
      { passive: true },
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        const curr = Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
        if (curr.length === 1 && prevTouches.length === 1) {
          this.shiftCenter(curr[0].x - prevTouches[0].x, curr[0].y - prevTouches[0].y);
        } else if (curr.length === 2 && prevTouches.length === 2) {
          const prevD = Math.hypot(prevTouches[0].x - prevTouches[1].x, prevTouches[0].y - prevTouches[1].y);
          const currD = Math.hypot(curr[0].x - curr[1].x, curr[0].y - curr[1].y);
          const cx = (curr[0].x + curr[1].x) / 2;
          const cy = (curr[0].y + curr[1].y) / 2;
          if (currD > prevD * 1.4) this.zoomAt(1, cx, cy);
          else if (currD < prevD / 1.4) this.zoomAt(-1, cx, cy);
        }
        prevTouches = curr;
      },
      { passive: false },
    );
    el.addEventListener("touchend", () => {
      prevTouches = [];
    });
  }

  private shiftCenter(dxScreen: number, dyScreen: number): void {
    const { gx, gy } = latLonToGlobalPx(this.centerLat, this.centerLon, this.zoom);
    const ll = globalPxToLatLon(gx - dxScreen, gy - dyScreen, this.zoom);
    this.centerLat = ll.lat;
    this.centerLon = ll.lon;
    this.onRedraw();
  }

  zoomAt(delta: number, screenX: number, screenY: number): void {
    const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + delta));
    if (newZ === this.zoom) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const ll = this.screenToLatLon(screenX, screenY, w, h);
    this.zoom = newZ;
    const { gx: fx, gy: fy } = latLonToGlobalPx(ll.lat, ll.lon, this.zoom);
    const c = globalPxToLatLon(fx - screenX + w / 2, fy - screenY + h / 2, this.zoom);
    this.centerLat = c.lat;
    this.centerLon = c.lon;
    this.onRedraw();
  }

  screenToLatLon(sx: number, sy: number, w: number, h: number): { lat: number; lon: number } {
    const { gx, gy } = latLonToGlobalPx(this.centerLat, this.centerLon, this.zoom);
    return globalPxToLatLon(gx + sx - w / 2, gy + sy - h / 2, this.zoom);
  }

  latLonToScreen(lat: number, lon: number, w: number, h: number): { x: number; y: number } {
    const { gx: cGx, gy: cGy } = latLonToGlobalPx(this.centerLat, this.centerLon, this.zoom);
    const { gx, gy } = latLonToGlobalPx(lat, lon, this.zoom);
    return { x: w / 2 + gx - cGx, y: h / 2 + gy - cGy };
  }

  drawTiles(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const z = this.zoom;
    const tileCount = Math.pow(2, z);
    const { gx: cGx, gy: cGy } = latLonToGlobalPx(this.centerLat, this.centerLon, z);
    const ox = cGx - w / 2;
    const oy = cGy - h / 2;

    const minTX = Math.floor(ox / TILE_SIZE);
    const minTY = Math.floor(oy / TILE_SIZE);
    const maxTX = Math.ceil((ox + w) / TILE_SIZE);
    const maxTY = Math.ceil((oy + h) / TILE_SIZE);

    for (let ty = minTY; ty <= maxTY; ty++) {
      if (ty < 0 || ty >= tileCount) continue;
      for (let tx = minTX; tx <= maxTX; tx++) {
        const wtx = ((tx % tileCount) + tileCount) % tileCount;
        const sx = Math.round(tx * TILE_SIZE - ox);
        const sy = Math.round(ty * TILE_SIZE - oy);
        const key = `${z}/${wtx}/${ty}`;
        const val = this.cache.get(key);
        if (val instanceof HTMLImageElement) {
          ctx.drawImage(val, sx, sy, TILE_SIZE, TILE_SIZE);
        } else if (val !== "loading" && val !== "error") {
          this.fetchTile(key, z, wtx, ty);
        }
      }
    }
    this.pruneCache();
  }

  private fetchTile(key: string, z: number, x: number, y: number): void {
    this.cache.set(key, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = this.tileUrl(z, x, y);
    img.onload = () => {
      this.cache.set(key, img);
      this.onRedraw();
    };
    img.onerror = () => {
      this.cache.set(key, "error");
    };
  }

  private pruneCache(): void {
    if (this.cache.size <= 256) return;
    const keys = [...this.cache.keys()];
    for (let i = 0; i < 64; i++) this.cache.delete(keys[i]);
  }
}
