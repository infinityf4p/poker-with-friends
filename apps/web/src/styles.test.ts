import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('table seat interaction styles', () => {
  it('keeps the positioned seat under the pointer while it is pressed', () => {
    expect(css).toMatch(
      /\.table-seat--empty:active:not\(:disabled\)\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)\s*scale\(0\.97\)/s,
    );
  });
});

describe('responsive layout safeguards', () => {
  it('lets the lobby grid adapt continuously instead of forcing tablet widths to one column', () => {
    expect(css).toMatch(
      /\.lobby-room-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*340px\),\s*1fr\)\)/s,
    );
    expect(css).not.toMatch(
      /@media\s*\(max-width:\s*919px\)[\s\S]*?\.lobby-room-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it('provides a compact two-column table layout for short landscape screens', () => {
    expect(css).toMatch(
      /@media\s*\(orientation:\s*landscape\)[^{]*\(max-height:\s*500px\)[^{]*\{[\s\S]*?\.real-table-layout\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:/,
    );
  });

  it('accounts for device safe areas in shared page and table containers', () => {
    expect(css).toMatch(/\.page-container\s*\{[^}]*env\(safe-area-inset-left\)/s);
    expect(css).toMatch(/\.real-table-layout\s*\{[^}]*env\(safe-area-inset-right\)/s);
  });

  it('keeps short login screens scrollable', () => {
    expect(css).toMatch(/\.login-page\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/@media\s*\(max-height:\s*700px\)[\s\S]*?place-items:\s*start center/);
  });

  it('wraps multi-winner settlements inside the narrow table width', () => {
    expect(css).toMatch(/\.settlement-banner\s*\{[^}]*width:\s*min\(86%,\s*460px\)/s);
    expect(css).toMatch(
      /\.settlement-banner__winners\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(88px,\s*1fr\)\)/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.settlement-banner__winners\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it('gives both lobby actions the full mobile card width without clipping status text', () => {
    expect(css).toMatch(
      /footer:has\(\.lobby-room-actions > button \+ button\)[\s\S]*?\.room-membership-copy\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /footer:has\(\.lobby-room-actions > button \+ button\)\s+\.lobby-room-actions\s*\{[^}]*display:\s*grid[^}]*width:\s*100%[^}]*grid-template-columns:/s,
    );
  });
});

describe('interaction accessibility safeguards', () => {
  it('shows keyboard focus around the composed wager input', () => {
    expect(css).toMatch(/\.amount-input:focus-within\s*\{[^}]*outline:\s*3px/s);
  });

  it('does not animate success messages to invisible before their timer expires', () => {
    expect(css).toMatch(/\.success-box\s*\{[^}]*animation:\s*notice-in/s);
    expect(css).not.toContain('@keyframes fade-notice');
  });

  it('keeps table preference controls touch-sized on mobile', () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.table-view-controls button\s*\{[^}]*min-height:\s*44px/,
    );
  });
});
