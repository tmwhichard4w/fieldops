// ============================================================
// FieldOps configuration
// ------------------------------------------------------------
// Paste the two values from your Supabase project here.
// Supabase dashboard → Project Settings → API
// ============================================================

export const SUPABASE_URL  = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_ANON = "YOUR-ANON-PUBLIC-KEY";

// Town defaults — adjust to your area so new maps center correctly.
export const MAP_CENTER = [31.105, -97.370]; // [latitude, longitude]
export const MAP_ZOOM   = 13;

// Overtime multiplier applied to OT hours in cost rollups.
export const OT_MULTIPLIER = 1.5;

// City GIS map (opens in a new tab, centered on a work order/valve location
// when coordinates are available). This is the City of Troy's Mango map.
export const CITY_GIS_URL = "https://mangomap.com/mrb-group/maps/111343/city-of-troy-gis";
