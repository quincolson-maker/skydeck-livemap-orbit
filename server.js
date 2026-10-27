// SkyDeck Orbit — 3D satellite-view globe. Zero dependencies (Node >= 18).
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.INBOUND_KEY || '';
const PUB = path.join(__dirname, 'public');
const PLAN_FILE = path.join(process.env.TMPDIR || '/tmp', 'skydeck-livemap-plan.json');
const UA = { 'User-Agent': 'SkyDeckLiveMapOrbit/1.0 (personal wx wall map)' };
const UP = process.env.PLAN_UPSTREAM || ''; // share flight plans with the main Live Map (its email inbound)
const cache = new Map();
async function cached(key, ttl, fn) {
  const c = cache.get(key); if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v; throw e; }
}
// ---------- METARs (bulk cache CSV, every station in one request) ----------
function csvRow(line) { const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out; }
async function metars() {
  return cached('metars', 240e3, async () => {
    const r = await fetch('https://aviationweather.gov/data/cache/metars.cache.csv.gz', { headers: UA });
    if (!r.ok) throw new Error('awc ' + r.status);
    const txt = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString();
    const lines = txt.split('\n'); let hi = lines.findIndex(l => l.startsWith('raw_text'));
    const H = csvRow(lines[hi]), ix = n => H.indexOf(n);
    const I = { raw: ix('raw_text'), id: ix('station_id'), t: ix('observation_time'), la: ix('latitude'), lo: ix('longitude'), cat: ix('flight_category'), auto: ix('auto') };
    const st = [];
    for (const l of lines.slice(hi + 1)) { if (!l) continue; const c = csvRow(l);
      const la = +c[I.la], lo = +c[I.lo];
      if (!(la > 23 && la < 51 && lo > -127 && lo < -65)) continue;
      st.push({ id: c[I.id], la, lo, c: c[I.cat] || '', t: c[I.t], m: c[I.auto] ? 0 : 1, raw: c[I.raw] }); }
    return { updated: new Date().toISOString(), count: st.length, stations: st };
  });
}
// ---------- Location lookup (AWC airport / navaid / fix) ----------
async function awc(kind, id) {
  return cached(kind + id, 864e5, async () => {
    const r = await fetch(`https://aviationweather.gov/api/data/${kind}?ids=${encodeURIComponent(id)}&format=json`, { headers: UA });
    if (!r.ok) return null; const t = await r.text(); if (!t.trim()) return null;
    const j = JSON.parse(t); return Array.isArray(j) && j[0] ? { id, name: (j[0].name || '').trim(), lat: +j[0].lat, lon: +j[0].lon } : null; });
}
async function locate(tok, airportOnly) {
  if (/^[A-Z]{4}$/.test(tok) || /^[A-Z0-9]{3,4}$/.test(tok) && /\d/.test(tok)) { const a = await awc('airport', tok); if (a) return { ...a, kind: 'apt' }; }
  if (/^[A-Z]{3}$/.test(tok)) { const a = await awc('airport', 'K' + tok); if (a) return { ...a, id: 'K' + tok, kind: 'apt' }; }
  if (airportOnly) return null;
  if (/^[A-Z]{2,3}$/.test(tok)) { const n = await awc('navaid', tok); if (n) return { ...n, kind: 'nav' }; }
  if (/^[A-Z]{5}$/.test(tok)) { const f = await awc('fix', tok); if (f) return { ...f, kind: 'fix' }; }
  return null;
}
// ---------- Flight plan parsing ----------
const STOP = new Set('THE AND FOR FROM WITH YOUR THIS THAT DCT DIRECT ROUTE TIME DATE ETD ETA ETE UTC GMT CDT CST EDT EST MDT MST PDT PST FUEL PLAN TRIP FLIGHT NOTE SENT VIA ALT TAS GPH SPEED KTS NM DEP DEST ARR DEPART DEPARTURE DESTINATION ARRIVAL ARRIVE AIRCRAFT TYPE PILOT FWD RE FW VFR IFR MVFR LIFR CRUISE RULES REMARKS SUBJECT TO CC BCC PM AM ONLY LOCAL ZULU ON AT IN OF TOTAL HRS HR MIN'.split(' '));
const ZONES = { UTC: 0, GMT: 0, Z: 0, CDT: -5, CST: -6, EDT: -4, EST: -5, MDT: -6, MST: -7, PDT: -7, PST: -8 };
function parseTime(s, ref) { // returns ms or null
  if (!s) return null; s = s.trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?\s*(Z|UTC|[+-]\d{2}:?\d{2}|[A-Z]{3})?/i);
  let Y, Mo, D, h, mi, z;
  if (m) { [, Y, Mo, D, h, mi, z] = m; }
  else if ((m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:at\s*)?(\d{1,2}):?(\d{2})\s*(AM|PM)?\s*(Z|UTC|GMT|[CEMP][SD]T|LOCAL)?/i))) { Mo = m[1]; D = m[2]; Y = m[3]; h = m[4]; mi = m[5]; if (m[6]) h = (+h % 12) + (/p/i.test(m[6]) ? 12 : 0); z = m[7]; }
  else if ((m = s.match(/\b(\d{1,2}):?(\d{2})\s*(AM|PM)?\s*(Z|UTC|GMT|[CEMP][SD]T|LOCAL)?\b/i))) { h = m[1]; mi = m[2]; if (m[3]) h = (+h % 12) + (/p/i.test(m[3]) ? 12 : 0); z = m[4]; }
  else return null;
  if (+h > 23 || +mi > 59) return null;
  z = (z || 'CDT').toUpperCase(); let off;
  if (/^[+-]/.test(z)) { const zz = z.replace(':', ''); off = (+zz.slice(0, 3)) + Math.sign(+zz.slice(0, 3) || 1) * (+zz.slice(3) / 60); }
  else off = ZONES[z] ?? (isCentralDST(ref) ? -5 : -6);
  const now = new Date(ref);
  Y = Y ? (+Y < 100 ? 2000 + +Y : +Y) : now.getUTCFullYear();
  if (Mo) { let t = Date.UTC(Y, +Mo - 1, +D, +h, +mi) - off * 36e5; return t; }
  // time only: choose the occurrence nearest to now (within -12h..+36h)
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), +h, +mi) - off * 36e5;
  while (t < ref - 3 * 36e5) t += 864e5; while (t > ref + 36 * 36e5) t -= 864e5; return t;
}
function isCentralDST(t) { const s = new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' }); return /CDT/.test(s); }
function hav(a, b) { const R = 3440.065, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
async function parsePlan(text, now = Date.now()) {
  text = String(text || '').replace(/\r/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/=\n/g, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const grab = re => { for (const l of lines) { const m = l.match(re); if (m) return m[1].trim(); } return null; };
  let routeStr = grab(/^(?:route|rte|filed route|flight plan route)\s*[:\-]\s*(.+)$/i);
  let dep = grab(/^(?:dep(?:arture)?|from|origin)\s*(?:airport)?\s*[:\-]\s*([A-Z0-9]{3,4})\b/i);
  let dest = grab(/^(?:dest(?:ination)?|to|arr(?:ival)?)\s*(?:airport)?\s*[:\-]\s*([A-Z0-9]{3,4})\b/i);
  if (!routeStr) { const subj = grab(/^subject\s*:\s*(.+)$/i) || ''; const m = (subj + '\n' + text).match(/\b([A-Z][A-Z0-9]{2,3})\s+(?:to|-|–|>|→)\s+([A-Z][A-Z0-9]{2,3})\b/); if (m) { dep = dep || m[1]; dest = dest || m[2]; } }
  if (!routeStr) { // first line with >=2 upper-case tokens that look like airports
    for (const l of lines) { const toks = l.toUpperCase().match(/\b[A-Z][A-Z0-9]{2,4}\b/g) || []; if (toks.filter(t => /^K[A-Z]{3}$/.test(t)).length >= 2 && toks.length <= 25) { routeStr = l; break; } } }
  let toks = (routeStr || '').toUpperCase().replace(/[^A-Z0-9 .\/]/g, ' ').split(/\s+/).filter(Boolean);
  toks = toks.map(t => t.split('.')[0]).filter(t => !STOP.has(t) && !/^[VJTQ]\d+$/.test(t) && !/^\d+$/.test(t) && /^[A-Z0-9]{2,5}$/.test(t) && /[A-Z]/.test(t));
  if (dep && toks[0] !== dep.toUpperCase()) toks.unshift(dep.toUpperCase());
  if (dest && toks[toks.length - 1] !== dest.toUpperCase()) toks.push(dest.toUpperCase());
  const pts = [];
  for (let i = 0; i < toks.length; i++) { const p = await locate(toks[i], i === 0 || i === toks.length - 1); if (p && !(pts.length && pts[pts.length - 1].id === p.id)) pts.push(p); }
  if (pts.length < 2 || pts[0].kind !== 'apt' || pts[pts.length - 1].kind !== 'apt') throw new Error('Could not find a departure and destination airport. Include a line like "Route: KPAH DCT KJVY".');
  const etdS = grab(/\b(?:etd|departure time|dep(?:art(?:ure)?)?\s*time|depart(?:ing)?|proposed(?: departure)?(?: time)?|off ?blocks?)\s*[:\-]?\s*(.+)$/i);
  const etaS = grab(/\b(?:eta|arrival time|arrive|arrival|on ?blocks?)\s*[:\-]?\s*(.+)$/i);
  const eteS = grab(/\b(?:ete|time enroute|time en route|en ?route time|flight time)\s*[:\-]?\s*(\d{1,2}[:h ]\s*\d{2}|\d+\s*min)/i);
  const tasS = grab(/\b(?:tas|true airspeed|cruise speed|speed)\s*[:\-]?\s*(\d{2,3})/i);
  const dist = pts.slice(1).reduce((s, p, i) => s + hav(pts[i], p), 0);
  let etd = parseTime(etdS, now) || now;
  let ete = null; if (eteS) { const m = eteS.match(/(\d+)\s*min/i); ete = m ? +m[1] * 6e4 : (() => { const [a, b] = eteS.split(/[:h ]\s*/); return (+a * 60 + +b) * 6e4; })(); }
  let eta = parseTime(etaS, etd); if (eta && eta < etd) eta += 864e5;
  const tas = +tasS || 120;
  if (!eta) eta = etd + (ete || dist / tas * 36e5);
  return { dep: pts[0], dest: pts[pts.length - 1], route: pts, routeText: toks.join(' '), distNm: Math.round(dist), etd, eta, expires: eta + 45 * 6e4, received: now };
}

// ---------- Airport Spotlight: decoded METAR + TAF (aviationweather.gov), FAA d-TPP airport diagram, USGS aerial ----------
async function getJ(url, ttl) { return cached(url, ttl, async () => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url); const t = await r.text(); return t.trim() ? JSON.parse(t) : []; }); }
async function dtppIndex() { // icao -> APD pdf, from the current FAA d-TPP metafile (cached 12 h)
  return cached('dtpp', 432e5, async () => {
    const info = await (await fetch('https://external-api.faa.gov/apra/dtpp/info?edition=current', { headers: { ...UA, Accept: 'application/json' } })).json();
    const e = info.edition[0], cycle = e.editionDate.slice(-2) + String(e.editionNumber).padStart(2, '0');
    const xml = await (await fetch(`https://aeronav.faa.gov/d-tpp/${cycle}/xml_data/d-tpp_Metafile.xml`, { headers: UA })).text();
    const idx = {}; const re = /<airport_name [^>]*icao_ident="([A-Z0-9]*)"[^>]*>([\s\S]*?)<\/airport_name>/g; let m;
    while ((m = re.exec(xml))) { const a = m[2].match(/<chart_code>APD<\/chart_code>\s*<chart_name>[^<]*<\/chart_name>[\s\S]*?<pdf_name>([^<]+)<\/pdf_name>/); if (m[1] && a) idx[m[1]] = a[1]; }
    return { cycle, from: e.editionDate, idx };
  });
}
async function spot(id) {
  const [met, apt] = await Promise.all([getJ(`https://aviationweather.gov/api/data/metar?ids=${id}&format=json`, 120e3), getJ(`https://aviationweather.gov/api/data/airport?ids=${id}&format=json`, 864e5)]);
  const a = apt[0] || {}, m = met[0] || null, lat = +(a.lat ?? m?.lat), lon = +(a.lon ?? m?.lon);
  let taf = (await getJ(`https://aviationweather.gov/api/data/taf?ids=${id}&format=json`, 300e3))[0] || null, tafNear = false;
  if (!taf && isFinite(lat)) { // no TAF at this field: use the nearest TAF within ~40 NM, clearly labelled
    const near = await getJ(`https://aviationweather.gov/api/data/taf?bbox=${(lat - .7).toFixed(2)},${(lon - .8).toFixed(2)},${(lat + .7).toFixed(2)},${(lon + .8).toFixed(2)}&format=json`, 300e3);
    let best = null; for (const t of near) { const d = hav({ lat, lon }, { lat: t.lat, lon: t.lon }); if (d < 40 && (!best || d < best.d)) best = { t, d }; }
    if (best) { taf = best.t; tafNear = Math.round(best.d); } }
  let apd = null; try { const d = await dtppIndex(); if (d.idx[id]) apd = { cycle: d.cycle, pdf: d.idx[id], url: `https://aeronav.faa.gov/d-tpp/${d.cycle}/${d.idx[id]}` }; } catch {}
  return { id, name: a.name || m?.name || id, lat, lon, elev: a.elev ?? m?.elev, runways: a.runways || [], metar: m, taf, tafNear, apd };
}
const BOOT = Date.now().toString(36), VERSION = process.env.RENDER_GIT_COMMIT || BOOT;
let plan = null; try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); } catch {}
function currentPlan() { if (plan && Date.now() > plan.expires) { plan = null; try { fs.unlinkSync(PLAN_FILE); } catch {} } return plan; }
function savePlan(p) { plan = p; fs.writeFileSync(PLAN_FILE, JSON.stringify(p)); }
// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let b = []; let n = 0; req.on('data', d => { n += d.length; if (n > 2e6) { no(new Error('too big')); req.destroy(); } else b.push(d); }); req.on('end', () => ok(Buffer.concat(b).toString())); });
function extractText(raw, ct) { // JSON / form / plain / raw MIME
  if (/json/.test(ct)) { try { const j = JSON.parse(raw); return [j.subject, j.plain, j.text, j.body, j.html, j.route, j.TextBody, j.Subject, j.HtmlBody, j.headers?.subject, j.envelope && '', j.raw].filter(Boolean).join('\n'); } catch {} }
  if (/x-www-form-urlencoded/.test(ct)) { const q = new URLSearchParams(raw); return ['subject', 'plain', 'text', 'body-plain', 'body', 'stripped-text', 'html', 'route'].map(k => q.get(k)).filter(Boolean).join('\n'); }
  if (/multipart\/form-data/.test(ct)) return raw.replace(/^--.*$/gm, '').replace(/^Content-[^\n]*$/gim, '');
  // raw RFC822: decode quoted-printable / base64 text parts roughly
  let t = raw; const b64 = [...raw.matchAll(/Content-Transfer-Encoding:\s*base64[\s\S]*?\n\n([A-Za-z0-9+\/=\n]+)/gi)].map(m => Buffer.from(m[1].replace(/\s/g, ''), 'base64').toString());
  if (b64.length) t += '\n' + b64.join('\n');
  return t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (p === '/api/ping') return json(res, 200, { ok: true, t: Date.now() });
    if (p === '/api/metars') { const m = await metars(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ updated: m.updated, count: m.count, stations: m.stations.map(s => [s.id, s.la, s.lo, s.c, s.m, s.t]) })); }
    if (p === '/api/metar') { const id = (u.searchParams.get('id') || '').toUpperCase(); const s = (await metars()).stations.find(x => x.id === id); return json(res, s ? 200 : 404, s || {}); }
    if (p === '/api/radar') { // IEM NEXRAD n0q composite, EPSG:4326 over CONUS, proxied + cached 4 min
      let bb = [-127, 22, -64, 52], RW = 3150, RH = 1500; const qb = (u.searchParams.get('bbox') || '').split(',').map(Number);
      if (qb.length === 4 && qb.every(isFinite) && qb[2] > qb[0] && qb[3] > qb[1]) { bb = [Math.max(-130, qb[0]), Math.max(18, qb[1]), Math.min(-60, qb[2]), Math.min(55, qb[3])].map(v => +v.toFixed(2)); RW = Math.min(2400, Math.max(200, +u.searchParams.get('w') || 1600)); RH = Math.min(2400, Math.max(200, Math.round(RW * (bb[3] - bb[1]) / (bb[2] - bb[0])))); }
      const img = await cached('radar' + bb + RW, 240e3, async () => { const r = await fetch(`https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=nexrad-n0q-900913&STYLES=&SRS=EPSG:4326&BBOX=${bb}&WIDTH=${RW}&HEIGHT=${RH}&FORMAT=image/png&TRANSPARENT=true`, { headers: UA }); if (!r.ok) throw new Error('iem ' + r.status); return { b: Buffer.from(await r.arrayBuffer()), t: new Date().toISOString() }; });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Radar-Time': img.t }); return res.end(img.b); }
    if (p === '/api/spot') { const id = (u.searchParams.get('id') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return json(res, 200, await spot(id)); }
    if (p === '/api/apd') { const id = (u.searchParams.get('id') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const d = await dtppIndex(); if (!d.idx[id]) return json(res, 404, { error: 'no FAA airport diagram' });
      const b = await cached('apd' + id + d.cycle, 864e5, async () => { const r = await fetch(`https://aeronav.faa.gov/d-tpp/${d.cycle}/${d.idx[id]}`, { headers: UA }); if (!r.ok) throw new Error('dtpp ' + r.status); return Buffer.from(await r.arrayBuffer()); });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=86400' }); return res.end(b); }
    if (p === '/api/aerial') { const la = +u.searchParams.get('lat'), lo = +u.searchParams.get('lon'), sp = Math.min(.1, Math.max(.005, +u.searchParams.get('span') || .025));
      if (!isFinite(la) || !isFinite(lo)) return json(res, 400, {}); const dx = sp / Math.cos(la * Math.PI / 180) * 4 / 3;
      const url = `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=${lo - dx},${la - sp},${lo + dx},${la + sp}&bboxSR=4326&imageSR=3857&size=1600,1200&format=jpg&f=image`;
      const b = await cached(url, 864e5, async () => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error('usgs ' + r.status); return Buffer.from(await r.arrayBuffer()); });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); return res.end(b); }
    if (p === '/api/plan' && req.method === 'GET') { let pl = currentPlan(), boot = BOOT;
      if (UP) try { const j = await cached('up', 30e3, async () => (await fetch(UP + '/api/plan', { headers: UA })).json()); if (j.plan && (!pl || (j.plan.received || 0) >= (pl.received || 0))) { pl = j.plan; boot = 'up-' + j.boot; } } catch {}
      return json(res, 200, { plan: pl, boot, version: VERSION }); }
    if (p === '/api/clouds') { // GOES-East ABI band 13 (10.3 um IR) CONUS from IEM, EPSG:4326, cached 5 min
      const img = await cached('clouds', 300e3, async () => { const r = await fetch('https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=conus_ch13&STYLES=&SRS=EPSG:4326&BBOX=-135,18,-58,55&WIDTH=2310&HEIGHT=1110&FORMAT=image/png&TRANSPARENT=true', { headers: UA }); if (!r.ok) throw new Error('iem ' + r.status); return { b: Buffer.from(await r.arrayBuffer()), t: new Date().toISOString() }; });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Time': img.t }); return res.end(img.b); }
    if (p === '/api/version') return json(res, 200, { version: VERSION, boot: BOOT });
    if (p === '/api/plan' && req.method === 'DELETE') { if (KEY && u.searchParams.get('key') !== KEY) return json(res, 403, { error: 'bad key' }); plan = null; try { fs.unlinkSync(PLAN_FILE); } catch {} return json(res, 200, { ok: true }); }
    if ((p === '/api/plan' || p === '/api/inbound') && req.method === 'POST') {
      if (KEY && u.searchParams.get('key') !== KEY) return json(res, 403, { error: 'bad key' });
      const raw = await body(req); const text = extractText(raw, req.headers['content-type'] || '');
      if (u.searchParams.get('dry')) return json(res, 200, { plan: await parsePlan(text) });
      try { const pl = await parsePlan(text); pl.source = p === '/api/inbound' ? 'email' : 'paste'; savePlan(pl); return json(res, 200, { ok: true, plan: pl }); }
      catch (e) { return json(res, p === '/api/inbound' ? 200 : 422, { ok: false, error: e.message }); }
    }
    let f = p === '/' ? '/index.html' : p === '/plan' ? '/plan.html' : p;
    f = path.normalize(path.join(PUB, f)); if (!f.startsWith(PUB)) return json(res, 403, {});
    fs.readFile(f, (e, d) => { if (e) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': /\.(jpg|webp|png|geojson)$/.test(f) ? 'public, max-age=86400' : 'no-cache' }); res.end(d); });
  } catch (e) { json(res, 502, { error: e.message }); }
});
setTimeout(() => dtppIndex().catch(() => {}), 2000); // warm FAA d-TPP index so the first spotlight is instant
server.listen(PORT, HOST, () => console.log(`SkyDeck Orbit → http://${HOST}:${PORT}`));
module.exports = { parsePlan };
