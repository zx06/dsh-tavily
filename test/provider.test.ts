/**
 * `ctx.web` provider tests: availability semantics, result mapping, error
 * translation, and cancellation. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebError } from '@deepseek-ai/dsh-web';
import { TavilyError, type TavilyClient } from '@dsh-plugins/plugin-kit';
import { TavilyWebSearchProvider, TAVILY_PROVIDER_ID, toWebError, type ProviderDeps } from '../src/provider.js';

/** A provider deps bundle with overridable pieces. */
function deps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    resolveClient: async () =>
      ({
        search: async () => ({ query: 'q', results: [], response_time: 0.1 }),
      }) as unknown as TavilyClient,
    defaultMaxResults: () => 5,
    hasCredential: () => false,
    allowKeyless: () => false,
    ...overrides,
  };
}

test('provider id is the documented stable id', () => {
  assert.equal(TAVILY_PROVIDER_ID, 'tavily');
  assert.equal(new TavilyWebSearchProvider(deps()).id, 'tavily');
});

test('available() is false without a credential and with keyless off', () => {
  // Claiming availability here would make a single-provider deployment
  // ambiguous and break the shipped web_search tool.
  const provider = new TavilyWebSearchProvider(deps());
  assert.equal(provider.available(), false);
});

test('available() is true when keyless is enabled, even with no credential', () => {
  const provider = new TavilyWebSearchProvider(deps({ allowKeyless: () => true }));
  assert.equal(provider.available(), true);
});

test('available() is true once a credential exists', () => {
  const provider = new TavilyWebSearchProvider(deps({ hasCredential: () => true }));
  assert.equal(provider.available(), true);
});

test('a successful search marks the credential as seen', async () => {
  let seen = false;
  const provider = new TavilyWebSearchProvider(
    deps({
      hasCredential: () => seen,
      resolveClient: async () =>
        ({
          search: async () => {
            seen = true;
            return { query: 'q', results: [{ url: 'https://example.com', title: 'T', content: 'c' }] };
          },
        }) as unknown as TavilyClient,
    }),
  );
  assert.equal(provider.available(), false);
  await provider.search({ query: 'q' });
  assert.equal(provider.available(), true);
});

test('search maps Tavily results onto the seam source shape', async () => {
  const provider = new TavilyWebSearchProvider(
    deps({
      resolveClient: async () =>
        ({
          search: async () => ({
            query: 'deepseek',
            answer: 'An answer.',
            response_time: 0.42,
            results: [
              {
                title: 'Result A',
                url: 'https://a.example',
                content: 'snippet a',
                published_date: '2026-01-02',
              },
              { url: 'https://b.example' },
              // No URL: the seam guarantees one, so this must be dropped.
              { title: 'no url', content: 'x' },
            ],
          }),
        }) as unknown as TavilyClient,
    }),
  );
  const result = await provider.search({ query: 'deepseek', maxResults: 5 });
  assert.equal(result.content, 'An answer.');
  assert.equal(result.truncated, false);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources[0], {
    url: 'https://a.example',
    title: 'Result A',
    snippet: 'snippet a',
    publishedAt: '2026-01-02',
  });
  // Absent optionals are omitted rather than set to undefined.
  assert.deepEqual(result.sources[1], { url: 'https://b.example' });
});

test('search omits content when Tavily returns no answer', async () => {
  const provider = new TavilyWebSearchProvider(
    deps({
      resolveClient: async () =>
        ({
          search: async () => ({ query: 'q', results: [{ url: 'https://x.example' }] }),
        }) as unknown as TavilyClient,
    }),
  );
  const result = await provider.search({ query: 'q' });
  assert.equal('content' in result, false);
});

test('search falls back to the configured default result count', async () => {
  let seen: unknown;
  const provider = new TavilyWebSearchProvider(
    deps({
      defaultMaxResults: () => 7,
      resolveClient: async () =>
        ({
          search: async (params: unknown) => {
            seen = params;
            return { query: 'q', results: [] };
          },
        }) as unknown as TavilyClient,
    }),
  );
  await provider.search({ query: 'q' });
  assert.equal((seen as { max_results: number }).max_results, 7);
});

test('toWebError maps a missing key to the seam credential code', () => {
  const missing = toWebError(new TavilyError('missing_api_key', 'no key', false));
  assert.ok(missing instanceof WebError);
  assert.equal(missing.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');

  const other = toWebError(new TavilyError('invalid_api_key', 'bad key', false));
  assert.equal(other.code, 'WEB_PROVIDER_ERROR');

  const unknown = toWebError(new Error('boom'));
  assert.equal(unknown.code, 'WEB_PROVIDER_ERROR');
});

test('search surfaces a client failure as WebError', async () => {
  const provider = new TavilyWebSearchProvider(
    deps({
      resolveClient: async () =>
        ({
          search: async () => {
            throw new TavilyError('invalid_api_key', 'Tavily API Key 无效', false);
          },
        }) as unknown as TavilyClient,
    }),
  );
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error: unknown) => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, 'WEB_PROVIDER_ERROR');
      return true;
    },
  );
});

test('search forwards the abort signal to the client', async () => {
  let received: AbortSignal | undefined;
  const controller = new AbortController();
  const provider = new TavilyWebSearchProvider(
    deps({
      resolveClient: async () =>
        ({
          search: async (params: { signal?: AbortSignal }) => {
            received = params.signal;
            return { query: 'q', results: [] };
          },
        }) as unknown as TavilyClient,
    }),
  );
  await provider.search({ query: 'q' }, controller.signal);
  assert.equal(received, controller.signal);
});
