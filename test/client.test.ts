/**
 * Client-half guards.
 *
 * These run against `client.js` as a TEXT artifact rather than through a DOM,
 * because the failure they prevent is a static one: a CSS custom property that
 * the shell does not define. The browser silently drops such a declaration, so
 * `background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-accent)`
 * renders a filled button with unstyled text — a black rectangle. Nothing in
 * the host, the type system, or a rendering smoke test catches that; only
 * checking the names against the live shell does.
 *
 * The token allowlist below is the set verified present in the shipped desktop
 * runtime (0.2.1-rc.3). Adding a token here means confirming it exists in the
 * shell's own stylesheets first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(here, '..', 'client.js');
const client = fs.readFileSync(CLIENT_PATH, 'utf8');

/**
 * The package name, read from the manifest rather than hard-coded.
 *
 * The loader entry id must equal this name, and the package is published under
 * a different name (`@zx06/tavily`) than the monorepo uses internally
 * (`@dsh-plugins/tavily`), while the plugin's *own* id — the settings
 * namespace and `ctx.web` provider id — stays `tavily`. Deriving the
 * expectation keeps either layout from silently desynchronizing this guard.
 */
const PKG_NAME = (
  JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { name: string }
).name;

/**
 * Theme tokens verified to exist in the desktop shell.
 *
 * Notably absent — and the reason this list exists — is
 * `--dsw-alias-label-on-accent`, which the first build invented. The shell's
 * real pairing for a filled primary button is
 * `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`.
 */
const KNOWN_TOKENS = new Set([
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
]);

test('every theme token used is a known shell token', () => {
  const used = new Set(client.match(/--dsw-[a-z0-9-]+/g) ?? []);
  const unknown = [...used].filter((token) => !KNOWN_TOKENS.has(token));
  assert.deepEqual(
    unknown,
    [],
    `client.js references theme tokens the shell does not define: ${unknown.join(', ')}. ` +
      'An unknown custom property is dropped silently, so the declaration has no effect.',
  );
});

test('the primary button pairs a real fill token with a real foreground token', () => {
  // Guards the specific regression: a filled button whose text colour resolves
  // to nothing reads as a solid block.
  const rule = /\.tv_primary\{([^}]*)\}/.exec(client);
  assert.ok(rule, '.tv_primary rule must exist');
  const body = rule[1] ?? '';
  assert.match(body, /background:var\(--dsw-alias-button-primary-fill\)/);
  assert.match(body, /color:var\(--dsw-alias-label-primary-foreground\)/);
  assert.ok(!body.includes('label-on-accent'));
});

test('the bundle registers under the package name and exports a plugin shape', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
  assert.ok(
    client.includes(`id: '${PKG_NAME}'`),
    `client.js must register under the package name (${PKG_NAME})`,
  );
  assert.match(client, /exports\.apply\s*=/);
  assert.match(client, /exports\.inject\s*=/);
  assert.match(client, /exports\.name\s*=/);
});

test('the client half declares the services it actually uses', () => {
  // A missing inject entry would make `ctx.configForms` throw on real cordis,
  // exactly as `ctx.systemPrompt` did on the host side.
  const injectMatch = /const inject = \[([^\]]*)\]/.exec(client);
  assert.ok(injectMatch, 'inject array must exist');
  const declared = injectMatch[1] ?? '';
  for (const service of ['slots', 'locale', 'configForms']) {
    assert.ok(declared.includes(`'${service}'`), `inject must declare ${service}`);
  }
});

test('the settings section registers with an id matching the settings namespace', () => {
  // `ctx.configForms.get(id)` is keyed by the Loader entry id, so a mismatch
  // would silently leave the options card unable to read or write anything.
  const nsMatch = /const CONFIG_NS = '([^']+)'/.exec(client);
  assert.ok(nsMatch, 'CONFIG_NS must be declared');
  assert.equal(nsMatch[1], 'tavily');
  assert.match(client, /id:\s*CONFIG_NS/);
});

test('the plugin detail page slot is keyed by the package name, not the settings id', () => {
  // The plugin manager dispatches `plugins.bundle.config` with
  // `entryKey = pkg.name`, and only renders the section for a bundle whose key
  // it collected. Keying by the settings id (`tavily`) would register fine and
  // then never render, which no type or syntax check can catch.
  assert.match(
    client,
    /ctx\.slots\.inject\('plugins\.bundle\.config'/,
    'client.js must register on plugins.bundle.config',
  );
  const block = /plugins\.bundle\.config[\s\S]{0,400}?key:\s*([A-Za-z_$][\w$]*|'[^']*')/.exec(client);
  assert.ok(block, 'the plugins.bundle.config registration must declare a key');
  const key = block[1] ?? '';
  const resolved = key.startsWith("'") ? key.slice(1, -1) : key;
  assert.equal(
    resolved,
    'PKG_NAME',
    'the detail-page key must be the PKG_NAME constant so it tracks package.json',
  );
  assert.match(
    client,
    new RegExp(`const PKG_NAME = '${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
    `PKG_NAME must equal the package name (${PKG_NAME})`,
  );
});

test('the client half declares the plugin manager so the detail slot exists', () => {
  // Without this entry the slot may never be declared and the registration
  // waits forever: the section silently never appears.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'),
  ) as { dsh?: { client?: { inject?: string[] } } };
  const declared = manifest.dsh?.client?.inject ?? [];
  assert.ok(
    declared.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
    'dsh.client.inject must declare @deepseek-ai/dsh-client-ui-plugin-manager',
  );
});

test('the detail page reuses the settings page instead of a second copy', () => {
  // Two divergent configuration UIs would drift; both mount SettingsPage, and
  // only the detail-page mount suppresses the page header the owner already
  // renders above the slot.
  const mounts = client.match(/h\(SettingsPage, \{[^}]*\}\)/g) ?? [];
  assert.equal(mounts.length, 2, 'exactly two SettingsPage mounts are expected');
  const compactMount = mounts.find((mount) => mount.includes('compact: true'));
  assert.ok(compactMount, 'the plugins.bundle.config mount must pass compact: true');
  assert.equal(
    mounts.filter((mount) => mount.includes('compact: true')).length,
    1,
    'only the detail-page mount is compact',
  );
});

test('the key input is a password field and is never seeded from a response', () => {
  assert.match(client, /type:\s*'password'/);
  // The draft must start empty: a response carries only a mask, and seeding the
  // input with it would invite the user to "save" a mask as their key.
  assert.match(client, /const \[draft, setDraft\] = useState\(''\)/);
});

test('the page header carries an inline icon rather than a shell icon dependency', () => {
  // The settings NAVIGATION icon is hardcoded in the shell and the
  // `settings.section` slot accepts no icon field, so the page brands itself.
  // The glyph must be drawn inline: `@deepseek-ai/dsh-client-ui-primitives`
  // declares no `dsh.client`, so a bundle half cannot require it.
  assert.match(client, /function GlobeIcon\(/, 'an inline icon component must exist');
  assert.match(client, /tv_headicon/);
  assert.ok(
    !/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/.test(client),
    'the bundle must not require a non-client package',
  );
  // The only allowed runtime import is the React the shell provides.
  const requires = client.match(/require\(['"][^'"]+['"]\)/g) ?? [];
  assert.deepEqual(requires, ["require('react')"]);
});

test('the icon uses currentColor so it follows the theme', () => {
  // A hardcoded fill would not track light/dark.
  assert.match(client, /fill:\s*'currentColor'/);
});
