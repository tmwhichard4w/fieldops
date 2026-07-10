// ============================================================
// citygis.js — loads the City of Troy (MRB) official GIS layers
// onto the map as read-only reference layers, each independently
// toggleable in the layers control.
//
// Data source: troy_gis.json (converted from MRB shapefiles,
// reprojected to WGS84). This is REFERENCE DATA — approximate,
// not for excavation. Crews must still call 811 before digging.
// ============================================================

// Display config for each layer: label shown in the toggle, color,
// how to draw it (line vs point), and whether it starts ON at load.
// Per request: only the water & sewer MAINS are on by default.
const CITY_GIS_CONFIG = {
  water_main:   { label: "🟦 City Water Main",    color: "#0284c7", kind: "line",  on: true  },
  sewer_main:   { label: "🟩 City Sewer Main",    color: "#15803d", kind: "line",  on: true  },
  force_main:   { label: "🟧 City Force Main",     color: "#ea580c", kind: "line",  on: false, dash: "6 5" },
  hydrant:      { label: "🔴 City Hydrants",       color: "#dc2626", kind: "point", on: false },
  iso_valve:    { label: "🟣 City Isolation Valves",color: "#7c3aed", kind: "point", on: false },
  flush_valve:  { label: "🔵 City Flush Valves",    color: "#0891b2", kind: "point", on: false },
  manhole:      { label: "⚫ City Manholes",        color: "#374151", kind: "point", on: false },
  cleanout:     { label: "🟤 City Cleanouts",       color: "#92400e", kind: "point", on: false },
  lift_station: { label: "🏭 City Lift Station",    color: "#be123c", kind: "point", on: false },
};

// Load the GIS file, build a Leaflet layer group per dataset, add each
// to the map + the layers control. Called once, after the map exists.
export async function loadCityGIS(map, layersControl) {
  let data;
  try {
    const res = await fetch("./troy_gis.json");
    if (!res.ok) throw new Error("troy_gis.json not found");
    data = await res.json();
  } catch (err) {
    console.warn("City GIS layers not loaded:", err.message);
    return; // app keeps working without the reference layers
  }

  for (const [key, cfg] of Object.entries(CITY_GIS_CONFIG)) {
    const layer = data[key];
    if (!layer || !layer.features || !layer.features.length) continue;

    const group = L.layerGroup();
    layer.features.forEach(f => {
      if (f.t === "ln") {
        // c is an array of [lng,lat] points → Leaflet wants [lat,lng]
        const latlngs = f.c.map(pt => [pt[1], pt[0]]);
        L.polyline(latlngs, {
          color: cfg.color, weight: 3, opacity: 0.9,
          dashArray: cfg.dash || null
        }).bindPopup(`<b>${cfg.label}</b><br><span style="font-size:11px;color:#666">City reference — call 811 before digging</span>`)
          .addTo(group);
      } else {
        // point: c is [lng,lat]
        const ll = [f.c[1], f.c[0]];
        L.circleMarker(ll, {
          radius: 5, color: "#fff", weight: 1.5,
          fillColor: cfg.color, fillOpacity: 1
        }).bindPopup(`<b>${cfg.label}</b><br><span style="font-size:11px;color:#666">City reference — call 811 before digging</span>`)
          .addTo(group);
      }
    });

    if (cfg.on) group.addTo(map);            // on by default (mains only)
    layersControl.addOverlay(group, cfg.label); // always in the toggle list
  }
}
