# Subcurrent app prototype

Live: https://subcurrent-prototype-v2.vercel.app (app) and https://subcurrent-prototype-v2.vercel.app/api/health (backend)

A clickable prototype of a Subcurrent fan app and owner portal. It opens on the first show: **Re:Turnal Nights**, Downright & Subcurrent, October 23–24, 2026, Denver, sound by VOID. The front end is one static page in `docs/` with no build step; the backend (Express + Prisma on Neon Postgres) runs in the same Vercel project as a serverless function at `/api`.

## Three views

- **Fan app:** shows, tickets, location drops, feed, messages, artist players.
- **Teams portal:** the crew's phone. Takeover pings for tasks, breaks, incidents and capacity; channel chat per department; push-to-talk walkie with transcripts; the door scanner with a live headcount that triggers a venue-wide capacity hold; run of show; roster.
- **Owner portal:** money, P&L, team pay, fans, Broadcast (one post to Facebook, Instagram, X and the app) and Ops dispatch in Messages (one-tap alerts, tasks, live acknowledgements, incident log).

## The 3D layer

- 3D waveform hero: the Subcurrent logo rebuilt as a field of spikes over a scrolling grid floor. It sways, pulses to the beat when a SoundCloud track plays, and turns when you drag it.
- 3D flow field behind the whole app: particles streaming out of a tunnel, faster while music plays.
- Coverflow rail for the nights, with the real Re:Turnal flyer.
- 3D tab bar: the active icon flips and lifts over a sliding glow puck. Screens swing in like a cube when you change tabs.
- Every card tilts in 3D with the pointer or the phone's motion, in the fan app and the owner portal.
- Spinning 3D mark, extruded condensed type in the flyer's style, ember orange on black throughout.

## What is real and what is demo

- Real: the Subcurrent logo, the Re:Turnal Nights flyer and lineup (Bluetech, Flintwick, Ovoid, Rhizomorphic, YOKO, Brickwife, Goosebumpz, Somatoast, Vinja, secret guests), the dates, VOID as the sound partner, and the SoundCloud pages for Bluetech, Flintwick, Ovoid, Rhizomorphic, Goosebumpz, Somatoast and Vinja.
- Demo: set times, doors, prices, past nights, Hallow Current and Undertow Afters, fans, sales and every money figure.
- Generic: Phase 1 checkout points at a "ticket partner" because Subcurrent's ticketing platform isn't confirmed. Swap in the real one (and its event links) once known.
- Live backend: accounts, tickets and check-in, the feed, DMs, push notifications, crew pings and chat, the door headcount with its capacity hold, Broadcast to the app, ticket transfers and the night recap. `docs/connect.js` wires the app's buttons to it.
- Each third-party integration turns on when its keys are set and stays simulated until then. `/api/health` shows which are live:

| Integration | Env vars | Without keys |
|---|---|---|
| Payments (Stripe Checkout) | `STRIPE_SECRET_KEY`, plus `STRIPE_WEBHOOK_SECRET` (set-keys.sh registers the webhook for you) | Orders are marked paid |
| Flyer AI + recap summary (Anthropic) | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | Sample flyer fields, template recap |
| SMS (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Logged, not sent |
| Facebook / Instagram | `META_PAGE_ID`, `META_PAGE_TOKEN`, `IG_USER_ID` | Recorded as not connected |
| X | `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | Recorded as not connected |

Fans pay on Stripe Checkout; tickets are issued by the webhook or on return to the app, whichever comes first, and only once. If the tier sold out mid-payment, the charge is refunded. Test mode card: 4242 4242 4242 4242.

## Deploy

```bash
./ship-v2.sh     # first-time setup: GitHub repo, Vercel project, Neon DB, secrets, schema + seed, deploy
./set-keys.sh    # enter integration keys (hidden input), then redeploy
```

After setup, every push to `main` redeploys. Backend tests: `cd backend && npm test`.

## Credits

The Archivo typeface by Omnibus-Type is embedded under the SIL Open Font License 1.1; see `LICENSE-ARCHIVO-OFL.txt`.
