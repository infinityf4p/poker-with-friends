import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const userInterfaceSource = [
  new URL('./App.tsx', import.meta.url),
  new URL('./poker-ui.ts', import.meta.url),
  new URL('./use-room.ts', import.meta.url),
]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('product copy', () => {
  it('does not reintroduce promotional or conversational phrases', () => {
    const disallowed = [
      'PLAY TOGETHER',
      '朋友到齐',
      '挑一桌',
      '组局小助手',
      '今晚就从这里开始',
      '大家重新点一下准备',
      '结果还没商量好',
      '我来开桌',
      '下手休息',
      '我准备好了',
      '牌局回放',
      '行动令牌',
    ];

    for (const phrase of disallowed) expect(userInterfaceSource).not.toContain(phrase);
  });

  it('uses 牌桌 instead of 房间 in current interface copy', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const connection = readFileSync(new URL('./use-room.ts', import.meta.url), 'utf8');

    expect(app).not.toContain('房间');
    expect(connection).not.toContain('房间');
  });
});
