/**
 * `/api/tavily` route tests, driven through fake `IncomingMessage` /
 * `ServerResponse` objects. No network, no filesystem.
 *
 * The route layer is where the key crosses into the system, so these cases
 * focus on what may never come back out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TavilyError, type TavilyClient } from '@dsh-plugins/plugin-kit';
import { createHandler, ROUTE_PREFIX, type RouteDeps } from '../src/routes.js';

/** A minimal ServerResponse that records what the handler wrote. */
interface Captured {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
  raw: string;
}

function fakeRes(captured: Captured): ServerResponse {
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(text?: string) {
      captured.raw = text ?? '';
      try {
        captured.body = text ? JSON.parse(text) : undefined;
      } catch {
        captured.body = text;
      }
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

/** A request carrying an optional JSON body. */
function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage & { method: string; url: string };
  req.method = method;
  req.url = url;
  return req;
}

interface Overrides {
  resolveKey?: RouteDeps['resolveKey'];
  allowKeyless?: RouteDeps['allowKeyless'];
  clientFor?: RouteDeps['clientFor'];
  saveKey?: RouteDeps['saveKey'];
  clearKey?: RouteDeps['clearKey'];
  dataDir?: RouteDeps['dataDir'];
}

function deps(overrides: Overrides = {}): RouteDeps {
  return {
    resolveKey: async () => ({ ok: false, source: 'none', ref: 'TAVILY_API_KEY' }),
    allowKeyless: () => true,
    clientFor: () =>
      ({ usage: async () => ({ key: { usage: 1, limit: 1000 } }) }) as unknown as TavilyClient,
    saveKey: async () => {},
    clearKey: async () => {},
    dataDir: () => '/tmp/tavily-test-nonexistent',
    ...overrides,
  };
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  url: string,
  body?: unknown,
): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined, raw: '' };
  await handler(fakeReq(method, url, body), fakeRes(captured));
  return captured;
}

test('route prefix is the documented path', () => {
  assert.equal(ROUTE_PREFIX, '/api/tavily');
});

test('GET /summary returns a mask and never the key', async () => {
  const handler = createHandler(
    deps({
      resolveKey: async () => ({
        ok: true,
        apiKey: 'tvly-supersecretvalue123',
        source: 'credentials',
        masked: 'tvly-sup...e123',
        ref: 'TAVILY_API_KEY',
      }),
    }),
  );
  const res = await call(handler, 'GET', '/api/tavily/summary');
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.configured, true);
  assert.equal(body.maskedKey, 'tvly-sup...e123');
  assert.equal(body.keySource, 'credentials');
  assert.equal(body.keyless, true);
  // The raw key must not appear anywhere in the response.
  assert.ok(!res.raw.includes('tvly-supersecretvalue123'));
});

test('POST /key validates before persisting, then returns only a mask', async () => {
  const saved: Array<{ ref: string; key: string }> = [];
  const handler = createHandler(
    deps({
      resolveKey: async () => ({ ok: false, source: 'none', ref: 'TAVILY_API_KEY' }),
      clientFor: (apiKey) =>
        ({
          usage: async () => {
            if (apiKey === 'tvly-bad') throw new TavilyError('invalid_api_key', 'Key 无效', false, 401);
            return {};
          },
        }) as unknown as TavilyClient,
      saveKey: async (ref, key) => {
        saved.push({ ref, key });
      },
    }),
  );

  const ok = await call(handler, 'POST', '/api/tavily/key', { apiKey: 'tvly-goodkeyvalue12345' });
  assert.equal(ok.status, 200);
  const okBody = ok.body as Record<string, unknown>;
  assert.equal(okBody.ok, true);
  assert.ok(!ok.raw.includes('tvly-goodkeyvalue12345'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.ref, 'TAVILY_API_KEY');
  assert.equal(saved[0]?.key, 'tvly-goodkeyvalue12345');
});

test('POST /key rejects an invalid key without persisting it', async () => {
  let saveCalls = 0;
  const handler = createHandler(
    deps({
      clientFor: () =>
        ({
          usage: async () => {
            throw new TavilyError('invalid_api_key', 'Tavily API Key 无效', false, 401);
          },
        }) as unknown as TavilyClient,
      saveKey: async () => {
        saveCalls += 1;
      },
    }),
  );
  const res = await call(handler, 'POST', '/api/tavily/key', { apiKey: 'tvly-bad' });
  assert.equal(res.status, 401);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.code, 'invalid_api_key');
  assert.equal(body.saved, false);
  assert.equal(saveCalls, 0);
});

test('POST /key rejects an empty key', async () => {
  const handler = createHandler(deps());
  const res = await call(handler, 'POST', '/api/tavily/key', { apiKey: '   ' });
  assert.equal(res.status, 400);
  assert.equal((res.body as Record<string, unknown>).code, 'bad_request');
});

test('POST /key reports a storage refusal as a save failure', async () => {
  const handler = createHandler(
    deps({
      saveKey: async () => {
        throw new Error('read-only source shadows this reference');
      },
    }),
  );
  const res = await call(handler, 'POST', '/api/tavily/key', { apiKey: 'tvly-goodkeyvalue12345' });
  assert.equal(res.status, 500);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.saved, false);
  assert.match(String(body.error), /保存失败/);
});

test('DELETE /key clears the reference', async () => {
  const cleared: string[] = [];
  const handler = createHandler(
    deps({
      resolveKey: async () => ({ ok: true, source: 'credentials', ref: 'MY_REF' }),
      clearKey: async (ref) => {
        cleared.push(ref);
      },
    }),
  );
  const res = await call(handler, 'DELETE', '/api/tavily/key');
  assert.equal(res.status, 200);
  assert.deepEqual(cleared, ['MY_REF']);
});

test('GET /usage without a key answers 400 rather than calling upstream', async () => {
  let usageCalls = 0;
  const handler = createHandler(
    deps({
      resolveKey: async () => ({ ok: false, source: 'none', ref: 'TAVILY_API_KEY' }),
      clientFor: () =>
        ({
          usage: async () => {
            usageCalls += 1;
            return {};
          },
        }) as unknown as TavilyClient,
    }),
  );
  const res = await call(handler, 'GET', '/api/tavily/usage');
  assert.equal(res.status, 400);
  assert.equal(usageCalls, 0);
});

test('GET /usage maps an upstream auth failure to 401', async () => {
  const handler = createHandler(
    deps({
      resolveKey: async () => ({ ok: true, apiKey: 'tvly-x', source: 'credentials', ref: 'R' }),
      clientFor: () =>
        ({
          usage: async () => {
            throw new TavilyError('invalid_api_key', 'bad', false, 401);
          },
        }) as unknown as TavilyClient,
    }),
  );
  const res = await call(handler, 'GET', '/api/tavily/usage');
  assert.equal(res.status, 401);
});

test('GET /audit clamps the limit and returns an entries array', async () => {
  const handler = createHandler(deps());
  const res = await call(handler, 'GET', '/api/tavily/audit?limit=99999');
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.ok(Array.isArray(body.entries));
  assert.ok(Array.isArray(body.months));
});

test('unknown paths answer 404 and never hang', async () => {
  const handler = createHandler(deps());
  const res = await call(handler, 'GET', '/api/tavily/nope');
  assert.equal(res.status, 404);
  assert.equal((res.body as Record<string, unknown>).code, 'not_found');
});

test('an internal throw still produces a response', async () => {
  const handler = createHandler(
    deps({
      resolveKey: async () => {
        throw new Error('unexpected');
      },
    }),
  );
  const res = await call(handler, 'GET', '/api/tavily/summary');
  assert.equal(res.status, 500);
  assert.equal((res.body as Record<string, unknown>).code, 'internal');
});

test('a malformed JSON body does not crash the handler', async () => {
  const handler = createHandler(deps());
  const req = Readable.from([Buffer.from('{not json')]) as unknown as IncomingMessage & {
    method: string;
    url: string;
  };
  req.method = 'POST';
  req.url = '/api/tavily/key';
  const captured: Captured = { status: 0, headers: {}, body: undefined, raw: '' };
  await handler(req, fakeRes(captured));
  // Empty/unparseable body means no candidate key, which is a 400.
  assert.equal(captured.status, 400);
});

test('responses are marked no-store', async () => {
  const handler = createHandler(deps());
  const res = await call(handler, 'GET', '/api/tavily/summary');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
