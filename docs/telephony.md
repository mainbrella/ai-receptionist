# Incoming phone connections

The Worker can answer incoming calls through Twilio Programmable Voice or Telnyx TeXML. Configure credentials in Appflare settings or as Worker secrets and variables; the Voice workspace displays connection status, phone number, SIP address, and provider webhook URLs. It does not accept provider credentials in the app.

The receptionist must be saved before the webhook URL is available. Set `VOICE_PUBLIC_ORIGIN` to the exact public HTTPS origin for this Worker, with no path or trailing slash. Carrier callbacks use this origin and cannot be tested against the local HTTP address in `.dev.vars`.

## Twilio

Configure these Worker values:

| Name | Type | Purpose |
| --- | --- | --- |
| `TWILIO_AUTH_TOKEN` | Secret | Verify incoming Twilio signatures and end calls |
| `TWILIO_ACCOUNT_SID` | Variable | Twilio account SID |
| `TWILIO_PHONE_NUMBER` | Variable, optional | Incoming destination in E.164 format, such as `+15551234567` |
| `TWILIO_SIP_URI` | Variable, optional | Programmable Voice SIP destination, such as `sip:receptionist@example.sip.twilio.com` |

Use either an E.164 number or a Twilio Programmable Voice SIP URI. Elastic SIP Trunking is not supported. In Twilio, open the number's voice configuration and set **A call comes in** to the Twilio webhook shown under **Phone connection**, using **HTTP POST**. If you use a SIP URI, configure the applicable Programmable Voice SIP domain to send incoming calls to that same webhook.

## Telnyx

Configure these Worker values:

| Name | Type | Purpose |
| --- | --- | --- |
| `TELNYX_API_KEY` | Secret | v2 API key with access to TeXML calls and number inventory; used to stop calls and search available numbers |
| `TELNYX_PUBLIC_KEY` | Variable | Base64 Ed25519 public key used to verify Telnyx signatures |
| `TELNYX_ACCOUNT_SID` | Variable | Telnyx account UUID used as `AccountSid` in TeXML requests |
| `TELNYX_CONNECTION_ID` | Variable | Numeric TeXML application/connection ID |
| `TELNYX_PHONE_NUMBER` | Variable, optional | Incoming destination in E.164 format |
| `TELNYX_SIP_URI` | Variable, optional | TeXML application SIP destination, such as `sip:receptionist@example.sip.telnyx.com` |

In Telnyx, create a TeXML application and set its Voice URL to the Telnyx webhook shown under **Phone connection**, using **POST**. Assign the incoming number to that application. For SIP, configure a SIP subdomain on the same TeXML application and use its displayed destination. The application ID is numeric; the account ID is a UUID. They are different values. The workspace generates the webhook path when a receptionist is saved; no separate agent ID variable is required.

If you cannot find your account UUID in Telnyx's TeXML request debugger, configure the other Telnyx settings and leave `TELNYX_ACCOUNT_SID` empty temporarily. Save your receptionist, copy its Telnyx webhook from **Phone connection**, and set that URL in the TeXML application. Open the installed Worker's logs in the Cloudflare dashboard, or run `npx wrangler tail <installed-worker-name>`, then call your number.

After verifying the signature, application ID, receptionist, destination, and call ID, the Worker logs:

```text
voice_telnyx_account_sid_required {"AccountSid":"YOUR_ACCOUNT_UUID","ConnectionId":"YOUR_APPLICATION_ID"}
```

Copy `AccountSid` into the app's `TELNYX_ACCOUNT_SID` setting and save it (or redeploy for a manual installation). Until it is set, the callback returns an empty 503 response, no call is created, and media connections stay disabled. The Worker never saves the discovered account ID automatically.

Diagnostic logs distinguish invalid signatures (`voice_telnyx_webhook_signature_invalid`), a wrong application/receptionist/destination/call ID (`voice_telnyx_webhook_identity_mismatch`), a missing or malformed incoming account ID (`voice_telnyx_account_sid_missing_or_invalid`), a configured account mismatch (`voice_telnyx_webhook_account_mismatch`), and incomplete settings (`voice_telnyx_configuration_incomplete`). Only a verified, matching webhook can log an account UUID; rejected requests are logged without caller data or credentials.

See Telnyx's [TeXML setup](https://developers.telnyx.com/docs/voice/programmable-voice/texml-setup), [TeXML application settings](https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application), and [media streaming](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming) documentation for provider-side setup.

## Number search

The **Search numbers** tab searches Telnyx inventory for voice-capable US and Canadian numbers. Search by digits or a word, optionally with an area code, location, region, or toll-free filter. Word searches use the phone keypad; similar results are opt-in and appear after exact matches. Prices are provider estimates.

Search requires only `TELNYX_API_KEY` and an authenticated admin session. It works before saving a receptionist or configuring incoming calls. Searches are limited to 20 per minute per installation using D1, with no additional binding required. The app can copy a result; purchasing the number and assigning its TeXML application remain in Telnyx.

## Callback and call behavior

Use the exact webhook URL displayed by the workspace and HTTP POST for both providers. Signed callback verification, destination/account checks, and short-lived single-use WebSocket media authorization are enforced by the Worker. Keep `/voice/twilio/*` and `/voice/telnyx/*` reachable by the providers if Cloudflare Access is enabled; the Appflare manifest supplies those bypass paths.

Carrier calls use the same three-active-call, 100-starts-per-rolling-24-hours, 15-minute, and 60-turn limits as browser and text tests. Twilio and Telnyx charge their accounts directly; Cloudflare AI usage is billed to the Cloudflare account. This app has no Mainbrella markup or wallet. Audio is streamed for the call and is not recorded. The app does not place outbound calls, transfer calls, or book appointments.

The local test suite uses deterministic fixtures. It does not prove that a live Twilio or Telnyx account, provider webhook, signature, or audio stream is configured correctly. Complete a real incoming-call smoke test for each provider before advertising that connection as verified.
