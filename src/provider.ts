/**
 * Tavily as a `ctx.web` search provider.
 *
 * Registering into the seam (rather than only shipping standalone tools) is
 * what lets DSH's own `web_search` tool serve Tavily results: the seam owns
 * provider selection, and `dsh-tool-web` owns the model-facing schema. This
 * provider therefore implements only retrieval and normalization.
 *
 * Two seam rules shape the implementation:
 *
 * - `available()` must be cheap and must make no network calls. It is consulted
 *   during provider selection, so an eager probe would put a network round trip
 *   on the settings path. See {@link TavilyWebSearchProvider.available}.
 * - `search()` must honor its `AbortSignal`. The SDK cannot, so cancellation is
 *   raced in the client layer.
 *
 * No fetch provider is registered. `WebFetchProvider` must report a real
 * `statusCode` and classify the body as `html` or `text`; Tavily extract is an
 * API call that returns extracted prose with no meaningful status of its own,
 * so mapping it onto that contract would make the seam lie. Plain URL
 * retrieval stays with the shipped `http` fetch provider.
 *
 * @module provider
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web';
import { TavilyError, type TavilyClient } from '@dsh-plugins/plugin-kit';

/** Stable provider id. Must not collide with a registered search provider. */
export const TAVILY_PROVIDER_ID = 'tavily';

/** What this provider needs from the plugin on each call. */
export interface ProviderDeps {
  /** Resolve a client for the CURRENT config (never cache the client itself). */
  resolveClient: () => Promise<TavilyClient>;
  /** Default result count when the request omits `maxResults`. */
  defaultMaxResults: () => number;
  /**
   * Whether a usable credential currently exists. Reported so
   * {@link TavilyWebSearchProvider.available} can answer without awaiting.
   */
  hasCredential: () => boolean;
  /** Whether keyless mode is enabled (serves search without a credential). */
  allowKeyless: () => boolean;
}

/**
 * Translate a client failure into the seam's error type.
 *
 * The seam reserves `WebError` for failures to safely retrieve a resource;
 * consumers route on `code`. `WEB_PROVIDER_CREDENTIAL_MISSING` is the one code
 * a caller can act on directly, so a missing key keeps it.
 *
 * @param error - the failure from the client layer.
 * @returns the seam-shaped error.
 */
export function toWebError(error: unknown): WebError {
  if (error instanceof WebError) return error;
  if (error instanceof TavilyError) {
    const code = error.code === 'missing_api_key' ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR';
    return new WebError(error.message, code, { cause: error });
  }
  return new WebError(
    `Tavily 搜索失败：${error instanceof Error ? error.message : String(error)}`,
    'WEB_PROVIDER_ERROR',
    { cause: error },
  );
}

/** Tavily-backed search provider for the `ctx.web` seam. */
export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID;

  /**
   * Cheap, network-free usability check.
   *
   * A literal key or a keyless-enabled plugin makes this unconditionally true.
   * Otherwise it reports the last credential probe's result, refreshed at
   * activation and after every successful search. Being conservative here
   * matters: claiming availability while unconfigured turns a single-provider
   * deployment into `WEB_PROVIDER_AMBIGUOUS`, which breaks the shipped
   * `web_search` tool for a user who never touched Tavily.
   */
  private credentialSeen: boolean;

  constructor(private readonly deps: ProviderDeps) {
    this.credentialSeen = deps.hasCredential();
  }

  available(): boolean {
    if (this.deps.allowKeyless()) return true;
    return this.credentialSeen || this.deps.hasCredential();
  }

  /** Refresh the cached credential signal; called after a successful search. */
  markCredentialSeen(): void {
    this.credentialSeen = true;
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const client = await this.deps.resolveClient();
    try {
      const response = await client.search({
        query: request.query,
        max_results: request.maxResults ?? this.deps.defaultMaxResults(),
        include_usage: true,
        ...(signal !== undefined ? { signal } : {}),
      });
      this.credentialSeen = true;
      const sources = (response.results ?? []).map((item) => ({
        url: item.url ?? '',
        ...(item.title !== undefined && item.title.length > 0 ? { title: item.title } : {}),
        ...(item.content !== undefined && item.content.length > 0 ? { snippet: item.content } : {}),
        ...(item.published_date !== undefined && item.published_date !== null && item.published_date.length > 0
          ? { publishedAt: item.published_date }
          : {}),
      }));
      // Drop entries without a URL: the seam's source shape guarantees one.
      const usable = sources.filter((source) => source.url.length > 0);
      return {
        // Tavily's own answer, when it produced one.
        ...(response.answer !== undefined && response.answer.length > 0 ? { content: response.answer } : {}),
        sources: usable,
        // The seam owns `maxResults` truncation and sets this itself; claiming
        // it here would report a truncation that may not have happened.
        truncated: false,
      };
    } catch (error) {
      throw toWebError(error);
    }
  }
}
