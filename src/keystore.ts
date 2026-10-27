/**
 * API key resolution for the Tavily plugin.
 *
 * Resolution order (highest first):
 *
 * 1. `config.apiKey` — a literal key in the plugin config. Kept for one-off
 *    setups and CI; `role('secret')` keeps it off every wire surface.
 * 2. `ctx.credentials.resolve(apiKeyEnv)` — the sanctioned path. The DSH
 *    credential store layers the inherited environment (read-only, shadows
 *    writes) over `$DSH_HOME/.credentials.yaml` (writable), so the settings
 *    page's write lands in the managed file and takes effect on the next call.
 * 3. `launchEnvironmentOf(ctx).get(apiKeyEnv)` — the launching environment,
 *    used only when no credential service is composed (headless profiles).
 *
 * Nothing is cached: `resolve` runs once per operation, which is what makes a
 * rotated key reach the next call without a reload.
 *
 * The resolved key is held in memory only — never written to logs, audit
 * entries, or the configuration panel (which receives a mask).
 *
 * @module keystore
 */

import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { maskApiKey } from '@dsh-plugins/plugin-kit';

/** Where a resolved key came from; `none` means nothing is configured. */
export type KeySource = 'config' | 'credentials' | 'env' | 'none';

export interface KeyResolution {
  /** True when a non-empty key was found. */
  ok: boolean;
  apiKey?: string;
  source: KeySource;
  /** Display mask (`tvly-abcd...wxyz`); never the key itself. */
  masked?: string;
  /** The credential reference that was consulted, for the configuration panel. */
  ref: string;
}

/**
 * The subset of a cordis context this module needs.
 *
 * Typed structurally rather than importing `Context` so the unit tests can
 * pass a plain object: `ctx.credentials` is optional because headless profiles
 * compose no credential service.
 */
export interface KeystoreContext {
  get(name: string): unknown;
}

interface CredentialService {
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>;
}

interface LaunchEnvironment {
  get(name: string): { value: string } | undefined;
}

/**
 * Resolve the Tavily API key for one operation.
 *
 * @param ctx - the plugin context (for the credential and environment planes).
 * @param options - the resolved config plus a literal-key override.
 * @returns the resolution; `ok: false` means the caller must decide whether
 *   keyless mode applies.
 */
export async function resolveApiKey(
  ctx: KeystoreContext,
  options: { apiKeyEnv: string; apiKey?: string },
): Promise<KeyResolution> {
  const ref = options.apiKeyEnv;

  const literal = options.apiKey?.trim();
  if (literal) {
    return { ok: true, apiKey: literal, source: 'config', masked: maskApiKey(literal), ref };
  }

  const credentials = ctx.get('credentials') as CredentialService | undefined;
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(credentialRef(ref));
      const value = resolved?.value?.trim();
      if (value) {
        return { ok: true, apiKey: value, source: 'credentials', masked: maskApiKey(value), ref };
      }
    } catch {
      // A credential-provider failure must not mask the environment fallback
      // below, and must never surface the key in an error message.
    }
  }

  // Only reached without a credential service (or with it reporting absent):
  // read the launching environment directly.
  const launch = ctx.get('launchEnvironment') as LaunchEnvironment | undefined;
  const ambient = launch?.get(ref)?.value?.trim();
  if (ambient) {
    return { ok: true, apiKey: ambient, source: 'env', masked: maskApiKey(ambient), ref };
  }

  return { ok: false, source: 'none', ref };
}
