import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import { handleVoiceRequest } from '../worker/app/voice';
import { hashToken } from '../worker/app/auth-core';
import { matchesNumberPattern, numberSearchDigits } from '../worker/app/voice-number-search';

const SESSION_ONE = 'a'.repeat(64);
const PASSWORD = 'a-long-number-search-fixture-password';
const handleRequest = (request: Request, env: Env) => handleVoiceRequest(request, env, {} as ExecutionContext);

const endpoint = 'https://receptionist.example/voice/numbers/search';
const row = (phone_number = '+18003569377', changes: Record<string, unknown> = {}) => ({
  phone_number, features: [{ name: 'voice' }], best_effort: false,
  region_information: [{ region_type: 'country_code', region_name: 'US' }, { region_type: 'state', region_name: 'TX' }],
  cost_information: { monthly_cost: '1.00', upfront_cost: '0.00', currency: 'USD' }, ...changes,
});
function request(query = '', options: { session?: string | null; origin?: string; method?: string } = {}) {
  return new Request(`${endpoint}${query ? `?${query}` : ''}`, { method: options.method ?? 'GET', headers: {
    Origin: options.origin ?? 'https://receptionist.example',
    ...(options.session === null ? {} : { Cookie: `__Host-receptionist_session=${options.session ?? SESSION_ONE}` }),
  } });
}
async function fixture(t: test.TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'number-search-db', modules: true, script: 'export default {fetch() {return new Response("ok")}}',
    compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,password_hash TEXT,expires_at INTEGER)').run();
  await db.prepare('CREATE TABLE number_search_attempts(bucket TEXT PRIMARY KEY,attempts INTEGER,expires_at INTEGER)').run();
  await db.prepare('INSERT INTO sessions VALUES(?,?,?)')
    .bind(await hashToken(SESSION_ONE), await hashToken(PASSWORD), Date.now() + 60_000).run();
  return { db, env: { DB: db, ADMIN_PASSWORD: PASSWORD, TELNYX_API_KEY: 'number-search-secret-fixture' } as unknown as Env };
}

test('number search works in Workers and rejects provider redirects without following them', async t => {
  const bundle = await build({
    stdin: { contents: `
      import { searchVoiceNumbers, numberSearchInput } from '../worker/app/voice-number-search';
      export default { async fetch(request, env) {
        try {
          return Response.json(await searchVoiceNumbers(env, numberSearchInput.parse({ query: 'flowers' })));
        } catch {
          return Response.json({ error: 'number_search_unavailable' }, { status: 503 });
        }
      } };
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser', external: ['cloudflare:*', 'node:*'],
  });
  const requests: string[] = [];
  let redirect = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'number-search-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat'],
    bindings: { TELNYX_API_KEY: 'number-search-secret-fixture' },
    outboundService: async request => {
      requests.push(request.url);
      assert.equal(new URL(request.url).origin, 'https://api.telnyx.com');
      assert.equal(request.headers.get('authorization'), 'Bearer number-search-secret-fixture');
      return redirect ? new MiniflareResponse(null, { status: 302, headers: { location: 'https://other.example/numbers' } })
        : MiniflareResponse.json({ data: [row()] });
    },
  }] }));
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch(endpoint);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.numbers[0].phoneNumber, '+18003569377');
  assert.equal(requests.length, 1);
  redirect = true;
  const redirected = await mf.dispatchFetch(endpoint);
  assert.equal(redirected.status, 503);
  assert.deepEqual(await redirected.json(), { error: 'number_search_unavailable' });
  assert.equal(requests.length, 2);
});

test('number search requires an authenticated account and trusted origin before provider access', async t => {
  const f = await fixture(t);
  const fetcher = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream request'); });
  assert.equal((await handleRequest(request('', { session: null }), f.env)).status, 401);
  assert.equal((await handleRequest(request('', { origin: 'https://evil.example' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('', { method: 'POST' }), f.env)).status, 405);
  const preflight = await handleRequest(request('', { method: 'OPTIONS', session: null }), f.env);
  assert.equal(preflight.status, 405);
  assert.equal(fetcher.mock.calls.length, 0); assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM number_search_attempts').first())!.count, 0);
});

test('number search rejects ambiguous, oversized and unsupported filters before dispatch', async t => {
  const f = await fixture(t);
  const fetcher = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream request'); });
  for (const query of ['query=one&query=two', 'query=%2A', 'query=12345678901', 'query=12345678&areaCode=310', 'query=---',
    'areaCode=012', 'country=XX', 'limit=51', 'limit=0', 'limit=NaN', 'region=California', 'locality=%3Cscript%3E',
    'type=mobile', 'match=regex', 'includeSimilar=yes', 'filter[features][]=sms', 'purchase=true']) {
    assert.equal((await handleRequest(request(query), f.env)).status, 400, query);
  }
  assert.equal(fetcher.mock.calls.length, 0); assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM number_search_attempts').first())!.count, 0);
});

test('word search makes a single GET with the server key and explicit voice filters; prices are provider estimates', async t => {
  const f = await fixture(t);
  const calls: { url: URL; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json({ data: [row('+18003569377'), row('+18003569377'), row('+18009999999', { best_effort: true }),
      row('+18003569376'), row('+18003569370', { features: [{ name: 'sms' }] }), row('+18003569371', { features: [] }),
      row('+18003569377', { region_information: [{ region_type: 'country_code', region_name: 'CA' }] })] });
  });
  f.env.VOICE_ENABLED = 'false'; // Browsing inventory does not require a saved agent or calling credits.
  const response = await handleRequest(request('query=flowers&areaCode=800&type=toll-free&region=TX&locality=Austin&limit=25'), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as any;
  assert.equal(body.search.digits, '3569377'); assert.equal(body.numbers.length, 1);
  assert.deepEqual(body.numbers[0], { phoneNumber: '+18003569377', location: 'TX', exactMatch: true,
    cost: { monthly: '1.00', upfront: '0.00', currency: 'USD' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].url.origin, 'https://api.telnyx.com');
  assert.equal(calls[0].url.pathname, '/v2/available_phone_numbers'); assert.equal(calls[0].init?.method, 'GET');
  const params = calls[0].url.searchParams;
  assert.equal(params.get('filter[phone_number][ends_with]'), '3569377');
  assert.equal(params.get('filter[national_destination_code]'), '800'); assert.equal(params.get('filter[features][]'), 'voice');
  assert.equal(params.get('filter[phone_number_type]'), 'toll_free'); assert.equal(params.get('filter[administrative_area]'), 'TX');
  assert.equal(params.get('filter[locality]'), 'Austin'); assert.equal(params.get('filter[country_code]'), 'US');
  assert.equal(params.get('filter[best_effort]'), 'false'); assert.equal(params.get('filter[exclude_held_numbers]'), 'true');
  assert.equal(params.get('filter[limit]'), '25');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer number-search-secret-fixture');
  assert.doesNotMatch(JSON.stringify(body), /secret-fixture|record_type|cost_information/);
});

test('similar numbers are opt-in, verified against the contiguous pattern and sorted after exact matches', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [row('+13109991010', { best_effort: true }),
    row('+13101010101'), row('+13109991011'), row('+13102221010', { cost_information: null }),
    row('+14162221010', { region_information: [{ region_type: 'country_code', region_name: 'CA' }] })] }));
  const response = await handleRequest(request('query=1010&areaCode=310&includeSimilar=true'), f.env);
  assert.equal(response.status, 200); const body = await response.json() as any;
  assert.deepEqual(body.numbers.map((number: any) => [number.phoneNumber, number.exactMatch]), [
    ['+13102221010', true], ['+13101010101', false], ['+13109991010', false], ['+13109991011', false],
  ]);
  assert.equal(body.numbers[0].cost, null);
});

test('search needs only a Telnyx key and limits authenticated searches to 20 per minute', async t => {
  const f = await fixture(t);
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  delete f.env.TELNYX_API_KEY;
  assert.equal((await handleRequest(request(), f.env)).status, 503);
  f.env.TELNYX_API_KEY = 'fixture';
  f.env.VOICE_ENABLED = 'false';
  assert.equal((await handleRequest(request(), f.env)).status, 200);
  const now = Date.now();
  // Seed the current and next minute to avoid a clock boundary making this flaky.
  for (const minute of [Math.floor(now / 60_000), Math.floor(now / 60_000) + 1]) {
    await f.db.prepare('INSERT INTO number_search_attempts VALUES(?,20,?) ON CONFLICT(bucket) DO UPDATE SET attempts=20')
      .bind(`owner:${minute}`, now + 120_000).run();
  }
  const limited = await handleRequest(request(), f.env);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(fetcher.mock.calls.length, 1);
});

test('provider failures and malformed responses produce safe retryable errors without leaking credentials', async t => {
  const f = await fixture(t);
  for (const [providerStatus, status] of [[401, 503], [403, 503], [422, 400], [429, 429], [500, 503]]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response('PRIVATE PROVIDER DATA', { status: providerStatus }));
    const response = await handleRequest(request(), f.env);
    assert.equal(response.status, status); assert.doesNotMatch(await response.text(), /PRIVATE|secret-fixture/); mocked.mock.restore();
  }
  for (const data of [null, { data: 'bad' }, { data: [{ phone_number: '+18003569377', features: 'bad' }] }]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json(data));
    assert.equal((await handleRequest(request(), f.env)).status, 503); mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('number-search-secret-fixture'); });
  const response = await handleRequest(request(), f.env); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'number_search_unavailable' });
});

test('phone keypad matching preserves 0 and 1, and supports words spanning area codes', () => {
  assert.equal(numberSearchDigits('WE-MAIN 1010'), '9362461010');
  assert.equal(numberSearchDigits('Flowers'), '3569377');
  assert.equal(matchesNumberPattern('+19362461010', { match: 'starts_with' }, numberSearchDigits('WEMAIN')), true);
  assert.equal(matchesNumberPattern('+19362461010', { areaCode: '936', match: 'starts_with' }, numberSearchDigits('WEMAIN')), false);
  assert.equal(matchesNumberPattern('+19362461010', { match: 'ends_with' }, '1010'), true);
  assert.equal(matchesNumberPattern('+19362461010', { match: 'contains' }, '361'), false);
});

test('oversized streamed inventory is rejected without exposing the provider response', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(524289)));
  const response = await handleRequest(request(), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'number_search_unavailable' });
});
