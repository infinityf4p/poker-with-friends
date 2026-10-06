import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 44291;
let child;
test.before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, POKER_BRIDGE_PORT: String(port) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('bridge did not start');
});
test.after(() => child?.kill());

test('accepts only a sanitized Poker snapshot', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: 'https://poker.infinityf4p.com',
      url: 'https://poker.infinityf4p.com/room/demo?password=secret',
      title: 'Poker',
      visibleText: '账号或密码错误',
      errorMessages: ['账号或密码错误'],
      buttons: ['登录'],
      password: 'must-not-be-kept',
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.snapshot.visibleText, '账号或密码错误');
  assert.equal(body.snapshot.url, 'https://poker.infinityf4p.com/room/demo');
  assert.equal('password' in body.snapshot, false);
});

test('rejects an unrelated origin', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: 'https://example.com', visibleText: 'secret' }),
  });
  assert.equal(response.status, 400);
});

test('rejects browser requests from unrelated websites', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { origin: 'https://example.com' },
  });
  assert.equal(response.status, 403);
});
