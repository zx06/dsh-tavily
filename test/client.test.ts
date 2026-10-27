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

test('the config namespace matches the Loader row id', () => {
  // `ctx.configForms.get(id)` is keyed by the Loader entry id, so a mismatch
  // would silently leave every card unable to read or write anything.
  const nsMatch = /const CONFIG_NS = '([^']+)'/.exec(client);
  assert.ok(nsMatch, 'CONFIG_NS must be declared');
  assert.equal(nsMatch[1], 'tavily');
  assert.match(client, /forms\.get\(CONFIG_NS\)/);
});

test('there is no settings section, so the plugin detail page is the only surface', () => {
  // The configuration deliberately lives on the bundle's own page. Re-adding a
  // `settings.section` would give the plugin two entry points to one form.
  assert.ok(
    !client.includes("'settings.section'"),
    'client.js must not register a settings.section entry',
  );
  // The dictionary entries only the removed nav row and page header read must
  // not come back either: dead keys would silently accumulate.
  for (const key of ['nav', 'title', 'desc']) {
    assert.ok(
      !new RegExp(`\\b${key}:\\s*['\"]`).test(client),
      `dictionary must not carry an unused '${key}' entry`,
    );
  }
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

test('the form mounts exactly once, on the plugin detail page', () => {
  const mounts = client.match(/h\(SettingsPage, \{[^}]*\}\)/g) ?? [];
  assert.equal(mounts.length, 1, 'SettingsPage must have a single mount point');
});

test('the form omits its own page header', () => {
  // The plugin manager renders this bundle's title and description immediately
  // above the slot, so a header here would print the name twice.
  assert.ok(!client.includes('tv_head'), 'the page header styles must be gone');
  assert.ok(!/h\('h2'/.test(client), 'the form must not render its own <h2>');
});

test('the key input is a password field and is never seeded from a response', () => {
  assert.match(client, /type:\s*'password'/);
  // The draft must start empty: a response carries only a mask, and seeding the
  // input with it would invite the user to "save" a mask as their key.
  assert.match(client, /const \[draft, setDraft\] = useState\(''\)/);
});

test('the bundle requires nothing but the React the shell provides', () => {
  // `@deepseek-ai/dsh-client-ui-primitives` declares no `dsh.client`, so a
  // bundle half cannot require it; any other require would fail at load time.
  const requires = client.match(/require\(['\"][^'\"]+['\"]\)/g) ?? [];
  assert.deepEqual(requires, ["require('react')"]);
});

test('no theme token is invented, and every used token is verified', () => {
  // The allowlist guard above covers this; this pins the specific regression
  // that shipped first: a filled button whose text colour resolved to nothing.
  assert.ok(!client.includes('label-on-accent'));
});
