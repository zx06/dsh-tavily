/**
 * Tavily error taxonomy plus the translation layer that turns failures into
 * user-facing Chinese messages.
 *
 * Why this module exists as its own layer: `@tavily/core` funnels every HTTP
 * failure through one `handleRequestError` helper that throws a PLAIN `Error`
 * and drops the response entirely — no `.response`, no `.status`, no `.code`.
 * A 401 therefore arrives indistinguishable from a network fault, and the
 * naive mapping reports "网络请求失败，请检查网络后重试" for a mistyped key.
 *
 * We cannot recover the status the SDK discarded, so the mapping is layered:
 *
 * 1. A structured match when the failure still carries machine facts: the
 *    SDK's exported `TavilyKeylessLimitError`, or an axios-style `.response`
 *    (our own `/usage` call and any future direct fetch keep this path).
 * 2. A text heuristic over the message the SDK forwards verbatim from Tavily
 *    (`"Unauthorized: ..."`, `"429 Error: ..."`, `"Request timed out..."`).
 * 3. `unknown` — never silently reclassified as retryable network trouble.
 *
 * Keeping this here (rather than inline in the client) means the tool layer,
 * the `ctx.web` provider, and the config routes all classify failures the
 * same way, so a Key problem reads identically wherever it surfaces.
 *
 * @module errors
 */

import { TavilyKeylessLimitError } from '@tavily/core';

export const TAVILY_API_BASE = 'https://api.tavily.com';
export const TAVILY_DASHBOARD_URL = 'https://app.tavily.com/home';
export const TAVILY_USAGE_DOCS_URL =
  'https://docs.tavily.com/documentation/api-reference/endpoint/usage';

/**
 * Where a user goes to configure the plugin.
 *
 * Defined once because five messages below interpolate it: when the
 * configuration surface moved from a Settings page to the plugin's own detail
 * page, every copy had to change and nothing failed when one was missed (no
 * test asserted these strings). Interpolating one constant makes the next move
 * a single edit, and `test/guidance.test.ts` guards the wording.
 */
export const CONFIG_LOCATION = '插件管理器 → @zx06/tavily 详情页';

/**
 * Machine-routable failure classes.
 *
 * `keyless_limit` and `aborted` are first-class rather than folded into
 * `rate_limited`/`network`: keyless throttling is fixed by configuring a Key
 * (not by waiting), and cancellation is the caller's own doing, so neither
 * should surface as a transient upstream fault.
 */
export type TavilyErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'bad_request'
  | 'rate_limited'
  | 'keyless_limit'
  | 'quota_exhausted'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'server'
  | 'unknown';

/** Structured error whose message is already user-facing Chinese. */
export class TavilyError extends Error {
  readonly code: TavilyErrorCode;
  /** True when retrying later (or after fixing quota/rate) may succeed. */
  readonly retryable: boolean;
  /** Raw HTTP status when the failure came from a path that kept it. */
  readonly status?: number;

  constructor(code: TavilyErrorCode, message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'TavilyError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export const MISSING_KEY_MESSAGE =
  `未配置 Tavily API Key。请前往${CONFIG_LOCATION}填写 API Key（可在 ${TAVILY_DASHBOARD_URL} 申请），保存后重试。`;

/**
 * Raised when a method that keyless mode cannot serve is called without a key.
 * `@tavily/core` only supports `search` and `extract` keyless; `crawl`, `map`,
 * and `research` need a credential.
 */
export const KEYLESS_METHOD_MESSAGE =
  `Tavily 免密模式仅支持搜索与正文抽取；crawl / map / research 需要 API Key。请前往${CONFIG_LOCATION}填写 API Key。`;

interface AxiosLikeError {
  response?: { status?: number; data?: unknown };
  code?: string;
  message?: string;
}

/** Pull the human detail out of Tavily's `{ detail: { error } }` envelope. */
function errorDetail(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const detail = record.detail ?? record.error ?? record.message;
    if (typeof detail === 'string') return detail;
    if (detail !== null && typeof detail === 'object') {
      const inner = (detail as Record<string, unknown>).error;
      if (typeof inner === 'string') return inner;
    }
    try {
      const text = JSON.stringify(detail ?? data);
      return text === '{}' ? '' : text;
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Map one known HTTP status. Reached only when the status survived — the
 * direct-fetch `/usage` path and axios-shaped errors; the SDK path cannot.
 */
export function mapStatus(status: number | undefined, detail: string, label: string): TavilyError {
  const suffix = detail ? `（${detail}）` : '';
  switch (status) {
    case 401:
      return new TavilyError(
        'invalid_api_key',
        `Tavily API Key 无效或缺失${suffix}。请前往${CONFIG_LOCATION}检查 Key 是否填写正确。`,
        false,
        status,
      );
    case 400:
    case 422:
      return new TavilyError('bad_request', `Tavily ${label} 请求参数有误${suffix}。`, false, status);
    case 429:
      return new TavilyError(
        'rate_limited',
        `Tavily 请求过于频繁（429）${suffix}。请稍候片刻后重试。`,
        true,
        status,
      );
    case 432:
    case 433:
      return new TavilyError(
        'quota_exhausted',
        `Tavily 额度已用尽（${status}）${suffix}。请前往 ${TAVILY_DASHBOARD_URL} 查看额度或升级套餐。`,
        false,
        status,
      );
    case undefined:
      return new TavilyError('network', `Tavily ${label} 网络请求失败${suffix}，请检查网络后重试。`, true);
    default:
      return new TavilyError(
        (status ?? 0) >= 500 ? 'server' : 'unknown',
        `Tavily ${label} 失败${status !== undefined ? `（${status}）` : ''}${suffix}。`,
        (status ?? 0) >= 500,
        status,
      );
  }
}

/**
 * Classify a message that no longer carries a status code.
 *
 * Every pattern below was observed from a real `@tavily/core` failure shape
 * (the SDK interpolates Tavily's own text), so these are not guesses about
 * hypothetical wording. The order matters: the keyless note is matched first
 * because the SDK throws it locally, before any request.
 *
 * @param message - the SDK's message text.
 * @param label - the operation name used in the Chinese sentence.
 * @returns the classified error, or undefined when nothing matched.
 */
function classifyMessage(message: string, label: string): TavilyError | undefined {
  if (/Keyless mode only supports/i.test(message)) {
    return new TavilyError('missing_api_key', KEYLESS_METHOD_MESSAGE, false);
  }
  // Tavily validates the request body BEFORE authentication, so a malformed
  // query on an otherwise-valid key reports a validation message rather than a
  // 401. Verified against the live API: `search('x')` returns
  // "Query is too short. Min query length is 2 characters." even with a bad
  // key. These must not be mistaken for an upstream fault.
  if (/Query is too short|Min query length|Invalid (?:request|parameter)|must be at least/i.test(message)) {
    return new TavilyError('bad_request', `Tavily ${label} 请求参数有误（${message}）。`, false);
  }
  if (/Unauthorized|invalid API key|missing or invalid/i.test(message)) {
    return new TavilyError(
      'invalid_api_key',
      `Tavily API Key 无效或缺失（${message}）。请前往${CONFIG_LOCATION}检查 Key 是否填写正确。`,
      false,
      401,
    );
  }
  // The SDK formats status-only failures as `"<status> Error: <body>"`.
  const statusPrefix = /^(\d{3})\s+Error\b/.exec(message.trim());
  if (statusPrefix?.[1]) {
    return mapStatus(Number(statusPrefix[1]), message.replace(/^\d{3}\s+Error:\s*/, ''), label);
  }
  if (/429|too many requests|rate limit/i.test(message)) {
    return new TavilyError(
      'rate_limited',
      `Tavily 请求过于频繁（${message}）。请稍候片刻后重试。`,
      true,
      429,
    );
  }
  if (/432|433|quota|exceeded your plan|insufficient credits/i.test(message)) {
    return new TavilyError(
      'quota_exhausted',
      `Tavily 额度已用尽（${message}）。请前往 ${TAVILY_DASHBOARD_URL} 查看额度或升级套餐。`,
      false,
    );
  }
  if (/timed out|timeout|ECONNABORTED/i.test(message)) {
    return new TavilyError('timeout', `Tavily ${label} 请求超时，请稍后重试。`, true);
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|socket hang up/i.test(message)) {
    return new TavilyError(
      'network',
      `Tavily ${label} 网络请求失败（${message}），请检查网络后重试。`,
      true,
    );
  }
  return undefined;
}

/** Build the stable cancellation error, preserving the caller's abort reason. */
export function abortedError(label: string, signal?: AbortSignal): TavilyError {
  const reason = signal?.reason;
  const detail = reason instanceof Error ? `：${reason.message}` : '';
  return new TavilyError('aborted', `Tavily ${label} 已被取消${detail}。`, false);
}

/**
 * Translate any failure into a `TavilyError`.
 *
 * @param error - whatever the SDK (or a direct fetch) threw.
 * @param label - the operation name used in the Chinese sentence.
 * @returns the classified error; already-classified errors pass through.
 */
export function toTavilyError(error: unknown, label: string): TavilyError {
  if (error instanceof TavilyError) return error;

  // Structured keyless throttle: cap type and retry hint survive.
  if (error instanceof TavilyKeylessLimitError) {
    const retry =
      error.retryAfter !== null && error.retryAfter > 0
        ? `请等待约 ${error.retryAfter} 秒，或`
        : '';
    const bonus = error.bonusEligible ? '（该账号可领取免费额度）' : '';
    return new TavilyError(
      'keyless_limit',
      `Tavily 免密额度已用尽（${error.capType}）${bonus}。${retry}前往${CONFIG_LOCATION}配置 API Key 以获得稳定额度。`,
      false,
    );
  }

  const err = (error ?? {}) as AxiosLikeError;
  const status = err.response?.status;
  const detail = errorDetail(err.response?.data) || (typeof err.message === 'string' ? err.message : '');

  if (err.code === 'ECONNABORTED') {
    return new TavilyError('timeout', `Tavily ${label} 请求超时，请稍后重试。`, true, status);
  }

  // The status survived (our own fetch, or an axios error object): trust it.
  if (status !== undefined) return mapStatus(status, errorDetail(err.response?.data), label);

  // The SDK path: no status left, so fall back to the message text.
  const classified = classifyMessage(detail, label);
  if (classified) return classified;

  return new TavilyError(
    'unknown',
    `Tavily ${label} 失败${detail ? `（${detail}）` : ''}。请稍后重试，若持续失败请检查网络与 Key。`,
    false,
  );
}

/**
 * Race an SDK call against caller cancellation.
 *
 * `@tavily/core` accepts no `AbortSignal` (verified against 0.7.14: the symbol
 * appears nowhere in its types or runtime), yet `ctx.web` providers must honor
 * cancellation. The race settles the caller immediately; the settlement
 * handlers stay attached so a later rejection from the abandoned request
 * cannot become an unhandled rejection.
 *
 * @param operation - the in-flight SDK promise.
 * @param signal - the caller's cancellation signal, when any.
 * @param label - the operation name used in the cancellation message.
 * @returns the operation's value, or rejects with the cancellation error.
 */
export function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (signal === undefined) return operation;
  // The operation has ALREADY started (it is an eagerly-evaluated argument),
  // so every early return must still observe its settlement: an abandoned SDK
  // promise that rejects unhandled would take the whole host process down.
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  if (signal.aborted) {
    void settled;
    return Promise.reject(abortedError(label, signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(label, signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
