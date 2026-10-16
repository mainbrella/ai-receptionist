import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceAPI, VoiceAPIError, type VoiceNumberSearchResult } from './voice-api.ts';
import { displayPhoneNumber, keypadDigits, numberPrice, vanityParts } from './voice-number-search.ts';

const search: VoiceNumberSearchResult['search'] = {
  country: 'US', query: 'FLOWERS', digits: '3569377', match: 'ends_with', type: 'toll-free', includeSimilar: 'false', limit: 50,
};

test('vanity search converts keypad letters and shows only words actually spelled by a number', () => {
  assert.equal(keypadDigits('We-Main 1010'), '9362461010');
  assert.equal(keypadDigits('abcdefghijklmnopqrstuvwxyz'), '22233344455566677778889999');
  assert.deepEqual(vanityParts('+18003569377', search), { prefix: '+1 800 ', word: 'FLOWERS', suffix: '' });
  assert.deepEqual(vanityParts('+19362461010', { ...search, query: 'WE MAIN', digits: '936246', match: 'starts_with' }),
    { prefix: '+1 ', word: 'WEMAIN', suffix: ' 1010' });
  assert.equal(vanityParts('+18009999999', search), null);
  assert.equal(vanityParts('+18003569377', { ...search, query: '3569377' }), null);
  assert.equal(vanityParts('+19362461010', { ...search, query: 'WEMAIN', digits: '936246', areaCode: '936', match: 'starts_with' }), null);
});

test('number and price formatting distinguish a zero setup fee from unavailable pricing', () => {
  assert.equal(displayPhoneNumber('+19362461010'), '+1 (936) 246-1010');
  assert.equal(numberPrice('0.00', 'USD'), 'USD\u00a00.00');
  assert.equal(numberPrice('1.25', 'USD'), 'USD\u00a01.25');
  for (const value of [null, '', '-1', 'NaN', '<script>', 'Infinity']) assert.equal(numberPrice(value, 'USD'), null);
  assert.equal(numberPrice('1.00', 'invalid'), null);
});

test('inventory requests send authenticated GET filters and cancellation without buying or reserving', async () => {
  const controller = new AbortController();
  const api = createVoiceAPI('https://api.mainbrella.com', (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/voice/numbers/search');
    assert.equal(url.searchParams.get('query'), 'WE MAIN'); assert.equal(url.searchParams.get('includeSimilar'), 'true');
    assert.equal(url.searchParams.get('areaCode'), null); assert.equal(url.searchParams.get('country'), 'US');
    assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'include'); assert.equal(init?.signal, controller.signal);
    assert.equal(init?.body, undefined);
    return Response.json({ search, numbers: [] });
  }) as typeof fetch);
  const result = await api.searchNumbers({ country: 'US', query: 'WE MAIN', match: 'starts_with', type: 'local', includeSimilar: true, limit: 50 }, controller.signal);
  assert.deepEqual(result.numbers, []);
});

test('search-specific errors remain actionable and canceled searches preserve their abort', async () => {
  for (const [status, code, expected] of [[400, 'invalid_number_search', /letters or digits/], [429, 'number_search_rate_limited', /Wait a minute/],
    [503, 'number_search_unavailable', /Number search is temporarily unavailable/]] as const) {
    const api = createVoiceAPI('https://api.mainbrella.com', (async () => Response.json({ error: code }, { status })) as typeof fetch);
    await assert.rejects(api.searchNumbers({ country: 'US', query: '', match: 'ends_with', type: 'local', includeSimilar: false, limit: 50 }),
      error => error instanceof VoiceAPIError && expected.test(error.message));
  }
  const controller = new AbortController(); controller.abort();
  const api = createVoiceAPI('https://api.mainbrella.com', (async () => { throw new DOMException('Canceled', 'AbortError'); }) as typeof fetch);
  await assert.rejects(api.searchNumbers({ country: 'US', query: '', match: 'ends_with', type: 'local', includeSimilar: false, limit: 50 }, controller.signal),
    error => error instanceof DOMException && error.name === 'AbortError');
});
