import { afterEach, describe, expect, it, vi } from 'vitest';

interface AudioHarnessOptions {
  stored?: string | null;
  rejectResume?: boolean;
}

function installAudioHarness(options: AudioHarnessOptions = {}) {
  const getItem = vi.fn(() => options.stored ?? null);
  const setItem = vi.fn();
  const contexts: FakeAudioContext[] = [];

  class FakeAudioContext {
    state: AudioContextState = 'suspended';
    currentTime = 1;
    destination = {};
    resume = vi.fn(async () => {
      if (options.rejectResume) throw new Error('gesture required');
      this.state = 'running';
    });
    createOscillator = vi.fn(() => ({
      type: 'sine' as OscillatorType,
      frequency: { value: 0 },
      connect: vi.fn((destination: unknown) => destination),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn((destination: unknown) => destination),
    }));

    constructor() {
      contexts.push(this);
    }
  }

  vi.stubGlobal('localStorage', { getItem, setItem });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  vi.stubGlobal('AudioContext', FakeAudioContext);

  return { contexts, getItem, setItem };
}

async function loadSound() {
  vi.resetModules();
  return import('./sound');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('table sound', () => {
  it('does not create or play audio when the stored preference is off', async () => {
    const harness = installAudioHarness({ stored: 'off' });
    const sound = await loadSound();

    expect(sound.soundEnabled()).toBe(false);
    sound.playBet();
    await sound.primeSound();

    expect(harness.contexts).toHaveLength(0);
  });

  it('unlocks one shared AudioContext from a user gesture', async () => {
    const harness = installAudioHarness({ stored: 'on' });
    const sound = await loadSound();

    await sound.primeSound();
    await sound.primeSound();

    expect(harness.contexts).toHaveLength(1);
    expect(harness.contexts[0]!.resume).toHaveBeenCalledTimes(1);
    expect(harness.contexts[0]!.state).toBe('running');
  });

  it('swallows an AudioContext resume rejection', async () => {
    const harness = installAudioHarness({ stored: 'on', rejectResume: true });
    const sound = await loadSound();

    await expect(sound.primeSound()).resolves.toBeUndefined();
    expect(harness.contexts[0]!.resume).toHaveBeenCalledTimes(1);
  });

  it('plays the bet sound and persists preference changes', async () => {
    const harness = installAudioHarness({ stored: 'off' });
    const sound = await loadSound();

    sound.setSoundEnabled(true);
    await sound.primeSound();
    sound.playBet();

    const audio = harness.contexts[0]!;
    expect(harness.setItem).toHaveBeenCalledWith('pwf:sound', 'on');
    expect(audio.createOscillator).toHaveBeenCalledTimes(2);
    for (const result of audio.createOscillator.mock.results) {
      expect(result.value.start).toHaveBeenCalledTimes(1);
      expect(result.value.stop).toHaveBeenCalledTimes(1);
    }

    sound.setSoundEnabled(false);
    sound.playBet();
    expect(harness.setItem).toHaveBeenLastCalledWith('pwf:sound', 'off');
    expect(audio.createOscillator).toHaveBeenCalledTimes(2);
  });
});
