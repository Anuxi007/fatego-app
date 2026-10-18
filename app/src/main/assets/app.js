"use strict";

const API = "https://api.atlasacademy.io";
const LIST_TTL = 24 * 60 * 60 * 1000; // refresh the servant list once a day
const UI_LANGS = ["es", "en", "ja"];
const CARD_TYPES = { "1": "arts", "2": "buster", "3": "quick", arts: "arts", buster: "buster", quick: "quick" };
const CLASS_ORDER = [
  "saber", "archer", "lancer", "rider", "caster", "assassin", "berserker",
  "shielder", "ruler", "avenger", "alterEgo", "moonCancer", "foreigner", "pretender", "beast",
];

// ---------- Storage (guarded: WebView storage can be unavailable) ----------
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota or disabled */ }
  },
};

// ---------- Settings ----------
function detectLang() {
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return UI_LANGS.includes(nav) ? nav : "en";
}
const settings = Object.assign(
  { ui: detectLang(), data: null },
  store.get("settings", {})
);
if (!UI_LANGS.includes(settings.ui)) settings.ui = "en"; // German/Russian were removed
try { ["drops", "daily", "list_en", "list_ja"].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* old caches without translated names */ }
if (!settings.data) settings.data = settings.ui === "ja" ? "ja" : "en";
function saveSettings() {
  store.set("settings", settings);
  syncNativeLang();
}
function syncNativeLang() {
  try { if (window.AndroidApp && window.AndroidApp.setLanguage) window.AndroidApp.setLanguage(settings.ui); } catch (e) { /* ignore */ }
}

function t(key, vars) {
  const dict = I18N[settings.ui] || I18N.en;
  let s = dict[key] != null ? dict[key] : I18N.en[key];
  if (s == null) return key;
  if (vars) for (const k in vars) s = s.replace("{" + k + "}", vars[k]);
  return s;
}

// ---------- State ----------
const state = {
  list: null,           // slim servant list for current data language
  listLang: null,
  query: "",
  cls: "all",
  rarity: "all",
  sort: "no",
  desc: false,
  region: "all",
  npCard: "all",
  npTarget: "all",
  moreOpen: false,
  index: null,
  details: {},          // cache: lang:id -> servant
  ascTab: {},           // selected artwork per servant
  oc: {},               // NP overcharge level per NP block
  trait: null,          // list filter: trait id
  lv: {},               // slider level per skill section
  ver: {},              // selected version (normal/upgraded) per skill
  dailyDay: 1,
  dailyTier: {},
};
Object.assign(state, store.get("filters", {}));
state.dailyDay = store.get("dailyDay", 1);

function saveFilters() {
  store.set("filters", {
    cls: state.cls, rarity: state.rarity, sort: state.sort, desc: state.desc,
    region: state.region, npCard: state.npCard, npTarget: state.npTarget,
  });
}

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const view = $("#view");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function cleanText(s) {
  // Atlas text contains color markup such as [g][o]▲[/o][/g] and [#…:…] ruby.
  return String(s || "")
    .replace(/\[#([^:\]]+):[^\]]*\]/g, "$1")
    .replace(/\[(?:\/?[a-z]{1,2}|[0-9a-fA-F]{6}|-)\]/g, "")  // color tags only; keep [Lawful], [Demerit]…
    .trim();
}
function fmt(n) {
  return n == null ? "–" : Number(n).toLocaleString(settings.ui === "ja" ? "ja-JP" : settings.ui);
}
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function stars(r) {
  return r > 0 ? "★".repeat(r) : "☆";
}
function className(c) {
  if (settings.data === "ja" && CLASS_NAMES_JA[c]) return CLASS_NAMES_JA[c];
  if (CLASS_NAMES_EN[c]) return CLASS_NAMES_EN[c];
  if (/^beast/.test(c)) return "Beast";
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : "";
}
function classIcon(classId, rarity) {
  const frame = rarity >= 4 ? 3 : rarity >= 2 ? 2 : 1;
  return `https://static.atlasacademy.io/JP/ClassIcons/class${frame}_${classId}.png`;
}
function classGroup(c) {
  return /^beast/.test(c) ? "beast" : c;
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}
function imgErr(img) {
  img.style.visibility = "hidden";
}
window.imgErr = imgErr;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

// ---------- Data ----------
function listUrl(lang) {
  return lang === "ja"
    ? `${API}/export/JP/basic_servant.json`
    : `${API}/export/JP/basic_servant_lang_en.json`;
}

function slim(arr) {
  return arr
    .filter((s) => s.collectionNo > 0 && (s.type === "normal" || s.type === "heroine"))
    .map((s) => ({
      id: s.id, no: s.collectionNo, name: s.name, orig: s.originalName || "",
      cls: s.className, cid: s.classId, r: s.rarity, atk: s.atkMax, hp: s.hpMax,
      face: s.face, attr: s.attribute,
      tr: (s.traits || []).map((x) => x.id),
    }));
}
// id -> trait name, for every trait that at least one servant has
function traitNamesOf(arr) {
  const out = {};
  for (const s of arr) for (const x of s.traits || []) if (x && x.id != null) out[x.id] = x.name;
  return out;
}
function setList(items, traits, lang) {
  state.list = items;
  state.listLang = lang;
  state.traitNames = traits || state.traitNames || {};
}

async function loadList(force) {
  const lang = settings.data;
  const key = "list2_" + lang;
  const cached = store.get(key, null);
  if (!force && cached && cached.items) {
    setList(cached.items, cached.traits, lang);
    if (Date.now() - cached.ts > LIST_TTL) refreshListInBackground(lang);
    return;
  }
  const raw = await getJSON(listUrl(lang));
  const items = slim(raw), traits = traitNamesOf(raw);
  store.set(key, { ts: Date.now(), items, traits });
  setList(items, traits, lang);
}

async function refreshListInBackground(lang) {
  try {
    const raw = await getJSON(listUrl(lang));
    const items = slim(raw), traits = traitNamesOf(raw);
    store.set("list2_" + lang, { ts: Date.now(), items, traits });
    if (state.listLang === lang) {
      setList(items, traits, lang);
      if (currentRoute().name === "list") renderListResults();
    }
  } catch (e) { /* keep cached data */ }
}

// ---------- Spanish translation of game text ----------
const TR_URL = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/es.json";
let TR = null;

function trActive() {
  return settings.ui === "es" && settings.data === "en" && settings.trGame !== false;
}
function tr(text) {
  if (!TR || !trActive() || typeof text !== "string") return text;
  const hit = TR[text.trim()];
  return hit != null ? hit : text;
}
async function loadTranslations() {
  if (TR || settings.ui !== "es") return;
  const cached = store.get("tr_es", null);
  if (cached && cached.data) TR = cached.data;
  if (!TR) {
    try { TR = await getJSON("es.json"); } catch (e) { /* bundled copy missing */ }
  }
  if (!cached || Date.now() - cached.ts > LIST_TTL) {
    try {
      const data = await getJSON(TR_URL + "?t=" + Math.floor(Date.now() / 3600000));
      TR = data;
      store.set("tr_es", { ts: Date.now(), data });
    } catch (e) { /* keep what we have */ }
  }
}

const INDEX_URL = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/index.json";

function applyIndex(raw) {
  state.index = { na: new Set(raw.na || []), np: raw.np || {} };
}

async function loadIndex() {
  const cached = store.get("index", null);
  if (cached && cached.data) applyIndex(cached.data);
  if (cached && Date.now() - cached.ts < LIST_TTL) return;
  try {
    const data = await getJSON(INDEX_URL + "?t=" + Math.floor(Date.now() / 3600000));
    store.set("index", { ts: Date.now(), data });
    applyIndex(data);
    if (currentRoute().name === "list") renderListResults();
  } catch (e) { /* filters fall back to cached or disabled */ }
}

async function loadServant(id) {
  const key = settings.data + ":" + id;
  if (state.details[key]) return state.details[key];
  let svt;
  let partial = false;
  if (settings.data === "ja") {
    svt = await getJSON(`${API}/nice/JP/servant/${id}?lore=true`);
  } else {
    try {
      svt = await getJSON(`${API}/nice/NA/servant/${id}?lore=true`);
    } catch (e) {
      if (e.status !== 404) throw e;
      svt = await getJSON(`${API}/nice/JP/servant/${id}?lang=en&lore=true`);
      partial = true;
    }
  }
  svt._partial = partial;
  state.details[key] = svt;
  return svt;
}

// ---------- Routing ----------
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("s/")) return { name: "detail", id: h.slice(2) };
  if (h === "settings") return { name: "settings" };
  if (h === "daily") return { name: "daily" };
  if (h === "plan") return { name: "plan" };
  if (h === "banners") return { name: "banners" };
  if (h === "ce") return { name: "ceList" };
  if (h.startsWith("ce/")) return { name: "ceDetail", id: h.slice(3) };
  if (h.startsWith("plan/")) return { name: "planEdit", slot: Number(h.slice(5)) };
  return { name: "list" };
}

function setHeader(title, showBack) {
  $("#title").innerHTML = title;
  $("#backBtn").classList.toggle("hidden", !showBack);
  $("#menuBtn").classList.toggle("hidden", !!showBack);
  closeDrawer();
}

let lastListScroll = 0;
function route() {
  const r = currentRoute();
  view.onclick = null;
  view.oninput = null;
  document.documentElement.lang = settings.ui;
  if (!$("#sheet").classList.contains("hidden")) closeSheet();
  if (r.name !== "detail") { state.curSvt = null; setBarActions(null); unmountGoTo(); }
  document.body.classList.toggle("on-detail", r.name === "detail");
  updateBarSolid();
  if (r.name === "detail") renderDetail(r.id);
  else if (r.name === "settings") renderSettings();
  else if (r.name === "daily") renderDaily();
  else if (r.name === "plan") renderPlan();
  else if (r.name === "planEdit") renderPlanEdit(r.slot);
  else if (r.name === "banners") renderBanners();
  else if (r.name === "ceList") renderCeList();
  else if (r.name === "ceDetail") renderCeDetail(r.id);
  else renderList();
}

// On the servant page the top bar floats over the artwork and turns solid once it scrolls past.
function updateBarSolid() {
  const hero = document.querySelector(".dhero");
  const limit = hero ? hero.offsetHeight - 70 : 0;
  document.body.classList.toggle("bar-solid", !document.body.classList.contains("on-detail") || window.scrollY > limit);
}
window.addEventListener("scroll", updateBarSolid, { passive: true });

window.addEventListener("hashchange", () => {
  route();
});
$("#backBtn").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.hash = "#/";
});
// ---------- Side menu ----------
const MENU = [
  { route: "list", hash: "#/", key: "menuServants", icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>' },
  { route: "banners", hash: "#/banners", key: "banners", icon: '<path d="M5 4h14v16l-7-4-7 4z"/><path d="M9 9h6"/>' },
  { route: "ceList", hash: "#/ce", key: "ceMenu", icon: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 15.5l3.5-6 3.5 6zM9 18h6"/>' },
  { route: "plan", hash: "#/plan", key: "plan", icon: '<path d="M4 20h16M7 16V9M12 16V5M17 16v-4"/>' },
  { route: "daily", hash: "#/daily", key: "daily", icon: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>' },
  { route: "settings", hash: "#/settings", key: "settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
];
function openDrawer() {
  const cur = currentRoute().name;
  $("#drawerItems").innerHTML = MENU.map((m) => `
    <a class="drawer-item ${cur === m.route || (m.route === "plan" && cur === "planEdit") || (m.route === "ceList" && cur === "ceDetail") ? "active" : ""}" href="${m.hash}">
      <svg viewBox="0 0 24 24" class="ic">${m.icon}</svg><span>${esc(t(m.key))}</span>
    </a>`).join("");
  document.body.classList.add("drawer-open");
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
}
$("#menuBtn").addEventListener("click", () => {
  if (currentRoute().name === "list") lastListScroll = window.scrollY;
  openDrawer();
});
$("#drawerShade").addEventListener("click", closeDrawer);

// Swipe from the left edge to open the menu (and swipe left to close it); the drawer follows the finger.
(function drawerSwipe() {
  const drawer = $("#drawer");
  const shade = $("#drawerShade");
  const EDGE = 28;
  let g = null;
  const width = () => drawer.getBoundingClientRect().width || 280;
  function setPos(px) {
    const w = width();
    const p = Math.max(0, Math.min(1, px / w));
    drawer.style.transition = "none";
    shade.style.transition = "none";
    drawer.style.transform = `translateX(${(p - 1) * 100}%)`;
    shade.style.opacity = String(p);
  }
  function reset() {
    drawer.style.transition = drawer.style.transform = "";
    shade.style.transition = shade.style.opacity = "";
  }
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const tch = e.touches[0];
    const open = document.body.classList.contains("drawer-open");
    if (!$("#sheet").classList.contains("hidden")) return;
    if (!open && (tch.clientX > EDGE || e.target.closest("input[type=range]"))) return;
    g = { x0: tch.clientX, y0: tch.clientY, open, active: false, last: tch.clientX, t: Date.now(), v: 0 };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!g) return;
    const tch = e.touches[0];
    const dx = tch.clientX - g.x0, dy = tch.clientY - g.y0;
    if (!g.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      if (Math.abs(dx) < 10) return;
      if (g.open ? dx > 0 : dx < 0) { g = null; return; }
      g.active = true;
      if (!g.open) openDrawer();
    }
    const now = Date.now();
    g.v = (tch.clientX - g.last) / Math.max(1, now - g.t);
    g.last = tch.clientX; g.t = now;
    setPos(g.open ? width() + dx : dx);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  function end() {
    if (!g) return;
    const was = g; g = null;
    if (!was.active) return;
    const shown = (was.open ? width() + (was.last - was.x0) : was.last - was.x0) / width();
    const keepOpen = was.v > 0.35 ? true : was.v < -0.35 ? false : shown > 0.5;
    reset();
    if (keepOpen) document.body.classList.add("drawer-open"); else closeDrawer();
  }
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();
$("#drawerItems").addEventListener("click", (e) => {
  if (e.target.closest("a")) closeDrawer();
});

// ---------- Views: states ----------
function renderLoading() {
  view.innerHTML = `<div class="state"><div class="spinner"></div>${esc(t("loading"))}</div>`;
}
function renderError(onRetry) {
  view.innerHTML = `<div class="state"><p>${esc(t("loadError"))}</p><button class="btn" id="retryBtn">${esc(t("retry"))}</button></div>`;
  $("#retryBtn").addEventListener("click", onRetry);
}

// ---------- View: list ----------
async function renderList() {
  setHeader('FGO <span class="accent">Codex</span>', false);
  if (!state.list || state.listLang !== settings.data) {
    renderLoading();
    try { await loadList(false); } catch (e) { return renderError(renderList); }
    if (currentRoute().name !== "list") return;
  }

  // classes present in the data, in game order
  const present = new Map();
  for (const s of state.list) {
    const g = classGroup(s.cls);
    if (!present.has(g)) present.set(g, s.cid);
  }
  const classes = CLASS_ORDER.filter((c) => present.has(c))
    .concat([...present.keys()].filter((c) => !CLASS_ORDER.includes(c)));

  view.innerHTML = `
    <input id="q" class="search" type="search" placeholder="${esc(t("search"))}" value="${esc(state.query)}" autocomplete="off">
    <div class="chips" id="classChips">
      <button class="chip ${state.cls === "all" ? "active" : ""}" data-cls="all">${esc(t("allClasses"))}</button>
      ${classes.map((c) => `
        <button class="chip icon-only ${state.cls === c ? "active" : ""}" data-cls="${esc(c)}" title="${esc(className(c))}">
          <img src="${classIcon(present.get(c), 5)}" alt="${esc(className(c))}" loading="lazy" onerror="this.replaceWith(document.createTextNode(this.alt))">
        </button>`).join("")}
    </div>
    <div class="chips" id="rarityChips">
      <button class="chip ${state.rarity === "all" ? "active" : ""}" data-r="all">${esc(t("allRarities"))}</button>
      ${[5, 4, 3, 2, 1, 0].map((r) => `<button class="chip ${String(state.rarity) === String(r) ? "active" : ""}" data-r="${r}">${r}★</button>`).join("")}
    </div>
    <div class="row-ctrl">
      <button class="chip ${moreActive() ? "active" : ""}" id="moreBtn">${moreLabel()}</button>
      <span class="count" id="count"></span>
      <div class="sort-wrap">
        <select id="sort" class="sort">
          ${[["no", "sortNo"], ["rarity", "sortRarity"], ["atk", "sortAtk"], ["hp", "sortHp"], ["name", "sortName"]]
            .map(([v, k]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>${esc(t(k))}</option>`).join("")}
        </select>
        <button class="sort invert ${state.desc ? "on" : ""}" id="invertBtn" title="${esc(t("invert"))}" aria-label="${esc(t("invert"))}">⇅</button>
      </div>
    </div>
    <div class="more ${state.moreOpen ? "" : "hidden"}" id="morePanel">
      <div class="more-label">${esc(t("region"))}</div>
      <div class="chips wrap" data-f="region">
        ${[["all", "all"], ["na", "naAvail"], ["jp", "jpOnly"]].map(([v, k]) =>
          `<button class="chip ${state.region === v ? "active" : ""}" data-v="${v}">${esc(t(k))}</button>`).join("")}
      </div>
      <div class="more-label">${esc(t("npCard"))}</div>
      <div class="chips wrap" data-f="npCard">
        <button class="chip ${state.npCard === "all" ? "active" : ""}" data-v="all">${esc(t("all"))}</button>
        ${["buster", "arts", "quick"].map((v) =>
          `<button class="chip np-${v} ${state.npCard === v ? "active" : ""}" data-v="${v}">${v.charAt(0).toUpperCase() + v.slice(1)}</button>`).join("")}
      </div>
      <div class="more-label">${esc(t("npTarget"))}</div>
      <div class="chips wrap" data-f="npTarget">
        ${[["all", "all"], ["aoe", "aoe"], ["st", "st"], ["support", "support"]].map(([v, k]) =>
          `<button class="chip ${state.npTarget === v ? "active" : ""}" data-v="${v}">${esc(t(k))}</button>`).join("")}
      </div>
      <p class="note ${state.index ? "hidden" : ""}" id="indexNote">${esc(t("indexError"))}</p>
    </div>
    ${state.trait != null ? `
    <div class="trait-filter" id="traitFilter">
      <span>${esc(t("traitFilter"))}:</span><b>${esc(traitDisplay(state.trait))}</b>
      <button class="icon-btn" aria-label="✕">✕</button>
    </div>` : ""}
    <div class="list" id="list"></div>
  `;

  const tf = $("#traitFilter");
  if (tf) tf.querySelector("button").addEventListener("click", () => { state.trait = null; tf.remove(); renderListResults(); });
  $("#q").addEventListener("input", (e) => { state.query = e.target.value; renderListResults(); });
  $("#classChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cls]"); if (!b) return;
    state.cls = b.dataset.cls; saveFilters();
    document.querySelectorAll("#classChips .chip").forEach((c) => c.classList.toggle("active", c === b));
    renderListResults();
  });
  $("#rarityChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]"); if (!b) return;
    state.rarity = b.dataset.r; saveFilters();
    document.querySelectorAll("#rarityChips .chip").forEach((c) => c.classList.toggle("active", c === b));
    renderListResults();
  });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; saveFilters(); renderListResults(); });
  $("#invertBtn").addEventListener("click", (e) => {
    state.desc = !state.desc; saveFilters();
    e.currentTarget.classList.toggle("on", state.desc);
    renderListResults();
  });
  $("#moreBtn").addEventListener("click", () => {
    state.moreOpen = !state.moreOpen;
    $("#morePanel").classList.toggle("hidden", !state.moreOpen);
  });
  $("#morePanel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    const group = b.closest("[data-f]");
    state[group.dataset.f] = b.dataset.v; saveFilters();
    group.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
    const mb = $("#moreBtn");
    mb.classList.toggle("active", moreActive());
    mb.textContent = moreLabel();
    renderListResults();
  });
  $("#list").addEventListener("click", (e) => {
    const a = e.target.closest("[data-id]"); if (!a) return;
    lastListScroll = window.scrollY;
    location.hash = "#/s/" + a.dataset.id;
  });

  renderListResults();
  window.scrollTo(0, lastListScroll);
}

function moreCount() {
  return ["region", "npCard", "npTarget"].filter((k) => state[k] !== "all").length;
}
function moreActive() {
  return moreCount() > 0;
}
function moreLabel() {
  const n = moreCount();
  return "☰ " + t("moreFilters") + (n ? ` (${n})` : "");
}

function filteredList() {
  const q = norm(state.query.trim());
  let arr = state.list.filter((s) => {
    if (state.cls !== "all" && classGroup(s.cls) !== state.cls) return false;
    if (state.rarity !== "all" && String(s.r) !== String(state.rarity)) return false;
    if (q && !norm(s.name).includes(q) && !norm(s.orig).includes(q) && String(s.no) !== q) return false;
    if (state.trait != null && !(s.tr || []).includes(Number(state.trait))) return false;
    if (state.index) {
      if (state.region === "na" && !state.index.na.has(s.id)) return false;
      if (state.region === "jp" && state.index.na.has(s.id)) return false;
      const np = state.index.np[String(s.id)];
      if (state.npCard !== "all" && (!np || np[0] !== state.npCard)) return false;
      if (state.npTarget !== "all" && (!np || np[1] !== state.npTarget)) return false;
    }
    return true;
  });
  const by = {
    no: (a, b) => a.no - b.no,
    rarity: (a, b) => b.r - a.r || a.no - b.no,
    atk: (a, b) => b.atk - a.atk,
    hp: (a, b) => b.hp - a.hp,
    name: (a, b) => a.name.localeCompare(b.name, settings.data === "ja" ? "ja" : "en"),
  }[state.sort] || ((a, b) => a.no - b.no);
  arr.sort(by);
  return state.desc ? arr.reverse() : arr;
}

function renderListResults() {
  const listEl = $("#list"); if (!listEl) return;
  const arr = filteredList();
  $("#count").textContent = t("results", { n: arr.length });
  const note = $("#indexNote");
  if (note) note.classList.toggle("hidden", !!state.index);
  if (!arr.length) {
    listEl.innerHTML = `<div class="state">${esc(t("noResults"))}</div>`;
    return;
  }
  listEl.innerHTML = arr.map((s) => `
    <a class="svt" data-id="${s.id}">
      <img class="face" src="${esc(s.face)}" alt="" loading="lazy" onerror="imgErr(this)">
      <div class="svt-main">
        <div class="svt-name">${esc(s.name)}</div>
        <div class="svt-meta">
          <img src="${classIcon(s.cid, s.r)}" alt="" loading="lazy" onerror="imgErr(this)">
          <span>${esc(className(s.cls))}</span>
          <span class="stars">${stars(s.r)}</span>
        </div>
      </div>
      <span class="no">#${s.no}</span>
    </a>`).join("");
}

// ---------- View: detail ----------
async function renderDetail(id) {
  setHeader("", true);
  const brief = state.list && state.list.find((s) => String(s.id) === String(id));
  if (brief) $("#title").textContent = brief.name;
  renderLoading();
  window.scrollTo(0, 0);
  let svt;
  try {
    [svt] = await Promise.all([loadServant(id), loadTranslations()]);
  } catch (e) { return renderError(() => renderDetail(id)); }
  const r = currentRoute();
  if (r.name !== "detail" || r.id !== String(id)) return;
  $("#title").textContent = svt.name;

  const art = artworks(svt);
  const tab = Math.min(state.ascTab[id] || 0, Math.max(art.length - 1, 0));
  const face = firstOf(svt.extraAssets && svt.extraAssets.faces && svt.extraAssets.faces.ascension);
  const region = svt._partial || settings.data === "ja" ? "JP" : "NA";

  view.innerHTML = `
    <div class="dhero">
      ${art.length ? `<img id="heroImg" class="dhero-img" src="${esc(art[tab].url)}" alt="" onerror="imgErr(this)">` : ""}
      <div class="dhero-shade"></div>
      <div class="dhero-bottom">
        <div class="dhero-title">
          <div>
            <div class="dhero-no">Nº ${svt.collectionNo}</div>
            <h2 class="dhero-name">${esc(svt.name)}</h2>
            <div class="dhero-tags">
              <span class="htag"><img src="${classIcon(svt.classId, svt.rarity)}" alt="" onerror="imgErr(this)">${esc(className(svt.className))}</span>
              <span class="htag stars-tag">${stars(svt.rarity)}</span>
            </div>
          </div>
          <div class="hero-acts" id="heroActs">${svtActionsHtml(svt)}${art.length ? `<button class="dhero-zoom" id="zoomBtn" aria-label="Zoom"><svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg></button>` : ""}</div>
        </div>
        ${art.length > 1 ? artSelector(art, tab) : ""}
      </div>
    </div>
    ${svt._partial && t("notInNA") ? `<div class="notice">${esc(t("notInNA"))}</div>` : ""}

    <div class="section" id="go-profile">
      <h2>${esc(t("profile"))}</h2>
      ${profileCard(svt)}
    </div>

    <div class="section">
      <h2>${esc(t("stats"))}</h2>
      ${statsCard(svt)}
    </div>

    <div id="go-cards">${cardsSection(svt)}</div>

    <div id="go-skills">${levelSection("skills", t("skills"), versionsPerNum(svt.skills), svt.skillMaterials)}</div>
    <div id="go-np">${levelSection("np", t("np"), npList(svt), null)}</div>
    <div id="go-append">${levelSection("append", t("appendSkills"), appendList(svt), svt.appendSkillMaterials)}</div>
    ${passiveSection(svt)}
    <div id="go-mats">${matsSection(t("ascension"), svt.ascensionMaterials, (k) => `${t("stage")} ${Number(k) + 1}`)}
    ${totalsSection(svt)}</div>
    <div id="go-traits">${traitsSection(svt)}</div>

    <a class="link-btn" href="https://apps.atlasacademy.io/db/${region}/servant/${svt.collectionNo}">${esc(t("openAtlas"))} ↗</a>
    <p class="footer-note">${esc(t("source"))}</p>
  `;

  bindLevelSection("skills", versionsPerNum(svt.skills), svt.skillMaterials);
  bindLevelSection("np", npList(svt), null);
  bindLevelSection("append", appendList(svt), svt.appendSkillMaterials);
  state.curSvt = svt;
  fillUnlocks(svt);
  setBarActions(svt);
  mountGoTo();

  const seg = $("#statSeg");
  if (seg) seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lv]"); if (!b) return;
    state.statLv = b.dataset.lv;
    seg.querySelectorAll("[data-lv]").forEach((c) => c.classList.toggle("on", c === b));
    $("#statBody").innerHTML = statsBody(svt, b.dataset.lv);
  });
  const tabs = $("#artTabs");
  if (tabs) tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]"); if (!b) return;
    const i = Number(b.dataset.i);
    state.ascTab[id] = i;
    const img = $("#heroImg");
    img.style.visibility = "";
    img.src = art[i].url;
    tabs.querySelectorAll("[data-i]").forEach((c) => c.classList.toggle("on", c === b));
  });
  const openViewer = () => showViewer(svt.name, art, state.ascTab[id] || 0, (i) => {
    // keep the detail page in sync with the image chosen in the viewer
    state.ascTab[id] = i;
    const img = $("#heroImg"); if (img) img.src = art[i].url;
    if (tabs) tabs.querySelectorAll("[data-i]").forEach((c) => c.classList.toggle("on", Number(c.dataset.i) === i));
  });
  const zb = $("#zoomBtn");
  if (zb) zb.addEventListener("click", openViewer);
  const hi = $("#heroImg");
  if (hi) hi.addEventListener("click", openViewer);
}


// ---------- Rank Up / Interlude that unlocks an upgraded skill or NP ----------
const QINFO_KEY = "qinfo_v1";
const qinfoMem = store.get(QINFO_KEY, {});
const NA_LAG = 2 * 365 * 86400; // NA runs roughly two years behind JP
async function questInfo(id) {
  const key = String(id);
  const c = qinfoMem[key];
  if (c && Date.now() - c.ts < (c.na ? 30 : 3) * 86400000) return c;
  let jp = null, en = null, na = null;
  try { jp = await getJSON(`${API}/nice/JP/quest/${id}`); } catch (e) { /* unknown quest */ }
  try { en = await getJSON(`${API}/nice/JP/quest/${id}?lang=en`); } catch (e) { /* ignore */ }
  try { na = await getJSON(`${API}/nice/NA/quest/${id}`); } catch (e) { na = null; }
  if (!jp && !na) return null;
  const jname = (jp && jp.name) || "";
  const info = {
    ts: Date.now(),
    rankUp: /強化クエスト/.test(jname) || /rank ?up/i.test((na && na.name) || (en && en.name) || ""),
    jname, ename: (en && en.name) || jname, naname: na ? na.name : "",
    na: !!na, opened: (jp && jp.openedAt) || 0,
  };
  qinfoMem[key] = info;
  store.set(QINFO_KEY, qinfoMem);
  return info;
}
function cleanQuestName(n) {
  return String(n || "").replace(/\s*\n\s*/g, " ").replace(/^(強化クエスト|Rank Up Quest|幕間の物語)\s*[:：]?\s*/i, "")
    .trim().replace(/^[(（](.*)[)）]$/, "$1").trim();
}
async function fillUnlocks(svt) {
  const els = [...document.querySelectorAll(".unlock[data-q]")];
  if (!els.length) return;
  // number the rank ups of this servant (1, 2, …) in release order
  const ids = new Set();
  for (const sk of svt.skills || []) if (sk.condQuestId > 0) ids.add(sk.condQuestId);
  for (const np of svt.noblePhantasms || []) if (np.condQuestId > 0) ids.add(np.condQuestId);
  const infos = {};
  await Promise.all([...ids].map(async (q) => { infos[q] = await questInfo(q); }));
  if (state.curSvt !== svt) return;
  const ranks = [...ids].filter((q) => infos[q] && infos[q].rankUp)
    .sort((a, b) => (infos[a].opened - infos[b].opened) || a - b);
  const loc = settings.ui === "ja" ? "ja-JP" : settings.ui === "es" ? "es-PE" : "en-US";
  document.querySelectorAll(".unlock[data-q]").forEach((el) => {
    const q = Number(el.dataset.q);
    const info = infos[q];
    if (!info) return;
    const name = cleanQuestName(settings.data === "ja" ? info.jname : (info.naname || info.ename));
    const kind = info.rankUp ? `${t("rankUp")} ${ranks.indexOf(q) + 1}` : t("interlude");
    let status;
    if (info.na) status = `<span class="ul-na ok">● ${esc(t("inNA"))}</span>`;
    else {
      const eta = info.opened ? info.opened + NA_LAG : 0;
      const etaTxt = eta > Date.now() / 1000
        ? new Intl.DateTimeFormat(loc, { month: "numeric", year: "numeric" }).format(new Date(eta * 1000))
        : t("etaSoon");
      status = `<span class="ul-na no">● ${esc(t("jpOnlyQ"))}${eta ? ` · ${esc(t("etaNA", { d: etaTxt }))}` : ""}</span>`;
    }
    el.innerHTML = `🔓 <b>${esc(kind)}</b>${name ? `: ${esc(name)}` : ""}<br>${status}`;
  });
}

// ---------- "Go to" side tab on the servant page ----------
const GOTO = [
  ["top", "goTop", "⬆"], ["go-profile", "goProfile", "📋"], ["go-cards", "cards", "🃏"],
  ["go-skills", "skills", "✦"], ["go-np", "np", "⚔"], ["go-append", "appendSkills", "➕"],
  ["go-mats", "goMats", "💎"], ["go-traits", "traits", "🏷"],
];
function unmountGoTo() {
  const el = $("#goto"); if (el) el.remove();
  document.body.classList.remove("goto-open");
}
function mountGoTo() {
  unmountGoTo();
  const el = document.createElement("div");
  el.id = "goto";
  const items = GOTO.filter(([id]) => id === "top" || (document.getElementById(id) && document.getElementById(id).children.length));
  el.innerHTML = `
    <div class="goto-shade"></div>
    <div class="goto-panel">
      <div class="goto-h">${esc(t("goTo"))}</div>
      ${items.map(([id, key, ic]) => `<button class="goto-it" data-go="${id}"><i>${ic}</i>${esc(t(key))}</button>`).join("")}
    </div>
    <button class="goto-tab" aria-label="${esc(t("goTo"))}"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>`;
  document.body.appendChild(el);
  const tab = el.querySelector(".goto-tab");
  const place = () => {
    const f = store.get("gotoY", 0.75);
    const y = Math.max(70, Math.min(window.innerHeight - 90, f * window.innerHeight));
    tab.style.top = y + "px";
    el.querySelector(".goto-panel").style.setProperty("--y", y + "px");
  };
  place();
  const open = (on) => {
    const now = on == null ? !document.body.classList.contains("goto-open") : on;
    if (now) {
      // highlight the section on screen
      let cur = "top";
      for (const [id] of items) {
        const n = document.getElementById(id);
        if (n && n.getBoundingClientRect().top < window.innerHeight * 0.4) cur = id;
      }
      el.querySelectorAll(".goto-it").forEach((b) => b.classList.toggle("cur", b.dataset.go === cur));
    }
    document.body.classList.toggle("goto-open", now);
  };
  el.querySelector(".goto-shade").addEventListener("click", () => open(false));
  el.querySelector(".goto-panel").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-go]"); if (!b) return;
    open(false);
    if (b.dataset.go === "top") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    const n = document.getElementById(b.dataset.go);
    if (n) window.scrollTo({ top: n.getBoundingClientRect().top + window.scrollY - 64, behavior: "smooth" });
  });
  // tab: tap = toggle, drag up/down = move it, drag left = open
  let g = null;
  tab.addEventListener("touchstart", (ev) => {
    const tch = ev.touches[0];
    g = { x: tch.clientX, y: tch.clientY, top: parseFloat(tab.style.top), mode: null };
  }, { passive: true });
  tab.addEventListener("touchmove", (ev) => {
    if (!g) return;
    const tch = ev.touches[0];
    const dx = tch.clientX - g.x, dy = tch.clientY - g.y;
    if (!g.mode && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) g.mode = Math.abs(dy) > Math.abs(dx) ? "move" : "swipe";
    if (g.mode === "move") {
      if (ev.cancelable) ev.preventDefault();
      const y = Math.max(70, Math.min(window.innerHeight - 90, g.top + dy));
      tab.style.top = y + "px";
      el.querySelector(".goto-panel").style.setProperty("--y", y + "px");
    } else if (g.mode === "swipe" && ev.cancelable) ev.preventDefault();
  }, { passive: false });
  tab.addEventListener("touchend", (ev) => {
    if (!g) return;
    const was = g; g = null;
    const tch = ev.changedTouches[0];
    if (was.mode === "move") { store.set("gotoY", parseFloat(tab.style.top) / window.innerHeight); return; }
    if (was.mode === "swipe") { open(tch.clientX - was.x < 0); return; }
    ev.preventDefault();
    open();
  });
  tab.addEventListener("click", () => open());
}
// Swipe from the right edge (servant page) opens the "Go to" panel
(function gotoEdgeSwipe() {
  let s = null;
  document.addEventListener("touchstart", (ev) => {
    if (!$("#goto") || ev.touches.length !== 1 || document.body.classList.contains("goto-open")) return;
    if (!$("#sheet").classList.contains("hidden") || document.body.classList.contains("drawer-open")) return;
    const tch = ev.touches[0];
    if (tch.clientX < window.innerWidth - 24 || ev.target.closest(".goto-tab, input[type=range]")) return;
    s = { x: tch.clientX, y: tch.clientY };
  }, { passive: true });
  document.addEventListener("touchmove", (ev) => {
    if (!s) return;
    const tch = ev.touches[0];
    const dx = tch.clientX - s.x, dy = tch.clientY - s.y;
    if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
    if (dx < -40) {
      s = null;
      const tab = document.querySelector("#goto .goto-tab");
      if (tab) tab.click();
    }
  }, { passive: true });
  document.addEventListener("touchend", () => { s = null; });
})();

// ---------- Detail: hero, profile, stats, cards ----------
function artSelector(art, tab) {
  const asc = art.filter((a) => a.kind === "asc");
  const extra = art.filter((a) => a.kind !== "asc");
  const btn = (a) => {
    const i = art.indexOf(a);
    return `<button class="asel ${i === tab ? "on" : ""}" data-i="${i}">${esc(a.short)}</button>`;
  };
  return `<div class="artsel" id="artTabs">
    <div class="asel-row" style="grid-template-columns:repeat(${Math.max(asc.length, 1)},1fr)">${asc.map(btn).join("")}</div>
    ${extra.length ? `<div class="asel-row" style="grid-template-columns:repeat(${Math.min(extra.length, 3)},1fr)">${extra.map(btn).join("")}</div>` : ""}
  </div>`;
}

function ring(value, fraction, color, label) {
  const p = Math.max(0, Math.min(1, fraction)) * 100;
  return `<div class="ring-cell">
    <div class="ring" style="background:conic-gradient(${color} 0 ${p}%, var(--surface-2) 0)"><span>${value}</span></div>
    <small>${esc(label)}</small></div>`;
}
function bar(fraction, grad) {
  const p = Math.max(0, Math.min(1, fraction)) * 100;
  return `<span class="mbar"><i style="width:${p}%;background:${grad}"></i></span>`;
}
function currentNp(svt) {
  const nps = svt.noblePhantasms || [];
  return nps.length ? nps[nps.length - 1] : null;
}
const ALIGN_ORDER = ["Lawful", "Neutral", "Chaotic", "Good", "Balanced", "Evil", "Madness", "Summer", "Bride"];
function alignment(svt) {
  const lim = Array.isArray(svt.limits) && svt.limits.length ? svt.limits[svt.limits.length - 1] : null;
  const st = (svt.profile && svt.profile.stats) || lim;
  if (st && (st.policy || st.personality)) {
    const cap = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : "";
    const words = [st.policy, st.personality]
      .filter((w) => w && !["none", "unknown"].includes(w))
      .map((w) => (t("align")[cap(w)]) || cap(w));
    if (words.length) return words.join(" · ");
  }
  const have = new Set((svt.traits || []).map((x) => x && x.name).filter(Boolean));
  const words = ALIGN_ORDER.filter((k) => have.has("alignment" + k)).map((k) => (t("align")[k]) || k);
  return words.length ? words.join(" · ") : "–";
}
function regionLabel(svt) {
  if (state.index) return state.index.na.has(svt.id) ? "NA · JP" : "JP";
  return svt._partial ? "JP" : "NA · JP";
}
function pct2(v) {
  return v == null ? "–" : num(v / 100, 2) + "%";
}
// ---------- Servant page actions: add to plan, banner alerts ----------
const ICON_PLAN = '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 16V9M12 16V5M17 16v-4"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
function watchState(id) {
  const app = nativeApp();
  if (!app || !app.getWatch) return null;
  const [na, jp] = String(app.getWatch(id) || "0,0").split(",").map((x) => x === "1");
  return { na, jp };
}
function svtActionsHtml(svt) {
  const pos = loadPlan().findIndex((e) => e.id === svt.id);
  const w = watchState(svt.id);
  const wl = w ? [w.na ? "NA" : "", w.jp ? "JP" : ""].filter(Boolean).join("·") : "";
  return `<button class="act-btn ${pos >= 0 ? "on" : ""}" data-act="plan" aria-label="${esc(t("plan"))}">${ICON_PLAN}${pos >= 0 ? `<span class="act-dot">#${pos + 1}</span>` : ""}</button>
    ${w ? `<button class="act-btn ${wl ? "on" : ""}" data-act="watch" aria-label="${esc(t("watchHead"))}">${ICON_BELL}${wl ? `<span class="act-dot">${wl}</span>` : ""}</button>` : ""}`;
}
function setBarActions(svt) {
  const bar = $("#barActs");
  if (bar) bar.innerHTML = svt ? svtActionsHtml(svt) : "";
  const hero = $("#heroActs");
  if (hero && svt) {
    const zoom = $("#zoomBtn");
    hero.innerHTML = svtActionsHtml(svt);
    if (zoom) hero.appendChild(zoom);
  }
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b || !b.closest("#heroActs, #barActs")) return;
  const svt = state.curSvt;
  if (!svt || currentRoute().name !== "detail") return;
  if (b.dataset.act === "watch") openWatchSheet(svt);
  else addToPlanAndShow(svt);
});
function openWatchSheet(svt) {
  const w = watchState(svt.id) || { na: false, jp: false };
  const face = (state.list && (state.list.find((x) => x.id === svt.id) || {}).face) ||
    firstOf(svt.extraAssets && svt.extraAssets.faces && svt.extraAssets.faces.ascension) || "";
  const row = (k, label, sub) => `
    <button class="w-opt" data-w="${k}">
      <span class="w-fl">${k.toUpperCase()}</span>
      <span class="w-t"><b>${esc(label)}</b><small>${esc(sub)}</small></span>
      <span class="sw ${w[k] ? "on" : ""}"></span>
    </button>`;
  openSheet(`
    <div class="w-head"><img src="${esc(face)}" alt="" onerror="imgErr(this)"><div><b>${esc(svt.name)}</b><small>🔔 ${esc(t("watchTitle"))}</small></div>
      <button class="icon-btn" data-close="1" aria-label="Close">✕</button></div>
    <p class="w-txt">${t("watchExplain")}</p>
    ${row("na", t("serverNA"), t("tzPacific"))}
    ${row("jp", t("serverJP"), t("tzJapan"))}
    <p class="note" style="text-align:center">${esc(t("watchChange"))}</p>`, (ev) => {
    const o = ev.target.closest("[data-w]"); if (!o) return;
    w[o.dataset.w] = !w[o.dataset.w];
    o.querySelector(".sw").classList.toggle("on", w[o.dataset.w]);
    const r = nativeApp().setWatch(svt.id, svt.name, w.na, w.jp);
    toast(t(!w.na && !w.jp ? "watchOff" : r === "perm" ? "remPerm" : "watchOn"));
    setBarActions(svt);
  });
}
function addToPlanAndShow(svt) {
  const plan = loadPlan();
  let pos = plan.findIndex((e) => e.id === svt.id);
  let added = false;
  if (pos < 0) {
    const brief = (state.list && state.list.find((x) => x.id === svt.id)) || {
      id: svt.id, no: svt.collectionNo, name: svt.name, face: firstOf(svt.extraAssets.faces.ascension),
      cls: svt.className, cid: svt.classId, r: svt.rarity,
    };
    plan.push(newPlanEntry(brief));
    savePlan(plan);
    pos = plan.length - 1;
    added = true;
    toast(t("planAdded", { n: pos + 1 }));
  }
  setBarActions(svt);
  openPlanSheet(added ? svt.id : null);
}
function profileCard(svt) {
  const np = currentNp(svt);
  const g = np && np.npGain;
  const atk = g && g.np && g.np.length ? g.np[0] : null;
  const def = g && g.defence && g.defence.length ? g.defence[0] : null;
  const gender = (t("genders")[svt.gender]) || svt.gender || "–";
  return `<div class="card pcard">
    <div class="p-rings">
      ${ring(pct(svt.starGen), (svt.starGen || 0) / 300, "#fde047", t("starGenShort"))}
      ${ring(fmt(svt.starAbsorb), (svt.starAbsorb || 0) / 200, "#67e8f9", t("absorbShort"))}
      ${ring(pct(svt.instantDeathChance), (svt.instantDeathChance || 0) / 500, "#f472b6", t("deathShort"))}
    </div>
    ${g ? `<div class="p-np">
      <div><small>${esc(t("npGainHit"))}</small><b>${pct2(atk)}</b>${bar((atk || 0) / 100, "linear-gradient(90deg,#60a5fa,#a78bfa)")}</div>
      <div><small>${esc(t("npGainDef"))}</small><b>${pct2(def)}</b>${bar((def || 0) / 500, "linear-gradient(90deg,#34d399,#67e8f9)")}</div>
    </div>` : ""}
    <div class="p-kv">
      <div><small>${esc(t("attribute"))}</small><b>${esc(attrName(svt.attribute))}</b></div>
      <div><small>${esc(t("gender"))}</small><b>${esc(gender)}</b></div>
      <div><small>${esc(t("alignment"))}</small><b>${esc(alignment(svt))}</b></div>
    </div>
    <div class="p-foot">
      <span>${esc(t("cost"))} <b>${fmt(svt.cost)}</b></span>
      <span>${esc(t("maxLvShort"))} <b>${fmt(svt.lvMax)}</b></span>
      <span>${esc(t("regionShort"))} <b>${regionLabel(svt)}</b></span>
    </div>
  </div>`;
}
function statLevels(svt) {
  const out = [{ key: "base", label: t("base"), atk: svt.atkBase, hp: svt.hpBase }];
  out.push({ key: "max", label: `Lv${svt.lvMax}`, atk: svt.atkMax, hp: svt.hpMax });
  if (grail(svt, 120)) out.push({ key: "120", label: "Lv120", atk: svt.atkGrowth[119], hp: svt.hpGrowth[119] });
  return out;
}
function statsBody(svt, key) {
  const lv = statLevels(svt).find((x) => x.key === key) || statLevels(svt)[1];
  return `
    <div class="srow"><span>ATK</span>${bar(lv.atk / 16500, "linear-gradient(90deg,#ff8a5b,#ffb36b)")}<em>${fmt(lv.atk)}</em></div>
    <div class="srow"><span>HP</span>${bar(lv.hp / 19000, "linear-gradient(90deg,#4fd1a5,#7be3c0)")}<em>${fmt(lv.hp)}</em></div>`;
}
function statsCard(svt) {
  const lvls = statLevels(svt);
  const cur = state.statLv && lvls.some((x) => x.key === state.statLv) ? state.statLv : "max";
  return `<div class="card scard">
    <div class="stat-seg" id="statSeg" style="grid-template-columns:repeat(${lvls.length},1fr)">
      ${lvls.map((x) => `<button class="asel ${x.key === cur ? "on" : ""}" data-lv="${x.key}">${esc(x.label)}</button>`).join("")}
    </div>
    <div id="statBody">${statsBody(svt, cur)}</div>
  </div>`;
}
function cardImg(type) {
  if (type === "extra") return `<img class="cl-ic ex" src="cards/card_txt_extra.png" alt="">`;
  return `<img class="cl-ic" src="cards/card_icon_${type}.png" alt="">`;
}
function cardsSection(svt) {
  if (!svt.cards || !svt.cards.length) return "";
  const det = svt.cardDetails || {};
  // the API keys card details either by name or by number (1 arts, 2 buster, 3 quick, 4 extra)
  const CARD_NUM = { arts: "1", buster: "2", quick: "3", extra: "4" };
  const hits = (k) => {
    const d = det[k] || det[CARD_NUM[k]];
    return d && d.hitsDistribution ? d.hitsDistribution.length : null;
  };
  const np = currentNp(svt);
  const npType = np ? CARD_TYPES[String(np.card)] : null;
  const npHits = np && np.npDistribution && np.npDistribution.length &&
    (np.functions || []).some((f) => /^damageNp/.test(f.funcType || "")) ? np.npDistribution.length : null;
  const n = svt.cards.length;
  const fan = svt.cards.map((c, i) => {
    const rot = (i - (n - 1) / 2) * 6;
    return `<div class="fan-card" style="left:${i * 21}px;transform:rotate(${rot}deg);z-index:${i}">${cardFace(c)}</div>`;
  }).join("");
  const rows = ["quick", "arts", "buster", "extra"].filter((k) => hits(k) != null).map((k) =>
    `<div class="cl-row">${cardImg(k)}<span>${esc(t("card_" + k))}</span><b>${hits(k)}</b></div>`).join("");
  return `
    <div class="section">
      <h2>${esc(t("cards"))}</h2>
      <div class="card cards-c">
        <div class="fan" style="width:${(n - 1) * 21 + 58}px">${fan}</div>
        <div class="cl">
          <div class="cl-head"><span>${esc(t("cardCol"))}</span><span>${esc(t("hitsCol"))}</span></div>
          ${rows}
          ${npType ? `<div class="cl-row cl-np"><img class="cl-ic" src="cards/card_icon_${npType}.png" alt=""><span><i class="np-tag">NP</i> ${esc(t("card_" + npType))}</span><b>${npHits != null ? npHits : "–"}</b></div>` : ""}
        </div>
      </div>
    </div>`;
}

// ---------- Full-screen image viewer ----------
function showViewer(name, art, start, onChange) {
  let i = start;
  const el = document.createElement("div");
  el.className = "viewer";
  el.innerHTML = `
    <div class="v-bg"></div>
    <div class="v-stage"><img class="v-img" alt=""></div>
    <div class="v-top">
      <button class="v-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="v-t"><b>${esc(name)}</b><small></small></div>
    </div>
    <div class="v-bottom">
      ${art.length > 1 ? `<div class="v-dots">${art.map(() => "<i></i>").join("")}</div>` : ""}
      <button class="v-dl"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>${esc(t("download"))}</button>
      <div class="v-hint">${esc(art.length > 1 ? t("viewerHint") : t("viewerHintZoom"))}</div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add("viewer-open");
  const img = el.querySelector(".v-img");
  const bg = el.querySelector(".v-bg");
  let z = { s: 1, x: 0, y: 0 };
  const apply = (anim) => {
    img.style.transition = anim ? "transform .2s" : "none";
    img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  };
  const show = (n) => {
    i = (n + art.length) % art.length;
    z = { s: 1, x: 0, y: 0 }; apply(false);
    img.src = art[i].url;
    bg.style.backgroundImage = `url("${art[i].url}")`;
    el.querySelector(".v-t small").textContent = `${art[i].label}${art.length > 1 ? ` · ${i + 1} / ${art.length}` : ""}`;
    el.querySelectorAll(".v-dots i").forEach((d, k) => d.classList.toggle("on", k === i));
    if (onChange) onChange(i);
  };
  show(i);

  let closed = false;
  const close = (fromPop) => {
    if (closed) return; closed = true;
    window.removeEventListener("popstate", onPop);
    el.classList.add("out");
    document.body.classList.remove("viewer-open");
    setTimeout(() => el.remove(), 180);
    if (!fromPop) history.back();
  };
  const onPop = () => close(true);
  history.pushState({ viewer: 1 }, "");
  window.addEventListener("popstate", onPop);
  el.querySelector(".v-close").addEventListener("click", () => close(false));

  el.querySelector(".v-dl").addEventListener("click", () => {
    const a = art[i];
    const file = `${name} - ${a.label}.png`;
    const app = nativeApp();
    if (app && app.saveImage) {
      const r = app.saveImage(a.url, file);
      toast(t(r === "ok" ? "downloading" : r === "perm" ? "permRetry" : "downloadError"));
    } else {
      window.open(a.url, "_blank");
    }
  });

  // gestures: swipe to change image, pinch / double tap to zoom, drag to pan when zoomed
  const stage = el.querySelector(".v-stage");
  let g = null, lastTap = 0;
  const dist = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      g = { mode: "pinch", d0: dist(e.touches[0], e.touches[1]), s0: z.s, x0: z.x, y0: z.y };
    } else if (e.touches.length === 1) {
      const tt = e.touches[0];
      g = { mode: z.s > 1 ? "pan" : "swipe", sx: tt.clientX, sy: tt.clientY, x0: z.x, y0: z.y, dx: 0 };
    }
  }, { passive: true });
  stage.addEventListener("touchmove", (e) => {
    if (!g) return;
    if (g.mode === "pinch" && e.touches.length === 2) {
      z.s = Math.max(1, Math.min(4, g.s0 * dist(e.touches[0], e.touches[1]) / g.d0));
      if (z.s === 1) { z.x = 0; z.y = 0; }
      apply(false);
    } else if (e.touches.length === 1) {
      const tt = e.touches[0];
      if (g.mode === "pan") { z.x = g.x0 + tt.clientX - g.sx; z.y = g.y0 + tt.clientY - g.sy; apply(false); }
      else if (g.mode === "swipe") { g.dx = tt.clientX - g.sx; img.style.transition = "none"; img.style.transform = `translateX(${g.dx}px)`; }
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  stage.addEventListener("touchend", (e) => {
    if (!g || e.touches.length) return;
    const was = g; g = null;
    if (was.mode === "swipe") {
      if (art.length > 1 && Math.abs(was.dx) > 60) show(i + (was.dx < 0 ? 1 : -1));
      else {
        apply(true);
        const now = Date.now();
        if (Math.abs(was.dx) < 8 && now - lastTap < 300) { z = { s: 2.5, x: 0, y: 0 }; apply(true); lastTap = 0; return; }
        lastTap = now;
      }
    } else if (was.mode === "pan") {
      const now = Date.now();
      if (now - lastTap < 300) { z = { s: 1, x: 0, y: 0 }; apply(true); lastTap = 0; return; }
      lastTap = now;
    }
  });
}

const ICONS = {
  class: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
  attribute: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/>',
  male: '<circle cx="10" cy="14" r="5.5"/><path d="M14 10l6-6M15 4h5v5"/>',
  female: '<circle cx="12" cy="9" r="5.5"/><path d="M12 14.5V21M9 18h6"/>',
  unknown: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
  cost: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4M10 4v8a2 2 0 0 0 4 0V4"/>',
  skull: '<path d="M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4 3 5v3h8v-3c1.8-1 3-2.6 3-5a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10.5" r="1.3"/><circle cx="14.5" cy="10.5" r="1.3"/><path d="M10.5 18v2M13.5 18v2"/>',
  level: '<path d="M6 13l6-6 6 6M6 19l6-6 6 6"/>',
};
window.icon = icon;
function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
function kvRow(ic, label, valueHtml) {
  return `<div class="kv-row"><span class="kv-ic">${ic.charAt(0) === "<" ? ic : icon(ic)}</span><div class="kv-txt"><div class="k">${esc(label)}</div><div class="v">${valueHtml}</div></div></div>`;
}

// ---------- Traits ----------
const TRAIT_HIDE = /^(unknown|canBeInBattle|hasCostume|class[A-Z].*|attribute[A-Z].*|.*StarServant|normalSvt|.*\d{3,}.*)$/;
const TRAIT_NAMES = {
  genderMale: "Male", genderFemale: "Female", genderUnknown: "Unknown Gender",
  hominidaeServant: "Hominidae", knightsOfTheRound: "Knights of the Round Table",
  fsnServant: "FSN Servant", FSNServant: "FSN Servant", saberface: "Saberface",
  weakToEnumaElish: "Weak to Enuma Elish", genderCaenisServant: "Caenis",
  attributeSky: "Heaven or Earth", attributeEarth: "Heaven or Earth",
};
const TRAIT_ES = {
  genderMale: "Masculino", genderFemale: "Femenino", genderUnknown: "Género desconocido",
  alignmentLawful: "Legal", alignmentNeutral: "Neutral", alignmentChaotic: "Caótico",
  alignmentGood: "Bueno", alignmentBalanced: "Equilibrado", alignmentEvil: "Malvado",
  alignmentMadness: "Locura", alignmentSummer: "Verano", alignmentBeast: "Bestia",
  servant: "Servant", human: "Humano", humanoid: "Humanoide", livingHuman: "Humano vivo",
  divine: "Divino", divineSpirit: "Espíritu divino", undead: "No muerto", demonic: "Demoníaco",
  demonicBeastServant: "Bestia demoníaca", wildbeast: "Bestia salvaje", fae: "Hada", oni: "Oni",
  giant: "Gigante", superGiant: "Supergigante", mechanical: "Mecánico", hominidaeServant: "Homínido",
  childServant: "Servant infantil", havingAnimalsCharacteristics: "Con rasgos animales",
  threatToHumanity: "Amenaza para la humanidad",
  dragon: "Dragón", dragonSlayer: "Matadragones", saberface: "Saberface", weakToEnumaElish: "Débil a Enuma Elish",
  riding: "Montura", levitating: "Levitante", canFlyInSpace: "Vuela en el espacio",
  existenceOutsideTheDomain: "Existencia fuera del dominio", holdingHolyGrail: "Porta el Santo Grial",
  roman: "Romano", king: "Rey", arthur: "Arturo", knightsOfTheRound: "Caballeros de la Mesa Redonda",
  greekMythologyMales: "Hombres de la mitología griega", associatedToTheArgo: "Relacionado con el Argo",
  brynhildsBeloved: "Amado de Brynhild", genji: "Genji", nobunaga: "Nobunaga",
  shinsengumiServant: "Shinsengumi", valkyrie: "Valquiria", fairyTaleServant: "Servant de cuento",
  FSNServant: "Servant de Fate/stay night", fsnServant: "Servant de Fate/stay night", illya: "Illya",
  sakuraSeries: "Serie Sakura", ryozanpaku: "Ryozanpaku", bunnyServant: "Servant conejita",
  summerModeServant: "Modo verano", groupServant: "Servant grupal",
  feminineLookingServant: "De apariencia femenina", blessedByKur: "Bendecido por Kur",
  attributeSky: "Cielo", attributeEarth: "Tierra", attributeHuman: "Humano", attributeStar: "Estrella", attributeBeast: "Bestia",
};
function traitLabel(name) {
  if (settings.ui === "es" && TRAIT_ES[name]) return TRAIT_ES[name];
  if (TRAIT_NAMES[name]) return TRAIT_NAMES[name];
  const words = name
    .replace(/^(alignment|gender)/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ");
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (i > 0 && ["to", "of", "the", "or", "and", "in", "a"].includes(lw)) return lw;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
function traitsSection(svt) {
  const seen = new Set();
  const out = [];
  for (const tr of svt.traits || []) {
    const n = tr && tr.name;
    if (!n || TRAIT_HIDE.test(n)) continue;
    const label = traitLabel(n);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ id: tr.id, label });
  }
  if (!out.length) return "";
  return `
    <div class="section">
      <h2>${esc(t("traits"))}</h2>
      <div class="card traits">${out.map((x) => `<button class="trait" data-trait="${x.id}">${esc(x.label)}</button>`).join("")}</div>
    </div>`;
}
function traitDisplay(id) {
  const name = (state.traitNames && state.traitNames[id]) || (state.traitSeen && state.traitSeen[id]);
  return name ? traitLabel(name) : `#${id}`;
}
// Tap any trait (list in the servant page, or [Trait] in a description) -> servant list filtered by it
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-trait]");
  if (!el) return;
  ev.preventDefault();
  state.trait = Number(el.dataset.trait);
  state.query = "";
  lastListScroll = 0;
  closeSheet();
  if (currentRoute().name === "list") renderList(); else location.hash = "#/";
});

function firstOf(obj) {
  if (!obj) return null;
  const k = Object.keys(obj).sort((a, b) => Number(a) - Number(b))[0];
  return k != null ? obj[k] : null;
}
function artworks(svt) {
  const g = (svt.extraAssets && svt.extraAssets.charaGraph) || {};
  const out = [];
  const asc = g.ascension || {};
  Object.keys(asc).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
    out.push({ kind: "asc", label: `${t("stage")} ${k}`, short: `${t("stageShort")} ${k}`, url: asc[k] });
  });
  const cos = g.costume || {};
  const costumeNames = {};
  if (svt.profile && svt.profile.costume) {
    for (const k in svt.profile.costume) costumeNames[k] = svt.profile.costume[k].shortName || svt.profile.costume[k].name;
  }
  Object.keys(cos).forEach((k, i) => {
    const n = Object.keys(cos).length;
    const label = costumeNames[k] || (n > 1 ? `${t("costume")} ${i + 1}` : t("costume"));
    out.push({ kind: "costume", label, short: label, url: cos[k] });
  });
  return out;
}
function attrName(a) {
  return (t("attrs")[a]) || a || "–";
}
function pct(v) {
  return v == null ? "–" : (v / 10).toLocaleString(settings.ui === "ja" ? "ja-JP" : settings.ui) + "%";
}
function grail(svt, lv) {
  return Array.isArray(svt.atkGrowth) && svt.atkGrowth.length >= lv && svt.lvMax < lv;
}
function cardFace(c) {
  const type = CARD_TYPES[String(c)] || "buster";
  return `<div class="cardface c-${type}"><img class="cf-bg" src="cards/card_bg_${type}.png" alt=""><img class="cf-ic" src="cards/card_icon_${type}.png" alt=""><img class="cf-tx" src="cards/card_txt_${type}.png" alt=""></div>`;
}

function npList(svt) {
  const nps = svt.noblePhantasms || [];
  // one entry per distinct NP (name + rank + detail); each is a "version" (base, strengthened…)
  const seen = new Set();
  const versions = [];
  for (const np of nps) {
    const key = [np.name, np.rank, cleanText(np.detail)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    versions.push(np);
  }
  versions.sort((x, y) => (x.priority || 0) - (y.priority || 0) || (x.id || 0) - (y.id || 0));
  return versions.length ? [{ versions }] : [];
}

function versionsPerNum(skills) {
  const byNum = {};
  for (const sk of skills || []) {
    const n = sk.num || 0;
    if (!byNum[n]) byNum[n] = [];
    byNum[n].push(sk);
  }
  return Object.keys(byNum).sort((x, y) => x - y).map((n) => ({
    versions: byNum[n].sort((x, y) => (x.priority || 0) - (y.priority || 0) || (x.id || 0) - (y.id || 0)),
  }));
}

// ---------- Skills with level slider ----------
function appendList(svt) {
  const byNum = {};
  for (const ap of svt.appendPassive || []) {
    if (ap && ap.skill) byNum[ap.num || 0] = ap.skill;
  }
  return Object.keys(byNum).sort((a, b) => a - b).map((n) => ({ versions: [byNum[n]] }));
}

function num(v, digits) {
  return Number(v).toLocaleString(settings.ui === "ja" ? "ja-JP" : settings.ui, { maximumFractionDigits: digits == null ? 2 : digits });
}

function fmtValue(fn, sv) {
  const v = sv.Value;
  if (v == null) return "";
  const ft = fn.funcType || "";
  const bt = (fn.buffs && fn.buffs[0] && fn.buffs[0].type) || "";
  if (/^damageNp/.test(ft)) return num(v / 10) + "%";
  if (/^(gainNp|lossNp|gainMultiplyNp|lossMultiplyNp)/.test(ft)) return num(v / 100) + "%";
  if (/^(gainStar|lossStar|gainHp|lossHp|subState|shortenSkill|extendSkill)/.test(ft)) return num(v, 0);
  if (/Individuality|^addIndividuality|^fieldIndividuality/.test(bt)) return "";
  if (bt === "regainNp") return num(v / 100) + "%";
  if (bt === "gutsRatio") return num(v / 10) + "%";
  if (/^(regainStar|regainHp|addMaxhp|subMaxhp|guts|donotAct|upChagetd)/.test(bt)) return num(v, 0);
  if (bt) return num(v / 10) + "%";
  return num(v, 0);
}

function svAt(fn, lv, oc) {
  const arr = oc > 1 ? fn["svals" + oc] : fn.svals;
  if (!arr || !arr.length) return null;
  return arr[Math.min(lv, arr.length) - 1] || {};
}
// keys of the function's values that change with overcharge at this NP level
function ocKeys(fn, lv) {
  const keys = new Set();
  const base = svAt(fn, lv, 1) || {};
  for (let oc = 2; oc <= 5; oc++) {
    const o = svAt(fn, lv, oc);
    if (!o) continue;
    for (const k of new Set([...Object.keys(base), ...Object.keys(o)])) {
      if (JSON.stringify(base[k]) !== JSON.stringify(o[k])) keys.add(k);
    }
  }
  return keys;
}
function fnLabel(fn) {
  const buff = fn.buffs && fn.buffs[0];
  return /^damageNp/.test(fn.funcType || "") && !(buff && buff.name)
    ? t("npDamage")
    : tr((buff && buff.name) || fn.funcPopupText || fn.funcType);
}
function fxParts(fn, sv) {
  const parts = [];
  const val = fmtValue(fn, sv);
  if (val) parts.push(`<b>${esc(val)}</b>`);
  if (sv.Turn > 0) parts.push(`${sv.Turn}T`);
  if (sv.Count > 0) parts.push(`${sv.Count}×`);
  if (sv.Rate > 0 && sv.Rate < 1000) parts.push(`${num(sv.Rate / 10)}% ${esc(t("chance"))}`);
  return parts;
}
function isSpecialDamage(fn) {
  return /^damageNp(Individual|Rare|StateIndividual|AndCheckIndividuality)/.test(fn.funcType || "");
}
function specialLabel(fn, sv) {
  const id = sv && (sv.Target || (Array.isArray(sv.TargetList) && sv.TargetList[0]));
  if (!id) return esc(t("specialDamage"));
  const name = traitDisplay(id);
  return `${esc(t("specialDamage"))} <span class="trait-link" data-trait="${id}">[${esc(name)}]</span>`;
}
function effectRows(skill, lv, isNP) {
  const rows = [];
  const seen = new Set();
  for (const fn of skill.functions || []) {
    if (!fn || fn.funcType === "none" || !fn.svals || !fn.svals.length) continue;
    const keys = isNP ? ocKeys(fn, lv) : new Set();
    // values that grow with overcharge go to the overcharge box instead
    if (keys.has("Value") || (keys.size && !isSpecialDamage(fn) && !/^damageNp/.test(fn.funcType || ""))) continue;
    const sv = svAt(fn, lv, 1) || {};
    const first = fn.svals[0] || {};
    const last = fn.svals[fn.svals.length - 1] || {};
    const parts = fxParts(fn, sv);
    const varies = first.Value !== last.Value || first.Rate !== last.Rate || first.Turn !== last.Turn || first.Count !== last.Count;
    const html = `<div class="fx ${varies ? "vary" : ""}"><span class="fx-l">${esc(cleanText(fnLabel(fn)))}</span><span class="fx-v">${parts.join(" · ") || "–"}</span></div>`;
    if (seen.has(html)) continue;   // the API repeats some effects (e.g. one per target group)
    seen.add(html);
    rows.push(html);
  }
  return rows.join("");
}
function ocRows(skill, lv, oc) {
  const rows = [];
  const seen = new Set();
  for (const fn of skill.functions || []) {
    if (!fn || !fn.svals || !fn.svals.length) continue;
    const keys = ocKeys(fn, lv);
    if (!keys.size) continue;
    const sv = svAt(fn, lv, oc) || {};
    let label, value;
    if (keys.has("Correction") && !keys.has("Value")) {
      label = specialLabel(fn, sv);
      value = `<b>${esc(num(sv.Correction / 10))}%</b>`;
    } else {
      label = esc(cleanText(fnLabel(fn)));
      value = fxParts(fn, sv).join(" · ") || "–";
    }
    const html = `<div class="fx"><span class="fx-l">${label}</span><span class="fx-v oc-v">${value}</span></div>`;
    if (seen.has(html)) continue;
    seen.add(html);
    rows.push(html);
  }
  return rows.join("");
}
function hasOc(skill) {
  return (skill.functions || []).some((fn) => fn && fn.svals && fn.svals.length && ocKeys(fn, 1).size);
}
function ocBox(skill, i, lv) {
  if (!hasOc(skill)) return "";
  const oc = (state.oc && state.oc[i]) || 1;
  return `
    <div class="oc-box">
      <div class="oc-head"><span class="oc-badge">${esc(t("overcharge"))}</span><span class="oc-hint">${esc(t("ocHint"))}</span></div>
      <div class="lv-row">
        <span class="lv-label">${esc(t("charge"))} <b class="oc-num" data-part="ocv">${oc * 100}%</b></span>
        <input type="range" class="lv-slider oc-slider" data-i="${i}" min="1" max="5" step="1" value="${oc}" style="--fill:${((oc - 1) / 4) * 100}%">
      </div>
      <div class="fx-list" data-part="oc">${ocRows(skill, lv, oc)}</div>
    </div>`;
}

// Split a skill/NP description into one effect per line ("A & B + C" -> "A.\nB.\nC.").
// Only top-level separators count: nothing inside quotes, brackets or {{placeholders}}.
const ES_CLAUSE = /^(aumenta|aumentas|reduce|reduces|elimina|eliminas|aplica|aplicas|restaura|restauras|recupera|recuperas|obtiene|obtienes|otorga|otorgas|inflige|infliges|te|le|les|se|absorbe|absorbes|convierte|cambia|carga|cargas|gana|ganas|quita|disminuye|cura|alta|baja|gran|probabilidad|consume|consumes|sacrifica|retrocede|retira|añade|anula|invoca|concede|activa|garantiza)\b/i;
const OPEN = "(<[{\"「（【〔『";
const CLOSE = ")>]}\"」）】〕』";
function splitEffects(text) {
  const lang = settings.data === "ja" ? "ja" : trActive() ? "es" : "en";
  const src = lang === "ja" ? text.replace(/\s*\n\s*/g, "") : text.replace(/\s*\n\s*/g, " ");
  const parts = [];
  let depth = 0, quote = false, start = 0;
  const cut = (at, skip) => { parts.push(src.slice(start, at)); start = at + skip; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (OPEN.includes(ch)) { depth++; continue; }
    if (CLOSE.includes(ch)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (lang === "ja") {
      if (ch === "＆" || ch === "＋") cut(i, 1);
      continue;
    }
    const rest = src.slice(i);
    if (rest.startsWith(" & ") || rest.startsWith(" + ")) { cut(i, 3); i += 2; continue; }
    if (lang === "es") {
      const m = /^(, y |, | y )/.exec(rest);
      if (m && ES_CLAUSE.test(rest.slice(m[1].length))) { cut(i, m[1].length); i += m[1].length - 1; }
    }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    if (lang === "ja") return /[。！？]$/.test(p) ? p : p + "。";
    p = p.replace(/^([<\[(][^>\])]*[>\])]\s*)?(\p{Ll})/u, (m0, pre, c) => (pre || "") + c.toUpperCase());
    return /[.!?。]$/.test(p) ? p : p + ".";
  }).join("\n");
}

// NA text uses placeholders like {{1:Value:m}} -> function #1, sval "Value", format m (÷10 %) / y (÷100 %)
function fillDetail(obj, lv, raw) {
  const text = splitEffects(cleanText(raw ? obj.detail : tr(obj.detail)));
  const fns = obj.functions || [];
  const parts = text.split(/(\{\{[^}]*\}\})/);
  const html = parts.map((p) => {
    const m = /^\{\{(\d+):([A-Za-z]+)(?::([A-Za-z]*))?\}\}$/.exec(p);
    if (!m) return esc(p);
    const fn = fns[Number(m[1]) - 1];
    const svals = fn && fn.svals;
    if (!svals || !svals.length) return "?";
    const sv = svals[Math.min(lv, svals.length) - 1] || {};
    const raw = sv[m[2]];
    if (raw == null) return "?";
    let out;
    if (m[3] === "m") out = num(raw / 10);
    else if (m[3] === "y") out = num(raw / 100);
    else if (m[3] === "p") out = num(raw / 10);
    else out = num(raw);
    return `<b class="tv">${esc(out)}</b>`;
  }).join("");
  return linkTraits(html, obj);
}

// Servant traits a skill/NP refers to, taken from its function data (not guessed from the text)
function traitRefs(obj) {
  const ids = new Map();
  const add = (x) => {
    if (x == null) return;
    const id = typeof x === "object" ? x.id : Number(x);
    if (!id) return;
    if (typeof x === "object" && x.name) { state.traitSeen = state.traitSeen || {}; state.traitSeen[id] = x.name; }
    if (!state.traitNames || !Object.keys(state.traitNames).length || state.traitNames[id]) ids.set(id, true);
  };
  for (const fn of obj.functions || []) {
    if (!fn) continue;
    (fn.functvals || []).forEach(add);
    const sv = (fn.svals && fn.svals[0]) || {};
    add(sv.Target);
    (Array.isArray(sv.TargetList) ? sv.TargetList : []).forEach(add);
    for (const bf of fn.buffs || []) {
      (bf.ckOpIndv || []).forEach(add);
      (bf.ckSelfIndv || []).forEach(add);
    }
  }
  return [...ids.keys()];
}
const NOT_TRAIT = /^(demerit|penalizaci[oó]n|デメリット|treated as|cuenta como|.*buff.*|.*debuff.*)$/i;
function linkTraits(html, obj) {
  const refs = traitRefs(obj);
  if (!refs.length) return html;
  const label = (id) => {
    const n = (state.traitNames && state.traitNames[id]) || (state.traitSeen && state.traitSeen[id]) || "";
    return { a: traitLabel(n).toLowerCase(), b: n.toLowerCase() };
  };
  const used = new Set();
  const tokens = [];
  html.replace(/\[([^\[\]<>]{1,40})\]/g, (m, inner) => { tokens.push(inner); return m; });
  // 1) exact name matches
  const assign = {};
  tokens.forEach((tk, k) => {
    const low = tk.trim().toLowerCase();
    const hit = refs.find((id) => !used.has(id) && (label(id).a === low || label(id).b.replace(/^alignment|^attribute/, "") === low.replace(/\s+/g, "")));
    if (hit) { used.add(hit); assign[k] = hit; }
  });
  // 2) one remaining trait + one remaining bracket (e.g. translated "[Legal]") -> pair them
  const leftIds = refs.filter((id) => !used.has(id));
  const leftTk = tokens.map((tk, k) => k).filter((k) => assign[k] == null && !NOT_TRAIT.test(tokens[k].trim()));
  if (leftIds.length === 1 && leftTk.length === 1) assign[leftTk[0]] = leftIds[0];
  let k = -1;
  return html.replace(/\[([^\[\]<>]{1,40})\]/g, (m) => {
    k++;
    return assign[k] ? `<span class="trait-link" data-trait="${assign[k]}">${m}</span>` : m;
  });
}

const MAX_LV = { skills: 10, append: 10, np: 5 };
const DEFAULT_LV = { skills: 10, append: 10, np: 1 };

function skillLevel(key, i) {
  return (state.lv[key] && state.lv[key][i]) || DEFAULT_LV[key] || 10;
}
function versionIndex(key, i, entry) {
  const v = state.ver[key] && state.ver[key][i];
  return v != null && v < entry.versions.length ? v : entry.versions.length - 1;
}
function versionLabel(idx, total) {
  if (idx === 0) return t("normalVer");
  return total > 2 ? `${t("upgradedVer")} ${idx}` : t("upgradedVer");
}

function cdBadge(skill, lv) {
  const cd = skill.coolDown || [];
  const now = cd.length ? cd[Math.min(lv, cd.length) - 1] : 0;
  return now > 0 ? `CD ${now}` : "";
}

function levelMats(mats, lv) {
  if (!mats) return "";
  if (lv >= 10) return `<div class="mats-label"><span>${esc(t("level"))} 10</span><span>${esc(t("maxed"))}</span></div>`;
  const m = mats[String(lv)];
  if (!m || !m.items || !m.items.length) return "";
  return `
    <div class="mats-label"><span>${esc(t("level"))} ${lv} → ${lv + 1}</span><span>QP ${fmt(m.qp)}</span></div>
    ${matTiles(m.items)}`;
}

function skillBlock(key, i, entry, mats) {
  const isNP = key === "np";
  const max = MAX_LV[key] || 10;
  const vi = versionIndex(key, i, entry);
  const skill = entry.versions[vi];
  const lv = Math.min(skillLevel(key, i), max);
  const cd = isNP ? "" : cdBadge(skill, lv);
  const type = CARD_TYPES[String(skill.card)] || "buster";
  const icon = isNP
    ? `<span class="np-ico"><img src="cards/card_icon_${type}.png" alt=""><i>NP</i></span>`
    : `<img class="skill-icon" src="${esc(skill.icon)}" alt="" loading="lazy" onerror="imgErr(this)">`;
  const badges = isNP
    ? `${skill.rank ? `<span class="badge">${esc(skill.rank)}</span>` : ""}${skill.type ? `<span class="badge">${esc(skill.type)}</span>` : ""}${(skill.npDistribution || []).length && (skill.functions || []).some((f) => /^damageNp/.test(f.funcType || "")) ? `<span class="badge">${esc(t("hitsN", { n: skill.npDistribution.length }))}</span>` : ""}`
    : `<span class="badge cd ${cd ? "" : "hidden"}" data-part="cd">${cd}</span>`;
  const toggle = entry.versions.length > 1 ? `
    <div class="ver-toggle">${entry.versions.map((_, k) =>
      `<button class="chip ${k === vi ? "active" : ""}" data-ver="${k}">${esc(versionLabel(k, entry.versions.length))}</button>`).join("")}
    </div>` : "";
  const unlock = vi > 0 && (skill.condQuestId > 0 || isNP) ? `<div class="d-sub unlock" ${skill.condQuestId > 0 ? `data-q="${skill.condQuestId}"` : ""}>🔓 ${esc(t("unlockQuest"))}</div>` : "";
  const lvLabel = isNP ? t("npLevel") : t("level");
  return `
    <div class="skill" data-i="${i}">
      ${icon}
      <div class="skill-main">
        <div class="skill-name">${esc(skill.name)}${badges}</div>
        ${isNP && skill.ruby && skill.ruby !== "-" && skill.ruby !== skill.name ? `<div class="d-sub">${esc(skill.ruby)}</div>` : ""}
        ${toggle}
        ${unlock}
        <div class="skill-detail" data-part="detail">${fillDetail(skill, lv)}</div>
        <div class="lv-row">
          <span class="lv-label">${esc(lvLabel)} <b data-part="lv">${lv}</b></span>
          <input type="range" class="lv-slider" data-key="${key}" data-i="${i}" min="1" max="${max}" step="1" value="${lv}" style="--fill:${((lv - 1) / (max - 1)) * 100}%">
        </div>
        <div class="fx-list" data-part="fx">${effectRows(skill, lv, isNP)}</div>
        ${isNP ? `<div data-part="ocbox">${ocBox(skill, i, lv)}</div>` : ""}
        <div class="lv-mats" data-part="mats">${levelMats(mats, lv)}</div>
      </div>
    </div>`;
}

function levelSection(key, title, list, mats) {
  if (!list.length) return "";
  return `
    <div class="section">
      <h2>${esc(title)}</h2>
      <div class="card" id="sec-${key}">
        ${list.map((entry, i) => skillBlock(key, i, entry, mats)).join("")}
      </div>
    </div>`;
}

function bindLevelSection(key, list, mats) {
  const sec = $("#sec-" + key);
  if (!sec) return;
  const max = MAX_LV[key] || 10;
  sec.addEventListener("input", (e) => {
    const slider = e.target.closest(".lv-slider");
    if (!slider) return;
    const i = Number(slider.dataset.i);
    if (slider.classList.contains("oc-slider")) {
      const oc = Number(slider.value);
      state.oc[i] = oc;
      const entry = list[i];
      const skill = entry.versions[versionIndex(key, i, entry)];
      const block = slider.closest(".skill");
      block.querySelector('[data-part="ocv"]').textContent = oc * 100 + "%";
      block.querySelector('[data-part="oc"]').innerHTML = ocRows(skill, skillLevel(key, i), oc);
      slider.style.setProperty("--fill", ((oc - 1) / 4) * 100 + "%");
      return;
    }
    const lv = Number(slider.value);
    const entry = list[i];
    const skill = entry.versions[versionIndex(key, i, entry)];
    if (!state.lv[key]) state.lv[key] = {};
    state.lv[key][i] = lv;
    const block = slider.closest(".skill");
    block.querySelector('[data-part="lv"]').textContent = lv;
    block.querySelector('[data-part="fx"]').innerHTML = effectRows(skill, lv, key === "np");
    const ocEl = block.querySelector('[data-part="oc"]');
    if (ocEl) ocEl.innerHTML = ocRows(skill, lv, (state.oc && state.oc[i]) || 1);
    block.querySelector('[data-part="detail"]').innerHTML = fillDetail(skill, lv);
    block.querySelector('[data-part="mats"]').innerHTML = levelMats(mats, lv);
    const cdEl = block.querySelector('[data-part="cd"]');
    if (cdEl) {
      const cd = cdBadge(skill, lv);
      cdEl.textContent = cd;
      cdEl.classList.toggle("hidden", !cd);
    }
    slider.style.setProperty("--fill", ((lv - 1) / (max - 1)) * 100 + "%");
  });
  sec.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ver]");
    if (!b) return;
    const block = b.closest(".skill");
    const i = Number(block.dataset.i);
    if (!state.ver[key]) state.ver[key] = {};
    state.ver[key][i] = Number(b.dataset.ver);
    block.outerHTML = skillBlock(key, i, list[i], mats);
    if (state.curSvt) fillUnlocks(state.curSvt);
  });
}

function passiveSection(svt) {
  const list = svt.classPassive || [];
  if (!list.length) return "";
  return `
    <div class="section">
      <h2>${esc(t("passives"))}</h2>
      <div class="card">
        ${list.map((s) => `
          <div class="skill">
            <img class="skill-icon" src="${esc(s.icon)}" alt="" loading="lazy" onerror="imgErr(this)">
            <div>
              <div class="skill-name">${esc(s.name)}</div>
              <div class="skill-detail">${fillDetail(s, 1)}</div>
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}

function matTiles(items) {
  return `<div class="mats">${items.map((it) => `
    <div class="mat" title="${esc(it.item.name)}" data-item="${esc(it.item.id || "")}" data-iname="${esc(it.item.name)}" data-icon="${esc(it.item.icon)}">
      <img src="${esc(it.item.icon)}" alt="${esc(it.item.name)}" loading="lazy" onerror="imgErr(this)">
      <span>${fmt(it.amount)}</span>
    </div>`).join("")}</div>`;
}

function matsSection(title, mats, label) {
  if (!mats) return "";
  const keys = Object.keys(mats).filter((k) => mats[k] && mats[k].items && mats[k].items.length)
    .sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return "";
  return `
    <div class="section">
      <h2>${esc(title)}</h2>
      <div class="card">
        ${keys.map((k) => `
          <div class="mats-stage">
            <div class="mats-label"><span>${esc(label(k))}</span><span>QP ${fmt(mats[k].qp)}</span></div>
            ${matTiles(mats[k].items)}
          </div>`).join("")}
      </div>
    </div>`;
}

function totalsSection(svt) {
  const totals = new Map();
  let qp = 0;
  const add = (mats, mult) => {
    if (!mats) return;
    for (const k in mats) {
      const m = mats[k];
      if (!m || !m.items) continue;
      qp += (m.qp || 0) * mult;
      for (const it of m.items) {
        const id = it.item.id || it.item.name;
        const cur = totals.get(id) || { item: it.item, amount: 0 };
        cur.amount += it.amount * mult;
        totals.set(id, cur);
      }
    }
  };
  add(svt.ascensionMaterials, 1);
  add(svt.skillMaterials, 3); // three active skills share the same material table
  if (!totals.size) return "";
  const items = [...totals.values()].sort((a, b) => (a.item.priority || 0) - (b.item.priority || 0) || (a.item.id || 0) - (b.item.id || 0));
  return `
    <div class="section">
      <h2>${esc(t("totals"))}</h2>
      <div class="card">
        <div class="mats-label"><span>${esc(t("ascension"))} + ${esc(t("skills"))} 10/10/10</span><span>QP ${fmt(qp)}</span></div>
        ${matTiles(items)}
      </div>
    </div>`;
}


// ---------- In-app updates (GitHub Releases) ----------
const RELEASES_API = "https://api.github.com/repos/Anuxi007/fatego-app/releases/latest";
const UPDATE_EVERY = 12 * 60 * 60 * 1000;

function nativeApp() {
  return typeof window.AndroidApp !== "undefined" ? window.AndroidApp : null;
}

async function checkForUpdate(manual) {
  const app = nativeApp();
  if (!app) return;
  if (!manual) {
    const last = store.get("updCheck", 0);
    if (Date.now() - last < UPDATE_EVERY) return;
  }
  store.set("updCheck", Date.now());
  try {
    const rel = await getJSON(RELEASES_API);
    const m = /(\d+)/.exec(rel.tag_name || "");
    const latest = m ? Number(m[1]) : 0;
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    if (asset && latest > app.getVersionCode()) {
      showUpdateBanner(latest, asset.browser_download_url);
    } else if (manual) {
      toast(t("updLatest"));
    }
  } catch (e) {
    if (manual) toast(t("updError"));
  }
}

function showUpdateBanner(build, url) {
  let el = $("#updBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "updBanner";
    el.className = "upd-banner";
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="upd-title">⬆ ${esc(t("updAvailable"))} <span class="upd-build">build ${build}</span></div>
    <div class="upd-msg" id="updMsg"></div>
    <div class="upd-bar hidden" id="updBar"><span id="updFill"></span></div>
    <div class="upd-actions" id="updActions">
      <button class="btn ghost" id="updLater">${esc(t("updLater"))}</button>
      <button class="btn" id="updNow">${esc(t("updNow"))}</button>
    </div>`;
  $("#updLater").addEventListener("click", () => el.remove());
  $("#updNow").addEventListener("click", () => {
    $("#updActions").classList.add("hidden");
    $("#updBar").classList.remove("hidden");
    $("#updMsg").textContent = t("updDownloading");
    nativeApp().downloadAndInstall(url);
  });
}

window.__updateProgress = (p) => {
  const fill = $("#updFill");
  if (fill) fill.style.width = p + "%";
  const msg = $("#updMsg");
  if (msg) msg.textContent = `${t("updDownloading")} ${p}%`;
};
window.__updateNeedsPermission = () => {
  const msg = $("#updMsg");
  if (msg) msg.textContent = t("updPermission");
};
window.__updateInstalling = () => {
  const msg = $("#updMsg");
  if (msg) msg.textContent = t("updInstalling");
  setTimeout(() => { const el = $("#updBanner"); if (el) el.remove(); }, 4000);
};
window.__updateError = () => {
  const msg = $("#updMsg");
  if (msg) msg.textContent = t("updError");
  const actions = $("#updActions");
  if (actions) actions.classList.remove("hidden");
  const bar = $("#updBar");
  if (bar) bar.classList.add("hidden");
};


// ---------- Daily quests (fixed weekly calendar) ----------
const DAILY_URL = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/daily.json";
const ALL_CLASSES = ["saber", "archer", "lancer", "rider", "caster", "assassin", "berserker"];
const CLASS_IDS = { saber: 1, archer: 2, lancer: 3, rider: 4, caster: 5, assassin: 6, berserker: 7 };
// Training Grounds and Ember Gathering per weekday (1 = Monday … 7 = Sunday). Weekends: everything.
const DAILY_SCHEDULE = {
  tg: { 1: ["archer"], 2: ["lancer"], 3: ["berserker"], 4: ["rider"], 5: ["caster"], 6: ALL_CLASSES, 7: ALL_CLASSES },
  ember: {
    1: ["lancer", "assassin"], 2: ["saber", "rider"], 3: ["archer", "caster"],
    4: ["lancer", "assassin"], 5: ["saber", "rider"], 6: ALL_CLASSES, 7: ALL_CLASSES,
  },
};
let DAILY = null;

async function loadDaily() {
  if (DAILY) return DAILY;
  const cached = store.get("daily_v2", null);
  if (cached && cached.data) DAILY = cached.data;
  if (!DAILY) {
    try { DAILY = await getJSON("daily.json"); } catch (e) { /* not bundled */ }
  }
  if (!cached || Date.now() - cached.ts > LIST_TTL) {
    try {
      const data = await getJSON(DAILY_URL + "?t=" + Math.floor(Date.now() / 3600000));
      DAILY = data;
      store.set("daily_v2", { ts: Date.now(), data });
    } catch (e) { /* keep cached/bundled */ }
  }
  if (!DAILY) throw new Error("no daily data");
  return DAILY;
}

function questsFor(kind, cls) {
  // One quest per tier (keep the one with the most recorded runs)
  const byTier = new Map();
  for (const q of DAILY.quests) {
    if (q.kind !== kind || !q.classes.includes(cls)) continue;
    const prev = byTier.get(q.tier);
    if (!prev || (q.runs || 0) > (prev.runs || 0)) byTier.set(q.tier, q);
  }
  return [...byTier.values()].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
}

function dropName(d) {
  return (settings.data === "ja" && d.jname) || d.name || "";
}

function dropRows(q) {
  return q.drops.map((d) => {
    const perAp = d.rate > 0 ? q.ap / d.rate : 0;
    return `
      <div class="drop" ${d.type === "item" ? `data-item="${d.id}" data-iname="${esc(dropName(d))}" data-icon="${esc(d.icon || "")}"` : ""}>
        <img src="${esc(d.icon || "")}" alt="" loading="lazy" onerror="imgErr(this)">
        <span class="drop-name">${esc(dropName(d))}</span>
        <span class="drop-rate"><b>${num(d.rate * 100, 1)}%</b><small>${perAp ? `${num(perAp, 1)} ${esc(t("apPerDrop"))}` : ""}</small></span>
      </div>`;
  }).join("");
}

function dailyCard(kind, key, classes, quests) {
  if (!quests.length) return "";
  const sel = Math.min((state.dailyTier[key] ?? quests.length - 1), quests.length - 1);
  const q = quests[sel];
  const icons = classes.map((c) => `<img src="${classIcon(CLASS_IDS[c], 5)}" alt="" onerror="imgErr(this)">`).join("");
  const title = classes.map((c) => className(c)).join(" · ");
  return `
    <div class="card daily-card" data-key="${esc(key)}" data-kind="${kind}">
      <div class="daily-head"><span class="daily-icons">${icons}</span><b>${esc(title)}</b></div>
      <div class="chips wrap tier-chips">
        ${quests.map((x, i) => `<button class="chip ${i === sel ? "active" : ""}" data-tier="${i}">${esc(t("tiers")[x.tier] || "?")}</button>`).join("")}
      </div>
      <div class="daily-meta">${esc(t("apCost"))}: <b>${q.ap}</b> · ${esc(t("runs"))}: <b>${fmt(q.runs)}</b></div>
      <div class="drops-head"><span>${esc(t("drop"))}</span><span>${esc(t("ratePerRun"))}</span></div>
      <div class="drops">${dropRows(q)}</div>
    </div>`;
}

function renderDailyDay() {
  const day = state.dailyDay;
  const body = $("#dailyBody");
  if (!body) return;
  const tgClasses = DAILY_SCHEDULE.tg[day];
  const emberClasses = DAILY_SCHEDULE.ember[day];
  const tgCards = tgClasses.map((c) => dailyCard("tg", "tg-" + c, [c], questsFor("tg", c))).join("");
  // Ember quests cover class pairs; show each distinct quest group once
  const seen = new Set();
  const emberCards = [];
  for (const c of emberClasses) {
    const qs = questsFor("ember", c);
    if (!qs.length) continue;
    const group = qs[0].classes.join("+");
    if (seen.has(group)) continue;
    seen.add(group);
    emberCards.push(dailyCard("ember", "em-" + group, qs[0].classes, qs));
  }
  body.innerHTML = `
    ${day >= 6 ? `<div class="notice">${esc(t("weekendAll"))}</div>` : ""}
    <div class="section"><h2>${esc(t("trainingGrounds"))}</h2>${tgCards || `<p class="note">${esc(t("noResults"))}</p>`}</div>
    <div class="section"><h2>${esc(t("emberGathering"))}</h2>${emberCards.join("") || `<p class="note">${esc(t("noResults"))}</p>`}</div>
    <p class="footer-note">${esc(t("dropsNote"))}${DAILY.updated ? ` · ${esc(DAILY.updated)}` : ""}</p>`;
}

async function renderDaily() {
  setHeader(esc(t("daily")), false);
  renderLoading();
  try { await loadDaily(); } catch (e) { return renderError(renderDaily); }
  if (currentRoute().name !== "daily") return;
  view.innerHTML = `
    <div class="chips day-chips" id="dayChips">
      ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button class="chip ${d === state.dailyDay ? "active" : ""}" data-day="${d}">${esc(t("weekdays")[d - 1])}</button>`).join("")}
    </div>
    <div id="dailyBody"></div>`;
  $("#dayChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]"); if (!b) return;
    state.dailyDay = Number(b.dataset.day);
    store.set("dailyDay", state.dailyDay);
    document.querySelectorAll("#dayChips .chip").forEach((c) => c.classList.toggle("active", c === b));
    renderDailyDay();
  });
  $("#dailyBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tier]"); if (!b) return;
    const card = b.closest(".daily-card");
    state.dailyTier[card.dataset.key] = Number(b.dataset.tier);
    renderDailyDay();
  });
  renderDailyDay();
}


// ---------- Upgrade plan ----------
const PLAN_MIN_SLOTS = 3;
function loadPlan() {
  const p = store.get("plan", null);
  return Array.isArray(p) ? p.filter(Boolean) : [];
}
function savePlan(p) { store.set("plan", p); }
function pad2(n) { return String(n).padStart(2, "0"); }
function planSummary(e) {
  return {
    skills: e.cur.s.map(pad2).join("/"),
    append: e.cur.a.map(pad2).join("/"),
  };
}
function newPlanEntry(s) {
  return {
    id: s.id, no: s.no, name: s.name, face: s.face, cls: s.cls, cid: s.cid, r: s.r,
    cur: { asc: 0, s: [1, 1, 1], a: [0, 0, 0] },
    tgt: { asc: 4, s: [10, 10, 10], a: [0, 0, 0] },
  };
}

function addMats(map, items, mult) {
  for (const it of items || []) {
    const id = it.item.id || it.item.name;
    const cur = map.get(id) || { item: it.item, amount: 0 };
    cur.amount += it.amount * (mult || 1);
    map.set(id, cur);
  }
}
function matsList(map) {
  return [...map.values()].sort((a, b) => (a.item.priority || 0) - (b.item.priority || 0) || (a.item.id || 0) - (b.item.id || 0));
}
function appendUnlock(svt, n) {
  const ap = (svt.appendPassive || []).find((x) => x.num === n + 1) || (svt.appendPassive || [])[n];
  return ap && ap.unlockMaterials ? ap.unlockMaterials : [];
}
// Materials for each track, either just the next step or everything up to the target.
function planCost(svt, e, onlyNext) {
  const total = { map: new Map(), qp: 0 };
  const steps = [];
  const add = (label, mats, extraItems) => {
    const map = new Map();
    let qp = 0;
    if (mats) { addMats(map, mats.items); qp += mats.qp || 0; }
    if (extraItems) addMats(map, extraItems);
    for (const v of map.values()) addMats(total.map, [{ item: v.item, amount: v.amount }]);
    total.qp += qp;
    if (onlyNext) steps.push({ label, items: matsList(map), qp });
  };
  const asc = svt.ascensionMaterials || {};
  for (let a = e.cur.asc; a < e.tgt.asc; a++) {
    add(`${t("stage")} ${a} → ${a + 1}`, asc[String(a)]);
    if (onlyNext) break;
  }
  const sm = svt.skillMaterials || {};
  e.cur.s.forEach((c, i) => {
    for (let l = c; l < e.tgt.s[i]; l++) {
      add(`${t("skillsShort")} ${i + 1}: ${l} → ${l + 1}`, sm[String(l)]);
      if (onlyNext) break;
    }
  });
  const am = svt.appendSkillMaterials || {};
  e.cur.a.forEach((c, i) => {
    for (let l = c; l < e.tgt.a[i]; l++) {
      if (l === 0) add(`${t("appendShort")} ${i + 1}: ${t("unlock")}`, null, appendUnlock(svt, i));
      else add(`${t("appendShort")} ${i + 1}: ${l} → ${l + 1}`, am[String(l)]);
      if (onlyNext) break;
    }
  });
  return { steps, items: matsList(total.map), qp: total.qp };
}

function costBlock(c) {
  if (!c.items.length && !c.qp) return `<p class="note">${esc(t("planDone"))}</p>`;
  return `
    <div class="mats-label"><span></span><span>QP ${fmt(c.qp)}</span></div>
    ${matTiles(c.items)}`;
}

const ICON_SWAP = '<svg viewBox="0 0 24 24"><path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
function planRowHtml(e, i, isNew) {
  const sum = planSummary(e);
  return `
    <div class="pl-row ${isNew ? "new" : ""}" data-i="${i}">
      <span class="pl-grip" aria-hidden="true">⋮⋮</span>
      <img class="face" src="${esc(e.face)}" alt="" onerror="imgErr(this)">
      <div class="pl-info">
        <div class="svt-name">${esc(e.name)}${isNew ? `<span class="pl-new">${esc(t("planNew"))}</span>` : ""}</div>
        <div class="pl-sum">${esc(t("skillsShort"))} <b>${sum.skills}</b> · ${esc(t("appendShort"))} <b>${sum.append}</b></div>
      </div>
      <button class="pl-btn" data-pl="swap" aria-label="${esc(t("planChange"))}">${ICON_SWAP}</button>
      <button class="pl-btn del" data-pl="del" aria-label="${esc(t("planRemove"))}">${ICON_DEL}</button>
    </div>`;
}
function planListHtml(plan, newId) {
  const rows = plan.map((e, i) => planRowHtml(e, i, e.id === newId)).join("");
  const empties = Math.max(0, PLAN_MIN_SLOTS - plan.length);
  const empty = Array.from({ length: empties }, () => `<button class="pl-empty" data-pl="add"><b>＋</b>${esc(t("planFree"))}</button>`).join("");
  const more = plan.length >= PLAN_MIN_SLOTS ? `<button class="pl-empty pl-more" data-pl="add"><b>＋</b>${esc(t("planAddMore"))}</button>` : "";
  return `<div class="pl-list" id="plList">${rows}${empty}${more}</div>`;
}
// Shared behaviour for the plan list (page and overlay): open, swap, delete, long-press to reorder
function bindPlanList(root, rerender, onOpen) {
  root.onclick = (ev) => {
    const b = ev.target.closest("[data-pl]");
    const row = ev.target.closest(".pl-row");
    if (b && b.dataset.pl === "add") { openPicker(-1); return; }
    if (b && row) {
      const i = Number(row.dataset.i);
      if (b.dataset.pl === "swap") { openPicker(i); return; }
      if (b.dataset.pl === "del") {
        if (!b.classList.contains("confirm")) {
          b.classList.add("confirm");
          b.innerHTML = esc(t("planDelQ"));
          setTimeout(() => { if (b.isConnected) { b.classList.remove("confirm"); b.innerHTML = ICON_DEL; } }, 3000);
          return;
        }
        const plan = loadPlan(); plan.splice(i, 1); savePlan(plan);
        if (state.curSvt) setBarActions(state.curSvt);
        rerender();
        return;
      }
    }
    if (row && !row.dataset.dragged) onOpen(Number(row.dataset.i));
    if (row) delete row.dataset.dragged;
  };
  // long-press + drag to reorder (touch)
  let lp = null, drag = null;
  const list = root.querySelector("#plList") || root;
  list.addEventListener("touchstart", (ev) => {
    const row = ev.target.closest(".pl-row");
    if (!row || ev.target.closest("[data-pl]") || ev.touches.length !== 1) return;
    const tch = ev.touches[0];
    lp = { row, x: tch.clientX, y: tch.clientY, timer: setTimeout(() => {
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* ignore */ } }
      const rect = row.getBoundingClientRect();
      drag = { row, startY: lp.y, top0: row.offsetTop, h: rect.height };
      row.classList.add("dragging");
      lp = null;
    }, 400) };
  }, { passive: true });
  list.addEventListener("touchmove", (ev) => {
    const tch = ev.touches[0];
    if (lp && (Math.abs(tch.clientX - lp.x) > 10 || Math.abs(tch.clientY - lp.y) > 10)) { clearTimeout(lp.timer); lp = null; }
    if (!drag) return;
    if (ev.cancelable) ev.preventDefault();
    const rows = [...list.querySelectorAll(".pl-row")];
    const dy = tch.clientY - drag.startY;
    const center = drag.top0 + dy + drag.h / 2;
    for (const other of rows) {
      if (other === drag.row) continue;
      const mid = other.offsetTop + other.offsetHeight / 2;
      if (other.offsetTop < drag.row.offsetTop && center < mid) { list.insertBefore(drag.row, other); break; }
      if (other.offsetTop > drag.row.offsetTop && center > mid) { list.insertBefore(drag.row, other.nextSibling); break; }
    }
    drag.row.style.transform = `translateY(${drag.top0 + dy - drag.row.offsetTop}px) scale(1.02)`;
  }, { passive: false });
  const end = () => {
    if (lp) { clearTimeout(lp.timer); lp = null; }
    if (!drag) return;
    const row = drag.row; drag = null;
    row.classList.remove("dragging");
    row.style.transform = "";
    row.dataset.dragged = "1";
    setTimeout(() => { delete row.dataset.dragged; }, 400);
    const order = [...list.querySelectorAll(".pl-row")].map((r) => Number(r.dataset.i));
    const plan = loadPlan();
    if (order.length === plan.length && order.some((v, k) => v !== k)) {
      savePlan(order.map((k) => plan[k]));
      if (state.curSvt) setBarActions(state.curSvt);
    }
    rerender();
  };
  list.addEventListener("touchend", end);
  list.addEventListener("touchcancel", end);
  list.addEventListener("contextmenu", (ev) => { if (ev.target.closest(".pl-row")) ev.preventDefault(); });
}

async function renderPlan() {
  setHeader(esc(t("plan")), false);
  const draw = () => {
    const plan = loadPlan();
    view.innerHTML = `
      <p class="note" style="margin-top:0">${esc(t("planHint2"))}</p>
      ${planListHtml(plan)}
      <div class="section" id="planTotal"></div>`;
    bindPlanList(view, draw, (i) => { location.hash = "#/plan/" + i; });
    planTotals(plan, $("#planTotal"), "plan");
  };
  draw();
}
async function planTotals(plan, el, routeName) {
  if (!plan.length || !el) return;
  el.innerHTML = `<h2>${esc(t("planTotal"))}</h2><div class="card"><div class="spinner"></div></div>`;
  try {
    const map = new Map();
    let qp = 0;
    for (const e of plan) {
      const svt = await loadServant(e.id);
      const c = planCost(svt, e, false);
      addMats(map, c.items);
      qp += c.qp;
    }
    if (routeName && currentRoute().name !== routeName) return;
    if (!el.isConnected) return;
    el.innerHTML = `<h2>${esc(t("planTotal"))}</h2><div class="card">${costBlock({ items: matsList(map), qp })}</div>`;
  } catch (err) {
    if (el.isConnected) el.innerHTML = `<div class="state">${esc(t("loadError"))}</div>`;
  }
}
function openPlanSheet(newId) {
  const draw = () => {
    const plan = loadPlan();
    openSheet(`
      <div class="pl-sheet-h"><b>${esc(t("plan"))}</b><small>${esc(t("planCount", { n: plan.length }))}</small>
        <button class="icon-btn" data-close="1" aria-label="Close">✕</button></div>
      <p class="note" style="margin:0 2px 10px">${esc(t("planHint2"))}</p>
      ${planListHtml(plan, newId)}
      <a class="pl-total-link" href="#/plan">${esc(t("planTotal"))} <span>${esc(t("planSeeAll"))} ›</span></a>`);
    const panel = document.querySelector("#sheet .sheet-panel");
    bindPlanList(panel, draw, (i) => { closeSheet(); location.hash = "#/plan/" + i; });
  };
  draw();
}

// Materials for one track (ascension, skill i or append i) from current to target
function trackCost(svt, e, kind, i) {
  const map = new Map();
  let qp = 0;
  const addStep = (mats, extra) => {
    if (mats) { addMats(map, mats.items); qp += mats.qp || 0; }
    if (extra) addMats(map, extra);
  };
  if (kind === "asc") {
    const asc = svt.ascensionMaterials || {};
    for (let a = e.cur.asc; a < e.tgt.asc; a++) addStep(asc[String(a)]);
  } else if (kind === "s") {
    const sm = svt.skillMaterials || {};
    for (let l = e.cur.s[i]; l < e.tgt.s[i]; l++) addStep(sm[String(l)]);
  } else {
    const am = svt.appendSkillMaterials || {};
    for (let l = e.cur.a[i]; l < e.tgt.a[i]; l++) {
      if (l === 0) addStep(null, appendUnlock(svt, i));
      else addStep(am[String(l)]);
    }
  }
  return { items: matsList(map), qp };
}

function trackMatsHtml(c) {
  if (!c.items.length && !c.qp) return `<div class="track-done">✓ ${esc(t("planDone"))}</div>`;
  return `
    <div class="mats-label"><span>${esc(t("planNeeded"))}</span><span>${c.qp ? "QP " + fmt(c.qp) : ""}</span></div>
    ${matTiles(c.items)}`;
}

function planTracks(svt) {
  const skills = versionsPerNum(svt.skills).map((x) => x.versions[x.versions.length - 1]);
  const appends = appendList(svt).map((x) => x.versions[0]);
  const tracks = [{ kind: "asc", i: 0, name: t("stage"), icon: "", min: 0, max: 4 }];
  for (let i = 0; i < 3; i++) {
    const sk = skills[i];
    tracks.push({ kind: "s", i, name: sk ? sk.name : `${t("skillsShort")} ${i + 1}`, icon: sk ? sk.icon : "", min: 1, max: 10, tag: `${t("skillsShort")} ${i + 1}` });
  }
  for (let i = 0; i < 3; i++) {
    const ap = appends[i];
    tracks.push({ kind: "a", i, name: ap ? ap.name : `${t("appendShort")} ${i + 1}`, icon: ap ? ap.icon : "", min: 0, max: 10, tag: `${t("appendShort")} ${i + 1}` });
  }
  return tracks;
}

function trackGet(e, which, tr) {
  return tr.kind === "asc" ? e[which].asc : e[which][tr.kind][tr.i];
}
function trackSet(e, which, tr, v) {
  if (tr.kind === "asc") e[which].asc = v; else e[which][tr.kind][tr.i] = v;
}

function trackCard(svt, e, tr, n) {
  const cur = trackGet(e, "cur", tr), tgt = trackGet(e, "tgt", tr);
  const fill = (v) => ((v - tr.min) / (tr.max - tr.min)) * 100;
  return `
    <div class="card track" data-t="${n}">
      <div class="track-head">
        ${tr.icon ? `<img class="skill-icon" src="${esc(tr.icon)}" alt="" onerror="imgErr(this)">` : `<div class="track-badge">✦</div>`}
        <div class="track-title">
          ${tr.tag ? `<div class="d-sub">${esc(tr.tag)}</div>` : ""}
          <div class="skill-name">${esc(tr.name)}</div>
        </div>
        <div class="track-range"><b data-p="cur">${cur}</b><span>→</span><b data-p="tgt">${tgt}</b></div>
      </div>
      <div class="lv-row">
        <span class="lv-label">${esc(t("planCurrent"))}</span>
        <input type="range" class="lv-slider" data-w="cur" min="${tr.min}" max="${tr.max}" step="1" value="${cur}" style="--fill:${fill(cur)}%">
      </div>
      <div class="lv-row">
        <span class="lv-label">${esc(t("planTarget"))}</span>
        <input type="range" class="lv-slider tgt" data-w="tgt" min="${tr.min}" max="${tr.max}" step="1" value="${tgt}" style="--fill:${fill(tgt)}%">
      </div>
      <div class="track-mats" data-p="mats">${trackMatsHtml(trackCost(svt, e, tr.kind, tr.i))}</div>
    </div>`;
}

async function renderPlanEdit(slot) {
  const plan = loadPlan();
  const e = plan[slot];
  if (!e) { location.hash = "#/plan"; return; }
  setHeader(esc(e.name), true);
  renderLoading();
  let svt;
  try {
    [svt] = await Promise.all([loadServant(e.id), loadTranslations()]);
  } catch (err) { return renderError(() => renderPlanEdit(slot)); }
  const r = currentRoute();
  if (r.name !== "planEdit" || r.slot !== slot) return;
  const tracks = planTracks(svt);

  const summary = () => costBlock(planCost(svt, e, false));
  const draw = () => {
    view.innerHTML = `
      <div class="d-head">
        <img class="face" src="${esc(e.face)}" alt="" onerror="imgErr(this)">
        <div>
          <h2 class="d-name">${esc(e.name)}</h2>
          <div class="d-sub">#${e.no} · <span class="stars">${stars(e.r)}</span> · ${esc(className(e.cls))}</div>
        </div>
      </div>
      <div class="plan-quick">
        <button class="chip" data-quick="max">${esc(t("planMaxAll"))}</button>
        <button class="chip" data-quick="cur">${esc(t("planKeep"))}</button>
      </div>
      <div class="section"><h2>${esc(t("stage"))}</h2>${trackCard(svt, e, tracks[0], 0)}</div>
      <div class="section"><h2>${esc(t("skills"))}</h2>${tracks.slice(1, 4).map((tr, k) => trackCard(svt, e, tr, k + 1)).join("")}</div>
      <div class="section"><h2>${esc(t("appendSkills"))}</h2>${tracks.slice(4).map((tr, k) => trackCard(svt, e, tr, k + 4)).join("")}</div>
      <div class="section"><h2>${esc(t("planSummary"))}</h2><div class="card" id="planSum">${summary()}</div></div>`;
  };
  draw();

  view.onclick = (ev) => {
    const q = ev.target.closest("[data-quick]"); if (!q) return;
    if (q.dataset.quick === "max") e.tgt = { asc: 4, s: [10, 10, 10], a: [10, 10, 10] };
    else e.tgt = JSON.parse(JSON.stringify(e.cur));
    plan[slot] = e; savePlan(plan);
    const y = window.scrollY; draw(); window.scrollTo(0, y);
  };
  view.oninput = (ev) => {
    const sl = ev.target.closest(".lv-slider"); if (!sl) return;
    const card = sl.closest(".track");
    const tr = tracks[Number(card.dataset.t)];
    const which = sl.dataset.w;
    const v = Number(sl.value);
    trackSet(e, which, tr, v);
    // keep target >= current
    if (which === "cur" && trackGet(e, "tgt", tr) < v) trackSet(e, "tgt", tr, v);
    if (which === "tgt" && trackGet(e, "cur", tr) > v) trackSet(e, "cur", tr, v);
    plan[slot] = e; savePlan(plan);
    const fill = (x) => ((x - tr.min) / (tr.max - tr.min)) * 100 + "%";
    card.querySelectorAll(".lv-slider").forEach((x) => {
      const val = trackGet(e, x.dataset.w, tr);
      if (Number(x.value) !== val) x.value = val;
      x.style.setProperty("--fill", fill(val));
    });
    card.querySelector('[data-p="cur"]').textContent = trackGet(e, "cur", tr);
    card.querySelector('[data-p="tgt"]').textContent = trackGet(e, "tgt", tr);
    card.querySelector('[data-p="mats"]').innerHTML = trackMatsHtml(trackCost(svt, e, tr.kind, tr.i));
    $("#planSum").innerHTML = summary();
  };
}

// ---------- Long press ----------
function bindLongPress(root, selector, onLong) {
  let timer = null, startX = 0, startY = 0, target = null;
  const cancel = () => { clearTimeout(timer); timer = null; if (target) target.classList.remove("pressing"); target = null; };
  root.addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(selector); if (!el) return;
    target = el; startX = ev.clientX; startY = ev.clientY;
    el.classList.add("pressing");
    timer = setTimeout(() => {
      el.dataset.longpressed = "1";
      el.classList.remove("pressing");
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* ignore */ } }
      onLong(el);
      timer = null;
    }, 500);
  });
  root.addEventListener("pointermove", (ev) => {
    if (timer && (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10)) cancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((n) => root.addEventListener(n, () => { if (timer) cancel(); }));
  root.addEventListener("contextmenu", (ev) => { if (ev.target.closest(selector)) ev.preventDefault(); });
}

// ---------- Bottom sheet ----------
function openSheet(html, onClick) {
  const sh = $("#sheet");
  sh.innerHTML = `<div class="sheet-shade" data-close="1"></div><div class="sheet-panel">${html}</div>`;
  sh.classList.remove("hidden");
  sh.onclick = (ev) => {
    if (ev.target.closest("[data-close]")) { closeSheet(); return; }
    onClick && onClick(ev);
  };
}
function closeSheet() {
  const sh = $("#sheet");
  sh.classList.add("hidden");
  sh.innerHTML = "";
  sh.onclick = null;
}
function openSlotSheet(i) {
  const plan = loadPlan();
  const e = plan[i]; if (!e) return;
  openSheet(`
    <div class="sheet-title">${esc(e.name)}</div>
    <button class="opt" data-act="change"><span>${esc(t("planChange"))}</span></button>
    <button class="opt danger" data-act="remove"><span>${esc(t("planRemove"))}</span></button>
    <button class="opt" data-close="1"><span>${esc(t("cancel"))}</span></button>`, (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    closeSheet();
    if (b.dataset.act === "remove") {
      plan.splice(i, 1); savePlan(plan); renderPlan();
    } else openPicker(i);
  });
}

// ---------- Servant picker ----------
async function openPicker(slot) {
  if (!state.list || state.listLang !== settings.data) {
    try { await loadList(false); } catch (e) { toast(t("loadError")); return; }
  }
  const pk = { q: "", cls: "all", r: "all" };
  const present = new Map();
  for (const s of state.list) { const g = classGroup(s.cls); if (!present.has(g)) present.set(g, s.cid); }
  const classes = CLASS_ORDER.filter((c) => present.has(c)).concat([...present.keys()].filter((c) => !CLASS_ORDER.includes(c)));
  openSheet(`
    <div class="picker">
      <div class="picker-top">
        <input id="pkQ" class="search" type="search" placeholder="${esc(t("search"))}" autocomplete="off">
        <button class="icon-btn" data-close="1" aria-label="Close">✕</button>
      </div>
      <div class="chips" id="pkCls">
        <button class="chip active" data-cls="all">${esc(t("allClasses"))}</button>
        ${classes.map((c) => `<button class="chip icon-only" data-cls="${esc(c)}"><img src="${classIcon(present.get(c), 5)}" alt="${esc(className(c))}" onerror="this.replaceWith(document.createTextNode(this.alt))"></button>`).join("")}
      </div>
      <div class="chips" id="pkR">
        <button class="chip active" data-r="all">${esc(t("allRarities"))}</button>
        ${[5, 4, 3, 2, 1, 0].map((r) => `<button class="chip" data-r="${r}">${r}★</button>`).join("")}
      </div>
      <div class="picker-list" id="pkList"></div>
    </div>`, (ev) => {
    const c = ev.target.closest("[data-cls]");
    if (c) { pk.cls = c.dataset.cls; document.querySelectorAll("#pkCls .chip").forEach((x) => x.classList.toggle("active", x === c)); draw(); return; }
    const r = ev.target.closest("[data-r]");
    if (r) { pk.r = r.dataset.r; document.querySelectorAll("#pkR .chip").forEach((x) => x.classList.toggle("active", x === r)); draw(); return; }
    const pick = ev.target.closest("[data-pick]");
    if (pick) {
      const s = state.list.find((x) => String(x.id) === pick.dataset.pick);
      const plan = loadPlan();
      const dup = plan.findIndex((x) => x.id === s.id);
      if (dup >= 0 && dup !== slot) { closeSheet(); toast(t("planAlready", { n: dup + 1 })); location.hash = "#/plan/" + dup; return; }
      let i = slot;
      if (i < 0 || i >= plan.length) { plan.push(newPlanEntry(s)); i = plan.length - 1; }
      else plan[i] = newPlanEntry(s);
      savePlan(plan);
      closeSheet();
      if (state.curSvt) setBarActions(state.curSvt);
      location.hash = "#/plan/" + i;
    }
  });
  const draw = () => {
    const q = norm(pk.q.trim());
    const arr = state.list.filter((s) =>
      (pk.cls === "all" || classGroup(s.cls) === pk.cls) &&
      (pk.r === "all" || String(s.r) === pk.r) &&
      (!q || norm(s.name).includes(q) || norm(s.orig).includes(q) || String(s.no) === q))
      .sort((a, b) => b.no - a.no).slice(0, 150);
    $("#pkList").innerHTML = arr.map((s) => `
      <button class="svt" data-pick="${s.id}">
        <img class="face" src="${esc(s.face)}" alt="" loading="lazy" onerror="imgErr(this)">
        <div class="svt-main">
          <div class="svt-name">${esc(s.name)}</div>
          <div class="svt-meta"><span>${esc(className(s.cls))}</span><span class="stars">${stars(s.r)}</span></div>
        </div>
        <span class="no">#${s.no}</span>
      </button>`).join("") || `<div class="state">${esc(t("noResults"))}</div>`;
  };
  $("#pkQ").addEventListener("input", (e) => { pk.q = e.target.value; draw(); });
  draw();
}


// ---------- Where to farm a material ----------
const DROPS_URL = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/drops.json";
let DROPS = null;
async function loadDrops() {
  if (DROPS) return DROPS;
  const cached = store.get("drops_v2", null);
  if (cached && cached.data) DROPS = cached.data;
  if (!DROPS) {
    try { DROPS = await getJSON("drops.json"); } catch (e) { /* not bundled */ }
  }
  if (!cached || Date.now() - cached.ts > LIST_TTL) {
    try {
      const data = await getJSON(DROPS_URL + "?t=" + Math.floor(Date.now() / 3600000));
      DROPS = data;
      store.set("drops_v2", { ts: Date.now(), data });
    } catch (e) { /* keep */ }
  }
  return DROPS;
}

function dailyDaysFor(kind, classes) {
  const days = [];
  for (let d = 1; d <= 7; d++) {
    if (DAILY_SCHEDULE[kind][d].some((c) => classes.includes(c))) days.push(d);
  }
  if (days.length === 7) return t("everyDay");
  return days.map((d) => t("weekdays")[d - 1].slice(0, 3)).join(", ");
}

async function openItemSheet(id, name, icon) {
  openSheet(`<div class="state"><div class="spinner"></div>${esc(t("loading"))}</div>`);
  const rows = [];
  try { await loadDaily(); } catch (e) { /* optional */ }
  try { await loadDrops(); } catch (e) { /* optional */ }
  if (DAILY) {
    for (const q of DAILY.quests) {
      const d = q.drops.find((x) => x.type === "item" && String(x.id) === String(id));
      if (!d || !d.rate) continue;
      rows.push({
        title: `${q.kind === "tg" ? t("trainingGrounds") : t("emberGathering")} · ${q.classes.map(className).join("/")} (${t("tiers")[q.tier] || "?"})`,
        sub: `${t("daily")}: ${dailyDaysFor(q.kind, q.classes)}`,
        ap: q.ap, runs: q.runs, rate: d.rate,
      });
    }
  }
  if (DROPS && DROPS.items[String(id)]) {
    for (const [qi, rate] of DROPS.items[String(id)]) {
      const q = DROPS.quests[qi];
      const ja = settings.data === "ja";
      const spot = (ja && q.jspot) || q.spot || "";
      const quest = (ja && q.jname) || q.name || "";
      const war = (ja && q.jwar) || q.war || "";
      rows.push({
        title: spot || quest,
        sub: [quest !== spot ? quest : "", war].filter((x) => x && x !== "-").join(" · "),
        ap: q.ap, runs: q.runs, rate,
      });
    }
  }
  rows.sort((a, b) => a.ap / a.rate - b.ap / b.rate);
  const top = rows.slice(0, 15);
  openSheet(`
    <div class="item-head">
      <img src="${esc(icon)}" alt="" onerror="imgErr(this)">
      <div><div class="sheet-title" style="padding:0">${esc(name)}</div><div class="d-sub">${esc(t("whereFarm"))}</div></div>
      <button class="icon-btn" data-close="1" aria-label="Close">✕</button>
    </div>
    ${top.length ? `
      <div class="drops-head"><span>${esc(t("location"))}</span><span>${esc(t("ratePerRun"))}</span></div>
      <div class="item-rows">${top.map((r) => `
        <div class="drop">
          <span class="drop-name"><b>${esc(r.title)}</b><small>${r.sub ? esc(r.sub) + "<br>" : ""}${r.ap} AP · ${fmt(r.runs)} ${esc(t("runsShort"))}</small></span>
          <span class="drop-rate"><b>${num(r.rate * 100, 1)}%</b><small>${num(r.ap / r.rate, 1)} ${esc(t("apPerDrop"))}</small></span>
        </div>`).join("")}</div>
      <p class="footer-note" style="margin-top:12px">${esc(t("dropsNote"))}</p>`
    : `<div class="state">${esc(t("noDrops"))}</div>`}`);
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-item]");
  if (!el || !el.dataset.item) return;
  openItemSheet(el.dataset.item, el.dataset.iname || "", el.dataset.icon || "");
});


// ---------- Banners (current summons, NA / JP) ----------
const BANNERS_URL = "https://raw.githubusercontent.com/Anuxi007/fatego-app/main/data/banners.json";
let BANNERS = null;
async function loadBanners() {
  const cached = store.get("banners", null);
  if (cached && cached.data && Date.now() - cached.ts < 60 * 60 * 1000) return (BANNERS = cached.data);
  try {
    const data = await getJSON(BANNERS_URL + "?t=" + Math.floor(Date.now() / 600000));
    store.set("banners", { ts: Date.now(), data });
    BANNERS = data;
  } catch (e) {
    if (cached && cached.data) BANNERS = cached.data; else throw e;
  }
  return BANNERS;
}
const SERVER_TZ = { NA: "America/Los_Angeles", JP: "Asia/Tokyo" };
function tzLabel(region) {
  if (region === "JP") return "JST (UTC+9)";
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: SERVER_TZ.NA, timeZoneName: "short" }).formatToParts(new Date());
    const n = (p.find((x) => x.type === "timeZoneName") || {}).value || "PT";
    return n === "PDT" ? "PDT (UTC−7)" : n === "PST" ? "PST (UTC−8)" : n;
  } catch (e) { return "PT"; }
}
function serverDate(ts, region, withDay) {
  const loc = settings.ui === "ja" ? "ja-JP" : settings.ui === "es" ? "es-PE" : "en-US";
  const o = { timeZone: SERVER_TZ[region], day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  if (withDay) o.weekday = "short";
  try { return new Intl.DateTimeFormat(loc, o).format(new Date(ts * 1000)); } catch (e) { return new Date(ts * 1000).toLocaleString(); }
}
function countdown(end) {
  let s = Math.max(0, Math.floor(end - Date.now() / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return (d ? `${d}${t("daysShort")} ` : "") + `${p2(h)}:${p2(m)}:${p2(s)}`;
}
function bannerName(b) {
  const raw = String((settings.data === "ja" ? b.jname : b.name) || b.name || "").replace(/\s*\n\s*/g, " ");
  // JP banners have no English name in the API: name them after their featured units instead
  if (settings.data !== "ja" && /[\u3040-\u30ff\u4e00-\u9fff]/.test(raw) && b.f.length && BANNERS) {
    const names = b.f.map((i) => (BANNERS.units[String(i)] || {}).n).filter(Boolean);
    if (names.length) return `${b.type === "friendPoint" ? t("bnFp") : t("bnQuartz")}: ${names.slice(0, 3).join(" · ")}${names.length > 3 ? " …" : ""}`;
  }
  return raw;
}
function bannerOrig(b) {
  const raw = String(b.jname || b.name || "").replace(/\s*\n\s*/g, " ");
  return raw !== bannerName(b) ? raw : "";
}
// Full artwork of a featured servant (final ascension, falling back to the first one, then the face)
function svtArt(id) {
  const u = BANNERS && BANNERS.units[String(id)];
  const base = `https://static.atlasacademy.io/JP/CharaGraph/${id}/${id}`;
  return `<img src="${base}b@2.png" data-fb="${base}a@1.png|${esc((u && u.f) || "")}" alt="" loading="lazy" onerror="artFallback(this)">`;
}
window.artFallback = (img) => {
  const list = (img.dataset.fb || "").split("|").filter(Boolean);
  if (!list.length) { img.onerror = null; img.style.visibility = "hidden"; return; }
  img.dataset.fb = list.slice(1).join("|");
  img.src = list[0];
};
function unitFace(id, size) {
  const u = BANNERS && BANNERS.units[String(id)];
  if (!u) return "";
  const ce = u.k === "c";
  return `<span class="bf ${ce ? "ce" : ""}" style="--s:${size || 34}px" ${ce ? `data-ce="${id}"` : `data-svt="${id}"`}>
    <img src="${esc(u.f)}" alt="" loading="lazy" onerror="imgErr(this)"><em>${ce ? "CE" : u.r + "★"}</em></span>`;
}
let bannerTimer = null;
function tickBanners() {
  const els = document.querySelectorAll("[data-end]");
  if (!els.length) { clearInterval(bannerTimer); bannerTimer = null; return; }
  const now = Date.now() / 1000;
  els.forEach((el) => {
    const end = Number(el.dataset.end), start = Number(el.dataset.start || 0);
    if (el.classList.contains("cd-txt")) el.textContent = "⏱ " + countdown(end);
    else if (el.classList.contains("cd-big")) el.textContent = countdown(end);
    else if (el.classList.contains("bbar")) el.firstElementChild.style.width = Math.min(100, ((now - start) / (end - start)) * 100) + "%";
  });
}
async function renderBanners() {
  setHeader(esc(t("bannersTitle")), false);
  renderLoading();
  try { await loadBanners(); } catch (e) { return renderError(renderBanners); }
  if (currentRoute().name !== "banners") return;
  if (!state.bannerRegion) state.bannerRegion = store.get("bannerRegion", settings.data === "ja" ? "JP" : "NA");
  if (!state.bannerKind) state.bannerKind = "all";
  const draw = () => {
    const region = state.bannerRegion;
    const now = Date.now() / 1000;
    const all = ((BANNERS.regions[region] || {}).banners || []).filter((b) => b.start <= now && b.end > now);
    const list = all.filter((b) => state.bannerKind === "all" || (state.bannerKind === "fp") === (b.type === "friendPoint"))
      .sort((a, b) => a.end - b.end || a.start - b.start);
    view.innerHTML = `
      <div class="asel-seg" id="bRegion">${["NA", "JP"].map((r) => `<button class="asel ${r === region ? "on" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
      <div class="chips" id="bKind">
        ${[["all", t("all") + " · " + all.length], ["stone", t("bnQuartz")], ["fp", t("bnFp")]].map(([k, l]) =>
          `<button class="chip ${state.bannerKind === k ? "active" : ""}" data-k="${k}">${esc(l)}</button>`).join("")}
      </div>
      <div class="b-tz"><span>${esc(t("serverTime"))}: <b>${esc(tzLabel(region))}</b></span><span class="live"><i></i>${esc(t("activeN", { n: all.length }))}</span></div>
      ${list.length ? list.map((b) => {
        const left = b.end - now;
        const ids = b.f.slice(0, 6);
        return `<div class="bnC ${left < 86400 ? "urg" : ""}" data-b="${b.id}">
          <div class="bnC-art">${ids.map((id) => svtArt(id)).join("")}</div>
          <span class="b-tag">${esc(b.type === "friendPoint" ? t("bnFp") : t("bnQuartz"))}</span>
          <span class="bnC-cd cd-txt" data-end="${b.end}">⏱ ${countdown(b.end)}</span>
          <div class="bnC-nm">${esc(bannerName(b))}</div>
          <div class="bnC-bot">
            <div class="bnC-row">
              <span class="bnC-dt">${esc(serverDate(b.start, region))} → ${esc(serverDate(b.end, region))}</span>
              <span class="bnC-faces">${b.f.slice(0, 5).map((id) => unitFace(id, 30)).join("")}</span>
            </div>
            <div class="bbar" data-end="${b.end}" data-start="${b.start}"><i style="width:${Math.min(100, ((now - b.start) / (b.end - b.start)) * 100)}%"></i></div>
          </div>
        </div>`;
      }).join("") : `<div class="state">${esc(t("noBanners"))}</div>`}
      <p class="footer-note">${esc(t("bannersNote"))}</p>`;
    if (!bannerTimer) bannerTimer = setInterval(tickBanners, 1000);
  };
  draw();
  view.onclick = (e) => {
    const r = e.target.closest("[data-r]");
    if (r) { state.bannerRegion = r.dataset.r; store.set("bannerRegion", r.dataset.r); return draw(); }
    const k = e.target.closest("[data-k]");
    if (k) { state.bannerKind = k.dataset.k; return draw(); }
    const sv = e.target.closest("[data-svt]");
    if (sv) { location.hash = "#/s/" + sv.dataset.svt; return; }
    const row = e.target.closest("[data-b]");
    if (row) openBannerSheet(state.bannerRegion, Number(row.dataset.b));
  };
}
function openBannerSheet(region, id) {
  const b = ((BANNERS.regions[region] || {}).banners || []).find((x) => x.id === id);
  if (!b) return;
  const svts = b.f.filter((i) => (BANNERS.units[String(i)] || {}).k !== "c");
  const ces = b.f.filter((i) => (BANNERS.units[String(i)] || {}).k === "c");
  const row = (i) => {
    const u = BANNERS.units[String(i)]; if (!u) return "";
    const name = settings.data === "ja" ? u.j || u.n : u.n;
    return `<div class="bd-it" ${u.k === "c" ? `data-ce="${i}"` : `data-svt="${i}"`}>${unitFace(i, 44)}
      <div><b>${esc(name)}</b><small><span class="stars">${stars(u.r)}</span>${u.c ? " · " + esc(className(u.c)) : ""}</small></div><span class="go">›</span></div>`;
  };
  openSheet(`
    <div class="bd-head"><div><span class="b-tag">${esc(b.type === "friendPoint" ? t("bnFp") : t("bnQuartz"))}</span>
      <div class="sheet-title" style="padding:6px 0 0">${esc(bannerName(b))}</div>
      ${bannerOrig(b) ? `<div class="d-sub">${esc(bannerOrig(b))}</div>` : ""}</div>
      <button class="icon-btn" data-close="1" aria-label="Close">✕</button></div>
    <div class="bd-times">
      <div><small>${esc(t("bnStart"))}</small><b>${esc(serverDate(b.start, region, true))}</b></div>
      <div><small>${esc(t("bnEnd"))}</small><b>${esc(serverDate(b.end, region, true))}</b></div>
    </div>
    <div class="bd-cd"><small>${esc(t("endsIn"))}</small><b class="cd-big" data-end="${b.end}">${countdown(b.end)}</b></div>
    <div class="b-tz" style="margin:8px 2px 0"><span>${esc(t("serverTime"))}: <b>${esc(tzLabel(region))}</b></span></div>
    ${reminderBox(region, b)}
    ${svts.length ? `<h3 class="bd-h">${esc(t("featuredSvts"))} <span>${svts.length}</span></h3><div class="bd-list">${svts.map(row).join("")}</div>` : ""}
    ${ces.length ? `<h3 class="bd-h">${esc(t("featuredCes"))} <span>${ces.length}</span></h3><div class="bd-list">${ces.map(row).join("")}</div>` : ""}
  `, (ev) => {
    const rm = ev.target.closest("[data-rem]");
    if (rm) { toggleReminder(region, b, Number(rm.dataset.rem), rm); return; }
    const sv = ev.target.closest("[data-svt]");
    if (sv) { closeSheet(); location.hash = "#/s/" + sv.dataset.svt; return; }
    const ce = ev.target.closest("[data-ce]");
    if (ce) { closeSheet(); location.hash = "#/ce/" + ce.dataset.ce; }
  });
  if (!bannerTimer) bannerTimer = setInterval(tickBanners, 1000);
}

// Banner "ends soon" reminders (off by default). Banners that last a day or less only offer 12 h and 1 h.
function reminderKey(region, b, h) { return `${region}:${b.id}:${h}`; }
function reminderBox(region, b) {
  const app = nativeApp();
  if (!app || !app.scheduleReminder) return "";
  const saved = store.get("bnRem", {});
  const opts = b.end - b.start <= 86400 ? [12, 1] : [24, 12, 1];
  const now = Date.now() / 1000;
  return `<div class="rem-box">
    <div class="rem-h">🔔 ${esc(t("remHead"))}</div>
    <div class="rem-opts">${opts.map((h) => {
      const past = b.end - h * 3600 <= now;
      const on = !past && saved[reminderKey(region, b, h)];
      return `<button class="rem ${on ? "on" : ""}" data-rem="${h}" ${past ? "disabled" : ""}>${on ? "✓ " : ""}${esc(t("remBefore", { h }))}</button>`;
    }).join("")}</div>
  </div>`;
}
function toggleReminder(region, b, h, btn) {
  const app = nativeApp();
  const saved = store.get("bnRem", {});
  const key = reminderKey(region, b, h);
  if (saved[key]) {
    delete saved[key];
    app.cancelReminder(key);
    btn.classList.remove("on");
    btn.textContent = t("remBefore", { h });
  } else {
    const at = (b.end - h * 3600) * 1000;
    if (at <= Date.now()) return;
    const r = app.scheduleReminder(key, at, `⏰ ${bannerName(b)}`, t("remText", { h, r: region }), "banners");
    saved[key] = b.end;
    btn.classList.add("on");
    btn.textContent = "✓ " + t("remBefore", { h });
    toast(t(r === "perm" ? "remPerm" : "remSet"));
  }
  // forget reminders of banners that already ended
  const now = Date.now() / 1000;
  for (const k in saved) if (saved[k] < now) delete saved[k];
  store.set("bnRem", saved);
}

// ---------- Craft Essences ----------
function ceListUrl(lang) {
  return lang === "ja" ? `${API}/export/JP/basic_equip.json` : `${API}/export/JP/basic_equip_lang_en.json`;
}
async function loadCeList() {
  const lang = settings.data;
  if (state.ceList && state.ceLang === lang) return state.ceList;
  const key = "celist_" + lang;
  const cached = store.get(key, null);
  if (cached && cached.items && Date.now() - cached.ts < LIST_TTL) {
    state.ceList = cached.items; state.ceLang = lang; return state.ceList;
  }
  const raw = await getJSON(ceListUrl(lang));
  const items = raw.filter((x) => x.collectionNo > 0).map((x) => ({
    id: x.id, no: x.collectionNo, name: x.name, r: x.rarity, face: x.face,
    cat: x.bondEquipOwner ? "bond" : x.valentineEquipOwner ? "valentine" : (x.flags || []).includes("svtEquipExp") ? "exp" : "normal",
  }));
  store.set(key, { ts: Date.now(), items });
  state.ceList = items; state.ceLang = lang;
  return items;
}
async function renderCeList() {
  setHeader(esc(t("ceMenu")), false);
  if (!state.ceList || state.ceLang !== settings.data) {
    renderLoading();
    try { await loadCeList(); } catch (e) { return renderError(renderCeList); }
    if (currentRoute().name !== "ceList") return;
  }
  const f = state.ceF || (state.ceF = { q: "", r: "all", cat: "all", desc: true });
  view.innerHTML = `
    <input id="ceQ" class="search" type="search" placeholder="${esc(t("search"))}" value="${esc(f.q)}" autocomplete="off">
    <div class="chips" id="ceR">
      <button class="chip ${f.r === "all" ? "active" : ""}" data-r="all">${esc(t("allRarities"))}</button>
      ${[5, 4, 3, 2, 1].map((r) => `<button class="chip ${String(f.r) === String(r) ? "active" : ""}" data-r="${r}">${r}★</button>`).join("")}
    </div>
    <div class="row-ctrl">
      <div class="chips" id="ceC" style="margin:0;flex:1">
        ${[["all", "all"], ["normal", "ceNormal"], ["bond", "ceBondCat"], ["valentine", "ceValentine"]].map(([v, k]) =>
          `<button class="chip ${f.cat === v ? "active" : ""}" data-c="${v}">${esc(t(k))}</button>`).join("")}
      </div>
      <button class="sort invert ${f.desc ? "on" : ""}" id="ceInv" aria-label="${esc(t("invert"))}">⇅</button>
    </div>
    <div class="count" id="ceCount" style="margin:6px 2px"></div>
    <div class="list" id="ceListEl"></div>`;
  const draw = () => {
    const q = norm(f.q.trim());
    let arr = state.ceList.filter((c) =>
      (f.r === "all" || String(c.r) === String(f.r)) &&
      (f.cat === "all" ? c.cat !== "exp" : c.cat === f.cat) &&
      (!q || norm(c.name).includes(q) || String(c.no) === q));
    arr.sort((a, b) => (f.desc ? b.no - a.no : a.no - b.no));
    $("#ceCount").textContent = t("results", { n: arr.length });
    $("#ceListEl").innerHTML = arr.slice(0, 300).map((c) => `
      <a class="svt" href="#/ce/${c.id}">
        <img class="face ce-face" src="${esc(c.face)}" alt="" loading="lazy" onerror="imgErr(this)">
        <div class="svt-main"><div class="svt-name">${esc(c.name)}</div>
          <div class="svt-meta"><span class="stars">${stars(c.r)}</span>${c.cat !== "normal" ? `<span class="ce-cat">${esc(t(c.cat === "bond" ? "ceBondCat" : c.cat === "valentine" ? "ceValentine" : "ceExp"))}</span>` : ""}</div></div>
        <span class="no">#${c.no}</span>
      </a>`).join("") || `<div class="state">${esc(t("noResults"))}</div>`;
  };
  draw();
  $("#ceQ").addEventListener("input", (e) => { f.q = e.target.value; draw(); });
  $("#ceR").addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (!b) return; f.r = b.dataset.r; $("#ceR").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b)); draw(); });
  $("#ceC").addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (!b) return; f.cat = b.dataset.c; $("#ceC").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b)); draw(); });
  $("#ceInv").addEventListener("click", (e) => { f.desc = !f.desc; e.currentTarget.classList.toggle("on", f.desc); draw(); });
}
async function loadCe(id) {
  const key = "ce:" + settings.data + ":" + id;
  if (state.details[key]) return state.details[key];
  let ce;
  if (settings.data === "ja") ce = await getJSON(`${API}/nice/JP/equip/${id}?lore=true`);
  else {
    try { ce = await getJSON(`${API}/nice/NA/equip/${id}?lore=true`); }
    catch (e) { if (e.status !== 404) throw e; ce = await getJSON(`${API}/nice/JP/equip/${id}?lang=en&lore=true`); ce._partial = true; }
  }
  state.details[key] = ce;
  return ce;
}
async function renderCeDetail(id) {
  setHeader("", true);
  renderLoading();
  window.scrollTo(0, 0);
  let ce;
  try { ce = await loadCe(id); } catch (e) { return renderError(() => renderCeDetail(id)); }
  const r = currentRoute();
  if (r.name !== "ceDetail" || r.id !== String(id)) return;
  $("#title").textContent = ce.name;
  const g = (ce.extraAssets && ce.extraAssets.charaGraph && ce.extraAssets.charaGraph.equip) || {};
  const img = Object.values(g)[0];
  const skills = (ce.skills || []).slice().sort((a, b) => (a.condLimitCount || 0) - (b.condLimitCount || 0) || (a.priority || 0) - (b.priority || 0));
  const prof = ce.profile || {};
  const lore = (prof.comments || []).map((c) => c.comment).filter(Boolean)[0];
  const owner = ce.bondEquipOwner || ce.valentineEquipOwner;
  const ownerSvt = owner && state.list && state.list.find((s) => s.id === owner);
  view.innerHTML = `
    ${ce._partial && t("notInNA") ? `<div class="notice">${esc(t("notInNA"))}</div>` : ""}
    <div class="ce-top">
      ${img ? `<img class="ce-art" id="ceArt" src="${esc(img)}" alt="" onerror="imgErr(this)">` : ""}
      <div class="ce-info">
        <div class="dhero-no">Nº ${ce.collectionNo}</div>
        <h2 class="ce-name">${esc(ce.name)}</h2>
        <div class="stars" style="font-size:16px">${stars(ce.rarity)}</div>
        <div class="p-foot" style="padding-top:10px">
          <span>${esc(t("cost"))} <b>${fmt(ce.cost)}</b></span>
          <span>${esc(t("maxLvShort"))} <b>${fmt(ce.lvMax)}</b></span>
        </div>
        ${owner ? `<a class="ce-owner" href="#/s/${owner}">${esc(t(ce.bondEquipOwner ? "ceBondOf" : "ceValentineOf"))}: <b>${esc(ownerSvt ? ownerSvt.name : "#" + owner)}</b> ›</a>` : ""}
        ${prof.illustrator ? `<div class="ce-ill">${esc(t("illustrator"))}: <b>${esc(prof.illustrator)}</b></div>` : ""}
      </div>
    </div>
    <div class="section"><h2>${esc(t("stats"))}</h2>
      <div class="card scard ce-st">
        <div class="srow"><span>ATK</span>${bar((ce.atkMax || 0) / 2500, "linear-gradient(90deg,#ff8a5b,#ffb36b)")}<em>${fmt(ce.atkBase)} → ${fmt(ce.atkMax)}</em></div>
        <div class="srow"><span>HP</span>${bar((ce.hpMax || 0) / 2500, "linear-gradient(90deg,#4fd1a5,#7be3c0)")}<em>${fmt(ce.hpBase)} → ${fmt(ce.hpMax)}</em></div>
      </div>
    </div>
    ${skills.length ? `<div class="section"><h2>${esc(t("ceEffect"))}</h2><div class="card">${skills.map((sk) => `
      <div class="skill">
        <img class="skill-icon" src="${esc(sk.icon)}" alt="" loading="lazy" onerror="imgErr(this)">
        <div class="skill-main">
          <div class="skill-name">${esc((sk.condLimitCount || 0) >= 4 ? t("ceMLB") : t("ceBase"))}</div>
          <div class="skill-detail">${fillDetail(sk, 1, true)}</div>
          <div class="fx-list">${effectRows(sk, 1)}</div>
        </div>
      </div>`).join("")}</div></div>` : ""}
    ${lore ? `<div class="section"><h2>${esc(t("ceLore"))}</h2><div class="card ce-lore">${esc(lore)}</div></div>` : ""}
    <a class="link-btn" href="https://apps.atlasacademy.io/db/${ce._partial || settings.data === "ja" ? "JP" : "NA"}/craft-essence/${ce.collectionNo}">${esc(t("openAtlas"))} ↗</a>`;
  const art = $("#ceArt");
  if (art && img) art.addEventListener("click", () => showViewer(ce.name, [{ kind: "asc", label: "CE", short: "CE", url: img }], 0));
}

// ---------- View: settings ----------
function renderSettings() {
  setHeader(esc(t("settings")), false);
  view.innerHTML = `
    <div class="section">
      <h2>${esc(t("uiLanguage"))}</h2>
      <div class="opt-list" id="uiOpts">
        ${UI_LANGS.map((l) => `
          <button class="opt ${settings.ui === l ? "active" : ""}" data-l="${l}">
            <span>${esc(I18N[l].langName)}</span>${settings.ui === l ? '<span class="check">✓</span>' : ""}
          </button>`).join("")}
      </div>
    </div>
    <div class="section">
      <h2>${esc(t("dataLanguage"))}</h2>
      <div class="opt-list" id="dataOpts">
        ${[["en", "dataEn"], ["ja", "dataJa"]].map(([l, k]) => `
          <button class="opt ${settings.data === l ? "active" : ""}" data-l="${l}">
            <span>${esc(t(k))}</span>${settings.data === l ? '<span class="check">✓</span>' : ""}
          </button>`).join("")}
      </div>
      <p class="note">${esc(t("dataNote"))}</p>
      ${settings.ui === "es" ? `
        <button class="opt ${settings.trGame !== false ? "active" : ""}" id="trToggle" style="margin-top:10px">
          <span>${esc(t("trGame"))}</span><span class="check">${settings.trGame !== false ? "✓" : ""}</span>
        </button>
        <p class="note">${esc(t("trNote"))}</p>` : ""}
    </div>
    <div class="section" style="text-align:center">
      <button class="btn ghost" id="refreshBtn">↻ ${esc(t("refresh"))}</button>
    </div>
    ${nativeApp() ? `
    <div class="section">
      <h2>${esc(t("updSection"))}</h2>
      <div class="card upd-card">
        <span>${esc(t("currentVersion"))}: <b>${esc(nativeApp().getVersionName())}</b></span>
        <button class="btn ghost" id="updCheckBtn">${esc(t("updCheck"))}</button>
      </div>
      <button class="opt ${nativeApp().getNotifications() ? "active" : ""}" id="notifToggle" style="margin-top:10px">
        <span>${esc(t("notifications"))}</span><span class="check">${nativeApp().getNotifications() ? "✓" : ""}</span>
      </button>
      <p class="note">${esc(t("notifNote"))}</p>
    </div>` : ""}
    <p class="footer-note">${esc(t("source"))}<br><a href="https://github.com/Anuxi007/fatego-app/blob/main/PRIVACY.md">${esc(t("privacy"))}</a></p>
  `;
  $("#uiOpts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-l]"); if (!b) return;
    const prevUi = settings.ui;
    settings.ui = b.dataset.l;
    // Japanese UI pairs naturally with Japanese data; switching away goes back to English data
    if (settings.ui === "ja") settings.data = "ja";
    else if (prevUi === "ja") settings.data = "en";
    saveSettings();
    renderSettings();
  });
  $("#dataOpts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-l]"); if (!b) return;
    settings.data = b.dataset.l;
    saveSettings();
    renderSettings();
  });
  const notifBtn = $("#notifToggle");
  if (notifBtn) notifBtn.addEventListener("click", () => {
    nativeApp().setNotifications(!nativeApp().getNotifications());
    renderSettings();
  });
  const updBtn = $("#updCheckBtn");
  if (updBtn) updBtn.addEventListener("click", () => checkForUpdate(true));
  const trBtn = $("#trToggle");
  if (trBtn) trBtn.addEventListener("click", () => {
    settings.trGame = settings.trGame === false;
    saveSettings();
    renderSettings();
  });
  $("#refreshBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      state.details = {};
      store.set("tr_es", null);
      TR = null;
      await Promise.all([loadList(true), loadTranslations()]);
      toast(t("refreshed"));
    } catch (err) {
      toast(t("loadError"));
    }
    btn.disabled = false;
  });
}

// ---------- Start ----------
route();
loadIndex();
syncNativeLang();
window.__onLaunchAction = () => {
  const app = nativeApp();
  if (!app || !app.consumeLaunchAction) return;
  const a = app.consumeLaunchAction();
  if (a === "update") checkForUpdate(true);
  else if (a.startsWith("servant:")) location.hash = "#/s/" + a.slice(8);
  else if (a === "banners") location.hash = "#/banners";
};
window.__onLaunchAction();
setTimeout(() => checkForUpdate(false), 1500);
