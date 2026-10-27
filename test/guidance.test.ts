/**
 * Guidance guards.
 *
 * The plugin tells users where to configure it from several separate messages
 * (missing key, invalid key, keyless-only method, exhausted keyless quota). When
 * the configuration surface moved off the Settings page, those copies kept
 * pointing at a page that no longer exists — and no test noticed, because
 * nothing asserted the wording.
 *
 * These guards make the location a single source of truth and fail if a stale
 * path is reintroduced anywhere in the shipped code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_LOCATION, KEYLESS_METHOD_MESSAGE, MISSING_KEY_MESSAGE } from '@dsh-plugins/plugin-kit';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Every source file that can produce a user-facing message. */
const SOURCES = [
  'src/host.ts',
  'src/tools.ts',
  'src/routes.ts',
  'src/keystore.ts',
  'src/provider.ts',
  'packages/plugin-kit/src/errors.ts',
  'packages/plugin-kit/src/client.ts',
];

/**
 * Phrases that name a location which no longer exists.
 *
 * `DSH 设置页` and `设置 →` referred to the removed `settings.section` entry;
 * `Tavily 搜索` was that entry's nav label. Any of them in a message sends the
 * user somewhere they cannot go.
 */
const STALE_PATHS = ['DSH 设置页', '设置页', '设置 →', 'Settings →', 'settings page'];

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('no shipped source points at the removed settings page', () => {
  const offenders: string[] = [];
  for (const relative of SOURCES) {
    const text = read(relative);
    for (const stale of STALE_PATHS) {
      if (text.includes(stale)) offenders.push(`${relative}: "${stale}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these files still send users to a removed surface: ${offenders.join(', ')}`,
  );
});

test('the configuration location names the plugin detail page', () => {
  // The plugin manager is the only place the form exists now.
  assert.match(CONFIG_LOCATION, /@zx06\/tavily/);
  assert.match(CONFIG_LOCATION, /详情页|detail/);
});

test('the actionable messages interpolate the shared location', () => {
  // If a message hard-codes its own path again, moving the surface would
  // silently leave it behind — which is exactly what happened before.
  assert.ok(
    MISSING_KEY_MESSAGE.includes(CONFIG_LOCATION),
    'MISSING_KEY_MESSAGE must interpolate CONFIG_LOCATION',
  );
  assert.ok(
    KEYLESS_METHOD_MESSAGE.includes(CONFIG_LOCATION),
    'KEYLESS_METHOD_MESSAGE must interpolate CONFIG_LOCATION',
  );
});

test('errors.ts defines the location exactly once', () => {
  // A second literal is how the copies diverged in the first place.
  const errors = read('packages/plugin-kit/src/errors.ts');
  const occurrences = errors.match(/插件管理器 → /g) ?? [];
  assert.equal(occurrences.length, 1, 'the location literal must appear once, as CONFIG_LOCATION');
});
