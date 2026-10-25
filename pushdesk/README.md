# PushDesk – self-hosted web push notification panel

Unlimited sites, subscribers and campaigns on your own server. Node.js + Express + SQLite on the backend, a no-build vanilla JS panel on the frontend. Uses the standard Web Push protocol with VAPID keys (no Firebase account needed).

## Run it

```bash
npm install
cp .env.example .env      # set BASE_URL to your public https URL
npm start
```

Open `http://localhost:3000/app`, create your account (first signup), add a site, and follow the **Integration** tab.
After creating your admin account, set `ALLOW_SIGNUP=false` in `.env` to close registration.

Requires Node 18+. `better-sqlite3` ships prebuilt binaries for common platforms; otherwise you need build tools (python3, make, g++).

## How it works

1. **Integration tab** gives you the embed script `<script src="BASE_URL/sdk/SITEKEY.js" async>` and `pushdesk-sw.js`.
2. Upload `pushdesk-sw.js` to the root of the customer website (service workers must be served from the site's own origin).
3. Visitors see an opt-in prompt; their browser subscription is stored in SQLite (`data/pushdesk.db`) with browser/OS/device/country/language/page.
4. **Send** tab: compose, optionally segment, send. Delivery runs in the background in batches of 100; expired subscriptions are deactivated automatically.
5. Clicks are tracked by the service worker and shown per campaign.

Quick local test: **Integration → Open test page** subscribes your browser on `localhost` (allowed as a secure context), then send a campaign.

## REST API

```bash
curl -X POST $BASE_URL/api/v1/send -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"Post is live","url":"https://example.com","segment":{"device":["Mobile"]}}'
GET /api/v1/subscribers/count?country=IN
GET /api/v1/campaigns/:id
```

## Production notes

- Serve behind HTTPS (nginx/Caddy). Web Push does not work on plain http except localhost.
- Keep `data/` backed up. It holds subscribers and your VAPID keys. **If you lose the VAPID keys, all existing subscribers stop working.**
- Country detection reads `cf-ipcountry` (Cloudflare) or `x-vercel-ip-country`; otherwise it shows `Unknown`. Add a GeoIP lookup in `server/index.js` (`/public/subscribe`) if you need it.
- iOS: Safari only supports push for sites added to the Home Screen (iOS 16.4+).
- Run with PM2 or systemd: `pm2 start server/index.js --name pushdesk`.

## Not included

WordPress plugin, scheduled/automatic sends (AutoMagic, YouTube push, push-on-publish), Google Drive backup, and subscriber import tools. The REST API is enough to build push-on-publish yourself.
