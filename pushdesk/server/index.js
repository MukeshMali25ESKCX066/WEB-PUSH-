require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, getSetting, setSetting } = require('./db');
const { vapidPublicKey, sendCampaign, countAudience, SEGMENT_FIELDS } = require('./push');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

let JWT_SECRET = process.env.JWT_SECRET || getSetting('jwt_secret');
if (!JWT_SECRET) { JWT_SECRET = crypto.randomBytes(32).toString('hex'); setSetting('jwt_secret', JWT_SECRET); }

const origin = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const rand = (n) => crypto.randomBytes(n).toString('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
function parseUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobile|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop';
  return { browser, os, device };
}
const clean = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const isUrl = (v) => !v || /^https?:\/\//i.test(v);

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  try {
    const p = jwt.verify(h.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    req.user = db.prepare('SELECT id,email FROM users WHERE id=?').get(p.id);
    if (!req.user) throw new Error('no user');
    next();
  } catch (_) { res.status(401).json({ error: 'Unauthorized' }); }
}
function ownSite(req, res, next) {
  const site = db.prepare('SELECT * FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  req.site = site; next();
}
const token = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

// ---------- auth ----------
app.post('/api/auth/signup', wrap((req, res) => {
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count > 0 && process.env.ALLOW_SIGNUP === 'false') return res.status(403).json({ error: 'Signups are disabled' });
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  const info = db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)').run(email, bcrypt.hashSync(password, 10));
  res.json({ token: token({ id: info.lastInsertRowid }), email });
}));
app.post('/api/auth/login', wrap((req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: token(u), email: u.email });
}));
app.get('/api/me', auth, (req, res) => res.json({ ...req.user, base_url: origin(req) }));

// ---------- sites ----------
app.get('/api/sites', auth, (req, res) => {
  const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM subscribers WHERE site_id=s.id AND active=1) AS subscribers,
    (SELECT COUNT(*) FROM campaigns WHERE site_id=s.id) AS campaigns FROM sites s WHERE user_id=? ORDER BY id DESC`).all(req.user.id);
  res.json(rows);
});
app.post('/api/sites', auth, (req, res) => {
  const name = clean(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const domain = clean(req.body.domain, 200).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const info = db.prepare('INSERT INTO sites(user_id,name,domain,site_key,api_key) VALUES(?,?,?,?,?)').run(req.user.id, name, domain, rand(8), rand(24));
  res.json(db.prepare('SELECT * FROM sites WHERE id=?').get(info.lastInsertRowid));
});
app.get('/api/sites/:id', auth, ownSite, (req, res) => res.json(req.site));
app.delete('/api/sites/:id', auth, ownSite, (req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.site.id); res.json({ ok: true });
});
app.post('/api/sites/:id/rotate-key', auth, ownSite, (req, res) => {
  const k = rand(24); db.prepare('UPDATE sites SET api_key=? WHERE id=?').run(k, req.site.id); res.json({ api_key: k });
});

app.get('/api/sites/:id/stats', auth, ownSite, (req, res) => {
  const id = req.site.id;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const totals = {
    active: one('SELECT COUNT(*) n FROM subscribers WHERE site_id=? AND active=1', id).n,
    all: one('SELECT COUNT(*) n FROM subscribers WHERE site_id=?', id).n,
    campaigns: one('SELECT COUNT(*) n FROM campaigns WHERE site_id=?', id).n,
    sent: one('SELECT COALESCE(SUM(sent),0) n FROM campaigns WHERE site_id=?', id).n,
    clicks: one('SELECT COALESCE(SUM(clicks),0) n FROM campaigns WHERE site_id=?', id).n
  };
  const breakdown = {};
  for (const f of SEGMENT_FIELDS) {
    breakdown[f] = db.prepare(`SELECT COALESCE(NULLIF(${f},''),'Unknown') AS label, COUNT(*) AS n FROM subscribers
      WHERE site_id=? AND active=1 GROUP BY label ORDER BY n DESC LIMIT 20`).all(id);
  }
  const daily = db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM subscribers WHERE site_id=? AND created_at >= date('now','-13 days')
    GROUP BY d ORDER BY d`).all(id);
  res.json({ totals, breakdown, daily });
});

app.get('/api/sites/:id/subscribers', auth, ownSite, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), size = 50;
  const rows = db.prepare(`SELECT id,browser,os,device,country,language,page,active,created_at,last_seen FROM subscribers
    WHERE site_id=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(req.site.id, size, (page - 1) * size);
  const total = db.prepare('SELECT COUNT(*) n FROM subscribers WHERE site_id=?').get(req.site.id).n;
  res.json({ rows, total, page, size });
});

// ---------- campaigns ----------
function normalizeSegment(seg = {}) {
  const out = {};
  for (const f of SEGMENT_FIELDS) if (Array.isArray(seg[f]) && seg[f].length) out[f] = seg[f].map(String).slice(0, 50);
  if (seg.page) out.page = clean(seg.page, 200);
  return out;
}
app.post('/api/sites/:id/estimate', auth, ownSite, (req, res) => {
  res.json({ count: countAudience(req.site.id, normalizeSegment(req.body.segment)) });
});
app.get('/api/sites/:id/campaigns', auth, ownSite, (req, res) => {
  res.json(db.prepare('SELECT * FROM campaigns WHERE site_id=? ORDER BY id DESC LIMIT 100').all(req.site.id));
});
function createCampaign(site, b, req) {
  const title = clean(b.title, 120);
  if (!title) throw Object.assign(new Error('Title is required'), { status: 400 });
  const body = clean(b.body, 400), url = clean(b.url, 1000), icon = clean(b.icon, 1000), image = clean(b.image, 1000);
  if (![url, icon, image].every(isUrl)) throw Object.assign(new Error('URLs must start with http:// or https://'), { status: 400 });
  const info = db.prepare('INSERT INTO campaigns(site_id,title,body,url,icon,image,segment) VALUES(?,?,?,?,?,?,?)')
    .run(site.id, title, body, url, icon, image, JSON.stringify(normalizeSegment(b.segment)));
  const id = info.lastInsertRowid;
  setImmediate(() => sendCampaign(id, origin(req)).catch((e) => {
    console.error('send failed', e); db.prepare("UPDATE campaigns SET status='failed' WHERE id=?").run(id);
  }));
  return db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
}
app.post('/api/sites/:id/campaigns', auth, ownSite, wrap((req, res) => res.json(createCampaign(req.site, req.body, req))));

// ---------- templates ----------
app.get('/api/templates', auth, (req, res) => res.json(db.prepare('SELECT * FROM templates WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/templates', auth, (req, res) => {
  const b = req.body, name = clean(b.name, 100), title = clean(b.title, 120);
  if (!name || !title) return res.status(400).json({ error: 'Name and title are required' });
  const info = db.prepare('INSERT INTO templates(user_id,name,title,body,url,icon,image) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, name, title, clean(b.body, 400), clean(b.url, 1000), clean(b.icon, 1000), clean(b.image, 1000));
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/templates/:tid', auth, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=? AND user_id=?').run(req.params.tid, req.user.id); res.json({ ok: true });
});

// ---------- developer REST API (x-api-key) ----------
function apiKey(req, res, next) {
  const k = req.get('x-api-key') || req.query.api_key;
  const site = k && db.prepare('SELECT * FROM sites WHERE api_key=?').get(k);
  if (!site) return res.status(401).json({ error: 'Invalid API key' });
  req.site = site; next();
}
app.post('/api/v1/send', apiKey, wrap((req, res) => {
  const c = createCampaign(req.site, req.body, req); res.json({ campaign_id: c.id, status: c.status });
}));
app.get('/api/v1/subscribers/count', apiKey, (req, res) => {
  res.json({ count: countAudience(req.site.id, normalizeSegment(req.query)) });
});
app.get('/api/v1/campaigns/:cid', apiKey, (req, res) => {
  const c = db.prepare('SELECT id,title,status,total,sent,failed,clicks,created_at FROM campaigns WHERE id=? AND site_id=?').get(req.params.cid, req.site.id);
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
});

// ---------- public endpoints used by the embed script / service worker ----------
const pub = cors({ origin: true });
app.options('/public/*', pub);
app.post('/public/subscribe', pub, wrap((req, res) => {
  const { key, subscription, page, language } = req.body || {};
  const site = key && db.prepare('SELECT * FROM sites WHERE site_key=?').get(String(key));
  const k = subscription && subscription.keys;
  if (!site || !subscription || !subscription.endpoint || !k || !k.p256dh || !k.auth) return res.status(400).json({ error: 'Invalid request' });
  const ua = parseUA(req.get('user-agent') || '');
  const country = (req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country') || 'Unknown').toUpperCase();
  db.prepare(`INSERT INTO subscribers(site_id,endpoint,p256dh,auth,browser,os,device,country,language,page)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,endpoint) DO UPDATE SET active=1, last_seen=CURRENT_TIMESTAMP,
    p256dh=excluded.p256dh, auth=excluded.auth, page=excluded.page`)
    .run(site.id, clean(subscription.endpoint, 2000), k.p256dh, k.auth, ua.browser, ua.os, ua.device, country, clean(language, 20), clean(page, 500));
  res.json({ ok: true });
}));
app.post('/public/unsubscribe', pub, wrap((req, res) => {
  const { key, endpoint } = req.body || {};
  const site = key && db.prepare('SELECT id FROM sites WHERE site_key=?').get(String(key));
  if (site && endpoint) db.prepare('UPDATE subscribers SET active=0 WHERE site_id=? AND endpoint=?').run(site.id, String(endpoint));
  res.json({ ok: true });
}));
app.post('/public/click/:cid', pub, (req, res) => {
  db.prepare('UPDATE campaigns SET clicks=clicks+1 WHERE id=?').run(req.params.cid); res.json({ ok: true });
});

// Embed script: <script src="https://panel/sdk/SITEKEY.js" async></script>
app.get('/sdk/:key.js', cors(), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE site_key=?').get(req.params.key);
  if (!site) return res.status(404).type('application/javascript').send('console.error("PushDesk: unknown site key")');
  res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(sdkSource(origin(req), site.site_key));
});
function sdkSource(server, key) {
  return `(function(){
var SERVER=${JSON.stringify(server)},KEY=${JSON.stringify(key)},VAPID=${JSON.stringify(vapidPublicKey)};
var SW=(window.PUSHDESK_SW_PATH||'/pushdesk-sw.js');
function b64(s){var p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
function supported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
async function subscribe(){
  if(!supported())throw new Error('Push is not supported in this browser');
  var reg=await navigator.serviceWorker.register(SW);await navigator.serviceWorker.ready;
  var perm=await Notification.requestPermission();if(perm!=='granted')throw new Error('Permission '+perm);
  var sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(VAPID)});
  await fetch(SERVER+'/public/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,subscription:sub.toJSON(),page:location.href,language:navigator.language})});
  try{localStorage.setItem('pd_done','1')}catch(e){}
  return sub;
}
async function unsubscribe(){
  var reg=await navigator.serviceWorker.getRegistration(SW);var sub=reg&&await reg.pushManager.getSubscription();if(!sub)return;
  await fetch(SERVER+'/public/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,endpoint:sub.endpoint})});await sub.unsubscribe();
}
window.PushDesk={subscribe:subscribe,unsubscribe:unsubscribe,supported:supported};
function banner(){
  if(window.PUSHDESK_NO_PROMPT||!supported()||Notification.permission!=='default')return;
  try{if(localStorage.getItem('pd_done')||localStorage.getItem('pd_later')>Date.now())return}catch(e){}
  var d=document.createElement('div');
  d.style.cssText='position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);max-width:420px;width:calc(100% - 32px);background:#fff;color:#111;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:16px;font:14px/1.4 system-ui,sans-serif';
  d.innerHTML='<div style="font-weight:600;margin-bottom:4px">Stay in the loop</div><div style="color:#555;margin-bottom:12px">Get notified about new updates from this site.</div><div style="display:flex;gap:8px;justify-content:flex-end"><button id="pdl" style="border:0;background:#eee;padding:8px 14px;border-radius:8px;cursor:pointer">Later</button><button id="pda" style="border:0;background:#4f46e5;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer">Allow</button></div>';
  document.body.appendChild(d);
  d.querySelector('#pda').onclick=function(){d.remove();subscribe().catch(function(e){console.warn('PushDesk',e.message)})};
  d.querySelector('#pdl').onclick=function(){d.remove();try{localStorage.setItem('pd_later',Date.now()+864e5*3)}catch(e){}};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(banner,1500)});else setTimeout(banner,1500);
})();`;
}

// Demo page so you can test end to end on the panel's own origin
app.get('/demo/:key', (req, res) => {
  const key = String(req.params.key).replace(/[^a-z0-9]/gi, '');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PushDesk demo</title><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px">
<h2>PushDesk test page</h2><p>This page loads the embed script for your site key and lets you subscribe this browser.</p>
<button id="b" style="padding:10px 18px;font-size:16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;cursor:pointer">Subscribe this browser</button>
<p id="m" style="color:#555"></p>
<script>window.PUSHDESK_NO_PROMPT=true</script>
<script src="/sdk/${key}.js"></script>
<script>document.getElementById('b').onclick=()=>PushDesk.subscribe().then(()=>m.textContent='Subscribed. Send a campaign from the panel.').catch(e=>m.textContent='Error: '+e.message)</script>`);
});

// ---------- static panel ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PushDesk running on http://localhost:${port}  (panel: /app)`));
