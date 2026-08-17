/**
 * Music playback: loads MUZAX.LZS, hands a decoded song to the FM worklet.
 *
 * Browsers refuse to start audio until the user interacts with the page, so
 * the context is created up front but only started on the first key press or
 * click, and playback is resumed from there.
 *
 * A full tab close normally tears the AudioContext down on its own, but nothing
 * here should depend on that: a backgrounded tab, an SPA re-render, or a stray
 * reference holding the context alive are all real ways for audio to keep
 * running somewhere the player can't see. So playback explicitly pauses on
 * `visibilitychange` and the context is explicitly closed on `pagehide`/`close()`,
 * rather than trusting teardown to happen implicitly.
 */

import { parseMuzax, type Song } from '../data/muzax.js';
import { parseMidi, type MidiEvent } from '../data/midi.js';

export interface MusicPlayer {
  /** Songs decoded from MUZAX.LZS. */
  songs: Song[];
  /** Starts a game song. Safe to call before audio is unlocked; it will queue. */
  play(index: number): void;
  /**
   * Parses and plays a user-supplied Standard MIDI File, replacing whatever
   * is currently playing (game music or a previous custom track). Loops by
   * default. Returns false if the bytes could not be parsed as MIDI.
   */
  playMidi(bytes: Uint8Array, options?: { loop?: boolean }): boolean;
  /** Stops custom MIDI playback. Does not resume game music on its own. */
  stopMidi(): void;
  stop(): void;
  setGain(value: number): void;
  /** Stops playback and releases the AudioContext. The player is unusable after this. */
  close(): Promise<void>;
  /** True once the browser has allowed audio to start. */
  readonly unlocked: boolean;
  readonly currentSong: number;
}

const WORKLET_URL = new URL('./fm-processor.js', import.meta.url);

/** Master gain, applied on creation. 0.6 was too loud; this is 75% of that. */
export const DEFAULT_GAIN = 0.45;

export async function createMusicPlayer(muzaxUrl: string): Promise<MusicPlayer> {
  const res = await fetch(muzaxUrl);
  if (!res.ok) throw new Error(`Music: could not load ${muzaxUrl}`);
  const songs = parseMuzax(new Uint8Array(await res.arrayBuffer()));

  const context = new AudioContext();
  await context.audioWorklet.addModule(WORKLET_URL);
  const node = new AudioWorkletNode(context, 'skyroads-fm', { outputChannelCount: [2] });
  node.connect(context.destination);

  // Wait for the processor's own 'ready' signal (see fm-processor.js) before
  // sending it anything -- the processor constructs on a separate audio
  // thread, so nothing here can otherwise be sure its message listener has
  // attached yet.
  await new Promise<void>((resolve) => {
    node.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ready') resolve();
    };
  });
  node.port.postMessage({ type: 'gain', value: DEFAULT_GAIN });

  let unlocked = context.state === 'running';
  let currentSong = -1;
  let closed = false;
  // Set while the tab is hidden, so returning to it can resume where it left off
  // rather than staying silent forever because `unlocked` was never re-checked.
  let pausedByVisibility = false;

  // Whatever was requested before the browser allowed audio to start. Either
  // a game song index or a parsed custom MIDI track; applied once unlocked.
  type Pending = { kind: 'song'; index: number } | { kind: 'midi'; events: MidiEvent[]; loop: boolean };
  let pending: Pending | null = null;

  const send = (index: number) => {
    const song = songs[index];
    if (!song) return;
    currentSong = index;
    // Structured-cloned to the audio thread; instruments and commands are
    // plain data, so this is a straightforward copy.
    node.port.postMessage({ type: 'song', song });
  };

  const sendMidi = (events: MidiEvent[], loop: boolean) => {
    currentSong = -1; // no longer tracking a game song index
    node.port.postMessage({ type: 'midi', events, loop });
  };

  async function unlock(): Promise<void> {
    if (unlocked || closed) return;
    try {
      await context.resume();
    } catch {
      return;
    }
    if (context.state !== 'running') return;
    unlocked = true;
    if (pending) {
      if (pending.kind === 'song') send(pending.index);
      else sendMidi(pending.events, pending.loop);
      pending = null;
    }
  }

  const unlockOnGesture = () => void unlock();
  for (const event of ['keydown', 'pointerdown'] as const) {
    addEventListener(event, unlockOnGesture, { passive: true });
  }

  const onVisibilityChange = () => {
    if (closed) return;
    if (document.hidden) {
      if (context.state === 'running') {
        pausedByVisibility = true;
        void context.suspend();
      }
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      void context.resume();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const onPageHide = () => void close();
  addEventListener('pagehide', onPageHide);

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const event of ['keydown', 'pointerdown'] as const) {
      removeEventListener(event, unlockOnGesture);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    removeEventListener('pagehide', onPageHide);
    node.port.postMessage({ type: 'stop' });
    node.port.postMessage({ type: 'stopMidi' });
    node.disconnect();
    try {
      await context.close();
    } catch {
      // Already closed or the browser is tearing the page down; nothing to do.
    }
  }

  return {
    songs,
    play(index: number) {
      if (closed) return;
      if (index === currentSong && unlocked) return;
      if (!unlocked) {
        pending = { kind: 'song', index };
        void unlock();
        return;
      }
      send(index);
    },
    playMidi(bytes: Uint8Array, options?: { loop?: boolean }): boolean {
      if (closed) return false;
      let song;
      try {
        song = parseMidi(bytes);
      } catch (err) {
        console.warn('Custom MIDI failed to parse:', err);
        return false;
      }
      const loop = options?.loop ?? true;
      if (!unlocked) {
        pending = { kind: 'midi', events: song.events, loop };
        void unlock();
        return true;
      }
      sendMidi(song.events, loop);
      return true;
    },
    stopMidi() {
      if (!closed) node.port.postMessage({ type: 'stopMidi' });
    },
    stop() {
      currentSong = -1;
      pending = null;
      if (!closed) node.port.postMessage({ type: 'stop' });
    },
    setGain(value: number) {
      if (!closed) node.port.postMessage({ type: 'gain', value });
    },
    close,
    get unlocked() {
      return unlocked;
    },
    get currentSong() {
      return currentSong;
    },
  };
}

/**
 * Song 0 is the long intro piece; the rest are in-game tracks. Levels cycle
 * through them so a planet keeps its own theme.
 */
export function songForLevel(levelIndex: number, songCount: number): number {
  if (songCount <= 1) return 0;
  const inGame = songCount - 1;
  return 1 + (Math.max(0, levelIndex - 1) % inGame);
}
