/**
 * Keystore resolution-order tests. No network, no filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, type KeystoreContext } from '../src/keystore.js';

/** Build a fake context from the services a case needs. */
function ctxWith(services: Record<string, unknown>): KeystoreContext {
  return { get: (name: string) => services[name] };
}

test('resolveApiKey prefers the literal config key', async () => {
  const ctx = ctxWith({
    credentials: {
      resolve: async () => ({ value: 'tvly-from-credentials', source: 'file' }),
    },
    launchEnvironment: { get: () => ({ value: 'tvly-from-env' }) },
  });
  const key = await resolveApiKey(ctx, { apiKeyEnv: 'TAVILY_API_KEY', apiKey: 'tvly-from-config' });
  assert.equal(key.ok, true);
  assert.equal(key.source, 'config');
  assert.equal(key.apiKey, 'tvly-from-config');
  assert.ok(key.masked && !key.masked.includes('from-config'));
});

test('resolveApiKey falls back to the credential store, then the environment', async () => {
  const withCreds = ctxWith({
    credentials: { resolve: async () => ({ value: 'tvly-from-credentials', source: 'file' }) },
    launchEnvironment: { get: () => ({ value: 'tvly-from-env' }) },
  });
  const fromCreds = await resolveApiKey(withCreds, { apiKeyEnv: 'TAVILY_API_KEY' });
  assert.equal(fromCreds.source, 'credentials');
  assert.equal(fromCreds.apiKey, 'tvly-from-credentials');

  // No credential service composed (headless profile): the launch environment
  // is the only remaining plane.
  const envOnly = ctxWith({ launchEnvironment: { get: () => ({ value: 'tvly-from-env' }) } });
  const fromEnv = await resolveApiKey(envOnly, { apiKeyEnv: 'TAVILY_API_KEY' });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.apiKey, 'tvly-from-env');
});

test('resolveApiKey reports none when nothing is configured', async () => {
  const ctx = ctxWith({ credentials: { resolve: async () => undefined } });
  const key = await resolveApiKey(ctx, { apiKeyEnv: 'TAVILY_API_KEY' });
  assert.equal(key.ok, false);
  assert.equal(key.source, 'none');
  assert.equal(key.apiKey, undefined);
  assert.equal(key.ref, 'TAVILY_API_KEY');
});

test('resolveApiKey treats a blank stored credential as absent', async () => {
  // The credential seam's rule: an empty value is absent everywhere, so a
  // blank must not shadow the environment layer.
  const ctx = ctxWith({
    credentials: { resolve: async () => ({ value: '   ', source: 'file' }) },
    launchEnvironment: { get: () => ({ value: 'tvly-from-env' }) },
  });
  const key = await resolveApiKey(ctx, { apiKeyEnv: 'TAVILY_API_KEY' });
  assert.equal(key.source, 'env');
});

test('resolveApiKey survives a credential-provider failure without leaking it', async () => {
  const ctx = ctxWith({
    credentials: {
      resolve: async () => {
        throw new Error('provider exploded with tvly-supersecretvalue');
      },
    },
    launchEnvironment: { get: () => ({ value: 'tvly-from-env' }) },
  });
  const key = await resolveApiKey(ctx, { apiKeyEnv: 'TAVILY_API_KEY' });
  assert.equal(key.ok, true);
  assert.equal(key.source, 'env');
  assert.ok(!JSON.stringify(key).includes('supersecret'));
});

test('resolveApiKey honours a custom credential reference', async () => {
  const seen: string[] = [];
  const ctx = ctxWith({
    credentials: {
      resolve: async (ref: unknown) => {
        seen.push(String(ref));
        return { value: 'tvly-custom', source: 'file' };
      },
    },
  });
  const key = await resolveApiKey(ctx, { apiKeyEnv: 'MY_TAVILY_KEY' });
  assert.equal(key.ok, true);
  assert.equal(key.ref, 'MY_TAVILY_KEY');
  assert.deepEqual(seen, ['MY_TAVILY_KEY']);
});
