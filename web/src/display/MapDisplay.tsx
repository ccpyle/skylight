import { useEffect, useRef } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { MapRenderer } from "./mapRenderer.js";
import { TileMap } from "./tileMap.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

function initialZoom(radiusMiles: number, lat: number, halfScreenPx: number): number {
  // Solve for z such that radiusMiles maps to halfScreenPx pixels.
  // pixels_per_mile = 2^z * 256 / (24901 * cos(lat))
  // halfScreenPx = radiusMiles * pixels_per_mile
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((halfScreenPx * 24901 * cosLat) / (radiusMiles * 256));
  return Math.max(4, Math.min(16, Math.round(z)));
}

export function MapDisplay() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const tileMapRef = useRef<TileMap | null>(null);

  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Re-center the map the first time the real config arrives from the server,
  // since on mount state.config is null and we fall back to DEFAULT_CONFIG.
  const centeredRef = useRef(false);
  useEffect(() => {
    const tm = tileMapRef.current;
    if (!tm || !state.config || centeredRef.current) return;
    centeredRef.current = true;
    tm.centerLat = state.config.centerLat;
    tm.centerLon = state.config.centerLon;
    const canvas = canvasRef.current;
    const halfPx = canvas
      ? Math.min(canvas.clientWidth, canvas.clientHeight) / 2
      : Math.min(window.innerWidth, window.innerHeight) / 2;
    tm.zoom = initialZoom(state.config.radiusMiles, state.config.centerLat, halfPx);
  }, [state.config]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const cfg = configRef.current;
    const halfPx = Math.min(window.innerWidth, window.innerHeight) / 2;
    const zoom = initialZoom(cfg.radiusMiles, cfg.centerLat, halfPx);

    const tm = new TileMap(canvasRef.current, cfg.centerLat, cfg.centerLon, zoom, () => {});
    tileMapRef.current = tm;

    const r = new MapRenderer(canvasRef.current, () => configRef.current, tm);
    rendererRef.current = r;
    r.start();

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
      tileMapRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      const tm = tileMapRef.current;
      switch (e.key) {
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
        case "+":
        case "=":
          tm?.zoomAt(1, (canvasRef.current?.clientWidth ?? 800) / 2, (canvasRef.current?.clientHeight ?? 600) / 2);
          break;
        case "-":
          tm?.zoomAt(-1, (canvasRef.current?.clientWidth ?? 800) / 2, (canvasRef.current?.clientHeight ?? 600) / 2);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const cfg = state.config;
  return (
    <div className="map-root">
      <canvas ref={canvasRef} className="map-canvas" />
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac · {cfg.theme}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
      <div className="map-attribution">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>{" "}
        © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>
      </div>
    </div>
  );
}
