/**
 * Synthesized table sounds via WebAudio — no binary assets, nothing to load.
 * Playback is a no-op until the user enables sound (or by default when they
 * have no reduced-motion preference), and every call is safe to make from
 * any event: failures are swallowed.
 */

const STORAGE_KEY = 'pwf:sound';

function storedPreference(): boolean | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === null ? null : value === 'on';
  } catch {
    return null;
  }
}

let enabled =
  storedPreference() ??
  !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

let context: AudioContext | null = null;
let resumePromise: Promise<void> | null = null;

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    /* private mode */
  }
  if (value) void primeSound();
}

function ensureContext(): AudioContext | null {
  try {
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

async function resumeContext(ctx: AudioContext): Promise<void> {
  if (ctx.state !== 'suspended') return;
  if (resumePromise) return resumePromise;
  resumePromise = (async () => {
    try {
      await ctx.resume();
    } catch {
      /* browsers may reject resume outside a user gesture */
    } finally {
      resumePromise = null;
    }
  })();
  return resumePromise;
}

/**
 * Creates and resumes WebAudio from a user gesture. Calling this from a click
 * or pointer handler lets later table events play even when the browser starts
 * AudioContext in a suspended state.
 */
export async function primeSound(): Promise<void> {
  if (!enabled) return;
  const ctx = ensureContext();
  if (!ctx) return;
  await resumeContext(ctx);
}

function tone(
  frequency: number,
  startOffset: number,
  duration: number,
  type: OscillatorType = 'sine',
  peak = 0.06,
): void {
  const ctx = ensureContext();
  if (!ctx) return;
  void resumeContext(ctx);
  const start = ctx.currentTime + startOffset;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function guarded(play: () => void): void {
  if (!enabled) return;
  try {
    play();
  } catch {
    /* audio is best-effort */
  }
}

/** Two rising notes plus a short vibration: it is your turn to act. */
export function playTurnAlert(): void {
  guarded(() => {
    tone(880, 0, 0.14);
    tone(1174.7, 0.16, 0.2);
  });
  if (enabled) navigator.vibrate?.(120);
}

/** Soft tick for a street being dealt. */
export function playDeal(): void {
  guarded(() => tone(520, 0, 0.06, 'triangle', 0.05));
}

/** A short pair of chip clicks for a bet, call, or raise. */
export function playBet(): void {
  guarded(() => {
    tone(260, 0, 0.055, 'square', 0.035);
    tone(390, 0.045, 0.075, 'triangle', 0.04);
  });
}

/** Neutral settle blip for a hand you did not win. */
export function playSettle(): void {
  guarded(() => {
    tone(660, 0, 0.1, 'triangle', 0.045);
    tone(495, 0.11, 0.14, 'triangle', 0.04);
  });
}

/** Short ascending arpeggio: you won the pot. */
export function playWin(): void {
  guarded(() => {
    tone(523.25, 0, 0.12);
    tone(659.25, 0.1, 0.12);
    tone(783.99, 0.2, 0.12);
    tone(1046.5, 0.3, 0.28);
  });
  if (enabled) navigator.vibrate?.([70, 40, 110]);
}
