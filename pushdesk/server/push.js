const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');

let pub = getSetting('vapid_public');
let priv = getSetting('vapid_private');
if (!pub || !priv) {
  const k = webpush.generateVAPIDKeys();
  pub = k.publicKey; priv = k.privateKey;
  setSetting('vapid_public', pub);
  setSetting('vapid_private', priv);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);

const SEGMENT_FIELDS = ['browser', 'os', 'device', 'country', 'language'];

function buildAudienceQuery(siteId, segment = {}) {
  let sql = 'FROM subscribers WHERE site_id=? AND active=1';
  const params = [siteId];
  for (const f of SEGMENT_FIELDS) {
    let v = segment[f];
    if (v == null || v === '') continue;
    if (!Array.isArray(v)) v = [v];
    if (!v.length) continue;
    sql += ` AND ${f} IN (${v.map(() => '?').join(',')})`;
    params.push(...v.map(String));
  }
  if (segment.page) { sql += ' AND page LIKE ?'; params.push('%' + String(segment.page) + '%'); }
  return { sql, params };
}

function countAudience(siteId, segment) {
  const { sql, params } = buildAudienceQuery(siteId, segment);
  return db.prepare('SELECT COUNT(*) AS n ' + sql).get(...params).n;
}

async function sendCampaign(campaignId, serverOrigin) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  if (!c) return;
  let segment = {};
  try { segment = JSON.parse(c.segment || '{}'); } catch (_) {}
  const { sql, params } = buildAudienceQuery(c.site_id, segment);
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth ' + sql).all(...params);
  db.prepare('UPDATE campaigns SET total=? WHERE id=?').run(subs.length, c.id);

  const payload = JSON.stringify({
    title: c.title, body: c.body || '', url: c.url || '', icon: c.icon || '', image: c.image || '',
    campaignId: c.id, server: serverOrigin
  });
  const dead = db.prepare('UPDATE subscribers SET active=0 WHERE id=?');
  const progress = db.prepare('UPDATE campaigns SET sent=sent+?, failed=failed+? WHERE id=?');
  const CHUNK = 100;

  for (let i = 0; i < subs.length; i += CHUNK) {
    const slice = subs.slice(i, i + CHUNK);
    const results = await Promise.allSettled(slice.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 })
    ));
    let ok = 0, bad = 0;
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') ok++;
      else {
        bad++;
        const code = r.reason && r.reason.statusCode;
        if (code === 404 || code === 410) dead.run(slice[idx].id);
      }
    });
    progress.run(ok, bad, c.id);
  }
  db.prepare("UPDATE campaigns SET status='completed' WHERE id=?").run(c.id);
}

module.exports = { webpush, vapidPublicKey: pub, sendCampaign, countAudience, SEGMENT_FIELDS };
