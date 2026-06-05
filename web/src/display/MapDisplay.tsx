import { useEffect, useRef } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { MapRenderer } from "./mapRenderer.js";
import { TileMap } from "./tileMap.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

function initialZoom(radiusMiles: number): number {
  // Target: radiusMiles ≈ 250px on a ~1000px screen (equatorial Mercator approximation).
  // 2^z = (250 * 40075000) / (radiusMiles * 1609.34 * 256) ≈ 24300 / radiusMiles
  return Math.max(8, Math.min(16, Math.round(Math.log2(24300 / radiusMiles))));
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
    tm.zoom = initialZoom(state.config.radiusMiles);
  }, [state.config]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const cfg = configRef.current;
    const zoom = initialZoom(cfg.radiusMiles);

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
