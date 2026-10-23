// Daily Letterboxd → Trakt watchlist sync. Runs in GitHub Actions.
// Reads the public Letterboxd watchlist, adds films it hasn't seen before to the Trakt watchlist.
// Token and progress are kept in sync-state.enc, encrypted with the key inside the LB_SYNC_SETUP secret.
const crypto = require("crypto");
const fs = require("fs");

const CLIENT_ID = "5xPgUQBHAjVzms1T4rWmijKoiKQHdSybeR2HwdT0fOI";
const REDIRECT = "https://anasf317.github.io/watchlist/";
const STATE_FILE = "sync-state.enc";
const API = "https://api.trakt.tv";
// Trakt rejects requests that don't identify the app and the site it's registered for.
const BASE_HEADERS = { "User-Agent": "anasf317-watchlist-sync/1.0", "Origin": "https://anasf317.github.io", "Referer": REDIRECT };

if (!process.env.SETUP) { console.error("Missing the LB_SYNC_SETUP secret. Create it from the watchlist page's Setup panel."); process.exit(1); }
let setup;
try { setup = JSON.parse(Buffer.from(process.env.SETUP.trim(), "base64").toString("utf8")); }
catch { console.error("LB_SYNC_SETUP isn't a valid sync key. Create a new one on the watchlist page."); process.exit(1); }
const key = crypto.createHash("sha256").update(setup.k).digest();
const setupId = crypto.createHash("sha256").update(setup.r).digest("hex").slice(0, 16);

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const b = Buffer.from(fs.readFileSync(STATE_FILE, "utf8"), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const s = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    return s.setupId === setupId ? s : null; // a new sync key starts fresh
  } catch { return null; }
}
function writeState(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(s)), c.final()]);
  fs.writeFileSync(STATE_FILE, Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function parseFilms(html) {
  const films = new Map();
  const tagRe = /<[^>]*data-(?:item|film|target)-slug="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const slug = m[1].replace(/^\/?film\//, "").replace(/\/$/, "");
    if (films.has(slug)) continue;
    const attr = n => (tag.match(new RegExp(`data-${n}="([^"]*)"`)) || [])[1];
    let name = attr("item-name") || attr("film-name") || attr("item-full-display-name") || "";
    let year = attr("film-release-year") || attr("item-release-year") || "";
    name = decode(name);
    const ym = name.match(/^(.*)\s+\((\d{4})\)$/);
    if (ym) { name = ym[1]; year = year || ym[2]; }
    if (!name) {
      const sm = slug.match(/^(.*?)(?:-(\d{4}))?$/);
      name = sm[1].replace(/-/g, " ");
      year = year || sm[2] || "";
    }
    films.set(slug, { slug, title: name, year });
  }
  return [...films.values()];
}

async function fetchWatchlist(user) {
  const all = [];
  for (let page = 1; page <= 60; page++) {
    const url = `https://letterboxd.com/${user}/watchlist/page/${page}/`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (personal watchlist sync)", "Accept": "text/html" } });
    if (res.status === 404) { if (page === 1) throw new Error(`Letterboxd user "${user}" not found, or their watchlist is private.`); break; }
    if (!res.ok) throw new Error(`Letterboxd returned ${res.status} for ${url}. It may be blocking automated requests.`);
    const films = parseFilms(await res.text());
    if (!films.length) break;
    all.push(...films);
    await sleep(800);
  }
  return all;
}

async function trakt(path, { method = "GET", body, token } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { ...BASE_HEADERS, "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": CLIENT_ID, ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep((+res.headers.get("retry-after") || 10) * 1000); continue; }
    if (!res.ok) throw new Error(`Trakt ${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error("Trakt kept rate-limiting; try again later.");
}

async function findMovie(title, year) {
  const tries = year ? [{ query: title, years: year }, { query: title }] : [{ query: title }];
  for (const t of tries) {
    const rows = await trakt("/search/movie?" + new URLSearchParams({ ...t, limit: "5", fields: "title,aliases" }));
    const exact = rows?.find(r => r.movie.title?.toLowerCase() === title.toLowerCase() && (!year || String(r.movie.year) === String(year)));
    const hit = exact || rows?.[0];
    if (hit) return hit.movie;
  }
  return null;
}

(async () => {
  const state = readState() || { setupId, refresh: setup.r, seen: [] };
  const seen = new Set(state.seen);

  // 1. Refresh the Trakt token and save the new one right away (Trakt rotates refresh tokens).
  const tokRes = await fetch(API + "/oauth/token", {
    method: "POST", headers: { ...BASE_HEADERS, "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": CLIENT_ID },
    body: JSON.stringify({ refresh_token: state.refresh, client_id: CLIENT_ID, redirect_uri: REDIRECT, grant_type: "refresh_token" }),
  });
  if (!tokRes.ok) {
    console.error(`Trakt refused the saved sign-in (${tokRes.status}): ${(await tokRes.text().catch(() => "")).slice(0, 300)}`);
    console.error(`If this keeps happening, create a new sync key on the watchlist page and update the LB_SYNC_SETUP secret.`);
    process.exit(1);
  }
  const tok = await tokRes.json();
  state.refresh = tok.refresh_token;
  writeState({ ...state, seen: [...seen] });

  // 2. Read Letterboxd.
  const films = await fetchWatchlist(setup.u);
  const fresh = films.filter(f => !seen.has(f.slug));
  console.log(`Letterboxd watchlist: ${films.length} films, ${fresh.length} new since last run.`);

  // 3. Match new films on Trakt and add them.
  const ids = [], missing = [];
  for (const f of fresh) {
    try {
      const m = await findMovie(f.title, f.year);
      if (m) ids.push(m.ids.trakt); else missing.push(f);
    } catch (e) { missing.push(f); console.warn(`Search failed for ${f.title}: ${e.message}`); }
    await sleep(300);
  }
  let added = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await trakt("/sync/watchlist", { method: "POST", token: tok.access_token, body: { movies: ids.slice(i, i + 100).map(id => ({ ids: { trakt: id } })) } });
    added += res?.added?.movies ?? 0;
  }
  fresh.forEach(f => seen.add(f.slug));
  state.lastRun = new Date().toISOString();
  writeState({ ...state, seen: [...seen] });

  console.log(`Added ${added} films to your Trakt watchlist.`);
  if (missing.length) console.log(`Couldn't match on Trakt: ${missing.map(f => `${f.title}${f.year ? ` (${f.year})` : ""}`).join("; ")}`);
})().catch(e => { console.error(e.message); process.exit(1); });
