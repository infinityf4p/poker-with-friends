import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PWA manifest', () => {
  it('follows the device orientation instead of forcing portrait mode', () => {
    const source = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source) as { orientation?: string };

    expect(manifest.orientation).toBe('any');
  });
});
