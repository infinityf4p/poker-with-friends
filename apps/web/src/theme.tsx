import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type SkinMode = 'classic' | 'emerald' | 'midnight' | 'sunset' | 'neon';

const STORAGE_KEY = 'poker-theme-mode';
const SKIN_STORAGE_KEY = 'poker-table-skin';
const ThemeContext = createContext<{
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  skin: SkinMode;
  setSkin: (skin: SkinMode) => void;
}>({
  mode: 'auto',
  resolved: 'light',
  setMode: () => undefined,
  skin: 'classic',
  setSkin: () => undefined,
});

function readSkin(): SkinMode {
  if (typeof window === 'undefined') return 'classic';
  const stored = window.localStorage.getItem(SKIN_STORAGE_KEY);
  return stored === 'emerald' || stored === 'midnight' || stored === 'sunset' || stored === 'neon'
    ? stored
    : 'classic';
}

function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'auto';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [skin, setSkinState] = useState<SkinMode>(readSkin);
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolved = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.skin = skin;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute('content', resolved === 'dark' ? '#0d1412' : '#ffffff');
    window.localStorage.setItem(STORAGE_KEY, mode);
    window.localStorage.setItem(SKIN_STORAGE_KEY, skin);
  }, [mode, resolved, skin]);

  const value = useMemo(
    () => ({
      mode,
      resolved,
      setMode: (next: ThemeMode) => setModeState(next),
      skin,
      setSkin: (next: SkinMode) => setSkinState(next),
    }),
    [mode, resolved, skin],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeModeSelect() {
  const { mode, setMode } = useTheme();
  return (
    <label className="theme-control">
      <span>颜色</span>
      <select
        aria-label="颜色模式"
        value={mode}
        onChange={(event) => setMode(event.target.value as ThemeMode)}
      >
        <option value="auto">自动</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}

export function SkinModeSelect() {
  const { skin, setSkin } = useTheme();
  return (
    <label className="theme-control skin-control">
      <span>牌桌</span>
      <select
        aria-label="牌桌皮肤"
        value={skin}
        onChange={(event) => setSkin(event.target.value as SkinMode)}
      >
        <option value="classic">经典</option>
        <option value="emerald">翡翠</option>
        <option value="midnight">午夜</option>
        <option value="sunset">落日</option>
        <option value="neon">霓虹</option>
      </select>
    </label>
  );
}
