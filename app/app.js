// ============================================================
// app.js — FieldOps UI logic, wired to Supabase via data.js
// ============================================================
import * as api from "./data.js";
import { MAP_CENTER, MAP_ZOOM, OT_MULTIPLIER } from "./config.js";

// ---------- tiny helpers ----------
const $ = id => document.getElementById(id);
const fmt = n => "$" + Math.round(n).toLocaleString();
const esc = s => (s == null ? "" : String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
const fmtDT = s => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const isWater = o => o.category === "Water Leak";
const isSewer = o => o.category === "Sewer Issue";

function respTime(o) {
  if (!o.reported_at || !o.found_at) return null;
  const d = (new Date(o.found_at) - new Date(o.reported_at)) / 3.6e6;
  return d >= 0 ? d : null;
}

// ---------- state ----------
let orders = [], equipment = [], inventory = [], requests = [], schedules = [];
let logs = { labor: [], equip: [], mat: [] }, photos = [];
let filterStatus = "all", selectedId = null, editingId = null, prefillReq = null;
let map, markers = {};

const TABS = [
  ["map", "Map"], ["list", "Orders"], ["water", "Water"], ["sewer", "Sewer"],
  ["intake", "Requests"], ["schedule", "Schedule"], ["inventory", "Inventory"],
  ["equipment", "Equipment"], ["reports", "Reports"], ["settings", "Settings"]
];

// ============================================================
// AUTH
// ============================================================
$("loginBtn").onclick = doLogin;
$("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  $("loginErr").textContent = "";
  const { error } = await api.signIn($("loginEmail").value.trim(), $("loginPass").value);
  if (error) { $("loginErr").textContent = error.message; return; }
  await startApp();
}

$("signOutBtn").onclick = async () => { await api.signOut(); location.reload(); };

(async function boot() {
  const user = await api.currentUser();
  if (user) await startApp();
})();

async function startApp() {
  $("loginScreen").style.display = "none";
  $("app").style.display = "block";
  buildNav();
  buildFilters();
  initMap();
  $("newBtn").onclick = () => openOrderModal();
  $("searchInput").oninput = renderOrders;
  $("zoomIn").onclick = () => map.zoomIn();
  $("zoomOut").onclick = () => map.zoomOut();
  $("fitAll").onclick = fitAll;
  await refreshAll();
  showView("map");
}

async function refreshAll() {
  [orders, equipment, inventory, requests, schedules] = await Promise.all([
    api.listWorkOrders(), api.listEquipment(), api.listInventory(),
    api.listRequests(), api.listSchedules()
  ]);
  // flatten leak_details (Supabase returns it as array)
  orders.forEach(o => { o.leak = (o.leak_details && o.leak_details[0]) || null; });
  renderOrders();
  renderStats();
}

// ============================================================
// NAV + FILTERS
// ============================================================
function buildNav() {
  $("navTabs").innerHTML = TABS.map(([k, label]) =>
    `<button class="nav-tab" data-view="${k}">${label}</button>`).join("");
  $("navTabs").querySelectorAll(".nav-tab").forEach(b =>
    b.onclick = () => showView(b.dataset.view));
}
function buildFilters() {
  const f = [["all", "All"], ["new", "New"], ["in_progress", "In Progress"],
    ["Water", "💧 Water"], ["Sewer", "🟢 Sewer"], ["urgent", "🔴 Urgent"]];
  $("filterRow").innerHTML = f.map(([k, l], i) =>
    `<div class="filter-chip${i === 0 ? " active" : ""}" data-f="${k}">${l}</div>`).join("");
  $("filterRow").querySelectorAll(".filter-chip").forEach(c =>
    c.onclick = () => {
      filterStatus = c.dataset.f;
      $("filterRow").querySelectorAll(".filter-chip").forEach(x => x.classList.remove("active"));
      c.classList.add("active"); renderOrders();
    });
}

// ============================================================
// MAP
// ============================================================
function initMap() {
  map = L.map("map", { zoomControl: false }).setView(MAP_CENTER, MAP_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
}
function markerColor(o) {
  if (isWater(o)) return "#0891b2";
  if (isSewer(o)) return "#16a34a";
  if (o.priority === "urgent") return "#dc2626";
  if (o.status === "in_progress") return "#d97706";
  if (o.status === "completed") return "#16a34a";
  return "#2563eb";
}
function fitAll() {
  const pts = orders.filter(o => o.lat && o.lng).map(o => [o.lat, o.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
}

// ============================================================
// COSTS
// ============================================================
const laborCost = rows => rows.reduce((s, l) => s + l.reg_hours * l.rate + l.ot_hours * l.rate * OT_MULTIPLIER, 0);
const laborHrs  = rows => rows.reduce((s, l) => s + Number(l.reg_hours) + Number(l.ot_hours), 0);
const equipCost = rows => rows.reduce((s, e) => s + e.hours * e.rate, 0);
const rentCost  = rows => rows.reduce((s, e) => s + (e.ownership === "rented" ? e.hours * e.rate : 0), 0);
const matCost   = rows => rows.reduce((s, m) => s + m.qty * m.unit_cost, 0);

// ============================================================
// ORDER LIST + MARKERS
// ============================================================
function statusBadge(o) {
  if (isWater(o)) return `<span class="badge badge-water">💧 Water</span>`;
  if (isSewer(o)) return `<span class="badge badge-sewer">🟢 Sewer</span>`;
  const map = { new: "new", in_progress: "progress", completed: "done" };
  const lbl = { new: "New", in_progress: "In Progress", completed: "Completed" };
  return `<span class="badge badge-${map[o.status] || "new"}">${lbl[o.status] || o.status}</span>`;
}

function renderOrders() {
  Object.values(markers).forEach(m => map && map.removeLayer(m)); markers = {};
  const q = ($("searchInput").value || "").toLowerCase();
  const list = orders.filter(o => {
    const mf = filterStatus === "all" || o.status === filterStatus ||
      (filterStatus === "Water" && isWater(o)) || (filterStatus === "Sewer" && isSewer(o)) ||
      (filterStatus === "urgent" && o.priority === "urgent");
    const ms = !q || (o.title || "").toLowerCase().includes(q) ||
      (o.address || "").toLowerCase().includes(q) || (o.wo_number || "").toLowerCase().includes(q);
    return mf && ms;
  });
  $("woList").innerHTML = list.map(o => `
    <div class="wo-card${o.id === selectedId ? " selected" : ""}" data-id="${o.id}">
      <div class="wo-row1"><span class="wo-id">${esc(o.wo_number)}</span>${statusBadge(o)}</div>
      <div class="wo-title">${esc(o.title)}</div>
      <div class="wo-meta"><div class="prio-dot prio-${o.priority === "high" || o.priority === "urgent" ? "high" : o.priority === "medium" ? "med" : "low"}"></div>${esc(o.priority)} · ${esc(o.assigned_to || "Unassigned")}</div>
      <div class="wo-meta" style="margin-top:3px">📍 ${esc(o.address || "")}</div>
    </div>`).join("") || `<div style="text-align:center;color:var(--txt3);padding:40px;font-size:14px">No work orders found</div>`;
  $("woList").querySelectorAll(".wo-card").forEach(c => c.onclick = () => selectOrder(c.dataset.id));

  orders.filter(o => o.lat && o.lng).forEach(o => {
    const icon = L.divIcon({ html: `<div style="width:16px;height:16px;border-radius:50%;background:${markerColor(o)};border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`, iconSize: [16, 16], iconAnchor: [8, 8], className: "" });
    const m = L.marker([o.lat, o.lng], { icon }).addTo(map);
    m.bindPopup(`<b>${esc(o.title)}</b><br><span style="font-size:12px;color:#666">${esc(o.wo_number)} · ${esc(o.status)}</span>`);
    m.on("click", () => selectOrder(o.id));
    markers[o.id] = m;
  });
}

function renderStats() {
  const s = [
    ["blue", orders.filter(o => o.status === "new").length, "Open"],
    ["amber", orders.filter(o => o.status === "in_progress").length, "In Progress"],
    ["cyan", orders.filter(o => isWater(o) && o.status !== "completed").length, "Water Leaks"],
    ["green", orders.filter(o => isSewer(o) && o.status !== "completed").length, "Sewer Issues"],
    ["red", orders.filter(o => o.priority === "urgent").length, "Urgent"],
    ["red", inventory.filter(i => Number(i.qty) < Number(i.min_qty)).length, "Low Stock"],
  ];
  $("statsBar").innerHTML = s.map(([c, n, l]) =>
    `<div class="stat-card stat-${c}"><div class="stat-num">${n}</div><div class="stat-lbl">${l}</div></div>`).join("");
}

// ============================================================
// DETAIL PANEL
// ============================================================
async function selectOrder(id) {
  selectedId = id;
  const o = orders.find(x => x.id === id);
  renderOrders();
  if (map && markers[id]) { map.setView([o.lat, o.lng], 15); markers[id].openPopup(); }
  // load logs + photos
  [logs.labor, logs.equip, logs.mat, photos] = await Promise.all([
    api.logsFor("labor_log", id), api.logsFor("equipment_log", id),
    api.logsFor("material_log", id), api.photosFor(id)
  ]);
  showDetail(o);
}

function showDetail(o) {
  const rt = respTime(o);
  const deptBadge = o.department === "Parks & Recreation" ? "badge-parks" : "badge-pw";
  const leakBlock = o.leak ? `
    <div class="section-title">${isWater(o) ? "💧" : "🟢"} ${o.leak.kind === "water" ? "Water" : "Sewer"} Details</div>
    <div class="detail-grid">
      <div class="detail-field"><div class="field-label">Line Size</div><div class="field-value">${esc(o.leak.line_size)}</div></div>
      <div class="detail-field"><div class="field-label">Pipe Material</div><div class="field-value">${esc(o.leak.pipe_material)}</div></div>
      <div class="detail-field"><div class="field-label">Cause</div><div class="field-value">${esc(o.leak.cause)}</div></div>
      <div class="detail-field"><div class="field-label">${isWater(o) ? "Gallons Lost" : "Gallons Spilled"}</div><div class="field-value">${Number(o.leak.gallons || 0).toLocaleString()} gal</div></div>
      <div class="detail-field"><div class="field-label">811 Ticket</div><div class="field-value">${esc(o.leak.locate_ticket) || "—"}</div></div>
      <div class="detail-field"><div class="field-label">${isWater(o) ? "Boil Notice" : "SSO Reported"}</div><div class="field-value" style="color:${o.leak.notice === "Yes" ? "var(--red)" : "var(--txt)"}">${esc(o.leak.notice)}</div></div>
    </div>` : "";

  const laborRows = logs.labor.map(l => `<tr><td>${esc(l.worker)}</td><td>${l.reg_hours} hr</td><td>${l.ot_hours} hr</td><td>${fmt(l.reg_hours * l.rate + l.ot_hours * l.rate * OT_MULTIPLIER)}</td><td><span class="del" data-t="labor_log" data-id="${l.id}" style="color:var(--red-txt);cursor:pointer">✕</span></td></tr>`).join("") || `<tr><td colspan="5" style="color:var(--txt3)">No labor logged</td></tr>`;
  const equipRows = logs.equip.map(e => `<tr><td>${esc(e.equipment_name)} <span class="badge badge-${e.ownership === "rented" ? "rented" : "owned"}">${e.ownership}</span></td><td>${e.hours} hr</td><td>${fmt(e.hours * e.rate)}</td><td><span class="del" data-t="equipment_log" data-id="${e.id}" style="color:var(--red-txt);cursor:pointer">✕</span></td></tr>`).join("") || `<tr><td colspan="4" style="color:var(--txt3)">No equipment logged</td></tr>`;
  const matRows = logs.mat.map(m => `<tr><td>${esc(m.item_name)}</td><td>${m.qty}</td><td>${fmt(m.qty * m.unit_cost)}</td><td><span class="del" data-t="material_log" data-id="${m.id}" style="color:var(--red-txt);cursor:pointer">✕</span></td></tr>`).join("") || `<tr><td colspan="4" style="color:var(--txt3)">No materials logged</td></tr>`;
  const photoHtml = photos.map(p => `<div class="photo-thumb"><img src="${p.url}" alt="${esc(p.label)}"></div>`).join("");

  const total = laborCost(logs.labor) + equipCost(logs.equip) + matCost(logs.mat);

  $("detailContent").innerHTML = `
    <div class="detail-header"><div><div style="display:flex;gap:6px;margin-bottom:6px"><span class="badge ${deptBadge}">${esc(o.department)}</span>${statusBadge(o)}</div><div class="detail-title">${esc(o.title)}</div></div>
      <button class="detail-close" id="dClose"><svg viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke-linecap="round" stroke="currentColor" stroke-width="2.5"/></svg></button></div>
    <div class="detail-grid">
      <div class="detail-field"><div class="field-label">📞 First Reported</div><div class="field-value">${fmtDT(o.reported_at)}</div></div>
      <div class="detail-field"><div class="field-label">🔍 First Found</div><div class="field-value">${fmtDT(o.found_at)}</div></div>
      <div class="detail-field"><div class="field-label">Response Time</div><div class="field-value">${rt !== null ? rt.toFixed(1) + " hrs" : "—"}</div></div>
      <div class="detail-field"><div class="field-label">Priority</div><div class="field-value">${esc(o.priority)}</div></div>
      <div class="detail-field"><div class="field-label">Assigned</div><div class="field-value">${esc(o.assigned_to || "Unassigned")}</div></div>
      <div class="detail-field"><div class="field-label">WO #</div><div class="field-value">${esc(o.wo_number)}</div></div>
    </div>
    <div class="detail-notes"><div class="field-label" style="margin-bottom:6px">📍 ${esc(o.address || "")}</div><p>${esc(o.notes || "")}</p>
      ${o.equip_needed ? `<div style="margin-top:8px"><span class="field-label">🚜 Equipment Needed: </span><span style="font-size:13px">${esc(o.equip_needed)}</span></div>` : ""}</div>
    ${leakBlock}
    <div class="section-title">👷 Labor / Man-Hours <button class="add-line-btn" data-line="labor" style="margin-left:auto">+ Add</button></div>
    <table class="log-table"><thead><tr><th>Worker</th><th>Reg</th><th>OT</th><th>Cost</th><th></th></tr></thead><tbody>${laborRows}</tbody></table>
    <div class="section-title">🚜 Equipment (owned & rented) <button class="add-line-btn" data-line="equip" style="margin-left:auto">+ Add</button></div>
    <table class="log-table"><thead><tr><th>Equipment</th><th>Hours</th><th>Cost</th><th></th></tr></thead><tbody>${equipRows}</tbody></table>
    <div class="section-title">📦 Materials / Consumables <button class="add-line-btn" data-line="mat" style="margin-left:auto">+ Add</button></div>
    <table class="log-table"><thead><tr><th>Item</th><th>Qty</th><th>Cost</th><th></th></tr></thead><tbody>${matRows}</tbody></table>
    <div class="section-title">📷 Photos</div>
    <div class="photo-row">${photoHtml}<label class="photo-thumb photo-add"><svg viewBox="0 0 24 24" fill="none"><path d="M12 6v12M6 12h12" stroke-linecap="round"/></svg>Add<input type="file" accept="image/*" capture="environment" id="photoInput" style="display:none"></label></div>
    <div class="cost-summary"><div><div class="field-label">Total Job Cost</div><div style="font-size:12px;color:var(--blue-txt);opacity:.8">Labor ${fmt(laborCost(logs.labor))} · Equip ${fmt(equipCost(logs.equip))} · Mat ${fmt(matCost(logs.mat))}</div></div><div class="cost-total">${fmt(total)}</div></div>
    <div class="detail-actions">
      ${o.status !== "completed" ? `<button class="action-btn btn-complete" data-status="completed">✓ Complete</button>` : ""}
      ${o.status === "new" ? `<button class="action-btn btn-primary" data-status="in_progress">Start Work</button>` : ""}
      <button class="action-btn btn-secondary" id="editBtn">Edit</button></div>`;

  $("detailPanel").classList.add("open");
  $("dClose").onclick = closeDetail;
  $("editBtn").onclick = () => openOrderModal(o);
  $("detailContent").querySelectorAll("[data-status]").forEach(b => b.onclick = async () => {
    const newStatus = b.dataset.status;
    await api.setStatus(o.id, newStatus);
    const label = { in_progress: "started", completed: "completed" }[newStatus] || newStatus;
    api.notify(newStatus === "completed" ? "completed" : "status",
      `Work order ${label}: ${o.title}`,
      `${o.wo_number} — ${o.title} was marked ${newStatus.replace("_", " ")}.`);
    await refreshAll(); selectOrder(o.id);
  });
  $("detailContent").querySelectorAll("[data-line]").forEach(b => b.onclick = () => openLineModal(o, b.dataset.line));
  $("detailContent").querySelectorAll(".del").forEach(d => d.onclick = async () => {
    await api.deleteLog(d.dataset.t, d.dataset.id); selectOrder(o.id);
  });
  $("photoInput").onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const label = prompt("Photo label (Before / After / Damage):", "Photo") || "Photo";
    try { await api.uploadPhoto(o.id, file, label); selectOrder(o.id); }
    catch (err) { alert("Upload failed: " + err.message); }
  };
}
function closeDetail() { $("detailPanel").classList.remove("open"); selectedId = null; renderOrders(); }

// ============================================================
// ORDER MODAL (create / edit)
// ============================================================
function openOrderModal(o) {
  editingId = o ? o.id : null;
  const crews = ["Unassigned", "Crew A", "Crew B", "Crew C", "John Martinez", "Sarah Lee", "Mike Johnson", "Dale Cooper"];
  const cats = ["Water Leak", "Sewer Issue", "Roads", "Electrical", "Meter", "Hydrant", "Valve", "Parks", "Trails", "Buildings", "Grounds", "Other"];
  const sizes = ['3/4"', '1"', '2"', '4"', '6"', '8"', '10"', '12"'];
  const mats = ["PVC", "Ductile Iron", "Cast Iron", "Asbestos Cement", "HDPE", "Steel", "Clay (sewer)"];
  const causes = ["Age/Corrosion", "Freeze", "Ground Shift", "Excavation Damage", "Pressure Surge", "Root Intrusion", "Grease/FOG", "Unknown"];
  const sel = (arr, v) => arr.map(x => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("");
  const p = prefillReq;
  const v = o || (p ? { title: p.issue, address: p.address, category: p.category, reported_at: p.reported_at, notes: `From request — ${p.resident || ""} ${p.phone || ""}` } : {});
  const lk = (o && o.leak) || {};
  const dtLocal = s => s ? new Date(s).toISOString().slice(0, 16) : "";

  $("modalBox").innerHTML = `
    <h2>${o ? "Edit" : "New"} Work Order</h2>
    <div class="form-group"><label>Title *</label><input class="form-control" id="f-title" value="${esc(v.title || "")}"></div>
    <div class="form-grid">
      <div class="form-group"><label>Department</label><select class="form-control" id="f-dept">${sel(["Public Works", "Parks & Recreation"], v.department)}</select></div>
      <div class="form-group"><label>Type</label><select class="form-control" id="f-cat">${sel(cats, v.category || "Water Leak")}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-group"><label>📞 First Reported</label><input class="form-control" id="f-reported" type="datetime-local" value="${dtLocal(v.reported_at) || new Date().toISOString().slice(0, 16)}"></div>
      <div class="form-group"><label>🔍 First Found</label><input class="form-control" id="f-found" type="datetime-local" value="${dtLocal(v.found_at)}"></div>
    </div>
    <div class="leak-fields" id="leakFields">
      <div class="field-label" id="leakHdr" style="margin-bottom:10px">Leak Details</div>
      <div class="form-grid-3">
        <div class="form-group"><label>Line Size</label><select class="form-control" id="f-size">${sel(sizes, lk.line_size || '6"')}</select></div>
        <div class="form-group"><label>Material</label><select class="form-control" id="f-material">${sel(mats, lk.pipe_material)}</select></div>
        <div class="form-group"><label>Cause</label><select class="form-control" id="f-cause">${sel(causes, lk.cause)}</select></div>
      </div>
      <div class="form-grid-3">
        <div class="form-group"><label id="galLbl">Gallons</label><input class="form-control" id="f-gallons" type="number" value="${lk.gallons || ""}"></div>
        <div class="form-group"><label>811 Ticket</label><input class="form-control" id="f-ticket" value="${esc(lk.locate_ticket || "")}"></div>
        <div class="form-group"><label id="noticeLbl">Notice?</label><select class="form-control" id="f-notice">${sel(["No", "Yes"], lk.notice)}</select></div>
      </div>
    </div>
    <div class="form-group"><label>🚜 Equipment Needed (planning)</label><input class="form-control" id="f-equipneeded" value="${esc(v.equip_needed || "")}" placeholder="e.g. Backhoe, Vac Truck, Trench Box (rented)"></div>
    <div class="form-grid-3">
      <div class="form-group"><label>Priority</label><select class="form-control" id="f-prio">${sel(["low", "medium", "high", "urgent"], v.priority || "medium")}</select></div>
      <div class="form-group"><label>Assigned</label><select class="form-control" id="f-assign">${sel(crews, v.assigned_to || "Unassigned")}</select></div>
      <div class="form-group"><label>Status</label><select class="form-control" id="f-status">${sel(["new", "in_progress", "completed"], v.status || "new")}</select></div>
    </div>
    <div class="form-group"><label>Location / Address</label><input class="form-control" id="f-addr" value="${esc(v.address || "")}"></div>
    <div class="form-grid">
      <div class="form-group"><label>Latitude</label><input class="form-control" id="f-lat" type="number" step="any" value="${v.lat || ""}" placeholder="${MAP_CENTER[0]}"></div>
      <div class="form-group"><label>Longitude</label><input class="form-control" id="f-lng" type="number" step="any" value="${v.lng || ""}" placeholder="${MAP_CENTER[1]}"></div>
    </div>
    <div class="form-group"><label>Notes</label><textarea class="form-control" id="f-notes">${esc(v.notes || "")}</textarea></div>
    <div class="modal-actions"><button class="action-btn btn-primary" id="saveOrder">Save</button><button class="action-btn btn-secondary" id="cancelOrder">Cancel</button></div>`;

  const toggleLeak = () => {
    const c = $("f-cat").value, w = c === "Water Leak", s = c === "Sewer Issue";
    const lf = $("leakFields");
    lf.classList.toggle("show", w || s);
    lf.classList.toggle("leak-water", w); lf.classList.toggle("leak-sewer", s);
    $("leakHdr").textContent = w ? "💧 Water Leak Details" : "🟢 Sewer Issue Details";
    $("galLbl").textContent = w ? "Gallons Lost" : "Gallons Spilled";
    $("noticeLbl").textContent = w ? "Boil Notice?" : "SSO Reported?";
  };
  $("f-cat").onchange = toggleLeak; toggleLeak();
  $("saveOrder").onclick = submitOrder;
  $("cancelOrder").onclick = () => { prefillReq = null; closeModal(); };
  $("modalOverlay").classList.add("open");
}

async function submitOrder() {
  const title = $("f-title").value.trim();
  if (!title) { alert("Please enter a title."); return; }
  const cat = $("f-cat").value, w = cat === "Water Leak", s = cat === "Sewer Issue";
  const wo = {
    title, department: $("f-dept").value, category: cat,
    priority: $("f-prio").value, assigned_to: $("f-assign").value, status: $("f-status").value,
    address: $("f-addr").value, notes: $("f-notes").value, equip_needed: $("f-equipneeded").value,
    reported_at: $("f-reported").value || null, found_at: $("f-found").value || null,
    lat: parseFloat($("f-lat").value) || MAP_CENTER[0], lng: parseFloat($("f-lng").value) || MAP_CENTER[1]
  };
  if (editingId) wo.id = editingId;
  const leak = (w || s) ? {
    kind: w ? "water" : "sewer", line_size: $("f-size").value, pipe_material: $("f-material").value,
    cause: $("f-cause").value, gallons: parseInt($("f-gallons").value) || 0,
    locate_ticket: $("f-ticket").value, notice: $("f-notice").value
  } : null;
  try {
    const isNew = !editingId;
    const prevAssignee = editingId ? (orders.find(o => o.id === editingId) || {}).assigned_to : null;
    const id = await api.saveWorkOrder(wo, leak);
    if (prefillReq) { await api.markRequestConverted(prefillReq.id, id); prefillReq = null; }

    // ---- email notifications (best-effort) ----
    const where = wo.address ? ` at ${wo.address}` : "";
    if (isNew) {
      api.notify("created", `New work order: ${wo.title}`,
        `A new ${wo.category} work order was created${where}.\nPriority: ${wo.priority}\nAssigned to: ${wo.assigned_to}`);
    } else if (wo.assigned_to && wo.assigned_to !== "Unassigned" && wo.assigned_to !== prevAssignee) {
      api.notify("assigned", `Work order assigned: ${wo.title}`,
        `${wo.title}${where} is now assigned to ${wo.assigned_to}.`);
    }
    if (leak && leak.notice === "Yes") {
      api.notify("notice", `${leak.kind === "water" ? "BOIL NOTICE" : "SSO REPORTED"}: ${wo.title}`,
        `A ${leak.kind} event${where} has a ${leak.kind === "water" ? "boil notice" : "sanitary sewer overflow"} flagged. Est. gallons: ${leak.gallons}.`);
    } else if (leak && isNew) {
      api.notify("leak", `${leak.kind === "water" ? "Water leak" : "Sewer issue"} logged: ${wo.title}`,
        `A ${leak.kind} issue was logged${where}. Size: ${leak.line_size}, cause: ${leak.cause}.`);
    }

    closeModal();
    await refreshAll();
  } catch (err) { alert("Save failed: " + err.message); }
}
function closeModal() { $("modalOverlay").classList.remove("open"); editingId = null; }

// ============================================================
// LINE MODALS (labor / equip / material)
// ============================================================
function openLineModal(o, type) {
  const crews = ["Crew A", "Crew B", "Crew C", "John Martinez", "Sarah Lee", "Mike Johnson", "Dale Cooper"];
  let body, title;
  if (type === "labor") {
    title = "Log Labor / Man-Hours";
    body = `<div class="form-group"><label>Worker / Crew</label><select class="form-control" id="l-who">${crews.map(c => `<option>${c}</option>`).join("")}</select></div>
      <div class="form-grid"><div class="form-group"><label>Regular Hours</label><input class="form-control" id="l-reg" type="number" step="0.5" value="1"></div>
      <div class="form-group"><label>OT Hours</label><input class="form-control" id="l-ot" type="number" step="0.5" value="0"></div></div>
      <div class="form-group"><label>Rate ($/hr)</label><input class="form-control" id="l-rate" type="number" step="0.5" value="30"></div>`;
  } else if (type === "equip") {
    title = "Log Equipment Used";
    body = `<div class="form-group"><label>Equipment</label><select class="form-control" id="l-eq">${equipment.map(e => `<option value="${e.id}">${esc(e.name)} — ${e.ownership} · ${fmt(e.hourly_rate)}/hr</option>`).join("")}</select></div>
      <div class="form-group"><label>Hours Used</label><input class="form-control" id="l-hrs" type="number" step="0.5" value="1"></div>`;
  } else {
    title = "Log Material / Consumable";
    body = `<div class="form-group"><label>Item</label><select class="form-control" id="l-item">${inventory.map(i => `<option value="${i.id}">${esc(i.name)} (${i.qty} ${i.unit})</option>`).join("")}</select></div>
      <div class="form-group"><label>Qty Used</label><input class="form-control" id="l-qty" type="number" step="1" value="1"></div>`;
  }
  $("lineBox").innerHTML = `<h2>${title}</h2>${body}<div class="modal-actions"><button class="action-btn btn-primary" id="saveLine">Add</button><button class="action-btn btn-secondary" id="cancelLine">Cancel</button></div>`;
  $("saveLine").onclick = () => submitLine(o, type);
  $("cancelLine").onclick = () => $("lineModal").classList.remove("open");
  $("lineModal").classList.add("open");
}

async function submitLine(o, type) {
  try {
    if (type === "labor") {
      await api.addLabor({ work_order_id: o.id, worker: $("l-who").value, reg_hours: +$("l-reg").value || 0, ot_hours: +$("l-ot").value || 0, rate: +$("l-rate").value || 30 });
    } else if (type === "equip") {
      const eq = equipment.find(e => e.id === $("l-eq").value); const hrs = +$("l-hrs").value || 0;
      await api.addEquipUse({ work_order_id: o.id, equipment_id: eq.id, equipment_name: eq.name, hours: hrs, rate: eq.hourly_rate, ownership: eq.ownership });
      if (eq.ownership === "owned") await api.bumpRunHours(eq.id, hrs);
    } else {
      const it = inventory.find(i => i.id === $("l-item").value); const qty = +$("l-qty").value || 0;
      await api.addMaterial({ work_order_id: o.id, inventory_id: it.id, item_name: it.name, qty, unit_cost: it.unit_cost });
      await api.adjustStock(it.id, -qty);
      const remaining = Number(it.qty) - qty;
      if (remaining < Number(it.min_qty) && Number(it.qty) >= Number(it.min_qty)) {
        api.notify("low_stock", `Low stock: ${it.name}`,
          `${it.name} dropped to ${remaining} ${it.unit} (reorder point is ${it.min_qty}). Time to reorder.`);
      }
    }
    $("lineModal").classList.remove("open");
    await refreshAll();
    selectOrder(o.id);
  } catch (err) { alert("Failed: " + err.message); }
}

// ============================================================
// PAGE VIEWS
// ============================================================
function showView(v) {
  $("mainView").style.display = v === "map" ? "flex" : "none";
  $("pageView").style.display = v === "map" ? "none" : "block";
  $("navTabs").querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
  if (v === "map" && map) setTimeout(() => map.invalidateSize(), 100);
  const render = { list: pgList, water: () => pgLeaks("water"), sewer: () => pgLeaks("sewer"), intake: pgIntake, schedule: pgSchedule, inventory: pgInventory, equipment: pgEquipment, reports: pgReports, settings: pgSettings }[v];
  if (render) render();
}

function csv(name, rows) {
  const out = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "text/csv" }));
  a.download = name; a.click();
}

function pgList() {
  const rows = orders.map(o => `<tr data-id="${o.id}" style="cursor:pointer">
    <td style="font-family:monospace;font-size:12px;color:var(--txt3)">${esc(o.wo_number)}</td><td style="font-weight:600">${esc(o.title)}</td>
    <td>${statusBadge(o)}</td><td style="font-size:12px">${fmtDT(o.reported_at)}</td><td style="font-size:12px">${fmtDT(o.found_at)}</td>
    <td style="font-size:13px">${esc(o.assigned_to || "")}</td></tr>`).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>All Work Orders</h2><button class="ghost-btn" id="exp">⬇ Export CSV</button></div>
    <div class="data-card"><table class="data-table"><thead><tr><th>WO#</th><th>Title</th><th>Type</th><th>Reported</th><th>Found</th><th>Assigned</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $("exp").onclick = () => {
    const r = [["WO#", "Title", "Dept", "Type", "Status", "Priority", "Assigned", "Reported", "Found", "Resp Hrs", "Address"]];
    orders.forEach(o => r.push([o.wo_number, o.title, o.department, o.category, o.status, o.priority, o.assigned_to, o.reported_at, o.found_at, respTime(o)?.toFixed(1) || "", o.address]));
    csv("work_orders.csv", r);
  };
  $("pageContent").querySelectorAll("tr[data-id]").forEach(t => t.onclick = () => { showView("map"); setTimeout(() => selectOrder(t.dataset.id), 200); });
}

function pgLeaks(kind) {
  const arr = orders.filter(o => o.leak && o.leak.kind === kind);
  const gal = arr.reduce((s, o) => s + Number(o.leak.gallons || 0), 0);
  const color = kind === "water" ? "cyan" : "green";
  const noun = kind === "water" ? "Lost" : "Spilled";
  const rows = arr.map(o => `<tr data-id="${o.id}" style="cursor:pointer"><td style="font-family:monospace;font-size:12px;color:var(--txt3)">${esc(o.wo_number)}</td><td style="font-weight:600">${esc(o.title)}</td><td>${esc(o.leak.line_size)}</td><td>${esc(o.leak.pipe_material)}</td><td>${esc(o.leak.cause)}</td><td style="font-size:12px">${fmtDT(o.reported_at)}</td><td style="font-weight:600">${Number(o.leak.gallons || 0).toLocaleString()}</td><td>${esc(o.status)}</td></tr>`).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2 style="color:var(--${color}-txt)">${kind === "water" ? "💧 Water System" : "🟢 Sewer System"}</h2><button class="ghost-btn" id="exp">⬇ Export</button></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
      <div class="stat-card stat-${color}"><div class="stat-num">${arr.filter(o => o.status !== "completed").length}</div><div class="stat-lbl">Active</div></div>
      <div class="stat-card stat-${color}"><div class="stat-num">${gal.toLocaleString()}</div><div class="stat-lbl">Gallons ${noun}</div></div>
      <div class="stat-card"><div class="stat-num">${arr.length}</div><div class="stat-lbl">Total YTD</div></div></div>
    <div class="data-card"><table class="data-table"><thead><tr><th>WO#</th><th>Title</th><th>Size</th><th>Material</th><th>Cause</th><th>Reported</th><th>Gallons</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="8" style="color:var(--txt3)">None logged</td></tr>`}</tbody></table></div>`;
  $("exp").onclick = () => {
    const r = [["WO#", "Title", "Size", "Material", "Cause", "Reported", "Found", "Gallons", "Notice", "Ticket"]];
    arr.forEach(o => r.push([o.wo_number, o.title, o.leak.line_size, o.leak.pipe_material, o.leak.cause, o.reported_at, o.found_at, o.leak.gallons, o.leak.notice, o.leak.locate_ticket]));
    csv(kind + "_report.csv", r);
  };
  $("pageContent").querySelectorAll("tr[data-id]").forEach(t => t.onclick = () => { showView("map"); setTimeout(() => selectOrder(t.dataset.id), 200); });
}

function pgIntake() {
  const rows = requests.map(r => `<tr><td style="font-family:monospace;font-size:12px;color:var(--txt3)">${esc(r.id.slice(0, 8))}</td>
    <td><div style="font-weight:600">${esc(r.resident || "")}</div><div style="font-size:12px;color:var(--txt3)">${esc(r.phone || "")}</div></td>
    <td style="font-size:13px">${esc(r.address || "")}</td><td style="font-size:13px">${esc(r.issue || "")}</td><td style="font-size:12px">${fmtDT(r.reported_at)}</td>
    <td>${r.status === "converted" ? `<span class="badge badge-done">→ Work Order</span>` : `<button class="add-line-btn" data-req="${r.id}">Create Order</button>`}</td></tr>`).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>📞 Citizen Requests</h2><button class="new-btn" id="newReq"><svg viewBox="0 0 16 16" fill="none" style="width:14px;height:14px"><path d="M8 3v10M3 8h10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg><span>Log Call</span></button></div>
    <div class="data-card"><table class="data-table"><thead><tr><th>ID</th><th>Resident</th><th>Address</th><th>Issue</th><th>Reported</th><th>Action</th></tr></thead><tbody>${rows || `<tr><td colspan="6" style="color:var(--txt3)">No open requests</td></tr>`}</tbody></table></div>`;
  $("newReq").onclick = async () => {
    const resident = prompt("Resident name:"); if (!resident) return;
    await api.addRequest({ resident, phone: prompt("Phone:") || "", address: prompt("Address:") || "", issue: prompt("Issue:") || "", reported_at: new Date().toISOString() });
    await refreshAll(); pgIntake();
  };
  $("pageContent").querySelectorAll("[data-req]").forEach(b => b.onclick = () => { prefillReq = requests.find(r => r.id === b.dataset.req); openOrderModal(); });
}

function pgSchedule() {
  const rows = [...schedules].sort((a, b) => new Date(a.next_due) - new Date(b.next_due)).map(s => {
    const days = Math.round((new Date(s.next_due) - new Date()) / 8.64e7);
    const badge = days < 0 ? `<span class="low-stock">Overdue</span>` : days <= 3 ? `<span style="color:var(--amber-txt);font-weight:600">${days}d</span>` : `${days}d`;
    return `<tr><td style="font-weight:600">${esc(s.task)}</td><td>${esc(s.category)}</td><td>${esc(s.frequency)}</td><td>${esc(s.next_due)}</td><td>${badge}</td><td>${esc(s.assigned_to || "")}</td></tr>`;
  }).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>📅 Preventive Maintenance</h2></div>
    <p style="font-size:13px;color:var(--txt2);margin-bottom:16px">Hydrant flushing, valve exercising, lift-station inspections, mowing, meter reading.</p>
    <div class="data-card"><table class="data-table"><thead><tr><th>Task</th><th>Type</th><th>Frequency</th><th>Next Due</th><th>Countdown</th><th>Assigned</th></tr></thead><tbody>${rows || `<tr><td colspan="6" style="color:var(--txt3)">No scheduled tasks</td></tr>`}</tbody></table></div>`;
}

function pgInventory() {
  const rows = inventory.map(i => {
    const pct = Math.min(100, Math.round(i.qty / (i.min_qty * 2 || 1) * 100));
    const low = Number(i.qty) < Number(i.min_qty);
    const color = low ? "var(--red)" : i.qty < i.min_qty * 1.5 ? "var(--amber)" : "var(--green)";
    return `<tr><td style="font-weight:600">${esc(i.name)}</td><td><span class="badge badge-pw">${esc(i.category)}</span></td>
      <td><div class="stock-bar"><div class="stock-fill" style="width:${pct}%;background:${color}"></div></div><span class="${low ? "low-stock" : ""}">${i.qty} ${esc(i.unit)}</span></td>
      <td>${i.min_qty}</td><td>${fmt(i.unit_cost)}</td><td>${fmt(i.qty * i.unit_cost)}</td>
      <td>${low ? `<span class="low-stock">⚠ Reorder</span>` : `<span style="color:var(--green-txt)">OK</span>`}</td>
      <td><button class="add-line-btn" data-restock="${i.id}">+ Restock</button></td></tr>`;
  }).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>📦 Inventory</h2></div>
    <div class="data-card"><table class="data-table"><thead><tr><th>Item</th><th>Category</th><th>In Stock</th><th>Min</th><th>Unit</th><th>Value</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:13px;color:var(--txt3)">Stock auto-deducts when materials are logged on a work order.</p>`;
  $("pageContent").querySelectorAll("[data-restock]").forEach(b => b.onclick = async () => {
    const n = prompt("Add how many?", "10"); if (!n) return;
    await api.adjustStock(b.dataset.restock, parseInt(n) || 0); await refreshAll(); pgInventory();
  });
}

function pgEquipment() {
  const owned = equipment.filter(e => e.ownership === "owned");
  const rented = equipment.filter(e => e.ownership === "rented");
  const ownedRows = owned.map(e => {
    const pct = Math.min(100, Math.round(e.run_hours / (e.service_at || 1) * 100));
    const color = e.status === "due_soon" ? "var(--amber)" : pct > 90 ? "var(--red)" : "var(--green)";
    return `<tr><td style="font-weight:600">${esc(e.name)}</td><td>${fmt(e.hourly_rate)}/hr</td><td>${Number(e.run_hours).toLocaleString()} hr</td>
      <td><div class="stock-bar"><div class="stock-fill" style="width:${pct}%;background:${color}"></div></div>${Number(e.service_at).toLocaleString()} hr</td>
      <td>${e.status === "due_soon" ? `<span class="low-stock">⚠ Service Due</span>` : `<span style="color:var(--green-txt)">In Service</span>`}</td></tr>`;
  }).join("");
  const rentedRows = rented.map(e => `<tr><td style="font-weight:600">${esc(e.name)} <span class="badge badge-rented">Rented</span></td><td>${esc(e.vendor || "—")}</td><td>${fmt(e.hourly_rate)}/hr</td></tr>`).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>🚜 Equipment & Fleet</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
      <div class="stat-card"><div class="stat-num">${owned.length}</div><div class="stat-lbl">Owned</div></div>
      <div class="stat-card stat-amber"><div class="stat-num">${rented.length}</div><div class="stat-lbl">Rented</div></div>
      <div class="stat-card stat-red"><div class="stat-num">${owned.filter(e => e.status === "due_soon").length}</div><div class="stat-lbl">Service Due</div></div></div>
    <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Owned Equipment</h3>
    <div class="data-card"><table class="data-table"><thead><tr><th>Equipment</th><th>Rate</th><th>Run Hours</th><th>Next Service</th><th>Status</th></tr></thead><tbody>${ownedRows}</tbody></table></div>
    <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Rented Equipment</h3>
    <div class="data-card"><table class="data-table"><thead><tr><th>Equipment</th><th>Vendor</th><th>Rate</th></tr></thead><tbody>${rentedRows || `<tr><td colspan="3" style="color:var(--txt3)">No rentals</td></tr>`}</tbody></table></div>`;
}

async function pgReports() {
  // pull all logs across all orders for the totals
  let tLabor = 0, tEquip = 0, tRent = 0, tMat = 0, tHrs = 0;
  const respArr = [];
  for (const o of orders) {
    const [lb, eq, mt] = await Promise.all([api.logsFor("labor_log", o.id), api.logsFor("equipment_log", o.id), api.logsFor("material_log", o.id)]);
    tLabor += laborCost(lb); tHrs += laborHrs(lb); tEquip += equipCost(eq); tRent += rentCost(eq); tMat += matCost(mt);
    const rt = respTime(o); if (rt !== null) respArr.push(rt);
  }
  const avgResp = respArr.length ? respArr.reduce((s, x) => s + x, 0) / respArr.length : 0;
  const byCat = {}; orders.forEach(o => byCat[o.category] = (byCat[o.category] || 0) + 1);
  const maxCat = Math.max(1, ...Object.values(byCat));
  const bars = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><div style="width:110px;font-size:13px;color:var(--txt2);text-align:right">${esc(c)}</div>
      <div style="flex:1;height:22px;background:var(--bg3);border-radius:4px;overflow:hidden"><div style="height:100%;width:${Math.round(n / maxCat * 100)}%;background:${c === "Water Leak" ? "var(--cyan)" : c === "Sewer Issue" ? "var(--green)" : "var(--blue)"};border-radius:4px"></div></div>
      <div style="font-size:13px;font-weight:600;width:24px">${n}</div></div>`).join("");
  $("pageContent").innerHTML = `<div class="page-head"><h2>Reports & Cost Summary</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:24px">
      <div class="stat-card stat-blue"><div class="stat-num">${fmt(tLabor)}</div><div class="stat-lbl">Labor</div></div>
      <div class="stat-card stat-amber"><div class="stat-num">${fmt(tEquip)}</div><div class="stat-lbl">Equipment</div></div>
      <div class="stat-card stat-amber"><div class="stat-num">${fmt(tRent)}</div><div class="stat-lbl">of which Rental</div></div>
      <div class="stat-card stat-green"><div class="stat-num">${fmt(tMat)}</div><div class="stat-lbl">Materials</div></div>
      <div class="stat-card"><div class="stat-num">${fmt(tLabor + tEquip + tMat)}</div><div class="stat-lbl">Total Op Cost</div></div>
      <div class="stat-card"><div class="stat-num">${Math.round(tHrs)}</div><div class="stat-lbl">Man-Hours</div></div>
      <div class="stat-card"><div class="stat-num">${avgResp.toFixed(1)}h</div><div class="stat-lbl">Avg Response</div></div></div>
    <div class="data-card" style="padding:16px"><div style="font-size:15px;font-weight:700;margin-bottom:14px">Work Orders by Type</div>${bars}</div>
    <div style="margin-bottom:16px"><div class="data-card" style="padding:16px">
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:var(--cyan-txt)">💧 Water lost</span><span style="font-weight:600">${orders.filter(isWater).reduce((s, o) => s + Number(o.leak?.gallons || 0), 0).toLocaleString()} gal</span></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0"><span style="color:var(--green-txt)">🟢 Sewer spilled</span><span style="font-weight:600">${orders.filter(isSewer).reduce((s, o) => s + Number(o.leak?.gallons || 0), 0).toLocaleString()} gal</span></div>
    </div></div>`;
}

// ============================================================
// SETTINGS — email notification preferences
// ============================================================
async function pgSettings() {
  const s = await api.getNotifySettings();
  const toggle = (key, label, desc) => `
    <label style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer">
      <input type="checkbox" id="set-${key}" ${s[key] ? "checked" : ""} style="width:20px;height:20px;margin-top:2px;flex-shrink:0">
      <span><span style="font-weight:600;font-size:14px">${label}</span><br><span style="font-size:13px;color:var(--txt3)">${desc}</span></span>
    </label>`;

  $("pageContent").innerHTML = `
    <div class="page-head"><h2>⚙️ Email Alerts</h2></div>
    <div class="data-card" style="padding:18px;max-width:560px">
      <label style="display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--border)">
        <input type="checkbox" id="set-enabled" ${s.enabled ? "checked" : ""} style="width:22px;height:22px">
        <span style="font-weight:700;font-size:15px">Email alerts ${s.enabled ? "on" : "off"}</span>
      </label>
      <div class="form-group" style="margin-top:16px">
        <label>Send alerts to (admin email)</label>
        <input class="form-control" id="set-email" type="email" value="${esc(s.admin_email || "")}" placeholder="director@yourtown.gov">
      </div>
      <div style="font-size:13px;font-weight:700;color:var(--txt2);margin:18px 0 4px">Send an email when…</div>
      ${toggle("on_created", "A work order is created", "Any new order is logged")}
      ${toggle("on_assigned", "A work order is assigned", "An order's assignee changes")}
      ${toggle("on_status", "Status changes", "An order is started or reopened")}
      ${toggle("on_completed", "A work order is completed", "Marked done")}
      ${toggle("on_leak", "A leak is logged", "New water leak or sewer issue")}
      ${toggle("on_notice", "Boil notice / SSO flagged", "Public-health or state-reportable events")}
      ${toggle("on_low_stock", "Inventory runs low", "An item drops below its reorder point")}
      ${toggle("on_service_due", "Equipment service due", "An owned unit reaches its service interval")}
      <div class="modal-actions">
        <button class="action-btn btn-primary" id="saveSettings">Save settings</button>
        <button class="action-btn btn-secondary" id="testEmail">Send test email</button>
      </div>
      <p id="setMsg" style="font-size:13px;color:var(--green-txt);margin-top:10px;min-height:18px"></p>
    </div>
    <p style="font-size:13px;color:var(--txt3);max-width:560px">Emails are free and sent to the one address above. Turn the master switch off anytime to silence everything. Your IT contractor sets up the email service once (see the setup guide).</p>`;

  const keys = ["on_created", "on_assigned", "on_status", "on_completed", "on_leak", "on_notice", "on_low_stock", "on_service_due"];
  $("saveSettings").onclick = async () => {
    const payload = { enabled: $("set-enabled").checked, admin_email: $("set-email").value.trim() };
    keys.forEach(k => payload[k] = $("set-" + k).checked);
    try {
      await api.saveNotifySettings(payload);
      $("setMsg").style.color = "var(--green-txt)";
      $("setMsg").textContent = "✓ Settings saved.";
      setTimeout(pgSettings, 800);
    } catch (e) { $("setMsg").style.color = "var(--red-txt)"; $("setMsg").textContent = "Save failed: " + e.message; }
  };
  $("testEmail").onclick = async () => {
    const email = $("set-email").value.trim();
    if (!email) { $("setMsg").style.color = "var(--red-txt)"; $("setMsg").textContent = "Enter an admin email first."; return; }
    // Save current state first so the function sees the email + enabled flag.
    const payload = { enabled: $("set-enabled").checked, admin_email: email };
    keys.forEach(k => payload[k] = $("set-" + k).checked);
    await api.saveNotifySettings(payload);
    await api.notify("created", "FieldOps test email", "This is a test. If you received this, email alerts are working.");
    $("setMsg").style.color = "var(--green-txt)";
    $("setMsg").textContent = "Test sent — check the inbox (and spam) for " + email + ". If alerts are off, it won't arrive; flip the master switch on first.";
  };
}
