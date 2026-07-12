import { describe, expect, it } from 'vitest';
import { isAllowedBrowserOrigin, requiresSameOrigin } from './origin.js';

describe('browser origin protection', () => {
  const publicOrigin = 'https://poker.example.com';

  it('allows the configured origin and trusted non-browser clients', () => {
    expect(isAllowedBrowserOrigin(publicOrigin, publicOrigin)).toBe(true);
    expect(isAllowedBrowserOrigin(undefined, publicOrigin)).toBe(true);
  });

  it('rejects sibling domains, opaque origins, and non-origin URLs', () => {
    expect(isAllowedBrowserOrigin('https://evil.example.com', publicOrigin)).toBe(false);
    expect(isAllowedBrowserOrigin('null', publicOrigin)).toBe(false);
    expect(isAllowedBrowserOrigin(`${publicOrigin}/path`, publicOrigin)).toBe(false);
  });

  it('protects state-changing methods while leaving reads available', () => {
    expect(requiresSameOrigin('POST')).toBe(true);
    expect(requiresSameOrigin('DELETE')).toBe(true);
    expect(requiresSameOrigin('GET')).toBe(false);
    expect(requiresSameOrigin('HEAD')).toBe(false);
  });
});
