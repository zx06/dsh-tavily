/**
 * Plugin configuration schema and its projection into per-call options.
 *
 * This is the 0.2.1-rc.3 shape: a schemastery `Config` exported from the Host
 * half. The Loader validates it, DSH derives a settings form from it
 * (`autoGenerate`), and `apply` receives it as the second argument.
 *
 * Every field is `.volatile()`, which makes the Loader hand `apply` a
 * {@link Volatile} ACCESSOR rather than a frozen snapshot. That is what lets a
 * settings-page edit take effect on the very next call without reloading the
 * plugin — so this module must never cache `config.x.get()` across calls.
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';

/** Default credential reference; the settings page writes through it. */
export const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY';

export const Config = z.object({
  /**
   * Credential REFERENCE (an environment-variable name) resolved per call
   * through `ctx.credentials`. Preferred over {@link Config.apiKey} because a
   * reference keeps the secret out of every configuration file.
   */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  /**
   * Literal API key. `role('secret')` keeps it out of every wire response;
   * prefer `apiKeyEnv` so the value lives in the credential store instead.
   */
  apiKey: z.string().role('secret').volatile(),
  /**
   * Allow Tavily's keyless tier when no credential resolves. Keyless serves
   * only search and extract, under a shared rate limit.
   */
  allowKeyless: z.boolean().default(true).volatile(),
  /** Default result count for `tavily_search` (1-10). */
  defaultMaxResults: z.number().step(1).min(1).max(10).default(5).volatile(),
  /** Default search depth: `basic` costs 1 credit, `advanced` costs 2. */
  defaultSearchDepth: z.union([z.const('basic'), z.const('advanced')]).default('advanced').volatile(),
  /** Per-request timeout in milliseconds for search/extract/crawl/map. */
  requestTimeoutMs: z.number().step(1).min(1000).default(45_000).volatile(),
  /**
   * Budget for one `tavily_research` call, in milliseconds. Research tasks run
   * for minutes, so this is separate from `requestTimeoutMs` and is enforced by
   * the tool's own polling loop rather than the SDK.
   */
  researchTimeoutMs: z.number().step(1).min(10_000).default(180_000).volatile(),
});

/**
 * The accessor shape `apply` receives for a `.volatile()` schema.
 *
 * Declared explicitly, as the shipped providers do: schemastery's `volatile()`
 * projects each field to `Volatile<T>` (an object with `get()`), and this
 * interface is what makes `config.apiKey.get()` type-check inside `apply`.
 */
export interface PluginConfig {
  apiKeyEnv: Volatile<string>;
  apiKey: Volatile<string | undefined>;
  allowKeyless: Volatile<boolean>;
  defaultMaxResults: Volatile<number>;
  defaultSearchDepth: Volatile<'basic' | 'advanced'>;
  requestTimeoutMs: Volatile<number>;
  researchTimeoutMs: Volatile<number>;
}

/** The validated plugin configuration (values, not accessors). */
export interface ResolvedConfig {
  apiKeyEnv: string;
  apiKey?: string;
  allowKeyless: boolean;
  defaultMaxResults: number;
  defaultSearchDepth: 'basic' | 'advanced';
  requestTimeoutMs: number;
  researchTimeoutMs: number;
}

/**
 * Read the current configuration.
 *
 * Called fresh on every operation: a `.volatile()` field can change between
 * calls (the settings page writes through the same namespace), so caching a
 * value here would silently pin the plugin to the config it started with.
 *
 * @param config - the Loader-provided accessors.
 * @returns one resolved configuration snapshot.
 */
export function resolveConfig(config: PluginConfig): ResolvedConfig {
  const literal = config.apiKey.get();
  return {
    apiKeyEnv: config.apiKeyEnv.get() || DEFAULT_API_KEY_ENV,
    ...(literal !== undefined && literal.trim().length > 0 ? { apiKey: literal } : {}),
    allowKeyless: config.allowKeyless.get(),
    defaultMaxResults: config.defaultMaxResults.get(),
    defaultSearchDepth: config.defaultSearchDepth.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
    researchTimeoutMs: config.researchTimeoutMs.get(),
  };
}
