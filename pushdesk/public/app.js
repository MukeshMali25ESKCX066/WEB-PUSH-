const $ = (s, r = document) => r.querySelector(s);
const view = $('#view'), nav = $('#nav');
const S = { token: localStorage.getItem('pd_token'), email: localStorage.getItem('pd_email'), base: location.origin };
let timer = null;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString() : '';

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { logout(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function logout() { localStorage.removeItem('pd_token'); localStorage.removeItem('pd_email'); S.token = null; location.hash = '#/login'; }
function saveAuth(j) { S.token = j.token; S.email = j.email; localStorage.setItem('pd_token', j.token); localStorage.setItem('pd_email', j.email); location.hash = '#/'; }
function copy(text, btn) { navigator.clipboard.writeText(text).then(() => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1200); }); }
window.copyText = copy;

function renderNav() {
  nav.innerHTML = S.token ? `<span class="muted">${esc(S.email)}</span><button class="btn sec sm" id="lo">Logout</button>` : '';
  const lo = $('#lo'); if (lo) lo.onclick = logout;
}

// ---------- auth ----------
function authView(mode) {
  const signup = mode === 'signup';
  view.innerHTML = `<div class="card" style="max-width:400px;margin:40px auto"><h2>${signup ? 'Create account' : 'Login'}</h2>
  <form id="f"><label>Email</label><input name="email" type="email" required autofocus>
  <label>Password</label><input name="password" type="password" required minlength="${signup ? 8 : 1}">
  <div style="margin-top:16px" class="row"><button class="btn">${signup ? 'Sign up' : 'Login'}</button>
  <a href="#/${signup ? 'login' : 'signup'}">${signup ? 'Have an account?' : 'Create account'}</a></div><div class="err" id="e"></div></form></div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    try { saveAuth(await api('/auth/' + (signup ? 'signup' : 'login'), 'POST', { email: f.get('email'), password: f.get('password') })); }
    catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------- sites list ----------
async function sitesView() {
  const sites = await api('/sites');
  view.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Your sites</h2></div>
  <div class="card"><form id="f" class="row"><input class="grow" name="name" placeholder="Site name" required>
  <input class="grow" name="domain" placeholder="example.com (optional)"><button class="btn">Add site</button></form><div class="err" id="e"></div></div>
  <div class="grid g2">${sites.map((s) => `<a class="card" href="#/site/${s.id}/overview" style="color:inherit">
    <h3>${esc(s.name)}</h3><div class="muted">${esc(s.domain || 'no domain set')}</div>
    <div class="row" style="margin-top:10px"><span class="pill">${s.subscribers} subscribers</span><span class="pill">${s.campaigns} campaigns</span></div></a>`).join('') || '<p class="muted">No sites yet. Add your first one above.</p>'}</div>`;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    try { const s = await api('/sites', 'POST', { name: f.get('name'), domain: f.get('domain') }); location.hash = `#/site/${s.id}/integration`; }
    catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------- site view ----------
const TABS = ['overview', 'integration', 'send', 'campaigns', 'subscribers', 'templates', 'api'];
async function siteView(id, tab) {
  if (!TABS.includes(tab)) tab = 'overview';
  const site = await api('/sites/' + id);
  view.innerHTML = `<div class="row" style="margin-bottom:8px"><a href="#/">&larr; Sites</a></div><h2>${esc(site.name)} <span class="muted" style="font-size:14px">${esc(site.domain)}</span></h2>
  <div class="tabs">${TABS.map((t) => `<a href="#/site/${id}/${t}" class="${t === tab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}</div><div id="tab"></div>`;
  const el = $('#tab');
  await ({ overview, integration, send, campaigns, subscribers, templates, api: apiTab }[tab])(el, site);
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows.length ? rows.map((r) => `<div class="bar"><span style="width:90px">${esc(r.label)}</span><i style="width:${Math.max(3, r.n / max * 160)}px"></i><em>${r.n}</em></div>`).join('') : '<p class="muted">No data yet</p>';
}
async function overview(el) {
  const id = location.hash.split('/')[2];
  const st = await api(`/sites/${id}/stats`);
  const t = st.totals, ctr = t.sent ? (t.clicks / t.sent * 100).toFixed(1) : '0.0';
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ d, n: (st.daily.find((x) => x.d === d) || {}).n || 0 }); }
  const max = Math.max(1, ...days.map((x) => x.n));
  el.innerHTML = `<div class="grid g4"><div class="card stat"><b>${t.active}</b><span>Active subscribers</span></div>
  <div class="card stat"><b>${t.campaigns}</b><span>Campaigns</span></div><div class="card stat"><b>${t.sent}</b><span>Delivered</span></div>
  <div class="card stat"><b>${ctr}%</b><span>Click rate (${t.clicks} clicks)</span></div></div>
  <div class="card"><h3>New subscribers, last 14 days</h3><div class="chart">${days.map((x) => `<div title="${x.d}: ${x.n}" style="height:${x.n / max * 100}%"></div>`).join('')}</div></div>
  <div class="grid g2">${['browser', 'os', 'device', 'country', 'language'].map((f) => `<div class="card"><h3>${f[0].toUpperCase() + f.slice(1)}</h3>${bars(st.breakdown[f])}</div>`).join('')}</div>`;
}

async function integration(el, site) {
  const me = await api('/me'); const base = me.base_url;
  const snippet = `<script src="${base}/sdk/${site.site_key}.js" async></script>`;
  el.innerHTML = `<div class="card"><h3>1. Upload the service worker</h3>
  <p class="muted">Download this file and upload it to the <b>root</b> of your website so it is reachable at <code>https://${esc(site.domain || 'yoursite.com')}/pushdesk-sw.js</code>.</p>
  <a class="btn" href="/pushdesk-sw.js" download>Download pushdesk-sw.js</a></div>
  <div class="card"><h3>2. Add the script to your pages</h3><p class="muted">Paste before <code>&lt;/body&gt;</code>. It shows an opt-in prompt automatically.</p>
  <pre>${esc(snippet)}</pre><button class="btn sm" onclick='copyText(${JSON.stringify(snippet)},this)'>Copy</button>
  <p class="muted" style="margin-top:14px">Want your own button? Set <code>window.PUSHDESK_NO_PROMPT=true</code> before the script, then call <code>PushDesk.subscribe()</code> from a click handler.</p></div>
  <div class="card"><h3>3. Test it</h3><p class="muted">Open the test page on this panel, subscribe your browser, then send a campaign.</p>
  <a class="btn sec" target="_blank" href="/demo/${site.site_key}">Open test page</a></div>
  <div class="card"><h3 style="color:var(--bad)">Danger zone</h3><button class="btn danger sm" id="del">Delete this site and all its data</button></div>`;
  $('#del').onclick = async () => { if (confirm('Delete site, subscribers and campaigns permanently?')) { await api('/sites/' + site.id, 'DELETE'); location.hash = '#/'; } };
}

async function send(el, site) {
  const [st, tpls] = await Promise.all([api(`/sites/${site.id}/stats`), api('/templates')]);
  const seg = (f) => `<label>${f[0].toUpperCase() + f.slice(1)}</label><div class="chk">${st.breakdown[f].map((r) => `<label><input type="checkbox" data-f="${f}" value="${esc(r.label)}"> ${esc(r.label)} (${r.n})</label>`).join('') || '<span class="muted">none yet</span>'}</div>`;
  el.innerHTML = `<div class="grid g2"><div class="card"><h3>Compose</h3>
  <label>Use template</label><select id="tpl"><option value="">-</option>${tpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
  <form id="f"><label>Title</label><input name="title" required maxlength="120"><label>Message</label><textarea name="body" rows="3" maxlength="400"></textarea>
  <label>Click URL</label><input name="url" type="url" placeholder="https://"><label>Icon URL</label><input name="icon" type="url" placeholder="https://">
  <label>Large image URL (optional)</label><input name="image" type="url" placeholder="https://">
  <h3 style="margin-top:20px">Audience</h3><p class="muted" style="margin:0">Leave all unchecked to send to everyone.</p>
  ${['browser', 'os', 'device', 'country', 'language'].map(seg).join('')}
  <label>Subscribed on page containing</label><input name="page" placeholder="/blog/">
  <div class="row" style="margin-top:18px"><button class="btn" id="go">Send now</button><button type="button" class="btn sec" id="est">Count audience</button><span id="n" class="muted"></span></div><div class="err" id="e"></div></form></div>
  <div class="card"><h3>Preview</h3><div class="preview"><img id="pi" alt=""><div><b id="pt">Title</b><div id="pb" class="muted">Message</div></div></div></div></div>`;
  const f = $('#f');
  const segment = () => { const s = {}; f.querySelectorAll('[data-f]:checked').forEach((c) => (s[c.dataset.f] = s[c.dataset.f] || []).push(c.value)); if (f.elements.page.value) s.page = f.elements.page.value; return s; };
  const payload = () => ({ title: f.elements.title.value, body: f.elements.body.value, url: f.elements.url.value, icon: f.elements.icon.value, image: f.elements.image.value, segment: segment() });
  const pv = () => { $('#pt').textContent = f.elements.title.value || 'Title'; $('#pb').textContent = f.elements.body.value || 'Message'; $('#pi').src = f.elements.icon.value || ''; };
  f.addEventListener('input', pv);
  $('#tpl').onchange = (e) => { const t = tpls.find((x) => x.id == e.target.value); if (!t) return; for (const k of ['title', 'body', 'url', 'icon', 'image']) f.elements[k].value = t[k] || ''; pv(); };
  $('#est').onclick = async () => { $('#n').textContent = '...'; try { $('#n').textContent = (await api(`/sites/${site.id}/estimate`, 'POST', { segment: segment() })).count + ' subscribers'; } catch (e) { $('#e').textContent = e.message; } };
  f.onsubmit = async (ev) => {
    ev.preventDefault(); $('#e').textContent = '';
    try { const n = (await api(`/sites/${site.id}/estimate`, 'POST', { segment: segment() })).count;
      if (!confirm(`Send to ${n} subscriber(s)?`)) return;
      await api(`/sites/${site.id}/campaigns`, 'POST', payload()); location.hash = `#/site/${site.id}/campaigns`;
    } catch (e) { $('#e').textContent = e.message; }
  };
}

async function campaigns(el, site) {
  const rows = await api(`/sites/${site.id}/campaigns`);
  el.innerHTML = `<div class="card" style="overflow:auto"><table><tr><th>Title</th><th>Status</th><th>Audience</th><th>Delivered</th><th>Failed</th><th>Clicks</th><th>CTR</th><th>Created</th></tr>
  ${rows.map((c) => `<tr><td>${esc(c.title)}</td><td><span class="pill ${c.status === 'completed' ? 'ok' : c.status === 'failed' ? 'bad' : ''}">${esc(c.status)}</span></td>
  <td>${c.total}</td><td>${c.sent}</td><td>${c.failed}</td><td>${c.clicks}</td><td>${c.sent ? (c.clicks / c.sent * 100).toFixed(1) + '%' : '-'}</td><td>${fmt(c.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No campaigns yet</td></tr>'}</table></div>`;
  if (rows.some((c) => c.status === 'sending')) timer = setTimeout(() => campaigns(el, site), 2000);
}

async function subscribers(el, site) {
  const page = parseInt(new URLSearchParams(location.hash.split('?')[1]).get('page')) || 1;
  const r = await api(`/sites/${site.id}/subscribers?page=${page}`);
  el.innerHTML = `<div class="card" style="overflow:auto"><p class="muted">${r.total} total</p><table><tr><th>#</th><th>Browser</th><th>OS</th><th>Device</th><th>Country</th><th>Page</th><th>Status</th><th>Joined</th></tr>
  ${r.rows.map((s) => `<tr><td>${s.id}</td><td>${esc(s.browser)}</td><td>${esc(s.os)}</td><td>${esc(s.device)}</td><td>${esc(s.country)}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.page)}</td>
  <td><span class="pill ${s.active ? 'ok' : 'bad'}">${s.active ? 'active' : 'inactive'}</span></td><td>${fmt(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No subscribers yet</td></tr>'}</table>
  <div class="row" style="margin-top:12px">${page > 1 ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?page=${page - 1}">Prev</a>` : ''}${page * r.size < r.total ? `<a class="btn sec sm" href="#/site/${site.id}/subscribers?page=${page + 1}">Next</a>` : ''}</div></div>`;
}

async function templates(el) {
  const rows = await api('/templates');
  el.innerHTML = `<div class="grid g2"><div class="card"><h3>New template</h3><form id="f"><label>Template name</label><input name="name" required>
  <label>Title</label><input name="title" required><label>Message</label><textarea name="body" rows="2"></textarea><label>Click URL</label><input name="url" type="url">
  <label>Icon URL</label><input name="icon" type="url"><label>Image URL</label><input name="image" type="url"><div style="margin-top:14px"><button class="btn">Save template</button></div><div class="err" id="e"></div></form></div>
  <div class="card"><h3>Saved templates (shared across your sites)</h3>${rows.map((t) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow"><b>${esc(t.name)}</b><div class="muted">${esc(t.title)}</div></div><button class="btn danger sm" data-d="${t.id}">Delete</button></div>`).join('') || '<p class="muted">None yet</p>'}</div></div>`;
  $('#f').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/templates', 'POST', Object.fromEntries(new FormData(ev.target))); templates(el); } catch (e) { $('#e').textContent = e.message; } };
  el.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => { await api('/templates/' + b.dataset.d, 'DELETE'); templates(el); });
}

async function apiTab(el, site) {
  const base = (await api('/me')).base_url;
  const ex = `curl -X POST ${base}/api/v1/send \\\n  -H "x-api-key: ${site.api_key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Hello","body":"New post is live","url":"https://example.com/post","segment":{"country":["IN","US"],"device":["Mobile"]}}'`;
  el.innerHTML = `<div class="card"><h3>API key</h3><p class="muted">Keep this secret. It can send notifications to this site's subscribers.</p>
  <pre>${esc(site.api_key)}</pre><div class="row"><button class="btn sm" onclick='copyText(${JSON.stringify(site.api_key)},this)'>Copy</button><button class="btn sec sm" id="rot">Regenerate</button></div></div>
  <div class="card"><h3>Send a notification</h3><pre>${esc(ex)}</pre>
  <h3>Other endpoints</h3><pre>GET ${esc(base)}/api/v1/subscribers/count?country=IN&amp;device=Mobile
GET ${esc(base)}/api/v1/campaigns/:id</pre><p class="muted">Pass the key as <code>x-api-key</code> header. Segment fields: browser, os, device, country, language, page.</p></div>`;
  $('#rot').onclick = async () => { if (confirm('Old key stops working immediately. Continue?')) { await api(`/sites/${site.id}/rotate-key`, 'POST'); route(); } };
}

// ---------- router ----------
async function route() {
  clearTimeout(timer); renderNav();
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  try {
    if (parts[0] === 'login' || parts[0] === 'signup') return authView(parts[0]);
    if (!S.token) return (location.hash = '#/login');
    if (parts[0] === 'site' && parts[1]) return await siteView(parts[1], parts[2]);
    await sitesView();
  } catch (e) { view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
route();
