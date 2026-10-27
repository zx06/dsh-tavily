/**
 * The plugin's JSON API, mounted at `/api/tavily`.
 *
 * The configuration panel owns the richer surface (key validation, quota, audit
 * table) that a schema-derived form cannot express, so it needs routes of its
 * own. They are registered as a `prefix` route on `ctx.webServer`; because the
 * webserver picks the LONGEST matching prefix, `/api/tavily` wins over the
 * shared connection channel's `/api` without touching it.
 *
 * Two rules govern this module:
 *
 * 1. **The key never leaves.** `/summary` returns a mask and a source label;
 *    no route ever echoes the stored value. Writes flow one way, in.
 * 2. **Handlers own the full response.** `WebRoute.handler` is
 *    `(req: IncomingMessage, res: ServerResponse) => void | Promise<void>` —
 *    NOT a fetch-style `(Request) => Response`. Every path writes a status and
 *    ends the response.
 *
 * @module routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TavilyClient, TavilyError, toTavilyError } from '@dsh-plugins/plugin-kit';
import { listMonthsAsync, monthStatsAsync, readAuditAsync, type AuditQuery } from './audit-store.js';

export const ROUTE_PREFIX = '/api/tavily';

/** Max audit rows a single read may return. */
const MAX_AUDIT_LIMIT = 200;

export interface RouteDeps {
  /** Resolve the current key and its provenance for `/summary`. */
  resolveKey: () => Promise<{
    ok: boolean;
    apiKey?: string;
    source: string;
    masked?: string;
    ref: string;
  }>;
  /** Whether keyless mode is enabled. */
  allowKeyless: () => boolean;
  /** Build a client from an explicit candidate key (validation, usage). */
  clientFor: (apiKey: string) => TavilyClient;
  /** Persist a validated key through the credential store. */
  saveKey: (ref: string, apiKey: string) => Promise<void>;
  /** Remove the stored key. */
  clearKey: (ref: string) => Promise<void>;
  /** Audit directory in use. */
  dataDir: () => string;
}

/** Write one JSON response and end it. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** Read a request body with a hard cap; returns {} on anything unusable. */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) return {};
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Map a failure onto an HTTP status plus a stable code. */
function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  const err = error instanceof TavilyError ? error : toTavilyError(error, '额度查询');
  const status =
    err.code === 'invalid_api_key'
      ? 401
      : err.code === 'bad_request' || err.code === 'missing_api_key'
        ? 400
        : err.code === 'rate_limited'
          ? 429
          : 502;
  return { status, body: { ok: false, error: err.message, code: err.code } };
}

/**
 * Build the `/api/tavily` handler.
 *
 * @param deps - the plugin's live accessors.
 * @returns the node:http handler to register on the webserver.
 */
export function createHandler(deps: RouteDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/tavily/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      if (path === '/summary' && method === 'GET') {
        const key = await deps.resolveKey();
        const dir = deps.dataDir();
        json(res, 200, {
          configured: key.ok,
          keySource: key.source,
          maskedKey: key.masked,
          keyRef: key.ref,
          keyless: deps.allowKeyless(),
          stats: await monthStatsAsync(undefined, dir),
          months: await listMonthsAsync(dir),
          dashboardUrl: 'https://app.tavily.com/home',
        });
        return;
      }

      if (path === '/usage' && method === 'GET') {
        const key = await deps.resolveKey();
        if (!key.ok || !key.apiKey) {
          json(res, 400, {
            ok: false,
            code: 'missing_api_key',
            error: '未配置 API Key，无法查询额度。',
          });
          return;
        }
        try {
          const usage = await deps.clientFor(key.apiKey).usage();
          json(res, 200, { ok: true, usage });
        } catch (error) {
          const mapped = errorResponse(error);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      if (path === '/audit' && method === 'GET') {
        const dir = deps.dataDir();
        const rawLimit = Number(url.searchParams.get('limit') ?? 50);
        const query: AuditQuery = {
          month: url.searchParams.get('month') ?? undefined,
          datePrefix: url.searchParams.get('date') ?? undefined,
          keyword: url.searchParams.get('q') ?? undefined,
          limit: Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_AUDIT_LIMIT) : 50,
        };
        json(res, 200, {
          ok: true,
          entries: await readAuditAsync(query, dir),
          months: await listMonthsAsync(dir),
        });
        return;
      }

      if (path === '/key' && method === 'POST') {
        const body = await readJsonBody(req);
        const candidate = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (!candidate) {
          json(res, 400, { ok: false, code: 'bad_request', error: 'API Key 不能为空。' });
          return;
        }
        const current = await deps.resolveKey();
        // Validate BEFORE persisting: a lightweight usage call is the cheapest
        // authenticated request that proves the key works.
        try {
          await deps.clientFor(candidate).usage();
        } catch (error) {
          const mapped = errorResponse(error);
          json(res, mapped.status, { ...mapped.body, saved: false });
          return;
        }
        try {
          await deps.saveKey(current.ref, candidate);
        } catch (error) {
          json(res, 500, {
            ok: false,
            code: 'save_failed',
            error: `Key 有效，但保存失败：${error instanceof Error ? error.message : String(error)}`,
            saved: false,
          });
          return;
        }
        // Return the mask only — never the value that was just written.
        const masked = candidate.length > 12
          ? `${candidate.slice(0, 8)}...${candidate.slice(-4)}`
          : '****';
        json(res, 200, { ok: true, maskedKey: masked, keyRef: current.ref });
        return;
      }

      if (path === '/key' && method === 'DELETE') {
        const current = await deps.resolveKey();
        try {
          await deps.clearKey(current.ref);
        } catch (error) {
          json(res, 500, {
            ok: false,
            code: 'clear_failed',
            error: `清除失败：${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, code: 'not_found', error: `未知路径：${path}` });
    } catch (error) {
      // A thrown handler would leave the socket hanging; always answer.
      json(res, 500, {
        ok: false,
        code: 'internal',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
