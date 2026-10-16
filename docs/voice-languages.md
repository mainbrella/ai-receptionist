# Speech models and languages

Receptionist settings select a speech model, language, voice, and response mode.
The model selector shows unavailable providers until their credentials are configured.
The API validates each combination, and active calls retain their saved settings.

| Speech model | Supported languages | Setup |
| --- | --- | --- |
| Aura-1 | English | Workers AI binding |
| Aura-2 · Cloudflare | English, Spanish | Workers AI binding |
| Aura-2 · Deepgram | English, Spanish, French, German, Japanese, Italian, Dutch | Deepgram through AI Gateway |
| Sonic 3.6 · Cartesia | English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch | Cartesia through AI Gateway |

English uses Flux transcription and Llama replies. Other languages use Nova-3
transcription and Gemma replies. Write the greeting in the selected language; it
is spoken verbatim. The voice list follows the chosen model and language.

Standard voice logic waits for the answer. **Reply right away** preloads three
short acknowledgments and rotates through them while generating answers. These
optional clips use the selected language, are interruptible, and are omitted
from transcripts. Text tests always return only the generated answer. Legacy
calls already in progress retain the previous backchannel behavior until they end.

All transports use mono PCM16 at 16 kHz. The implementation uses the same model
catalog and provider requests as the upstream Voice app. Fixture tests verify
routing, audio format handling, interruptions, and settings; live pronunciation
and latency still require provider testing.

## Optional gateway providers

Set these variables for an existing Cloudflare AI Gateway:

- `VOICE_AI_GATEWAY_ACCOUNT_ID`: your 32-character Cloudflare account ID.
- `VOICE_AI_GATEWAY_ID`: your gateway name.

For an authenticated gateway, set the `VOICE_AI_GATEWAY_TOKEN` secret. Set
`DEEPGRAM_API_KEY` for Aura-2 through Deepgram and/or `CARTESIA_API_KEY` for
Sonic 3.6. Appflare exposes these as optional installation settings. For a manual
deployment, use `npx wrangler secret put <NAME>` for each secret.

Credentials stay in the Worker. External speech requests bypass gateway caching.
Provider accounts bill you directly; this standalone app does not require billing
rates or a Mainbrella wallet.

Apply the D1 migrations before deploying an upgrade. Existing agents default to
Aura-1, English, and standard voice logic; historical call snapshots stay intact.
