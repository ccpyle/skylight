// Bundled airport geometry, drawn at true geographic position so departures and
// arrivals visibly line up with the runways. Coordinates from OurAirports (KSFO).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  runways: Runway[];
}

export const SFO: Airport = {
  icao: "KSFO",
  name: "SFO",
  runways: [
    { leIdent: "10L", heIdent: "28R", le: [37.628742, -122.39341], he: [37.613538, -122.35716], widthFt: 200 },
    { leIdent: "10R", heIdent: "28L", le: [37.626298, -122.393124], he: [37.61172, -122.358367], widthFt: 200 },
    { leIdent: "1L", heIdent: "19R", le: [37.607898, -122.38295], he: [37.626476, -122.37063], widthFt: 200 },
    { leIdent: "1R", heIdent: "19L", le: [37.606333, -122.381061], he: [37.627346, -122.367124], widthFt: 200 },
  ],
};

export const ATL: Airport = {
  icao: "KATL",
  name: "ATL",
  runways: [
    { leIdent: "8L", heIdent: "26R", le: [33.649543, -84.439071], he: [33.649546, -84.409492], widthFt: 200 },
    { leIdent: "8R", heIdent: "26L", le: [33.646794, -84.438362], he: [33.646806, -84.405530], widthFt: 200 },
    { leIdent: "9L", heIdent: "27R", le: [33.634718, -84.447963], he: [33.634730, -84.407283], widthFt: 200 },
    { leIdent: "9R", heIdent: "27L", le: [33.631827, -84.447974], he: [33.631827, -84.418452], widthFt: 200 },
  ],
};

export const VPS: Airport = {
  icao: "KVPS",
  name: "VPS",
  runways: [
    { leIdent: "20", heIdent: "2", le: [30.5010768, -86.510793], he: [30.4709103, -86.518372], widthFt: 150 },
    { leIdent: "12", heIdent: "30", le: [30.4887647, -86.552243], he: [30.471095, -86.516366], widthFt: 150 },
  ],
};

export const ECP: Airport = {
  icao: "KECP",
  name: "ECP",
  runways: [
    { leIdent: "16", heIdent: "34", le: [30.37107, -85.80114], he: [30.345766, -85.79016], widthFt: 200 },
  ],
};

/** Airports drawn on the map (currently just SFO; easy to extend). */
export const AIRPORTS: Airport[] = [ECP, ATL, VPS];
