// ============================================================
// citygis.js — loads the City of Troy (MRB) official GIS layers
// onto the map as read-only reference layers, each independently
// toggleable in the layers control.
//
// Data source: troy_gis.json (converted from MRB shapefiles,
// reprojected to WGS84). REFERENCE DATA — approximate, not for
// excavation. Crews must still call 811 before digging.
// ============================================================

const CITY_GIS_CONFIG = {
  water_main:   { label: "🟦 City Water Main",     color: "#0284c7", kind: "line",  on: true  },
  sewer_main:   { label: "🟩 City Sewer Main",     color: "#15803d", kind: "line",  on: true  },
  force_main:   { label: "🟧 City Force Main",      color: "#ea580c", kind: "line",  on: false, dash: "6 5" },
  hydrant:      { label: "🔴 City Hydrants",        color: "#dc2626", kind: "point", on: false },
  iso_valve:    { label: "🟣 City Isolation Valves",color: "#7c3aed", kind: "point", on: false },
  flush_valve:  { label: "🔵 City Flush Valves",     color: "#0891b2", kind: "point", on: false },
  manhole:      { label: "⚫ City Manholes",         color: "#374151", kind: "point", on: false },
  cleanout:     { label: "🟤 City Cleanouts",        color: "#92400e", kind: "point", on: false },
  lift_station: { label: "🏭 City Lift Station",     color: "#be123c", kind: "point", on: false },
};

// The data file is served at this exact address (verified reachable).
const GIS_URL = "https://cotworkorder.netlify.app/troy_gis.json";

async function fetchGisData() {
  const res = await fetch(GIS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("fetch failed: HTTP " + res.status);
  return await res.json();
}

export async function loadCityGIS(map, layersControl) {
  let data;
  try {
    data = await fetchGisData();
    console.log("City GIS: data loaded OK");
  } catch (err) {
    console.error("City GIS layers not loaded:", err.message);
    return;
  }

  let added = 0;
  for (const [key, cfg] of Object.entries(CITY_GIS_CONFIG)) {
    const layer = data[key];
    if (!layer || !layer.features || !layer.features.length) {
      console.warn("City GIS: no features for", key);
      continue;
    }
    const group = L.layerGroup();
    layer.features.forEach(f => {
      if (f.t === "ln") {
        const latlngs = f.c.map(pt => [pt[1], pt[0]]);
        L.polyline(latlngs, { color: cfg.color, weight: 3, opacity: 0.9, dashArray: cfg.dash || null })
          .bindPopup(`<b>${cfg.label}</b><br><span style="font-size:11px;color:#666">City reference — call 811 before digging</span>`)
          .addTo(group);
      } else {
        const ll = [f.c[1], f.c[0]];
        L.circleMarker(ll, { radius: 5, color: "#fff", weight: 1.5, fillColor: cfg.color, fillOpacity: 1 })
          .bindPopup(`<b>${cfg.label}</b><br><span style="font-size:11px;color:#666">City reference — call 811 before digging</span>`)
          .addTo(group);
      }
    });
    if (cfg.on) group.addTo(map);
    layersControl.addOverlay(group, cfg.label);
    added++;
  }
  console.log("City GIS: added", added, "layers");
}
