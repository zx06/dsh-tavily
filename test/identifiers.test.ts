/**
 * Cross-file identity guards.
 *
 * Several independent literals must agree for the plugin to work, and nothing
 * in the type system ties them together:
 *
 * - the Loader row id in `cordis.patch.yml` is the settings namespace that
 *   `ctx.configForms` is keyed by, and the id the `dsh.client` half attaches to;
 * - the `ctx.web` provider id must not collide with a shipped provider;
 * - the plugin manager dispatches `plugins.bundle.config` by PACKAGE name.
 *
 * A mismatch in any of these fails silently at runtime (a form that never
 * loads, a provider that never registers, a card that never renders), so they
 * are asserted here rather than trusted to comments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const manifest = JSON.parse(read('package.json')) as { name: string; version: string };
const patch = read('cordis.patch.yml');
const host = read('src/host.ts');
const provider = read('src/provider.ts');
const client = read('client.js');

/** The one id shared by the Loader row, the settings namespace and the provider. */
const PLUGIN_ID = 'tavily';

test('the Loader row id, host name and provider id all agree', () => {
  const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch);
  assert.ok(rowId, 'cordis.patch.yml must declare a row id');
  assert.equal(rowId[1], PLUGIN_ID, 'the Loader row id must be the plugin id');

  const hostName = /export const name = '([^']+)'/.exec(host);
  assert.ok(hostName, 'host.ts must export a name');
  assert.equal(hostName[1], PLUGIN_ID, 'the host plugin name must be the plugin id');

  const providerId = /export const TAVILY_PROVIDER_ID = '([^']+)'/.exec(provider);
  assert.ok(providerId, 'provider.ts must export TAVILY_PROVIDER_ID');
  assert.equal(providerId[1], PLUGIN_ID, 'the ctx.web provider id must be the plugin id');
});

test('the settings namespace the client reads equals the Loader row id', () => {
  // `ctx.configForms.get(id)` is keyed by the Loader entry id. If these drift,
  // every card renders read-only with no error.
  const ns = /const CONFIG_NS = '([^']+)'/.exec(client);
  assert.ok(ns, 'client.js must declare CONFIG_NS');
  const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch);
  assert.equal(ns[1], rowId?.[1], 'CONFIG_NS must equal the Loader row id');
});

test('the bundle-config key is the package name the manager dispatches', () => {
  // The plugin manager renders `plugins.bundle.config` with `entryKey = pkg.name`,
  // so the registered key must be the package name — not the plugin id.
  const key = /const PKG_NAME = '([^']+)'/.exec(client);
  assert.ok(key, 'client.js must declare PKG_NAME');
  assert.equal(key[1], manifest.name, 'PKG_NAME must equal package.json name');
  assert.notEqual(key[1], PLUGIN_ID, 'the bundle key is the package name, not the plugin id');
});

test('the module loader id is the package name', () => {
  const loaded = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/.exec(client);
  assert.ok(loaded, 'client.js must declare a ModuleLoader id');
  assert.equal(loaded[1], manifest.name);
});

test('the host half registers a row named after the package', () => {
  // The patch inserts a row whose `name` is the published package; the client
  // half attaches to that row because its id is the name's last segment.
  assert.match(patch, new RegExp(`name:\\s*'${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
});
