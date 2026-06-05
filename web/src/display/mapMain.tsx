import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/map.css";
import { MapDisplay } from "./MapDisplay.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MapDisplay />
  </StrictMode>,
);
