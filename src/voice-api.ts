export interface Receptionist {
  id: string;
  name: string;
  businessName: string;
  greeting: string;
  instructions: string;
  voice: string;
  model?: VoiceModel;
  language?: VoiceLanguage;
  voiceLogic?: VoiceLogic;
  transferNumber: string | null;
  updatedAt: string;
}

export type VoiceLogic = 'original_no_reply' | 'reply_right_away';
export type VoiceModel = 'aura-1' | 'aura-2' | 'aura-2-gateway' | 'sonic-3.6';
export type VoiceLanguage = 'en' | 'es' | 'fr' | 'de' | 'hi' | 'ru' | 'pt' | 'ja' | 'it' | 'nl';
export interface VoiceSpeechOptions {
  languages: Array<{ code: VoiceLanguage; name: string }>;
  models: Array<{ id: VoiceModel; name: string; available: boolean; unavailableReason: string | null;
    languages: Array<{ code: VoiceLanguage; voices: Array<{ id: string; name: string }> }> }>;
}

export interface VoiceMessage { role: 'user' | 'assistant'; text: string }
export interface VoiceCall {
  id: string;
  channel: 'browser' | 'text' | 'phone';
  status: 'active' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  transcript: VoiceMessage[];
}

export interface VoiceConfig {
  enabled: boolean;
  browserCalling: boolean;
  telephony: {
    configured: boolean;
    twilioConfigured: boolean;
    webhookUrl: string | null;
    phoneNumber: string | null;
    sipUri: string | null;
    telnyx: { configured: boolean; webhookUrl: string | null; phoneNumber: string | null; sipUri: string | null };
  };
  models: { stt: string; llm: string; tts: string };
  speech?: VoiceSpeechOptions;
}

export interface VoiceNumberSearchInput {
  country: 'US' | 'CA'; query: string; areaCode?: string;
  match: 'ends_with' | 'contains' | 'starts_with'; type: 'local' | 'toll-free';
  locality?: string; region?: string; includeSimilar: boolean; limit: number;
}
export interface VoiceNumberSearchResult {
  search: Omit<VoiceNumberSearchInput, 'includeSimilar'> & { includeSimilar: 'true' | 'false'; digits: string };
  numbers: Array<{ phoneNumber: string; location: string; exactMatch: boolean;
    cost: { monthly: string | null; upfront: string | null; currency: string } | null }>;
}

export class VoiceAPIError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    const messages: Record<string, string> = {
      not_authenticated: 'Your session has expired. Sign in again to continue.',
      invalid_request: 'Check your settings and try again.',
      agent_required: 'Save your receptionist before starting a test.',
      agent_not_found: 'Save your receptionist before starting a test.',
      call_not_found: 'This call could not be found. Refresh your call history.',
      not_found: 'This call could not be found. Refresh your call history.',
      voice_disabled: 'Voice calling is not enabled yet. Your settings can still be saved.',
      voice_unavailable: 'Voice is temporarily unavailable. Please try again.',
      voice_model_unavailable: 'This voice model is not available. Choose another model and save your settings.',
      call_limit: 'You have reached the active call limit. End a call before starting another.',
      voice_call_limit: 'Your call limit has been reached. End an active call or try again later.',
      rate_limited: 'Too many requests. Wait a moment and try again.',
      call_ended: 'This call has ended. Start a new test to continue.',
      invalid_number_search: 'Check the search filters. Use up to 10 letters or digits, or 7 when specifying an area code.',
      number_search_rejected: 'These filters could not be searched. Try another area code or a shorter word.',
      number_search_rate_limited: 'Too many searches. Wait a minute and try again.',
      number_search_unavailable: 'Number search is temporarily unavailable. Please try again.',
    };
    super(messages[code] ?? (status === 401 ? messages.not_authenticated : status === 429 ? messages.rate_limited
      : status >= 500 ? 'Voice is temporarily unavailable. Please try again.' : 'The request could not be completed. Please try again.'));
    this.name = 'VoiceAPIError';
  }
}

export function createVoiceAPI(origin: string, fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, method = 'GET', body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${origin}/voice${path}`, {
        method, credentials: 'include', keepalive, signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Could not reach Voice. Check your connection and try again.');
    }
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new VoiceAPIError(response.status, typeof data?.error === 'string' ? data.error : 'request_failed');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Could not read the response from Voice. Please try again.');
    return data as T;
  }

  return {
    config: () => request<VoiceConfig>('/config'),
    agent: () => request<{ agent: Receptionist | null }>('/agent'),
    saveAgent: (agent: Omit<Receptionist, 'id' | 'updatedAt'> & { voiceLogic: VoiceLogic }) => request<{ agent: Receptionist }>('/agent', 'PUT', agent),
    calls: () => request<{ calls: VoiceCall[] }>('/calls'),
    call: (id: string) => request<{ call: VoiceCall }>(`/calls/${encodeURIComponent(id)}`),
    remove: (id: string) => request<void>(`/calls/${encodeURIComponent(id)}`, 'DELETE'),
    start: (channel: 'browser' | 'text') => request<{ call: VoiceCall; websocketUrl: string }>('/calls', 'POST', { channel }),
    end: (id: string, keepalive = false) => request<{ call: VoiceCall }>(`/calls/${encodeURIComponent(id)}/end`, 'POST', {}, keepalive),
    searchNumbers: (input: VoiceNumberSearchInput, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') query.set(key, String(value));
      return request<VoiceNumberSearchResult>(`/numbers/search?${query}`, 'GET', undefined, false, signal);
    },
  };
}

export function callDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function channelLabel(channel: VoiceCall['channel']): string {
  return { browser: 'Browser test', text: 'Text test', phone: 'Phone' }[channel];
}

// Accept only the API's origin, so a malformed response cannot move a session to another host.
export function voiceSocketURL(value: string, apiOrigin: string): string {
  const api = new URL(apiOrigin);
  const url = new URL(value, api);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.host !== api.host || url.protocol !== (api.protocol === 'https:' ? 'wss:' : 'ws:') || url.username || url.password) {
    throw new Error('Could not connect securely to Voice. Please try again.');
  }
  return url.href;
}
