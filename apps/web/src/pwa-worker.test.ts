import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface WorkerRequest {
  method: string;
  url: string;
  mode: string;
  destination: string;
}

interface FetchEvent {
  request: WorkerRequest;
  respondWith: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}

function loadFetchHandler(options?: {
  contentType?: string;
  cacheError?: boolean;
  fetchError?: boolean;
  cachedResponse?: Response;
}) {
  const handlers = new Map<string, (event: FetchEvent) => void>();
  const put = options?.cacheError
    ? vi.fn().mockRejectedValue(new Error('cache unavailable'))
    : vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockResolvedValue({ put });
  const response = new Response('body', {
    status: 200,
    headers: { 'content-type': options?.contentType ?? 'application/javascript' },
  });
  const fetch = options?.fetchError
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue(response);
  const match = vi.fn().mockResolvedValue(options?.cachedResponse);
  const source = readFileSync(new URL('../public/pwa-worker.js', import.meta.url), 'utf8');

  runInNewContext(source, {
    URL,
    Response,
    Promise,
    fetch,
    caches: {
      open,
      keys: vi.fn().mockResolvedValue([]),
      match,
      delete: vi.fn(),
    },
    self: {
      location: { origin: 'https://poker.example' },
      clients: { claim: vi.fn() },
      skipWaiting: vi.fn(),
      addEventListener: (type: string, handler: (event: FetchEvent) => void) => {
        handlers.set(type, handler);
      },
    },
  });

  const handler = handlers.get('fetch');
  if (!handler) throw new Error('fetch handler was not registered');
  return { handler, fetch, open, put, match };
}

function request(path: string, destination = ''): WorkerRequest {
  return {
    method: 'GET',
    url: `https://poker.example${path}`,
    mode: 'cors',
    destination,
  };
}

describe('PWA fetch boundary', () => {
  it.each(['/api/auth/session', '/api/rooms/room-id', '/socket.io/', '/health/ready'])(
    'leaves private or realtime request %s on the network',
    (path) => {
      const { handler, fetch, open } = loadFetchHandler();
      const respondWith = vi.fn();
      const waitUntil = vi.fn();

      handler({ request: request(path), respondWith, waitUntil });

      expect(respondWith).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('caches a valid static script response', async () => {
    const { handler, put } = loadFetchHandler();
    const respondWith = vi.fn();
    const waitUntil = vi.fn();
    const scriptRequest = request('/assets/app.js', 'script');

    handler({ request: scriptRequest, respondWith, waitUntil });
    const responsePromise = respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await responsePromise;
    const cachePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await cachePromise;

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe(scriptRequest);
  });

  it('does not cache HTML accidentally returned for a script path', async () => {
    const { handler, put } = loadFetchHandler({ contentType: 'text/html' });
    const respondWith = vi.fn();
    const waitUntil = vi.fn();

    handler({ request: request('/assets/missing.js', 'script'), respondWith, waitUntil });
    const responsePromise = respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await responsePromise;

    expect(waitUntil).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('returns the network response even when Cache Storage rejects the update', async () => {
    const { handler } = loadFetchHandler({ cacheError: true });
    const respondWith = vi.fn();
    const waitUntil = vi.fn();

    handler({ request: request('/assets/app.js', 'script'), respondWith, waitUntil });
    const networkResponse = await (respondWith.mock.calls[0]?.[0] as Promise<Response>);
    await (waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(networkResponse.status).toBe(200);
  });

  it('returns an explicit 503 when offline navigation has no cached shell', async () => {
    const { handler, match } = loadFetchHandler({ fetchError: true });
    const respondWith = vi.fn();
    const waitUntil = vi.fn();
    const navigation = { ...request('/room/example'), mode: 'navigate' };

    handler({ request: navigation, respondWith, waitUntil });
    const response = await (respondWith.mock.calls[0]?.[0] as Promise<Response>);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Offline');
    expect(match).toHaveBeenCalledWith('/index.html');
  });
});
