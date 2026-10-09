/**
 * Integration test against the REAL cordis runtime.
 *
 * The unit tests drive `apply` with a hand-written fake context, which cannot
 * catch the class of bug that actually broke the first live install: cordis
 * THROWS when a service property is read without a matching `inject` entry, and
 * optional chaining does not catch it because the getter itself throws. A fake
 * context that returns `undefined` for anything hides that completely.
 *
 * So this file builds a real `Context`, provides the services the plugin reads,
 * and asserts the fiber reaches an active state with the expected
 * registrations. It is the closest thing to the live activation path that can
 * run without the desktop app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, Config, inject, name } from '../src/host.js';

/** Everything `apply` might touch, recorded for assertions. */
function services() {
  const tools: string[] = [];
  const searchProviders: string[] = [];
  const routes: Array<{ kind: string; path: string }> = [];
  const sections: string[] = [];
  return {
    tools,
    searchProviders,
    routes,
    sections,
    provide(root: Context) {
      root.provide('tools', {
        register: (definition: { name: string }) => {
          tools.push(definition.name);
          return () => {};
        },
      });
      root.provide('systemPrompt', {
        section: (section: { name: string }) => {
          sections.push(section.name);
          return () => {};
        },
      });
      root.provide('credentials', {
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      });
      root.provide('web', {
        registerSearchProvider: (provider: { id: string }) => {
          searchProviders.push(provider.id);
          return () => {};
        },
      });
      root.provide('webServer', {
        register: (route: { kind: string; path: string }) => {
          routes.push(route);
          return () => {};
        },
      });
    },
  };
}

/** Run the plugin on a fresh real cordis root and settle. */
async function activate(configure: (root: Context) => void = () => {}) {
  const root = new Context();
  const seen = services();
  seen.provide(root);
  configure(root);
  const cfg = Config({});
  root.plugin({
    name,
    inject,
    apply: (ctx: Context) => apply(ctx as never, cfg),
  });
  // Let async activation (the credential probe) settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { root, seen };
}

test('activates on real cordis and registers every contribution', async () => {
  const { seen } = await activate();
  assert.deepEqual(
    [...seen.tools].sort(),
    ['tavily_crawl', 'tavily_extract', 'tavily_map', 'tavily_research', 'tavily_search'],
  );
  assert.deepEqual(seen.searchProviders, ['tavily']);
  assert.equal(seen.routes.length, 1);
  assert.equal(seen.routes[0]?.path, '/api/tavily');
  assert.deepEqual(seen.sections, ['tool:tavily']);
});

test('activates when systemPrompt is NOT composed', async () => {
  // Regression guard for the bug that failed the first live install: reading
  // `ctx.systemPrompt` without `inject: ['systemPrompt']` throws on real
  // cordis, so the plugin must reach it through `ctx.get()`.
  const root = new Context();
  const seen = services();
  seen.provide(root);
  // Deliberately override with a root that has no systemPrompt at all.
  const bare = new Context();
  bare.provide('tools', {
    register: (definition: { name: string }) => {
      seen.tools.push(definition.name);
      return () => {};
    },
  });
  bare.provide('web', { registerSearchProvider: () => () => {} });
  bare.provide('webServer', { register: () => () => {} });
  const cfg = Config({});
  assert.doesNotThrow(() => {
    bare.plugin({ name, inject, apply: (ctx: Context) => apply(ctx as never, cfg) });
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // All five tools still register: systemPrompt is optional, not required.
  assert.equal(seen.tools.length, 5);
});

test('reading an uninjected service property really does throw inside a fiber', async () => {
  // Documents WHY the guard above exists, so a future refactor back to
  // `ctx.systemPrompt?.section(...)` fails loudly here instead of in the app.
  //
  // The guard is scoped to a plugin FIBER: a bare root context returns
  // undefined for an unprovided service, which is exactly why a fake-context
  // unit test cannot catch this class of bug.
  const root = new Context();
  root.provide('tools', { register: () => () => {} });
  let observed = '';
  root.plugin({
    name: 'probe',
    inject: ['tools'],
    apply: (ctx: Context) => {
      try {
        void (ctx as unknown as { systemPrompt?: unknown }).systemPrompt;
        observed = 'read-ok';
      } catch (error) {
        observed = error instanceof Error ? error.message : String(error);
      }
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(observed, /without inject/);
});

test('the fiber settles without a failed activation', async () => {
  // `plugin()` returns a promise-like fiber handle; awaiting it rejects when
  // activation throws, so a clean await IS the assertion. This mirrors the
  // live failure mode, where the loader reported "entry did not activate".
  const root = new Context();
  services().provide(root);
  const cfg = Config({});
  const handle = root.plugin({
    name,
    inject,
    apply: (ctx: Context) => apply(ctx as never, cfg),
  });
  await assert.doesNotReject(async () => {
    await handle;
  });
});
