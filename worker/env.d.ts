interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  RECEPTIONIST_CALL: DurableObjectNamespace<import("./durable-objects/receptionist-call").ReceptionistCall>;
  ADMIN_PASSWORD: string;
  VOICE_ENABLED?: string;
  VOICE_PUBLIC_ORIGIN?: string;
  TRANSCRIPT_RETENTION_DAYS?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_SIP_URI?: string;
  TELNYX_API_KEY?: string;
  TELNYX_PUBLIC_KEY?: string;
  TELNYX_ACCOUNT_SID?: string;
  TELNYX_CONNECTION_ID?: string;
  TELNYX_PHONE_NUMBER?: string;
  TELNYX_SIP_URI?: string;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
