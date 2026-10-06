// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_SETTINGS } from '@poker-with-friends/protocol';
import type { InvitePreview, JoinResponse, LobbyRoomSummary, UserSession } from '../api';
import { LobbyPage } from './LobbyPage';
import { JoinPage } from './JoinPage';

const { request, navigate } = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn() }));
vi.mock('../api', () => ({ api: request }));
vi.mock('../navigation', () => ({ navigate }));

const user: UserSession = {
  id: 'test-user',
  username: 'test-user',
  displayName: 'Test Player',
  mustChangePassword: false,
};

function room(id: string, changes: Partial<LobbyRoomSummary> = {}): LobbyRoomSummary {
  return {
    roomId: id,
    name: id,
    mode: 'ONLINE',
    status: 'LOBBY',
    handNumber: 0,
    settings: { ...DEFAULT_ROOM_SETTINGS, mode: 'ONLINE' },
    playerCount: 0,
    availableSeats: 6,
    players: [],
    membership: null,
    ...changes,
  };
}

function preview(id: string): InvitePreview {
  return { ...room(id), nicknames: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request.mockReset();
  navigate.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

describe('lobby room selection', () => {
  it('combines mode and availability filters while retaining a full room already joined', async () => {
    const rooms = [
      room('online-open'),
      room('live-open', { mode: 'LIVE' }),
      room('full', { availableSeats: 0 }),
      room('blocked', {
        membership: {
          playerId: 'kicked',
          nickname: 'Test',
          seat: null,
          stack: 0,
          status: 'KICKED',
        },
      }),
      room('joined-full', {
        availableSeats: 0,
        membership: { playerId: 'member', nickname: 'Test', seat: 0, stack: 100, status: 'ACTIVE' },
      }),
    ];
    request.mockImplementation(async (path: string) =>
      path === '/api/auth/session' ? user : rooms,
    );
    await act(async () => root.render(<LobbyPage />));
    expect(container.querySelectorAll('[data-room-id]')).toHaveLength(5);

    await act(async () => button('线上').click());
    expect(container.querySelectorAll('[data-room-id]')).toHaveLength(4);
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(
      [...container.querySelectorAll('[data-room-id]')].map((item) =>
        item.getAttribute('data-room-id'),
      ),
    ).toEqual(['online-open', 'joined-full']);

    await act(async () => button('线下').click());
    expect(container.querySelector('[data-room-id]')?.getAttribute('data-room-id')).toBe(
      'live-open',
    );
  });

  it('serializes attempts across different rooms and releases controls after a failed attempt', async () => {
    const attempt = deferred<JoinResponse>();
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(user);
      if (path === '/api/rooms') return Promise.resolve([room('first'), room('second')]);
      return attempt.promise;
    });
    await act(async () => root.render(<LobbyPage />));
    const first = container.querySelector<HTMLButtonElement>('[data-testid="join-room-first"]')!;
    const second = container.querySelector<HTMLButtonElement>('[data-testid="join-room-second"]')!;
    await act(async () => {
      first.click();
      second.click();
    });
    expect(request.mock.calls.filter(([path]) => path.endsWith('/enter'))).toHaveLength(1);
    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(true);

    await act(async () => attempt.reject(new Error('牌桌已满')));
    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('牌桌已满');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the latest refreshed list when an older request finishes later', async () => {
    const older = deferred<LobbyRoomSummary[]>();
    const newer = deferred<LobbyRoomSummary[]>();
    let listRequests = 0;
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(user);
      listRequests += 1;
      if (listRequests === 1) return Promise.resolve([room('initial')]);
      return listRequests === 2 ? older.promise : newer.promise;
    });
    await act(async () => root.render(<LobbyPage />));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => newer.resolve([room('latest')]));
    await act(async () => older.resolve([room('stale')]));
    expect(container.querySelector('[data-room-id]')?.getAttribute('data-room-id')).toBe('latest');
  });

  it('locks room entry while signing out and returns to a clean login state', async () => {
    const signOut = deferred<void>();
    const staleList = deferred<LobbyRoomSummary[]>();
    let listRequests = 0;
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(user);
      if (path === '/api/auth/logout') return signOut.promise;
      listRequests += 1;
      return listRequests === 1 ? Promise.resolve([room('initial')]) : staleList.promise;
    });
    await act(async () => root.render(<LobbyPage />));
    await act(async () => window.dispatchEvent(new Event('focus')));
    const signOutButton = container.querySelector<HTMLButtonElement>('[aria-label="退出登录"]')!;
    const join = container.querySelector<HTMLButtonElement>('[data-testid="join-room-initial"]')!;
    await act(async () => {
      signOutButton.click();
      join.click();
      signOutButton.click();
    });
    expect(join.disabled).toBe(true);
    expect(request.mock.calls.filter(([path]) => path === '/api/auth/logout')).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => path.endsWith('/enter'))).toBe(false);
    await act(async () => signOut.resolve());
    await act(async () => staleList.reject(new Error('Old session expired')));
    expect(container.querySelector('h1')?.textContent).toBe('登录');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('administrator sign-in recovery', () => {
  it('tries the admin endpoint only after an unauthorized player login and redirects to admin', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.reject(new Error('no player session'));
      if (path === '/api/auth/login')
        return Promise.reject({ status: 401, message: '账号或密码错误' });
      if (path === '/api/admin/login')
        return Promise.resolve({ id: 'admin-id', username: 'admin', displayName: '管理员' });
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => root.render(<LobbyPage />));
    const setInput = (name: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setInput('username', 'admin');
      setInput('password', 'secret-password');
    });

    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/auth/session',
      '/api/auth/login',
      '/api/admin/login',
    ]);
    expect(navigate).toHaveBeenCalledWith('/admin');
    expect(container.textContent).not.toContain('secret-password');
  });

  it('does not call the admin endpoint for non-401 player login failures', async () => {
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.reject(new Error('no player session'));
      if (path === '/api/auth/login')
        return Promise.reject({ status: 429, message: '请求过于频繁' });
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => root.render(<LobbyPage />));
    const setInput = (name: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setInput('username', 'player');
      setInput('password', 'secret-password');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/auth/session',
      '/api/auth/login',
    ]);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('invitation request lifecycle', () => {
  it('ignores a previous invitation response after the token changes', async () => {
    const oldPreview = deferred<InvitePreview>();
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(user);
      if (path.includes('/old/')) return oldPreview.promise;
      return Promise.resolve(preview('new-table'));
    });
    await act(async () => root.render(<JoinPage token="old" />));
    await act(async () => root.render(<JoinPage token="new" />));
    expect(container.querySelector('h1')?.textContent).toBe('new-table');

    await act(async () => oldPreview.resolve(preview('old-table')));
    expect(container.querySelector('h1')?.textContent).toBe('new-table');
  });

  it('prevents duplicate joins and ignores an obsolete join redirect', async () => {
    const attempt = deferred<JoinResponse>();
    request.mockImplementation((path: string) => {
      if (path === '/api/auth/session') return Promise.resolve(user);
      if (path.endsWith('/join')) return attempt.promise;
      return Promise.resolve(preview(path.includes('/old/') ? 'old-table' : 'new-table'));
    });
    await act(async () => root.render(<JoinPage token="old" />));
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(request.mock.calls.filter(([path]) => path.endsWith('/join'))).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('form button')?.disabled).toBe(true);

    await act(async () => root.render(<JoinPage token="new" />));
    await act(async () => attempt.resolve({ roomId: 'old-table', playerId: 'test-player' }));
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe('new-table');
  });
});
