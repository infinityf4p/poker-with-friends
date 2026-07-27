const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresSameOrigin(method: string): boolean {
  return !SAFE_HTTP_METHODS.has(method.toUpperCase());
}

/**
 * Browsers send Origin for cross-origin writes and realtime handshakes.
 * Whether a request without Origin is acceptable is the caller's policy
 * (`allowMissingOrigin`): development/test tooling and trusted non-browser
 * clients need it, production defaults to rejecting.
 */
export function isAllowedBrowserOrigin(
  origin: string | undefined,
  publicOrigin: string,
  allowMissingOrigin = false,
): boolean {
  if (origin === undefined) return allowMissingOrigin;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === publicOrigin;
  } catch {
    return false;
  }
}
