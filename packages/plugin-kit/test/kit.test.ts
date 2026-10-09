import test from 'node:test';
import assert from 'node:assert/strict';
import { maskApiKey, TavilyClient, TavilyError, toTavilyError } from '../src/client.js';
import {
  filterEntries,
  parseEntry,
  redactApiKeyLike,
  serializeEntry,
  summarize,
  type AuditEntry,
} from '../src/audit.js';
import { clamp, cleanStringArray, compactText, normalizeUrl, normalizeUrls } from '../src/normalize.js';

test('TavilyClient rejects empty query without network', async () => {
  const client = new TavilyClient({ apiKey: 'tvly-test' });
  await assert.rejects(() => client.search({ query: '   ' }), TavilyError);
});

test('TavilyClient constructs a keyless client when no key is given', () => {
  // Keyless is an explicit supported mode, not an error: the SDK serves
  // search/extract without a key. The credential-requiring methods say so.
  const keyless = new TavilyClient({ apiKey: '   ' });
  assert.equal(keyless.keyless, true);
  assert.equal(new TavilyClient({ apiKey: 'tvly-test' }).keyless, false);
});

test('TavilyClient requires a key for crawl/map/research/usage', async () => {
  const keyless = new TavilyClient({});
  for (const call of [
    () => keyless.crawl({ url: 'https://example.com' }),
    () => keyless.map({ url: 'https://example.com' }),
    () => keyless.research('anything'),
    () => keyless.usage(),
  ]) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof TavilyError);
      assert.equal(error.code, 'missing_api_key');
      return true;
    });
  }
});

test('TavilyClient rejects invalid arguments as bad_request without network', async () => {
  const client = new TavilyClient({ apiKey: 'tvly-test' });
  // Local validation must not masquerade as an upstream fault.
  for (const call of [
    () => client.search({ query: '   ' }),
    () => client.extract({ urls: [] }),
    () => client.crawl({ url: 'ftp://example.com' }),
    () => client.map({ url: 'not a url' }),
    () => client.research('   '),
    () => client.getResearch('  '),
  ]) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof TavilyError);
      assert.equal(error.code, 'bad_request');
      return true;
    });
  }
  await assert.rejects(() => client.extract({ urls: [] }), /urls cannot be empty/);
  await assert.rejects(() => client.crawl({ url: 'ftp://example.com' }), /http/);
  await assert.rejects(() => client.map({ url: 'not a url' }), /valid URL/);
});

test('withAbort rejects an aborted call and never leaks a rejection', async () => {
  const { withAbort } = await import('../src/errors.js');
  const preAborted = new AbortController();
  preAborted.abort(new Error('cancelled'));

  // A pre-aborted signal rejects immediately, and the operation it abandoned
  // must still be observed — an unhandled rejection would crash the host.
  const started = Promise.reject(new Error('upstream blew up later'));
  await assert.rejects(
    () => withAbort(started, preAborted.signal, '搜索'),
    (error: unknown) => {
      assert.ok(error instanceof TavilyError);
      assert.equal(error.code, 'aborted');
      return true;
    },
  );
  // Give the abandoned rejection a turn to surface as unhandled.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('toTavilyError recovers classification from the SDK plain-Error message', () => {
  // @tavily/core discards the HTTP status and throws a plain Error, so these
  // are the exact shapes the wrapper must still classify correctly.
  const unauthorized = toTavilyError(new Error('Unauthorized: missing or invalid API key.'), '搜索');
  assert.equal(unauthorized.code, 'invalid_api_key');
  assert.equal(unauthorized.retryable, false);

  const statusPrefixed = toTavilyError(new Error('429 Error: {"detail":{"error":"slow down"}}'), '搜索');
  assert.equal(statusPrefixed.code, 'rate_limited');
  assert.equal(statusPrefixed.retryable, true);

  const quota = toTavilyError(new Error('432 Error: over your plan quota'), '搜索');
  assert.equal(quota.code, 'quota_exhausted');

  const timeout = toTavilyError(new Error('Request timed out after 45 seconds.'), '搜索');
  assert.equal(timeout.code, 'timeout');
  assert.equal(timeout.retryable, true);

  const refused = toTavilyError(
    new Error('An unexpected error occurred while making the request. Error: Error: connect ECONNREFUSED 127.0.0.1:9'),
    '搜索',
  );
  assert.equal(refused.code, 'network');
  assert.equal(refused.retryable, true);

  const keyless = toTavilyError(
    new Error('crawl: Keyless mode only supports search and extract; provide an API key to use this method.'),
    '站点爬取',
  );
  assert.equal(keyless.code, 'missing_api_key');
  assert.equal(keyless.retryable, false);

  // An unrecognized message must NOT be laundered into retryable network trouble.
  const opaque = toTavilyError(new Error('something entirely unexpected'), '搜索');
  assert.equal(opaque.code, 'unknown');
  assert.equal(opaque.retryable, false);
});

test('a validation message is classified as bad_request, not an upstream fault', () => {
  // Tavily validates the request body BEFORE authenticating, so a malformed
  // query on an otherwise-valid key reports a validation message, not a 401.
  const tooShort = toTavilyError(
    new Error('Query is too short. Min query length is 2 characters.'),
    '搜索',
  );
  assert.equal(tooShort.code, 'bad_request');
  assert.equal(tooShort.retryable, false);
});

test('a too-short query is rejected locally without a network call', async () => {
  const client = new TavilyClient({ apiKey: 'tvly-test' });
  await assert.rejects(
    () => client.search({ query: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof TavilyError);
      assert.equal(error.code, 'bad_request');
      assert.match(error.message, /过短/);
      return true;
    },
  );
});

test('toTavilyError maps axios-style failures', () => {
  const unauthorized = toTavilyError({ response: { status: 401, data: { detail: { error: 'bad key' } } } }, '搜索');
  assert.equal(unauthorized.code, 'invalid_api_key');
  assert.equal(unauthorized.retryable, false);

  const rateLimited = toTavilyError({ response: { status: 429, data: 'slow down' } }, '搜索');
  assert.equal(rateLimited.code, 'rate_limited');
  assert.equal(rateLimited.retryable, true);

  const quota = toTavilyError({ response: { status: 432, data: { detail: { error: 'over plan' } } } }, '搜索');
  assert.equal(quota.code, 'quota_exhausted');
  assert.match(quota.message, /额度已用尽/);

  const timeout = toTavilyError({ code: 'ECONNABORTED', message: 'timeout of 45000ms exceeded' }, '搜索');
  assert.equal(timeout.code, 'timeout');
  assert.equal(timeout.retryable, true);

  const network = toTavilyError({ message: 'fetch failed' }, '搜索');
  assert.equal(network.code, 'network');
  assert.equal(network.retryable, true);

  const passthrough = new TavilyError('server', 'x', true);
  assert.equal(toTavilyError(passthrough, '搜索'), passthrough);
});

test('maskApiKey never returns the full key', () => {
  const masked = maskApiKey('tvly-abcdefghijklmnopqrstuvwxyz');
  assert.ok(!masked.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(masked.startsWith('tvly-abc'));
  assert.ok(masked.endsWith('wxyz'));
});

test('redactApiKeyLike masks embedded keys', () => {
  const text = redactApiKeyLike('search with tvly-secretkey123 inside');
  assert.ok(!text.includes('tvly-secretkey123'));
  assert.ok(text.includes('tvly-****'));
});

test('audit serialize/parse round-trips and strips apiKey', () => {
  const entry: AuditEntry = {
    at: new Date().toISOString(),
    tool: 'search',
    target: 'tavily docs',
    status: 'ok',
    latencyMs: 123,
    resultCount: 5,
    caller: 'agent-1',
  };
  const line = serializeEntry(entry);
  assert.ok(line);
  // Even if a key-shaped string sneaks into target it must be redacted.
  const keyed = serializeEntry({ ...entry, target: 'oops tvly-abcdef123456' });
  assert.ok(keyed && !keyed.includes('tvly-abcdef123456'));
  const parsed = parseEntry(line as string);
  assert.deepEqual(parsed, entry);
});

test('audit parseEntry rejects corrupt lines', () => {
  assert.equal(parseEntry(''), undefined);
  assert.equal(parseEntry('not json'), undefined);
  assert.equal(parseEntry('{"at":123}'), undefined);
});

test('audit summarize counts each tool separately, including map and research', () => {
  const entries: AuditEntry[] = [
    { at: '2026-10-01T10:00:00.000Z', tool: 'search', target: 'alpha', status: 'ok', latencyMs: 10, resultCount: 3, credits: 1 },
    { at: '2026-10-02T10:00:00.000Z', tool: 'extract', target: 'https://example.com', status: 'error', errorCode: 'timeout', latencyMs: 20, resultCount: 0 },
    { at: '2026-10-03T10:00:00.000Z', tool: 'search', target: 'beta query', status: 'ok', latencyMs: 30, resultCount: 2, credits: 2 },
    { at: '2026-10-04T10:00:00.000Z', tool: 'map', target: 'https://example.com', status: 'ok', latencyMs: 40, resultCount: 7 },
    { at: '2026-10-05T10:00:00.000Z', tool: 'crawl', target: 'https://example.com', status: 'ok', latencyMs: 50, resultCount: 4 },
    { at: '2026-10-06T10:00:00.000Z', tool: 'research', target: 'quantum computing', status: 'ok', latencyMs: 60, resultCount: 2, credits: 9 },
  ];
  const stats = summarize(entries);
  assert.equal(stats.totalCalls, 6);
  assert.equal(stats.searchCalls, 2);
  assert.equal(stats.extractCalls, 1);
  assert.equal(stats.crawlCalls, 1);
  // `map` must not be folded into `crawl`.
  assert.equal(stats.mapCalls, 1);
  assert.equal(stats.researchCalls, 1);
  assert.equal(stats.failedCalls, 1);
  assert.equal(stats.totalResults, 18);
  // Only entries that reported usage contribute.
  assert.equal(stats.totalCredits, 12);
  assert.deepEqual(filterEntries(entries, { keyword: 'beta' }).map((e) => e.target), ['beta query']);
  assert.equal(filterEntries(entries, { datePrefix: '2026-10-02' }).length, 1);
});

test('audit parseEntry accepts map/research and round-trips credits', () => {
  for (const tool of ['search', 'extract', 'crawl', 'map', 'research'] as const) {
    const entry: AuditEntry = {
      at: '2026-10-08T12:00:00.000Z',
      tool,
      target: 'x',
      status: 'ok',
      latencyMs: 1,
      resultCount: 1,
      credits: 3,
    };
    const line = serializeEntry(entry);
    assert.ok(line);
    assert.deepEqual(parseEntry(line as string), entry);
  }
  // An unknown tool is rejected rather than silently coerced.
  assert.equal(parseEntry('{"at":"x","tool":"bogus"}'), undefined);
});

test('clamp/cleanStringArray/compactText/normalizeUrls basics', () => {
  assert.equal(clamp(99, 1, 10), 10);
  assert.equal(clamp(Number.NaN, 1, 10), 1);
  assert.deepEqual(cleanStringArray(['a', ' a ', ''], 10), ['a']);
  assert.equal(compactText('  a   b '), 'a b');
  assert.deepEqual(normalizeUrls(['https://example.com', ' https://example.com ']), ['https://example.com']);
  assert.throws(() => normalizeUrl('ftp://example.com', 'url'), /http/);
});
