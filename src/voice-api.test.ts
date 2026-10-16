import test from 'node:test';
import assert from 'node:assert/strict';
import { callDuration, createVoiceAPI, VoiceAPIError, voiceSocketURL } from './voice-api.ts';

test('voice API requests stay on the supplied origin and include the session cookie', async () => {
  const sent: { url: string; options: RequestInit }[] = [];
  const api = createVoiceAPI('https://voice.example.test', (async (url, options) => {
    sent.push({ url: String(url), options: options! });
    return Response.json({ calls: [] });
  }) as typeof fetch);

  await api.calls();

  assert.equal(sent[0].url, 'https://voice.example.test/voice/calls');
  assert.equal(sent[0].options.credentials, 'include');
});

test('deleting a transcript accepts the API’s empty 204 response', async () => {
  let request: { url: string; options: RequestInit } | undefined;
  const api = createVoiceAPI('https://voice.example.test', (async (url, options) => {
    request = { url: String(url), options: options! };
    return new Response(null, { status: 204 });
  }) as typeof fetch);

  await api.remove('call/with space');

  assert.equal(request?.url, 'https://voice.example.test/voice/calls/call%2Fwith%20space');
  assert.equal(request?.options.method, 'DELETE');
  assert.equal(request?.options.credentials, 'include');
});

test('voice API errors retain status and use human-readable messages', async () => {
  for (const [status, code, expected] of [
    [401, 'not_authenticated', /session has expired/],
    [429, 'rate_limited', /Wait a moment/],
    [503, 'voice_model_unavailable', /Choose another model/],
    [503, 'worker_detail_with_internal_data', /temporarily unavailable/],
  ] as const) {
    const api = createVoiceAPI('https://voice.example.test', (async () => Response.json({ error: code }, { status })) as typeof fetch);
    await assert.rejects(api.calls(), caught => caught instanceof VoiceAPIError && caught.status === status && expected.test(caught.message));
  }
});

test('voice settings preserve model, language, speaker, and response timing', async () => {
  const settings = { name: 'Receptionist', businessName: 'A & B', greeting: 'Hola', instructions: 'Ask about the visit.',
    voice: 'celeste', model: 'aura-2' as const, language: 'es' as const,
    voiceLogic: 'reply_right_away' as const, transferNumber: null };
  const api = createVoiceAPI('https://voice.example.test', (async (url, options) => {
    assert.equal(url, 'https://voice.example.test/voice/agent');
    assert.equal(options?.method, 'PUT');
    assert.equal(options?.credentials, 'include');
    assert.deepEqual(JSON.parse(options?.body as string), settings);
    return Response.json({ agent: { ...settings, id: 'agent-1' } });
  }) as typeof fetch);

  assert.equal((await api.saveAgent(settings)).agent.language, 'es');
});

test('voice sockets reject a different origin', () => {
  assert.equal(voiceSocketURL('/voice/calls/123/connect', 'https://voice.example.test'), 'wss://voice.example.test/voice/calls/123/connect');
  assert.throws(() => voiceSocketURL('wss://elsewhere.example/voice/calls/123/connect', 'https://voice.example.test'), /connect securely/);
});

test('call durations handle zero, minutes, and invalid measurements', () => {
  assert.equal(callDuration(0), '0:00');
  assert.equal(callDuration(65.9), '1:05');
  assert.equal(callDuration(-10), '0:00');
  assert.equal(callDuration(Number.NaN), '0:00');
});
