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
  details: {},          // cache: lang:id -> servant
  ascTab: {},           // selected artwork per servant
  lv: {},               // slider level per skill section
};
Object.assign(state, store.get("filters", {}));

function saveFilters() {
  store.set("filters", { cls: state.cls, rarity: state.rarity, sort: state.sort });
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
      <span class="count" id="count"></span>
      <select id="sort" class="sort">
        ${[["no", "sortNo"], ["rarity", "sortRarity"], ["atk", "sortAtk"], ["hp", "sortHp"], ["name", "sortName"]]
          .map(([v, k]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>${esc(t(k))}</option>`).join("")}
      </select>
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
  $("#list").addEventListener("click", (e) => {
    const a = e.target.closest("[data-id]"); if (!a) return;
    lastListScroll = window.scrollY;
    location.hash = "#/s/" + a.dataset.id;
  });

  renderListResults();
  window.scrollTo(0, lastListScroll);
}

function filteredList() {
  const q = norm(state.query.trim());
  let arr = state.list.filter((s) => {
    if (state.cls !== "all" && classGroup(s.cls) !== state.cls) return false;
    if (state.rarity !== "all" && String(s.r) !== String(state.rarity)) return false;
    if (q && !norm(s.name).includes(q) && !norm(s.orig).includes(q) && String(s.no) !== q) return false;
    return true;
  });
  const by = {
    no: (a, b) => a.no - b.no,
    rarity: (a, b) => b.r - a.r || a.no - b.no,
    atk: (a, b) => b.atk - a.atk,
    hp: (a, b) => b.hp - a.hp,
    name: (a, b) => a.name.localeCompare(b.name, settings.data === "ja" ? "ja" : "en"),
  }[state.sort] || ((a, b) => a.no - b.no);
  return arr.sort(by);
}

function renderListResults() {
  const listEl = $("#list"); if (!listEl) return;
  const arr = filteredList();
  $("#count").textContent = t("results", { n: arr.length });
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
  try { svt = await loadServant(id); } catch (e) { return renderError(() => renderDetail(id)); }
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
        <div><div class="k">${esc(t("class"))}</div><div class="v"><img src="${classIcon(svt.classId, svt.rarity)}" alt="" onerror="imgErr(this)">${esc(className(svt.className))}</div></div>
        <div><div class="k">${esc(t("attribute"))}</div><div class="v">${esc(attrName(svt.attribute))}</div></div>
        <div><div class="k">${esc(t("gender"))}</div><div class="v">${esc((t("genders")[svt.gender]) || svt.gender || "–")}</div></div>
        <div><div class="k">${esc(t("cost"))}</div><div class="v">${fmt(svt.cost)}</div></div>
        <div><div class="k">${esc(t("starGen"))}</div><div class="v">${pct(svt.starGen)}</div></div>
        <div><div class="k">${esc(t("starAbsorb"))}</div><div class="v">${fmt(svt.starAbsorb)}</div></div>
        <div><div class="k">${esc(t("deathRate"))}</div><div class="v">${pct(svt.instantDeathChance)}</div></div>
        <div><div class="k">${esc(t("maxLevel"))}</div><div class="v">${fmt(svt.lvMax)}</div></div>
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

    ${npSection(svt)}
    ${levelSection("skills", t("skills"), latestPerNum(svt.skills), svt.skillMaterials)}
    ${levelSection("append", t("appendSkills"), appendList(svt), svt.appendSkillMaterials)}
    ${passiveSection(svt)}
    ${matsSection(t("ascension"), svt.ascensionMaterials, (k) => `${t("stage")} ${Number(k) + 1}`)}
    ${totalsSection(svt)}

    <a class="link-btn" href="https://apps.atlasacademy.io/db/${region}/servant/${svt.collectionNo}">${esc(t("openAtlas"))} ↗</a>
    <p class="footer-note">${esc(t("source"))}</p>
  `;

  bindLevelSection("skills", svt, latestPerNum(svt.skills), svt.skillMaterials);
  bindLevelSection("append", svt, appendList(svt), svt.appendSkillMaterials);

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

function npSection(svt) {
  const nps = svt.noblePhantasms || [];
  if (!nps.length) return "";
  // keep one entry per distinct NP (name + rank + detail), latest last
  const seen = new Set();
  const list = [];
  for (const np of nps) {
    const key = [np.name, np.rank, cleanText(np.detail)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(np);
  }
  return `
    <div class="section">
      <h2>${esc(t("np"))}</h2>
      <div class="card">
        ${list.map((np) => {
          const type = CARD_TYPES[String(np.card)] || "buster";
          return `
          <div class="skill">
            <div class="np-card c-${type}">${type.toUpperCase()}</div>
            <div>
              <div class="skill-name">${esc(np.name)}${np.rank ? `<span class="badge">${esc(np.rank)}</span>` : ""}${np.type ? `<span class="badge">${esc(np.type)}</span>` : ""}</div>
              ${np.ruby && np.ruby !== "-" && np.ruby !== np.name ? `<div class="d-sub">${esc(np.ruby)}</div>` : ""}
              <div class="skill-detail">${esc(cleanText(np.detail))}</div>
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

function latestPerNum(skills) {
  const byNum = {};
  for (const s of skills || []) {
    const n = s.num || 0;
    if (!byNum[n]) byNum[n] = [];
    byNum[n].push(s);
  }
  return Object.keys(byNum).sort((a, b) => a - b).map((n) => {
    const arr = byNum[n];
    const latest = arr.reduce((a, b) => ((b.priority || 0) >= (a.priority || 0) ? b : a));
    return { skill: latest, upgrades: arr.length - 1 };
  });
}

// ---------- Skills with level slider ----------
function appendList(svt) {
  const byNum = {};
  for (const ap of svt.appendPassive || []) {
    if (ap && ap.skill) byNum[ap.num || 0] = ap.skill;
  }
  return Object.keys(byNum).sort((a, b) => a - b).map((n) => ({ skill: byNum[n], upgrades: 0 }));
}

function num(v, digits) {
  return Number(v).toLocaleString(settings.ui === "ja" ? "ja-JP" : settings.ui, { maximumFractionDigits: digits == null ? 2 : digits });
}

function fmtValue(fn, sv) {
  const v = sv.Value;
  if (v == null) return "";
  const ft = fn.funcType || "";
  const bt = (fn.buffs && fn.buffs[0] && fn.buffs[0].type) || "";
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
    const label = (buff && buff.name) || fn.funcPopupText || fn.funcType;
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

function skillsBody(list, lv) {
  return list.map(({ skill, upgrades }) => {
    const cd = skill.coolDown || [];
    const cdNow = cd.length ? cd[Math.min(lv, cd.length) - 1] : null;
    return `
      <div class="skill">
        <img class="skill-icon" src="${esc(skill.icon)}" alt="" loading="lazy" onerror="imgErr(this)">
        <div class="skill-main">
          <div class="skill-name">${esc(skill.name)}${upgrades ? `<span class="badge">▲${upgrades}</span>` : ""}${cdNow > 0 ? `<span class="badge cd">CD ${cdNow}</span>` : ""}</div>
          <div class="skill-detail">${esc(cleanText(skill.detail))}</div>
          <div class="fx-list">${effectRows(skill, lv)}</div>
        </div>
      </div>`;
  }).join("");
}

function levelMats(mats, lv) {
  if (!mats) return "";
  if (lv >= 10) return `<div class="mats-label"><span>${esc(t("level"))} 10</span><span>${esc(t("maxed"))}</span></div>`;
  const m = mats[String(lv)];
  if (!m || !m.items || !m.items.length) return "";
  return `
    <div class="mats-label"><span>${esc(t("level"))} ${lv} → ${lv + 1} · ${esc(t("perSkill"))}</span><span>QP ${fmt(m.qp)}</span></div>
    ${matTiles(m.items)}`;
}

function levelSection(key, title, list, mats) {
  if (!list.length) return "";
  const lv = state.lv[key] || 10;
  return `
    <div class="section">
      <h2>${esc(title)}</h2>
      <div class="card">
        <div class="lv-row">
          <span class="lv-label">${esc(t("level"))} <b id="lv-${key}">${lv}</b></span>
          <input type="range" class="lv-slider" id="slider-${key}" min="1" max="10" step="1" value="${lv}">
        </div>
        <div id="body-${key}">${skillsBody(list, lv)}</div>
        <div class="lv-mats" id="mats-${key}">${levelMats(mats, lv)}</div>
      </div>
    </div>`;
}

function bindLevelSection(key, svt, list, mats) {
  const slider = $("#slider-" + key);
  if (!slider) return;
  const paint = () => {
    const pctFill = ((slider.value - 1) / 9) * 100;
    slider.style.setProperty("--fill", pctFill + "%");
  };
  paint();
  slider.addEventListener("input", () => {
    const lv = Number(slider.value);
    state.lv[key] = lv;
    $("#lv-" + key).textContent = lv;
    $("#body-" + key).innerHTML = skillsBody(list, lv);
    $("#mats-" + key).innerHTML = levelMats(mats, lv);
    paint();
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
              <div class="skill-detail">${esc(cleanText(s.detail))}</div>
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
  $("#refreshBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      state.details = {};
      await loadList(true);
      toast(t("refreshed"));
    } catch (err) {
      toast(t("loadError"));
    }
    btn.disabled = false;
  });
}

// ---------- Start ----------
route();
