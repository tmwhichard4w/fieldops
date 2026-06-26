// ============================================================
// data.js — every database call lives here.
// Uses the Supabase JS client loaded in index.html.
// ============================================================
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";

export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------- AUTH ----------
export async function signIn(email, password) {
  return db.auth.signInWithPassword({ email, password });
}
export async function signOut() { return db.auth.signOut(); }
export async function currentUser() {
  const { data } = await db.auth.getUser();
  return data.user;
}

// ---------- WORK ORDERS ----------
export async function listWorkOrders() {
  const { data, error } = await db
    .from("work_orders").select("*, leak_details(*)").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function nextWoNumber() {
  const { data } = await db.from("work_orders").select("wo_number").order("created_at", { ascending: false }).limit(1);
  let n = 1001;
  if (data && data[0] && data[0].wo_number) {
    const m = data[0].wo_number.match(/(\d+)/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return "WO-" + n;
}

export async function saveWorkOrder(wo, leak) {
  let id = wo.id;
  if (id) {
    const { error } = await db.from("work_orders").update({ ...wo, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  } else {
    wo.wo_number = await nextWoNumber();
    const { data, error } = await db.from("work_orders").insert(wo).select().single();
    if (error) throw error;
    id = data.id;
  }
  // leak detail upsert / clear
  if (leak) {
    await db.from("leak_details").upsert({ work_order_id: id, ...leak });
  } else {
    await db.from("leak_details").delete().eq("work_order_id", id);
  }
  return id;
}

export async function setStatus(id, status) {
  const { error } = await db.from("work_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

// Permanently delete a work order (and its leak detail / logs / photos cascade).
export async function deleteWorkOrder(id) {
  const { error } = await db.from("work_orders").delete().eq("id", id);
  if (error) throw error;
}

// ---------- LOGS (labor / equipment / material / fuel) ----------
export async function logsFor(table, woId) {
  const { data, error } = await db.from(table).select("*").eq("work_order_id", woId).order("logged_at");
  if (error) throw error;
  return data || [];
}
export async function addLabor(row)    { return db.from("labor_log").insert(row); }
export async function addEquipUse(row) { return db.from("equipment_log").insert(row); }
export async function addMaterial(row) { return db.from("material_log").insert(row); }
export async function deleteLog(table, id) { return db.from(table).delete().eq("id", id); }

// ---------- EQUIPMENT ----------
export async function listEquipment() {
  const { data, error } = await db.from("equipment").select("*").order("ownership").order("name");
  if (error) throw error;
  return data || [];
}
export async function bumpRunHours(equipId, addHours) {
  const { data } = await db.from("equipment").select("run_hours, service_at").eq("id", equipId).single();
  if (!data) return;
  const hrs = Number(data.run_hours) + Number(addHours);
  const status = hrs >= Number(data.service_at) ? "due_soon" : "in_service";
  await db.from("equipment").update({ run_hours: hrs, status }).eq("id", equipId);
}
export async function addFuel(row) { return db.from("fuel_log").insert(row); }
export async function fuelFor(equipId) {
  const { data } = await db.from("fuel_log").select("*").eq("equipment_id", equipId);
  return data || [];
}

// ---------- INVENTORY ----------
export async function listInventory() {
  const { data, error } = await db.from("inventory").select("*").order("category").order("name");
  if (error) throw error;
  return data || [];
}
export async function adjustStock(invId, delta) {
  const { data } = await db.from("inventory").select("qty").eq("id", invId).single();
  if (!data) return;
  await db.from("inventory").update({ qty: Math.max(0, Number(data.qty) + delta) }).eq("id", invId);
}

// ---------- REQUESTS ----------
export async function listRequests() {
  const { data } = await db.from("requests").select("*").order("reported_at", { ascending: false });
  return data || [];
}
export async function addRequest(row) { return db.from("requests").insert(row); }
export async function markRequestConverted(id, woId) {
  return db.from("requests").update({ status: "converted", work_order_id: woId }).eq("id", id);
}

// ---------- SCHEDULE ----------
export async function listSchedules() {
  const { data } = await db.from("schedules").select("*").order("next_due");
  return data || [];
}

// ---------- VALVES ----------
export async function listValves() {
  const { data, error } = await db.from("valves").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function saveValve(valve) {
  if (valve.id) {
    const { error } = await db.from("valves").update(valve).eq("id", valve.id);
    if (error) throw error;
    return valve.id;
  }
  const { data, error } = await db.from("valves").insert(valve).select().single();
  if (error) throw error;
  return data.id;
}
export async function deleteValve(id) { return db.from("valves").delete().eq("id", id); }

// ---------- GIS: HYDRANTS / MANHOLES / MAINS ----------
export async function listHydrants() { const { data } = await db.from("hydrants").select("*").order("created_at", { ascending: false }); return data || []; }
export async function saveHydrant(h) {
  if (h.id) { const { error } = await db.from("hydrants").update(h).eq("id", h.id); if (error) throw error; return h.id; }
  const { data, error } = await db.from("hydrants").insert(h).select().single(); if (error) throw error; return data.id;
}
export async function deleteHydrant(id) { return db.from("hydrants").delete().eq("id", id); }

export async function listManholes() { const { data } = await db.from("manholes").select("*").order("created_at", { ascending: false }); return data || []; }
export async function saveManhole(m) {
  if (m.id) { const { error } = await db.from("manholes").update(m).eq("id", m.id); if (error) throw error; return m.id; }
  const { data, error } = await db.from("manholes").insert(m).select().single(); if (error) throw error; return data.id;
}
export async function deleteManhole(id) { return db.from("manholes").delete().eq("id", id); }

export async function listMains() { const { data } = await db.from("mains").select("*").order("created_at", { ascending: false }); return data || []; }
export async function saveMain(m) {
  if (m.id) { const { error } = await db.from("mains").update(m).eq("id", m.id); if (error) throw error; return m.id; }
  const { data, error } = await db.from("mains").insert(m).select().single(); if (error) throw error; return data.id;
}
export async function deleteMain(id) { return db.from("mains").delete().eq("id", id); }

// ---------- NOTIFICATION SETTINGS ----------
export async function getNotifySettings() {
  const { data } = await db.from("notification_settings").select("*").eq("id", 1).single();
  return data || { id: 1, enabled: false };
}
export async function saveNotifySettings(settings) {
  return db.from("notification_settings").upsert({ id: 1, ...settings });
}

// Fire an email notification. Best-effort: never blocks or throws into the UI.
// The Edge Function decides whether to actually send based on saved settings.
export async function notify(event_type, subject, body) {
  try {
    await db.functions.invoke("send-notification", {
      body: { event_type, subject, body },
    });
  } catch (e) {
    console.warn("notify failed (non-blocking):", e);
  }
}

// ---------- PHOTOS ----------
export async function uploadPhoto(woId, file, label) {
  const path = `${woId}/${Date.now()}_${file.name}`;
  const { error } = await db.storage.from("wo-photos").upload(path, file);
  if (error) throw error;
  await db.from("photos").insert({ work_order_id: woId, storage_path: path, label });
  return path;
}
export async function photosFor(woId) {
  const { data } = await db.from("photos").select("*").eq("work_order_id", woId);
  return (data || []).map(p => ({
    ...p,
    url: db.storage.from("wo-photos").getPublicUrl(p.storage_path).data.publicUrl
  }));
}
export async function uploadValvePhoto(valveId, file, label) {
  const path = `valve/${valveId}/${Date.now()}_${file.name}`;
  const { error } = await db.storage.from("wo-photos").upload(path, file);
  if (error) throw error;
  await db.from("photos").insert({ valve_id: valveId, storage_path: path, label });
  return path;
}
export async function photosForValve(valveId) {
  const { data } = await db.from("photos").select("*").eq("valve_id", valveId);
  return (data || []).map(p => ({
    ...p,
    url: db.storage.from("wo-photos").getPublicUrl(p.storage_path).data.publicUrl
  }));
}
