/**
 * Tavily plugin — Host half.
 *
 * Composes four contributions onto one plugin:
 *
 * 1. A **`ctx.web` search provider** (`id: tavily`) so DSH's own `web_search`
 *    tool can serve Tavily results once the seam selects it.
 * 2. **Five model-facing tools** (`tavily_search`/`extract`/`crawl`/`map`/
 *    `research`) that work immediately, without waiting for provider selection.
 * 3. A **settings API** at `/api/tavily` backing the browser half's page.
 * 4. A **system-prompt section** marking Tavily output as untrusted data.
 *
 * Key handling follows the 0.2.0-rc.2 conventions:
 *
 * - The key resolves per call as literal config → `ctx.credentials` → launch
 *   environment, and is never cached (see `./keystore`).
 * - The settings page writes through `ctx.credentials`, so the value lives in
 *   the managed store rather than any configuration file.
 * - `Config` is a `.volatile()` schema, so `apply` reads accessors and a
 *   settings edit reaches the next call without a reload.
 *
 * Optional services are read with `ctx.get()` and checked, so the plugin still
 * activates in a headless profile that composes no webserver or credential
 * service.
 *
 * @module host
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TavilyClient, type AuditEntry } from '@dsh-plugins/plugin-kit';
import { appendAudit, dataDir } from './audit-store.js';
import { Config, resolveConfig, type PluginConfig } from './config.js';
import { resolveApiKey, type KeyResolution } from './keystore.js';
import { TavilyWebSearchProvider } from './provider.js';
import { createHandler, ROUTE_PREFIX } from './routes.js';
import {
  registerCrawlTool,
  registerExtractTool,
  registerMapTool,
  registerResearchTool,
  registerSearchTool,
  type ToolDeps,
} from './tools.js';

export const name = 'tavily';

/**
 * Hard dependencies. `tools` is required (the plugin's whole surface is tools
 * plus a provider); everything else is read optionally at runtime.
 */
export const inject = ['tools'];

export { Config };
export type { PluginConfig };

/** Minimal structural view of the context, so tests can supply a fake. */
interface Ctx {
  tools?: { register: (definition: unknown) => () => void };
  get?: (name: string) => unknown;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  effect?: (callback: () => (() => void) | void, label?: string) => void;
  inject?: (deps: string[], callback: (scoped: Ctx) => void) => unknown;
  web?: { registerSearchProvider: (provider: unknown) => () => void };
  webServer?: { register: (route: unknown) => () => void };
  systemPrompt?: { section: (section: { name: string; order: number; text: string }) => () => void };
  credentials?: {
    resolve: (ref: unknown) => Promise<{ value: string; source: string } | undefined>;
    set: (ref: unknown, value: string) => Promise<void>;
    unset: (ref: unknown) => Promise<void>;
  };
}

export function apply(ctx: Ctx, config: PluginConfig): void {
  // `logger` is a cordis built-in available on every context; `get` is the
  // safe reader for optional services.
  const logger = ctx.logger ?? console;
  const get = (service: string): unknown => ctx.get?.(service);

  // ---- key resolution + client construction -------------------------------

  /** Resolve the current key for one operation. Never caches the result. */
  const resolveKey = async (): Promise<KeyResolution> => {
    const cfg = resolveConfig(config);
    return resolveApiKey({ get }, { apiKeyEnv: cfg.apiKeyEnv, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
  };

  /**
   * Build a client for the current configuration.
   *
   * A missing credential is not fatal: keyless mode still serves search and
   * extract, and the client reports `keyless` so callers that need more can
   * say so precisely.
   */
  const clientFor = (apiKey?: string): TavilyClient => {
    const cfg = resolveConfig(config);
    if (apiKey !== undefined) {
      return new TavilyClient({ apiKey, requestTimeoutMs: cfg.requestTimeoutMs });
    }
    return new TavilyClient({
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
  };

  /** Whether keyless fallback is allowed right now. */
  const allowKeyless = (): boolean => resolveConfig(config).allowKeyless;

  // ---- audit --------------------------------------------------------------

  const append = (entry: AuditEntry): void => {
    appendAudit(entry, dataDir());
  };

  // ---- 1. ctx.web search provider ----------------------------------------

  /**
   * Last known credential state.
   *
   * `available()` must answer synchronously and make no network call, so the
   * async credential probe runs once at activation and is refreshed whenever a
   * key is actually resolved. Without this cache the provider would have to
   * either lie (claiming availability while unconfigured, which turns a
   * single-provider deployment into `WEB_PROVIDER_AMBIGUOUS`) or block.
   */
  let credentialSeen = false;

  const provider = new TavilyWebSearchProvider({
    resolveClient: async () => {
      const key = await resolveKey();
      if (!key.ok && !allowKeyless()) {
        const cfg = resolveConfig(config);
        throw new Error(
          `Tavily 未配置 API Key（凭据引用 ${cfg.apiKeyEnv}）。请前往 DSH 设置页 → Tavily 搜索填写，或在配置中开启 allowKeyless。`,
        );
      }
      if (key.ok) credentialSeen = true;
      return clientFor(key.apiKey);
    },
    defaultMaxResults: () => resolveConfig(config).defaultMaxResults,
    hasCredential: () => credentialSeen,
    allowKeyless,
  });

  // Probe once so `available()` is accurate before the first search.
  void (async () => {
    try {
      const key = await resolveKey();
      credentialSeen = key.ok;
      if (!key.ok && !allowKeyless()) {
        logger.info?.(
          `[tavily] 未配置 API Key（${key.ref}），ctx.web provider 保持不可用；工具仍会给出配置指引。`,
        );
      }
    } catch (error) {
      logger.warn?.('[tavily] 凭据探测失败：', error);
    }
  })();

  ctx.inject?.(['web'], (scoped) => {
    const web = scoped.web;
    if (web === undefined) return;
    scoped.effect?.(
      () => web.registerSearchProvider(provider),
      'tavily: ctx.web search provider',
    );
  });

  // ---- 2. model-facing tools ---------------------------------------------

  const toolDeps: ToolDeps = {
    defineTool,
    register: (definition) => {
      // `tools` is a hard dependency (declared in `inject`), so this is the one
      // service property that is always safe to read directly.
      ctx.tools?.register(definition);
    },
    section: (section) => {
      // Read through `ctx.get`, never `ctx.systemPrompt`: cordis throws when a
      // service property is touched without a matching `inject`, and optional
      // chaining does not catch that (the getter itself throws). `systemPrompt`
      // is deliberately not a hard dependency — a headless profile may compose
      // none, and the tools must still register.
      const systemPrompt = get('systemPrompt') as Ctx['systemPrompt'] | undefined;
      systemPrompt?.section(section);
    },
    resolveClient: async () => {
      const key = await resolveKey();
      if (!key.ok && !allowKeyless()) {
        const cfg = resolveConfig(config);
        throw new Error(
          `未配置 Tavily API Key（凭据引用 ${cfg.apiKeyEnv}）。请前往 DSH 设置页 → Tavily 搜索填写 API Key，或在配置中开启 allowKeyless 使用免密搜索。`,
        );
      }
      return clientFor(key.apiKey);
    },
    appendAudit: append,
    config: () => {
      const cfg = resolveConfig(config);
      return {
        defaultMaxResults: cfg.defaultMaxResults,
        defaultSearchDepth: cfg.defaultSearchDepth,
        researchTimeoutMs: cfg.researchTimeoutMs,
      };
    },
  };

  registerSearchTool(toolDeps);
  registerExtractTool(toolDeps);
  registerCrawlTool(toolDeps);
  registerMapTool(toolDeps);
  registerResearchTool(toolDeps);

  // ---- 3. settings API ---------------------------------------------------

  const handler = createHandler({
    resolveKey: async () => {
      const key = await resolveKey();
      return {
        ok: key.ok,
        ...(key.apiKey !== undefined ? { apiKey: key.apiKey } : {}),
        source: key.source,
        ...(key.masked !== undefined ? { masked: key.masked } : {}),
        ref: key.ref,
      };
    },
    allowKeyless,
    clientFor: (apiKey) => clientFor(apiKey),
    saveKey: async (ref, apiKey) => {
      const credentials = get('credentials') as Ctx['credentials'] | undefined;
      if (credentials === undefined) {
        throw new Error('凭据服务不可用：当前 profile 未挂载 credentials 服务，无法保存 Key。');
      }
      // A read-only source (the inherited environment) shadows writes, and the
      // service refuses rather than pretending to succeed. Surface that.
      await credentials.set(credentialRef(ref), apiKey);
    },
    clearKey: async (ref) => {
      const credentials = get('credentials') as Ctx['credentials'] | undefined;
      if (credentials === undefined) {
        throw new Error('凭据服务不可用：当前 profile 未挂载 credentials 服务。');
      }
      await credentials.unset(credentialRef(ref));
    },
    dataDir: () => dataDir(),
  });

  ctx.inject?.(['webServer'], (scoped) => {
    const server = scoped.webServer;
    if (server === undefined) return;
    scoped.effect?.(
      () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'tavily: settings API',
    );
  });

  logger.info?.('[tavily] loaded');
}
