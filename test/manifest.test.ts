/**
 * Manifest guards for the declared DSH requirement.
 *
 * DSH refuses to load a bundle whose declared DSH requirement does not match
 * the single runtime version it is running. The check reads every
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` entry in `peerDependencies` and
 * compares that range against the runtime version; `@deepseek-ai/cordis` is not
 * a DSH package and is never consulted. Those four literals are therefore
 * load-bearing, and an exact pin turns every DSH prerelease into a hard
 * refusal for every user.
 *
 * 0.4.1 shipped exactly that way: `0.2.1-rc.3` pins against a `0.2.1-rc.5`
 * runtime, so the plugin manager rejected the bundle at startup even though the
 * SDK's own `lib/` (JS and `.d.ts`) was byte-identical between the two
 * releases — nothing in the code needed to change. The fix is a caret range
 * floored at the SDK this repo builds against; these tests keep the floor
 * honest and keep a later "just pin it" fix from silently reintroducing the
 * refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const resolve = createRequire(import.meta.url);

interface Manifest {
  name: string;
  version: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
) as Manifest;

/**
 * The peer entries DSH compares against its runtime version.
 *
 * `dsh-settings` is declared even though the plugin only reaches the settings
 * form through the browser half: it is the seam the config panel's transport
 * belongs to, and declaring it keeps the requirement honest for readers.
 */
const DSH_PEERS = [
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-web',
];

/** The one DSH peer that is a cordis plugin, not a DSH package. */
const CORDIS_PEER = '@deepseek-ai/cordis';

function installedVersion(name: string): string {
  const file = resolve.resolve(`${name}/package.json`);
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
}

test('every DSH seam the plugin binds to is declared as a peer', () => {
  for (const name of DSH_PEERS) {
    assert.ok(
      manifest.peerDependencies?.[name],
      `${name} must stay in peerDependencies: it is one of the seams the plugin binds to`,
    );
  }
});

test('DSH peers are ranges, never exact pins', () => {
  // An exact pin is the 0.4.1 bug: it matches one runtime version and is
  // refused by every later one, even when the API is unchanged.
  for (const name of DSH_PEERS) {
    const range = manifest.peerDependencies?.[name] ?? '';
    assert.match(
      range,
      /^\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
      `${name} must be a caret range so a later DSH prerelease is not refused`,
    );
  }
});

test('the DSH peer floor is the SDK version this repo builds against', () => {
  // `@deepseek-ai/dsh-agent` is the devDependency that pins the SDK release
  // train for the build and the tests. Keeping the peer floor equal to it means
  // "we declared exactly the version we compiled against, and accept later
  // ones in the same series" — bump both together, never one alone.
  const floor = installedVersion('@deepseek-ai/dsh-agent');
  assert.equal(
    manifest.devDependencies?.['@deepseek-ai/dsh-agent'],
    floor,
    'the dsh-agent devDependency must stay an exact pin so the floor is unambiguous',
  );
  for (const name of DSH_PEERS) {
    assert.equal(
      manifest.peerDependencies?.[name],
      `^${floor}`,
      `${name} must be floored at the dsh-agent version (${floor})`,
    );
  }
});

test('the installed SDK matches the declared floor', () => {
  // Guards the other direction: a range that is newer than what is installed
  // would mean the repo builds and tests against an SDK it claims not to
  // support, which is how a declaration drifts away from reality.
  const floor = installedVersion('@deepseek-ai/dsh-agent');
  for (const name of DSH_PEERS) {
    assert.equal(
      installedVersion(name),
      floor,
      `${name} must resolve to the same version as the declared floor`,
    );
  }
});

test('the cordis peer is the one version range the runtime ships', () => {
  // DSH's admission check ignores non-DSH packages, so this range is only a
  // resolution constraint; it must still track the runtime's own cordis, which
  // 0.2.1-rc.5 ships as ~4.0.5.
  assert.equal(manifest.peerDependencies?.[CORDIS_PEER], '~4.0.5');
});

test('compatibility is declared through peers, not engines.dsh', () => {
  // DSH decides by `engines.dsh` alone when it is present and then ignores
  // every peer range. Declaring both would silently drop the per-seam check,
  // so the two mechanisms must not be mixed by accident.
  assert.equal(
    manifest.engines?.dsh,
    undefined,
    'engines.dsh would override the peer check; remove it or remove the peers, not both',
  );
});
