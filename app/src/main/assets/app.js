"use strict";

const API = "https://api.atlasacademy.io";
const LIST_TTL = 24 * 60 * 60 * 1000; // refresh the servant list once a day
const UI_LANGS = ["es", "en", "de", "ru", "ja"];
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
if (!settings.data) settings.data = settings.ui === "ja" ? "ja" : "en";
function saveSettings() { store.set("settings", settings); }

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
  lv: {},               // slider level per skill section
  ver: {},              // selected version (normal/upgraded) per skill
};
Object.assign(state, store.get("filters", {}));

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
    .replace(/\[\/?[a-zA-Z0-9]+\]/g, "")
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
    }));
}

async function loadList(force) {
  const lang = settings.data;
  const key = "list_" + lang;
  const cached = store.get(key, null);
  if (!force && cached && cached.items) {
    state.list = cached.items;
    state.listLang = lang;
    if (Date.now() - cached.ts > LIST_TTL) refreshListInBackground(lang);
    return;
  }
  const items = slim(await getJSON(listUrl(lang)));
  store.set(key, { ts: Date.now(), items });
  state.list = items;
  state.listLang = lang;
}

async function refreshListInBackground(lang) {
  try {
    const items = slim(await getJSON(listUrl(lang)));
    store.set("list_" + lang, { ts: Date.now(), items });
    if (state.listLang === lang) {
      state.list = items;
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
    svt = await getJSON(`${API}/nice/JP/servant/${id}`);
  } else {
    try {
      svt = await getJSON(`${API}/nice/NA/servant/${id}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      svt = await getJSON(`${API}/nice/JP/servant/${id}?lang=en`);
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
  return { name: "list" };
}

function setHeader(title, showBack) {
  $("#title").innerHTML = title;
  $("#backBtn").classList.toggle("hidden", !showBack);
  $("#settingsBtn").classList.toggle("hidden", currentRoute().name === "settings");
}

let lastListScroll = 0;
function route() {
  const r = currentRoute();
  document.documentElement.lang = settings.ui;
  if (r.name === "detail") renderDetail(r.id);
  else if (r.name === "settings") renderSettings();
  else renderList();
}

window.addEventListener("hashchange", () => {
  route();
});
$("#backBtn").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.hash = "#/";
});
$("#settingsBtn").addEventListener("click", () => {
  if (currentRoute().name === "list") lastListScroll = window.scrollY;
  location.hash = "#/settings";
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
    <div class="list" id="list"></div>
  `;

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
    <div class="d-head">
      ${face ? `<img class="face" src="${esc(face)}" alt="" onerror="imgErr(this)">` : ""}
      <div>
        <h2 class="d-name">${esc(svt.name)}</h2>
        <div class="d-sub">#${svt.collectionNo} · <span class="stars">${stars(svt.rarity)}</span> · ${esc(className(svt.className))}</div>
        ${svt.originalName && svt.originalName !== svt.name ? `<div class="d-sub">${esc(svt.originalName)}</div>` : ""}
      </div>
    </div>
    ${svt._partial && t("notInNA") ? `<div class="notice">${esc(t("notInNA"))}</div>` : ""}

    <div class="d-top">
      <div class="d-art">
        ${art.length ? `
          <div class="hero"><img id="heroImg" class="hero-img" src="${esc(art[tab].url)}" alt="" onerror="imgErr(this)"></div>
          ${art.length > 1 ? `<div class="asc-grid" id="artTabs">${art.map((a, i) =>
            `<button class="chip ${i === tab ? "active" : ""}" data-i="${i}" title="${esc(a.label)}">${esc(a.short)}</button>`).join("")}</div>` : ""}
        ` : ""}
      </div>
      <div class="card kv kv-side">
        ${kvRow(`<img class="kv-cls" src="${classIcon(svt.classId, svt.rarity)}" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment(icon('class')))">`, t("class"), esc(className(svt.className)))}
        ${kvRow("attribute", t("attribute"), esc(attrName(svt.attribute)))}
        ${kvRow(svt.gender === "male" ? "male" : svt.gender === "female" ? "female" : "unknown", t("gender"), esc((t("genders")[svt.gender]) || svt.gender || "–"))}
        ${kvRow("cost", t("cost"), fmt(svt.cost))}
        ${kvRow("star", t("starGen"), pct(svt.starGen))}
        ${kvRow("magnet", t("starAbsorb"), fmt(svt.starAbsorb))}
        ${kvRow("skull", t("deathRate"), pct(svt.instantDeathChance))}
        ${kvRow("level", t("maxLevel"), fmt(svt.lvMax))}
      </div>
    </div>

    <div class="section">
      <h2>${esc(t("stats"))}</h2>
      <div class="card">
        <table class="stat-table">
          <tr><th></th><th>${esc(t("base"))}</th><th>${esc(t("max"))} (Lv${svt.lvMax})</th>${grail(svt, 120) ? "<th>Lv120</th>" : ""}</tr>
          <tr><td>ATK</td><td>${fmt(svt.atkBase)}</td><td>${fmt(svt.atkMax)}</td>${grail(svt, 120) ? `<td>${fmt(svt.atkGrowth[119])}</td>` : ""}</tr>
          <tr><td>HP</td><td>${fmt(svt.hpBase)}</td><td>${fmt(svt.hpMax)}</td>${grail(svt, 120) ? `<td>${fmt(svt.hpGrowth[119])}</td>` : ""}</tr>
        </table>
      </div>
    </div>

    ${svt.cards && svt.cards.length ? `
    <div class="section">
      <h2>${esc(t("cards"))}</h2>
      <div class="deck">${svt.cards.map((c) => cardFace(c)).join("")}</div>
    </div>` : ""}

    ${levelSection("skills", t("skills"), versionsPerNum(svt.skills), svt.skillMaterials)}
    ${levelSection("np", t("np"), npList(svt), null)}
    ${levelSection("append", t("appendSkills"), appendList(svt), svt.appendSkillMaterials)}
    ${passiveSection(svt)}
    ${matsSection(t("ascension"), svt.ascensionMaterials, (k) => `${t("stage")} ${Number(k) + 1}`)}
    ${totalsSection(svt)}
    ${traitsSection(svt)}

    <a class="link-btn" href="https://apps.atlasacademy.io/db/${region}/servant/${svt.collectionNo}">${esc(t("openAtlas"))} ↗</a>
    <p class="footer-note">${esc(t("source"))}</p>
  `;

  bindLevelSection("skills", versionsPerNum(svt.skills), svt.skillMaterials);
  bindLevelSection("np", npList(svt), null);
  bindLevelSection("append", appendList(svt), svt.appendSkillMaterials);

  const tabs = $("#artTabs");
  if (tabs) tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]"); if (!b) return;
    const i = Number(b.dataset.i);
    state.ascTab[id] = i;
    const img = $("#heroImg");
    img.style.visibility = "";
    img.src = art[i].url;
    tabs.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
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
function traitLabel(name) {
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
    out.push(label);
  }
  if (!out.length) return "";
  return `
    <div class="section">
      <h2>${esc(t("traits"))}</h2>
      <div class="card traits">${out.map((l) => `<span class="trait">${esc(l)}</span>`).join("")}</div>
    </div>`;
}

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
    out.push({ label: `${t("stage")} ${k}`, short: `${t("stageShort")} ${k}`, url: asc[k] });
  });
  const cos = g.costume || {};
  const costumeNames = {};
  if (svt.profile && svt.profile.costume) {
    for (const k in svt.profile.costume) costumeNames[k] = svt.profile.costume[k].shortName || svt.profile.costume[k].name;
  }
  Object.keys(cos).forEach((k, i) => {
    const label = costumeNames[k] || `${t("art")} ${i + 1}`;
    out.push({ label, short: label, url: cos[k] });
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
  return `<div class="cardface c-${type}">${type.toUpperCase()}</div>`;
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

function effectRows(skill, lv) {
  const rows = [];
  for (const fn of skill.functions || []) {
    if (!fn || fn.funcType === "none" || !fn.svals || !fn.svals.length) continue;
    const sv = fn.svals[Math.min(lv, fn.svals.length) - 1] || {};
    const first = fn.svals[0] || {};
    const last = fn.svals[fn.svals.length - 1] || {};
    const buff = fn.buffs && fn.buffs[0];
    const label = /^damageNp/.test(fn.funcType || "") && !(buff && buff.name)
      ? t("npDamage")
      : tr((buff && buff.name) || fn.funcPopupText || fn.funcType);
    const parts = [];
    const val = fmtValue(fn, sv);
    if (val) parts.push(`<b>${esc(val)}</b>`);
    if (sv.Turn > 0) parts.push(`${sv.Turn}T`);
    if (sv.Count > 0) parts.push(`${sv.Count}×`);
    if (sv.Rate > 0 && sv.Rate < 1000) parts.push(`${num(sv.Rate / 10)}% ${esc(t("chance"))}`);
    const varies = first.Value !== last.Value || first.Rate !== last.Rate || first.Turn !== last.Turn || first.Count !== last.Count;
    rows.push(`<div class="fx ${varies ? "vary" : ""}"><span class="fx-l">${esc(cleanText(label))}</span><span class="fx-v">${parts.join(" · ") || "–"}</span></div>`);
  }
  return rows.join("");
}

// NA text uses placeholders like {{1:Value:m}} -> function #1, sval "Value", format m (÷10 %) / y (÷100 %)
function fillDetail(obj, lv) {
  const text = cleanText(tr(obj.detail));
  const fns = obj.functions || [];
  const parts = text.split(/(\{\{[^}]*\}\})/);
  return parts.map((p) => {
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
    ? `<div class="np-card c-${type}">${type.toUpperCase()}</div>`
    : `<img class="skill-icon" src="${esc(skill.icon)}" alt="" loading="lazy" onerror="imgErr(this)">`;
  const badges = isNP
    ? `${skill.rank ? `<span class="badge">${esc(skill.rank)}</span>` : ""}${skill.type ? `<span class="badge">${esc(skill.type)}</span>` : ""}`
    : `<span class="badge cd ${cd ? "" : "hidden"}" data-part="cd">${cd}</span>`;
  const toggle = entry.versions.length > 1 ? `
    <div class="ver-toggle">${entry.versions.map((_, k) =>
      `<button class="chip ${k === vi ? "active" : ""}" data-ver="${k}">${esc(versionLabel(k, entry.versions.length))}</button>`).join("")}
    </div>` : "";
  const unlock = vi > 0 && (skill.condQuestId > 0 || isNP) ? `<div class="d-sub unlock">🔓 ${esc(t("unlockQuest"))}</div>` : "";
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
        <div class="fx-list" data-part="fx">${effectRows(skill, lv)}</div>
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
    const lv = Number(slider.value);
    const entry = list[i];
    const skill = entry.versions[versionIndex(key, i, entry)];
    if (!state.lv[key]) state.lv[key] = {};
    state.lv[key][i] = lv;
    const block = slider.closest(".skill");
    block.querySelector('[data-part="lv"]').textContent = lv;
    block.querySelector('[data-part="fx"]').innerHTML = effectRows(skill, lv);
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
    <div class="mat" title="${esc(it.item.name)}">
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

// ---------- View: settings ----------
function renderSettings() {
  setHeader(esc(t("settings")), true);
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
    <p class="footer-note">${esc(t("source"))} · api.atlasacademy.io</p>
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
