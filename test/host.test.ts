/**
 * Host wiring test: `apply` must register the `ctx.web` provider and all five
 * tools, and must degrade gracefully when optional services are absent.
 *
 * No network: the provider is registered but never invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply, name, inject } from '../src/host.js';

/** Build a fake cordis context capturing every registration. */
function fakeCtx(services: Record<string, unknown> = {}) {
  const registeredTools: Array<{ name: string }> = [];
  const searchProviders: Array<{ id: string }> = [];
  const routes: Array<{ kind: string; path: string }> = [];
  const effects: string[] = [];
  const store = new Map<string, unknown>(Object.entries(services));

  const scoped = (): unknown => ({
    get: (n: string) => store.get(n),
    effect: (cb: () => unknown, label?: string) => {
      effects.push(label ?? '');
      const dispose = cb();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    web: {
      registerSearchProvider: (provider: { id: string }) => {
        searchProviders.push(provider);
        return () => {};
      },
    },
    webServer: {
      register: (route: { kind: string; path: string }) => {
        routes.push(route);
        return () => {};
      },
    },
  });

  const ctx = {
    get: (n: string) => store.get(n),
    tools: {
      register: (definition: { name: string }) => {
        registeredTools.push(definition);
        return () => {};
      },
    },
    inject: (deps: string[], cb: (s: unknown) => void) => {
      // Only invoke for services this fake actually provides.
      if (deps.every((d) => store.has(d))) cb(scoped());
      return undefined;
    },
    effect: (cb: () => unknown, label?: string) => {
      effects.push(label ?? '');
      return () => {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { ctx, registeredTools, searchProviders, routes, effects, store };
}

/** A config stand-in: the accessors `apply` reads. */
function volatileConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    apiKeyEnv: 'TAVILY_API_KEY',
    apiKey: undefined,
    allowKeyless: true,
    defaultMaxResults: 5,
    defaultSearchDepth: 'advanced',
    requestTimeoutMs: 45_000,
    researchTimeoutMs: 180_000,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { get: () => value }]),
  );
}

test('plugin identity is stable', () => {
  assert.equal(name, 'tavily');
  assert.deepEqual(inject, ['tools']);
  assert.ok(Config);
});

test('apply registers all five tools', () => {
  const { ctx, registeredTools } = fakeCtx();
  apply(ctx as never, volatileConfig() as never);
  assert.deepEqual(
    registeredTools.map((t) => t.name).sort(),
    ['tavily_crawl', 'tavily_extract', 'tavily_map', 'tavily_research', 'tavily_search'],
  );
});

test('apply registers the ctx.web search provider exactly once', () => {
  const { ctx, searchProviders, effects } = fakeCtx({ web: {} });
  apply(ctx as never, volatileConfig() as never);
  assert.equal(searchProviders.length, 1);
  assert.equal(searchProviders[0]?.id, 'tavily');
  assert.ok(effects.includes('tavily: ctx.web search provider'));
});

test('apply registers the settings API route exactly once', () => {
  const { ctx, routes, effects } = fakeCtx({ webServer: {} });
  apply(ctx as never, volatileConfig() as never);
  // Registering twice would throw on a duplicate (kind, path) in the real
  // webserver, so exactly one registration is the contract.
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.kind, 'prefix');
  assert.equal(routes[0]?.path, '/api/tavily');
  assert.ok(effects.includes('tavily: settings API'));
});

test('apply activates with no optional services at all', () => {
  // A headless profile composes no web/webServer: tools must still register.
  const { ctx, registeredTools, searchProviders, routes } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx as never, volatileConfig() as never));
  assert.equal(registeredTools.length, 5);
  assert.equal(searchProviders.length, 0);
  assert.equal(routes.length, 0);
});

test('apply tolerates a config with no literal apiKey field present', () => {
  // `apiKey` is an optional volatile field; reading it must not throw.
  const { ctx, registeredTools } = fakeCtx();
  const cfg = volatileConfig();
  delete (cfg as Record<string, unknown>).apiKey;
  (cfg as Record<string, unknown>).apiKey = { get: () => undefined };
  assert.doesNotThrow(() => apply(ctx as never, cfg as never));
  assert.equal(registeredTools.length, 5);
});
