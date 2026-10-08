// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUserSummary } from '../api';
import { AdminPage } from './AdminPage';
import { LobbyPage } from './LobbyPage';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api', () => ({ api: request }));
vi.mock('../navigation', () => ({ navigate: vi.fn() }));

const user: AdminUserSummary = {
  id: 'player-id',
  username: 'alice',
  displayName: 'Alice',
  mustChangePassword: false,
  loginEnabled: true,
  linkedAdminId: null,
  createdAt: '2026-10-08T00:00:00Z',
  chipBalance: 100,
};
const admin = { id: 'admin-id', username: 'admin', displayName: '管理员' };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request.mockReset();
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
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function adminRequests(mutation: (path: string, init?: RequestInit) => unknown) {
  request.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/admin/session') return Promise.resolve(admin);
    if (path === '/api/admin/users') return Promise.resolve([user]);
    if (path === '/api/admin/rooms') return Promise.resolve([]);
    return mutation(path, init);
  });
}

describe('password changes without the old password', () => {
  it.each(['player', 'admin'] as const)(
    'lets a %s save a new password and validates its length',
    async (kind) => {
      const profilePath = kind === 'admin' ? '/api/admin/profile' : '/api/auth/profile';
      request.mockImplementation(async (path: string) => {
        if (path === '/api/auth/session') return user;
        if (path === '/api/admin/session') return admin;
        if (path === '/api/admin/users') return [user];
        if (path === profilePath) return kind === 'admin' ? admin : user;
        return [];
      });
      await act(async () => root.render(kind === 'admin' ? <AdminPage /> : <LobbyPage />));
      await act(async () =>
        kind === 'admin'
          ? container.querySelector<HTMLButtonElement>('.profile-button')!.click()
          : button('设置').click(),
      );
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).not.toContain('当前密码');
      expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(1);
      const password = dialog.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )!;
      await act(async () => setInput(password, 'short'));
      expect(button('保存账号设置').disabled).toBe(true);
      await act(async () => setInput(password, 'new-secret'));
      expect(button('保存账号设置').disabled).toBe(false);
      await act(async () =>
        dialog
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      const saved = request.mock.calls.find(([path]) => path === profilePath)!;
      expect(saved[1].method).toBe('PATCH');
      expect(JSON.parse(saved[1].body)).toEqual({
        displayName: kind === 'admin' ? '管理员' : 'Alice',
        newPassword: 'new-secret',
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );
});

describe('admin account deletion', () => {
  it('requires confirmation, locks while pending and removes the deleted account', async () => {
    let resolve!: () => void;
    const deletion = new Promise<void>((accept) => {
      resolve = accept;
    });
    adminRequests(() => deletion);
    await act(async () => root.render(<AdminPage />));
    await act(async () => button('账号 1').click());
    await act(async () => button('删除账号').click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Alice（@alice）');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '历史牌局与筹码记录会保留',
    );
    expect(request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await act(async () => button('取消').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button('删除账号').click());
    await act(async () => button('确认删除账号').click());
    expect(button('删除中…').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([
      ['/api/admin/users/player-id', { method: 'DELETE' }],
    ]);
    await act(async () => resolve());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll('.account-list > article')).toHaveLength(0);
  });

  it('retains the account and displays the server conflict so the admin can resolve it', async () => {
    const message = '该账号仍属于未结束的牌局，请先结束牌局再删除账号';
    adminRequests(() => Promise.reject(Object.assign(new Error(message), { status: 409 })));
    await act(async () => root.render(<AdminPage />));
    await act(async () => button('账号 1').click());
    await act(async () => button('删除账号').click());
    await act(async () => button('确认删除账号').click());
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      message,
    );
    expect(button('确认删除账号').disabled).toBe(false);
    expect(container.querySelectorAll('.account-list > article')).toHaveLength(1);
  });
});
