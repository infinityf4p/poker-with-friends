import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isAllowedRealtimeRequest } from './socket.js';

const publicOrigin = 'https://poker.example.com';

function request(
  options: {
    method?: string;
    url?: string;
    origin?: string;
    fetchSite?: string;
    upgrade?: string;
  } = {},
): Pick<IncomingMessage, 'headers' | 'method' | 'url'> {
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/socket.io/?EIO=4&transport=polling',
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
      ...(options.upgrade ? { upgrade: options.upgrade } : {}),
    },
  };
}

describe('Socket.IO request origin protection', () => {
  it('allows a strict-mode same-origin polling GET when the browser omits Origin', () => {
    expect(
      isAllowedRealtimeRequest(request({ fetchSite: 'same-origin' }), publicOrigin, false),
    ).toBe(true);
  });

  it('rejects missing-Origin WebSocket handshakes even with same-origin Fetch Metadata', () => {
    expect(
      isAllowedRealtimeRequest(
        request({
          url: '/socket.io/?EIO=4&transport=websocket',
          fetchSite: 'same-origin',
          upgrade: 'websocket',
        }),
        publicOrigin,
        false,
      ),
    ).toBe(false);
  });

  it('rejects cross-site and unverifiable missing-Origin polling requests in strict mode', () => {
    expect(
      isAllowedRealtimeRequest(request({ fetchSite: 'cross-site' }), publicOrigin, false),
    ).toBe(false);
    expect(isAllowedRealtimeRequest(request(), publicOrigin, false)).toBe(false);
    expect(
      isAllowedRealtimeRequest(
        request({ method: 'POST', fetchSite: 'same-origin' }),
        publicOrigin,
        false,
      ),
    ).toBe(false);
  });

  it('still validates an explicit Origin in both strict and permissive modes', () => {
    expect(
      isAllowedRealtimeRequest(
        request({
          url: '/socket.io/?EIO=4&transport=websocket',
          origin: publicOrigin,
          upgrade: 'websocket',
        }),
        publicOrigin,
        false,
      ),
    ).toBe(true);
    expect(
      isAllowedRealtimeRequest(request({ origin: 'https://evil.example.com' }), publicOrigin, true),
    ).toBe(false);
  });

  it('keeps the explicit development escape hatch for requests without Origin', () => {
    expect(isAllowedRealtimeRequest(request(), publicOrigin, true)).toBe(true);
  });
});
