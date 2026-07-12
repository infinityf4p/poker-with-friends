const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresSameOrigin(method: string): boolean {
  return !SAFE_HTTP_METHODS.has(method.toUpperCase());
}

/**
 * Browsers send Origin for cross-origin writes and realtime handshakes. Requests
 * without Origin remain available to trusted non-browser clients and health tools.
 */
export function isAllowedBrowserOrigin(origin: string | undefined, publicOrigin: string): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === publicOrigin;
  } catch {
    return false;
  }
}
