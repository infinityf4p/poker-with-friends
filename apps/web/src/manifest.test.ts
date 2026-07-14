import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PWA manifest', () => {
  it('uses the canonical product name', () => {
    const source = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source) as { name?: string; short_name?: string };

    expect(manifest.name).toBe('Poker with Friends');
    expect(manifest.short_name).toBe('Poker with Friends');
  });

  it('follows the device orientation instead of forcing portrait mode', () => {
    const source = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source) as { orientation?: string };

    expect(manifest.orientation).toBe('any');
  });
});
