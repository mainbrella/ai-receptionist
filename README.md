# Mainbrella Voice

A self-hosted AI receptionist for Cloudflare Workers. It provides a password-protected workspace to configure one receptionist, test it by voice or text, receive incoming Twilio or Telnyx calls, and review or delete transcripts.

Each installation runs as a single Worker with static assets, a D1 database, a SQLite-backed `ReceptionistCall` Durable Object, and Workers AI. There is no Mainbrella account, wallet, Stripe billing, Google sign-in, or container service. Cloudflare and your phone carrier bill you directly.

## Requirements

- Node.js 22 or newer and npm
- A Cloudflare account with Workers, D1, Durable Objects, and Workers AI access
- A Cloudflare Workers Paid plan. The Worker sets a 30,000 ms CPU limit for voice processing.
- Wrangler authentication for deploys; local development uses Wrangler's remote Workers AI binding

## Local development

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
# Edit .dev.vars and replace ADMIN_PASSWORD with a random password of at least 16 characters.
npm run db:migrate:local
npm run dev
```

Open the local URL printed by Wrangler and sign in with `ADMIN_PASSWORD`. `npm run dev` builds the browser client and starts Wrangler. Browser and text tests do not require carrier credentials. Local Workers AI uses your Cloudflare account and may incur charges.

## Checks

```sh
npm test
npm run build
```

The tests use deterministic AI fixtures; they do not place paid calls to Cloudflare models or phone carriers. They do not verify live provider credentials, carrier webhooks, or production audio.

## Production deploy

Create a D1 database, then copy its returned ID into `d1_databases[0].database_id` in `wrangler.jsonc`:

```sh
npx wrangler d1 create mainbrella-voice
```

Set `VOICE_PUBLIC_ORIGIN` to the exact public HTTPS origin for this Worker, without a trailing slash. Keep `VOICE_ENABLED` set to `"true"` to allow calls. Add `ADMIN_PASSWORD` as a Worker secret; do not put secrets in `wrangler.jsonc`:

```sh
npx wrangler secret put ADMIN_PASSWORD
npm run db:migrate:remote
npm run deploy
```

Set the origin and any non-secret provider settings in the Cloudflare Worker settings or `wrangler.jsonc`. Set optional provider secrets with `npx wrangler secret put TWILIO_AUTH_TOKEN` and/or `npx wrangler secret put TELNYX_API_KEY`. See [Phone connections](docs/telephony.md) for the complete provider configuration and number search. Appflare installs provision D1, Durable Objects, migrations, and the generated admin password automatically.

For an existing installation, run `npm run db:migrate:remote` before deploying this update. The new migrations preserve receptionists and call history while adding speech settings and phone-search limits. Use `npm run db:migrate:local` for a local installation.

## Behavior and limits

The default is Aura-1 in English, with Flux speech recognition and Llama responses. Settings also offer Aura-2 and optional Deepgram or Cartesia speech through AI Gateway, with ten languages across the model catalog. Non-English calls use Nova-3 recognition and Gemma replies. See [Speech models and languages](docs/voice-languages.md) for provider setup and supported combinations.

Voice logic defaults to the standard response. The experimental **Reply right away** mode plays a short acknowledgment in the selected language while the answer is generated. Each call uses a snapshot of its saved settings. Calls are limited to three active at once, 100 starts in a rolling 24-hour window, 15 minutes per call, and 60 turns.

Transcripts are retained for 30 days by default. `TRANSCRIPT_RETENTION_DAYS` accepts 1–365; invalid values use 30. The daily cleanup removes expired transcript and saved-call configuration data while retaining minimal call/provider tombstones for replay protection and quota accounting. Deleting a completed or failed transcript also purges its temporary Durable Object state. Audio is not recorded.

The app supports incoming calls and taking messages. Scheduling, outbound calls, human transfers, CRM lookups, and account lookups are not connected.

See [Appflare packaging](docs/appflare.md) for catalog maintainers and [Phone connections](docs/telephony.md) for Twilio and Telnyx setup. Licensing and source attribution are in [NOTICE.md](NOTICE.md); the project is GPL-3.0-only.
