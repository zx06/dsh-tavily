/**
 * Bundle the Host half into a single self-contained ESM file.
 *
 * Why this exists: `@dsh-plugins/plugin-kit` is a private workspace package —
 * it is never published to npm, so a consumer installing the plugin from a
 * registry or from GitHub can never resolve it. Inlining the kit's *built*
 * output into `dist/host.js` removes that edge and leaves the plugin with only
 * real, resolvable dependencies. This is the shape the published DSH plugins
 * use (they ship zero runtime dependencies of their own).
 *
 * Two categories stay external, and for different reasons:
 *
 * - `@deepseek-ai/*` is the Host runtime the plugin runs *inside*. It must bind
 *   to the loader's own instance (one cordis container, one tool registry, one
 *   credentials service); bundling a second copy would split those seams.
 *   These are also declared as `peerDependencies`.
 * - `@tavily/core` is a real npm package, so a normal dependency install
 *   resolves it. It drags in axios + js-tiktoken (~6 MB bundled); leaving it
 *   external keeps this artifact at ~60 KB and lets the consumer dedupe it.
 *
 * Node builtins (`node:*`) are external by virtue of `platform: "node"`.
 *
 * @module scripts/bundle
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

await build({
  entryPoints: [join(root, 'src/host.ts')],
  outfile: join(root, 'dist/host.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // No sourcemap: `.gitignore` keeps `*.js.map` out of the repo (so stale maps
  // can never sit next to sources), and committing a build without its map
  // would leave a dangling `sourceMappingURL`. Sources ship in the repo anyway.
  sourcemap: false,
  // Keep the Host runtime and the real npm dependency external (see above).
  external: ['@deepseek-ai/*', '@tavily/core'],
  logLevel: 'warning',
})
