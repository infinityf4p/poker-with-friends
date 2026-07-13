import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('table seat interaction styles', () => {
  it('keeps the positioned seat under the pointer while it is pressed', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.table-seat--empty:active:not\(:disabled\)\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)\s*scale\(0\.97\)/s,
    );
  });
});
