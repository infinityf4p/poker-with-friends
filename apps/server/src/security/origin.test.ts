import { describe, expect, it } from 'vitest';
import { isAllowedBrowserOrigin, requiresSameOrigin } from './origin.js';

describe('browser origin protection', () => {
  const publicOrigin = 'https://poker.example.com';

  it('allows the configured origin and requires an explicit opt-in for non-browser clients', () => {
    expect(isAllowedBrowserOrigin(publicOrigin, publicOrigin)).toBe(true);
    expect(isAllowedBrowserOrigin(undefined, publicOrigin)).toBe(false);
    expect(isAllowedBrowserOrigin(undefined, publicOrigin, true)).toBe(true);
  });

  it('rejects requests without an Origin header when the policy is fail-closed', () => {
    expect(isAllowedBrowserOrigin(undefined, publicOrigin, false)).toBe(false);
    expect(isAllowedBrowserOrigin(undefined, publicOrigin, true)).toBe(true);
    expect(isAllowedBrowserOrigin(publicOrigin, publicOrigin, false)).toBe(true);
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
