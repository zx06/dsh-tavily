/**
 * Tavily client built on the official `@tavily/core` SDK with friendly Chinese
 * error mapping.
 *
 * Auth: the API key is accepted per call (resolved by the caller from the DSH
 * credential store) and never logged, persisted, or echoed.
 *
 * Three deliberate adaptations sit on top of the SDK:
 *
 * 1. **Cancellation.** `@tavily/core` 0.7.14 accepts no `AbortSignal` (the
 *    symbol appears nowhere in its types or runtime), so every call is raced
 *    against the caller's signal by `withAbort`.
 * 2. **Error classification.** The SDK discards HTTP status codes, throwing a
 *    plain `Error` for every failure. `toTavilyError` recovers what it can
 *    from the message text; see `./errors.ts`.
 * 3. **Usage accounting.** Every request asks for `includeUsage` so the caller
 *    can record real credit consumption.
 *
 * The SDK covers search/extract/crawl/map/research. `/usage` has no SDK
 * method, so it stays a direct `fetch` call — which has the side benefit of
 * preserving a real HTTP status for the configuration panel.
 *
 * Keyless mode: the SDK serves `search` and `extract` without a key. This
 * client exposes that as an explicit option rather than a silent fallback, so
 * a caller that requires a credential (crawl/map/research) can say so.
 *
 * @module client
 */

import {
  tavily,
  type TavilyClient as SdkClient,
  type TavilyCrawlResponse,
  type TavilyExtractResponse,
  type TavilyMapResponse,
  type TavilySearchResponse as SdkSearchResponse,
} from '@tavily/core';
import {
  abortedError,
  MISSING_KEY_MESSAGE,
  TAVILY_API_BASE,
  TAVILY_DASHBOARD_URL,
  TAVILY_USAGE_DOCS_URL,
  TavilyError,
  toTavilyError,
  withAbort,
} from './errors.js';
import type {
  TavilyCrawlOptions,
  TavilyExtractCrawlResponse,
  TavilyExtractOptions,
  TavilyMapOptions,
  TavilyResearchOptions,
  TavilyResearchResult,
  TavilyResearchTask,
  TavilyResultItem,
  TavilySearchOptions,
  TavilySearchResponse,
  TavilyUsageResponse,
} from './types.js';
import { clamp, cleanStringArray, compactText, normalizeUrl, normalizeUrls } from './normalize.js';

export { TAVILY_API_BASE, TAVILY_DASHBOARD_URL, TAVILY_USAGE_DOCS_URL };
export { TavilyError, toTavilyError, abortedError } from './errors.js';
export type { TavilyErrorCode } from './errors.js';

export const REQUEST_TIMEOUT_MS = 45_000;
export const USAGE_REQUEST_TIMEOUT_MS = 15_000;
export const RESEARCH_TIMEOUT_S = 180;
export const MAX_DOMAINS = 300;
export const MAX_URLS_PER_EXTRACT = 20;
/** Tavily's own minimum accepted query length; enforced locally to save a round trip. */
export const MIN_QUERY_LENGTH = 2;

export interface TavilyClientOptions {
  /**
   * API key. When omitted (or blank) the client runs in keyless mode — the SDK
   * then serves only `search` and `extract`, and the credential-requiring
   * methods fail with an actionable message.
   */
  apiKey?: string;
  requestTimeoutMs?: number;
  usageTimeoutMs?: number;
}

function requireKey(apiKey: string | undefined): string {
  const key = apiKey?.trim();
  if (!key) throw new TavilyError('missing_api_key', MISSING_KEY_MESSAGE, false);
  return key;
}

/**
 * Run one argument-normalization step and classify its failure as
 * `bad_request`.
 *
 * Validation must happen OUTSIDE the SDK try/catch: `toTavilyError` reads
 * upstream failure text, and a local "urls cannot be empty" would otherwise be
 * reported as an opaque `unknown` upstream fault.
 *
 * @param normalize - the normalization step.
 * @returns the normalized value.
 * @throws {@link TavilyError} `bad_request` when the argument is unusable.
 */
function validated<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new TavilyError(
      'bad_request',
      error instanceof Error ? error.message : String(error),
      false,
    );
  }
}

function normalizeDepth(depth: TavilySearchOptions['search_depth']): 'basic' | 'advanced' {
  return depth === 'basic' || depth === 'fast' || depth === 'ultra-fast' ? 'basic' : 'advanced';
}

/** Read `usage.credits` from any SDK response that carries one. */
function creditsOf(response: { usage?: { credits?: number } } | undefined): number | undefined {
  const credits = response?.usage?.credits;
  return typeof credits === 'number' ? credits : undefined;
}

/**
 * Tavily wrapper over `@tavily/core`; one instance per resolved API key.
 *
 * `keyless` is true when constructed without a key. Callers that need a
 * credential should check it rather than discovering the failure mid-call.
 */
export class TavilyClient {
  private readonly sdk: SdkClient;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly usageTimeoutMs: number;

  /** True when this client has no key and relies on Tavily's keyless tier. */
  readonly keyless: boolean;

  constructor(options: TavilyClientOptions) {
    const key = options.apiKey?.trim();
    this.apiKey = key && key.length > 0 ? key : undefined;
    this.keyless = this.apiKey === undefined;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.usageTimeoutMs = options.usageTimeoutMs ?? USAGE_REQUEST_TIMEOUT_MS;
    // The SDK reads process.env.TAVILY_API_KEY itself when apiKey is omitted;
    // passing an explicit object keeps keyless mode a caller decision.
    this.sdk = this.apiKey === undefined ? tavily({}) : tavily({ apiKey: this.apiKey });
  }

  async search(
    params: TavilySearchOptions & { signal?: AbortSignal },
  ): Promise<TavilySearchResponse> {
    const query = compactText(params.query);
    if (!query) throw new TavilyError('bad_request', '搜索 query 不能为空。', false);
    // Tavily rejects queries under 2 characters ("Query is too short. Min query
    // length is 2 characters.") AFTER the request is sent, and it does so before
    // authenticating — so a one-character query would report a confusing
    // validation error instead of the real problem. Catch it locally.
    if (query.length < MIN_QUERY_LENGTH) {
      throw new TavilyError(
        'bad_request',
        `搜索 query 过短：至少需要 ${MIN_QUERY_LENGTH} 个字符（当前 ${query.length} 个）。`,
        false,
      );
    }
    try {
      const response: SdkSearchResponse = await withAbort(
        this.sdk.search(query, {
          topic: params.topic ?? 'general',
          searchDepth: normalizeDepth(params.search_depth),
          maxResults: clamp(params.max_results ?? 5, 1, 10),
          includeAnswer: params.include_answer ?? true,
          includeRawContent:
            params.include_raw_content === true ? 'markdown' : (params.include_raw_content ?? false),
          includeDomains: cleanStringArray(params.include_domains, MAX_DOMAINS),
          excludeDomains: cleanStringArray(params.exclude_domains, MAX_DOMAINS),
          includeDomainsMode: params.include_domains_mode,
          timeRange: params.time_range,
          timeout: Math.floor(this.requestTimeoutMs / 1000),
          includeUsage: params.include_usage ?? true,
        }),
        params.signal,
        '搜索',
      );
      const results: TavilyResultItem[] = (response.results ?? []).map((item) => ({
        title: item.title,
        url: item.url,
        content: item.content,
        raw_content: item.rawContent,
        score: item.score,
        published_date: item.publishedDate ?? null,
        favicon: item.favicon,
      }));
      return {
        query: response.query ?? query,
        answer: typeof response.answer === 'string' ? response.answer : undefined,
        results,
        response_time: response.responseTime,
        request_id: response.requestId,
        credits: creditsOf(response),
      };
    } catch (error) {
      throw toTavilyError(error, '搜索');
    }
  }

  async extract(
    params: TavilyExtractOptions & { signal?: AbortSignal },
  ): Promise<TavilyExtractCrawlResponse> {
    try {
      const response: TavilyExtractResponse = await withAbort(
        this.sdk.extract(validated(() => normalizeUrls(params.urls, MAX_URLS_PER_EXTRACT)), {
          extractDepth: params.extract_depth === 'basic' ? 'basic' : 'advanced',
          includeImages: params.include_images ?? false,
          timeout: Math.floor(this.requestTimeoutMs / 1000),
          includeUsage: true,
        }),
        params.signal,
        '正文抽取',
      );
      return {
        results: (response.results ?? []).map((item) => ({
          title: item.title ?? undefined,
          url: item.url,
          content: item.rawContent,
          raw_content: item.rawContent,
          images: item.images,
          favicon: item.favicon,
        })),
        failed_results: (response.failedResults ?? []).map((item) => ({
          url: item.url,
          error: item.error,
        })),
        response_time: response.responseTime,
        request_id: response.requestId,
        credits: creditsOf(response),
      };
    } catch (error) {
      throw toTavilyError(error, '正文抽取');
    }
  }

  async crawl(
    params: TavilyCrawlOptions & { signal?: AbortSignal },
  ): Promise<TavilyExtractCrawlResponse> {
    requireKey(this.apiKey);
    try {
      const response: TavilyCrawlResponse = await withAbort(
        this.sdk.crawl(validated(() => normalizeUrl(params.url, 'url')), {
          instructions: compactText(params.instructions) || undefined,
          maxDepth: clamp(params.max_depth ?? 2, 1, 5),
          maxBreadth: clamp(params.max_breadth ?? 20, 1, 50),
          limit: clamp(params.limit ?? 10, 1, 50),
          selectPaths: cleanStringArray(params.select_paths, 50),
          excludePaths: cleanStringArray(params.exclude_paths, 50),
          allowExternal: params.allow_external ?? false,
          extractDepth: params.extract_depth === 'basic' ? 'basic' : 'advanced',
          includeImages: params.include_images ?? false,
          timeout: Math.floor(this.requestTimeoutMs / 1000),
          includeUsage: true,
        }),
        params.signal,
        '站点爬取',
      );
      return {
        results: (response.results ?? []).map((item) => ({
          url: item.url,
          content: item.rawContent,
          raw_content: item.rawContent,
          images: item.images,
          favicon: item.favicon,
        })),
        base_url: response.baseUrl,
        response_time: response.responseTime,
        request_id: response.requestId,
        credits: creditsOf(response),
      };
    } catch (error) {
      throw toTavilyError(error, '站点爬取');
    }
  }

  async map(
    params: TavilyMapOptions & { signal?: AbortSignal },
  ): Promise<{ urls: string[]; response_time?: number; credits?: number }> {
    requireKey(this.apiKey);
    try {
      const response: TavilyMapResponse = await withAbort(
        this.sdk.map(validated(() => normalizeUrl(params.url, 'url')), {
          limit: clamp(params.limit ?? 50, 1, 500),
          maxDepth: params.max_depth !== undefined ? clamp(params.max_depth, 1, 5) : undefined,
          maxBreadth: params.max_breadth !== undefined ? clamp(params.max_breadth, 1, 50) : undefined,
          selectPaths: cleanStringArray(params.select_paths, 50),
          excludePaths: cleanStringArray(params.exclude_paths, 50),
          allowExternal: params.allow_external ?? false,
          timeout: Math.floor(this.requestTimeoutMs / 1000),
          includeUsage: true,
        }),
        params.signal,
        '站点映射',
      );
      return {
        urls: response.results ?? [],
        response_time: response.responseTime,
        credits: creditsOf(response),
      };
    } catch (error) {
      throw toTavilyError(error, '站点映射');
    }
  }

  /**
   * Create one asynchronous research task. Returns as soon as Tavily accepts
   * the task; poll {@link getResearch} for the report.
   */
  async research(
    input: string,
    params: TavilyResearchOptions & { signal?: AbortSignal } = {},
  ): Promise<TavilyResearchTask> {
    requireKey(this.apiKey);
    const text = compactText(input);
    if (!text) throw new TavilyError('bad_request', 'research 输入不能为空。', false);
    try {
      const response = await withAbort(
        this.sdk.research(text, {
          model: params.model ?? 'auto',
          citationFormat: params.citation_format,
          timeout: params.timeout_s ?? RESEARCH_TIMEOUT_S,
        }),
        params.signal,
        '深度研究',
      );
      // `stream: true` would yield an async generator here; we never request it.
      const task = response as {
        requestId?: string;
        createdAt?: string;
        status?: string;
        input?: string;
        model?: string;
        responseTime?: number;
      };
      return {
        request_id: task.requestId ?? '',
        created_at: task.createdAt,
        status: task.status,
        input: task.input,
        model: task.model,
        response_time: task.responseTime,
      };
    } catch (error) {
      throw toTavilyError(error, '深度研究');
    }
  }

  /** Read one research task's current state (and its report once complete). */
  async getResearch(
    requestId: string,
    params: { include_usage?: boolean; signal?: AbortSignal } = {},
  ): Promise<TavilyResearchResult> {
    requireKey(this.apiKey);
    const id = compactText(requestId);
    if (!id) throw new TavilyError('bad_request', 'research request_id 不能为空。', false);
    try {
      const response = await withAbort(
        this.sdk.getResearch(id, { includeUsage: params.include_usage ?? true }),
        params.signal,
        '研究结果查询',
      );
      const result = response as {
        requestId?: string;
        createdAt?: string;
        status?: string;
        content?: string | Record<string, unknown>;
        sources?: Array<{ title?: string; url?: string }>;
        responseTime?: number;
        usage?: { credits?: number };
      };
      return {
        request_id: result.requestId ?? id,
        created_at: result.createdAt,
        status: result.status,
        content: result.content,
        sources: result.sources,
        response_time: result.responseTime,
        credits: typeof result.usage?.credits === 'number' ? result.usage.credits : undefined,
      };
    } catch (error) {
      throw toTavilyError(error, '研究结果查询');
    }
  }

  /**
   * `/usage` has no SDK method; direct fetch with the same error mapping.
   *
   * Unlike the SDK path this preserves the real HTTP status, which is why the
   * configuration panel can validate a candidate key precisely.
   *
   * @param signal - optional cancellation.
   * @returns the usage snapshot.
   * @throws {@link TavilyError} `missing_api_key` in keyless mode.
   */
  async usage(signal?: AbortSignal): Promise<TavilyUsageResponse> {
    const key = requireKey(this.apiKey);
    const timeout = AbortSignal.timeout(this.usageTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${TAVILY_API_BASE}/usage`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) throw abortedError('额度查询', signal);
      throw toTavilyError(error, '额度查询');
    }
    const rawText = await response.text().catch(() => '');
    let data: unknown = {};
    if (rawText.trim()) {
      try {
        data = JSON.parse(rawText) as unknown;
      } catch {
        if (!response.ok) {
          throw toTavilyError({ response: { status: response.status, data: rawText } }, '额度查询');
        }
        throw new TavilyError(
          'server',
          'Tavily 额度接口返回了无法解析的响应，请稍后重试。',
          true,
          response.status,
        );
      }
    }
    if (!response.ok) {
      throw toTavilyError({ response: { status: response.status, data } }, '额度查询');
    }
    return (data ?? {}) as TavilyUsageResponse;
  }
}

/** Mask a key for display: `tvly-abcd...wxyz`. Never log the raw key. */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length <= 12) return key.length > 4 ? `${key.slice(0, 4)}****` : '****';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}
