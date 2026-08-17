/**
 * OPL2-style 2-operator FM synthesiser, running on the audio thread.
 *
 * This is a re-creation of the OPL2's *behaviour*, not a cycle-exact emulation
 * of the chip. It implements the parts that shape the music -- the eight
 * waveforms, two operators per channel in FM or additive mode, operator
 * feedback, and per-operator ADSR in dB -- driven by the instrument
 * definitions and command stream decoded from MUZAX.LZS.
 *
 * The envelope rate curves are approximations. The original's rates are
 * 0-15 indices into hardware tables; these map them to musically plausible
 * time constants. Melody, harmony, instrument character and timing are all
 * faithful; the exact attack contour of a given patch is not.
 *
 * Plain JS rather than TS because AudioWorklet modules are loaded as raw
 * script URLs, outside the bundler's TypeScript pipeline.
 */

const TICK_HZ = 200; // command stream rate, a 5ms tick in the original
const CHANNELS = 11;
const TWO_PI = Math.PI * 2;

/** The OPL2's eight waveform variants, over a phase in [0, 1). */
function waveform(type, phase) {
  const p = phase - Math.floor(phase);
  switch (type) {
    case 0:
      return Math.sin(TWO_PI * p);
    case 1: // half sine: negative half silenced
      return p < 0.5 ? Math.sin(TWO_PI * p) : 0;
    case 2: // absolute sine
      return Math.abs(Math.sin(TWO_PI * p));
    case 3: // pulse sine: quarter-wave bursts
      return p % 0.5 < 0.25 ? Math.abs(Math.sin(TWO_PI * p)) : 0;
    case 4: // even-numbered sine, double rate
      return p < 0.5 ? Math.sin(TWO_PI * 2 * p) : 0;
    case 5:
      return p < 0.5 ? Math.abs(Math.sin(TWO_PI * 2 * p)) : 0;
    case 6:
      return p < 0.5 ? 1 : -1;
    case 7: // derived square: a falling saw
      return 1 - 2 * p;
    default:
      return Math.sin(TWO_PI * p);
  }
}

const dbToLinear = (db) => Math.pow(10, db / 20);

/** Rate index (0-15) to seconds. Approximations; see the file header. */
const attackSeconds = (r) => (r >= 15 ? 0.001 : 3.0 / Math.pow(2, r * 0.6));
const decaySeconds = (r) => (r <= 0 ? 100 : 6.0 / Math.pow(2, r * 0.5));

/** OPL multiplier 0 means one half, not zero. */
const multiplier = (m) => (m === 0 ? 0.5 : m);

class Operator {
  constructor() {
    this.phase = 0;
    this.config = null;
    this.env = 0; // 0..1
    this.stage = 'off'; // off | attack | decay | sustain | release
  }

  configure(config) {
    this.config = config;
    this.level = dbToLinear(config.outputLevel);
    this.sustain = dbToLinear(config.sustainLevel);
    this.attackRate = 1 / (attackSeconds(config.attackRate) * sampleRate);
    this.decayRate = 1 / (decaySeconds(config.decayRate) * sampleRate);
    this.releaseRate = 1 / (decaySeconds(config.releaseRate) * sampleRate);
  }

  keyOn() {
    this.stage = 'attack';
    this.phase = 0;
  }

  keyOff() {
    if (this.stage !== 'off') this.stage = 'release';
  }

  advanceEnvelope() {
    switch (this.stage) {
      case 'attack':
        this.env += this.attackRate;
        if (this.env >= 1) {
          this.env = 1;
          this.stage = 'decay';
        }
        break;
      case 'decay':
        this.env -= this.decayRate;
        if (this.env <= this.sustain) {
          this.env = this.sustain;
          // A non-sustaining patch keeps decaying to silence instead of holding.
          this.stage = this.config && this.config.soundSustaining ? 'sustain' : 'release';
        }
        break;
      case 'sustain':
        break;
      case 'release':
        this.env -= this.releaseRate;
        if (this.env <= 0) {
          this.env = 0;
          this.stage = 'off';
        }
        break;
    }
    return this.env;
  }
}

class Channel {
  constructor() {
    this.a = new Operator();
    this.b = new Operator();
    this.additive = false;
    this.feedback = 0;
    this.frequency = 0;
    this.volume = 1;
    this.lastOutput = 0;
  }

  setInstrument(instrument) {
    this.a.configure(instrument.a);
    this.b.configure(instrument.b);
    this.additive = instrument.additive;
    // OPL feedback is a power-of-two scale; 0 means none.
    this.feedback = instrument.feedback === 0 ? 0 : Math.pow(2, instrument.feedback) / 256;
  }

  keyOn(frequency) {
    this.frequency = frequency;
    this.a.keyOn();
    this.b.keyOn();
  }

  keyOff() {
    this.a.keyOff();
    this.b.keyOff();
  }

  render(dt) {
    if (this.a.stage === 'off' && this.b.stage === 'off') return 0;
    if (!this.a.config || !this.b.config) return 0;

    const envA = this.a.advanceEnvelope();
    const envB = this.b.advanceEnvelope();

    this.a.phase += this.frequency * multiplier(this.a.config.multiplication) * dt;
    this.b.phase += this.frequency * multiplier(this.b.config.multiplication) * dt;

    const modIn = this.feedback > 0 ? this.lastOutput * this.feedback : 0;
    const outA = waveform(this.a.config.waveForm, this.a.phase + modIn) * this.a.level * envA;
    this.lastOutput = outA;

    let out;
    if (this.additive) {
      out = outA + waveform(this.b.config.waveForm, this.b.phase) * this.b.level * envB;
    } else {
      // FM: operator A's output displaces operator B's phase.
      out = waveform(this.b.config.waveForm, this.b.phase + outA) * this.b.level * envB;
    }
    return out * this.volume;
  }
}

class FmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = Array.from({ length: CHANNELS }, () => new Channel());
    this.song = null;
    this.pointer = 0;
    this.pauseTicks = 0;
    this.jumpPointer = 0;
    this.tickAccumulator = 0;
    this.samplesPerTick = sampleRate / TICK_HZ;
    // Overridden immediately by music.ts's DEFAULT_GAIN; kept here only as a
    // safe fallback if the 'gain' message is ever missed.
    this.gain = 0.45;
    this.playing = false;

    // Custom MIDI playback state. Shares the same Channel pool as MUZAX
    // playback -- the two modes are mutually exclusive, never mixed.
    this.midiEvents = null;
    this.midiCursor = 0;
    this.midiTime = 0;
    this.midiLoop = true;
    this.midiPlaying = false;
    this.midiVoiceMap = new Map(); // `${channel}:${note}` -> physical channel index
    this.midiVoiceOrder = []; // physical channel indices, oldest first, for voice stealing
    this.midiChannelPrograms = new Map(); // MIDI channel -> program number

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'song') {
        this.stopMidi();
        this.song = msg.song;
        this.pointer = 0;
        this.pauseTicks = 0;
        this.jumpPointer = 0;
        this.playing = true;
        for (const c of this.channels) {
          c.keyOff();
          c.volume = 1;
        }
      } else if (msg.type === 'stop') {
        this.playing = false;
        for (const c of this.channels) c.keyOff();
      } else if (msg.type === 'resume') {
        this.playing = true;
      } else if (msg.type === 'gain') {
        this.gain = msg.value;
      } else if (msg.type === 'midi') {
        this.playing = false; // MUZAX playback stops; the two never mix
        for (const c of this.channels) c.keyOff();
        this.midiEvents = msg.events;
        this.midiCursor = 0;
        this.midiTime = 0;
        this.midiLoop = msg.loop !== false;
        this.midiVoiceMap.clear();
        this.midiVoiceOrder.length = 0;
        this.midiChannelPrograms.clear();
        this.midiPlaying = this.midiEvents.length > 0;
      } else if (msg.type === 'stopMidi') {
        this.stopMidi();
      }
    };

    // The processor constructs on a separate audio-rendering thread; the main
    // thread has no other way to know the message listener above is actually
    // attached yet. Without this, a message sent immediately after
    // `new AudioWorkletNode(...)` (as music.ts's initial gain message is) is
    // racing the processor's own construction.
    this.port.postMessage({ type: 'ready' });
  }

  stopMidi() {
    this.midiPlaying = false;
    this.midiEvents = null;
    for (const phys of this.midiVoiceMap.values()) this.channels[phys].keyOff();
    this.midiVoiceMap.clear();
    this.midiVoiceOrder.length = 0;
  }

  /** Picks a physical FM channel for a new MIDI note, stealing the oldest if all are busy. */
  allocateMidiVoice(key) {
    const used = new Set(this.midiVoiceMap.values());
    let phys = -1;
    for (let i = 0; i < CHANNELS; i++) {
      if (!used.has(i)) {
        phys = i;
        break;
      }
    }
    if (phys === -1) {
      phys = this.midiVoiceOrder.shift();
      for (const [k, v] of this.midiVoiceMap) {
        if (v === phys) {
          this.midiVoiceMap.delete(k);
          break;
        }
      }
    }
    this.midiVoiceMap.set(key, phys);
    this.midiVoiceOrder.push(phys);
    return phys;
  }

  midiNoteOn(channel, note, velocity) {
    const key = `${channel}:${note}`;
    const phys = this.allocateMidiVoice(key);
    const program = this.midiChannelPrograms.get(channel) ?? 0;
    this.channels[phys].setInstrument(MIDI_PATCHES[patchForProgram(program)]);
    this.channels[phys].volume = Math.max(0.15, (velocity ?? 100) / 127);
    this.channels[phys].keyOn(midiNoteToFrequency(note));
  }

  midiNoteOff(channel, note) {
    const key = `${channel}:${note}`;
    const phys = this.midiVoiceMap.get(key);
    if (phys === undefined) return;
    this.channels[phys].keyOff();
    this.midiVoiceMap.delete(key);
    const idx = this.midiVoiceOrder.indexOf(phys);
    if (idx >= 0) this.midiVoiceOrder.splice(idx, 1);
  }

  /** Advances MIDI playback by `dt` seconds, dispatching every event that falls due. */
  stepMidi(dt) {
    if (!this.midiPlaying || !this.midiEvents) return;
    this.midiTime += dt;

    while (this.midiCursor < this.midiEvents.length) {
      const ev = this.midiEvents[this.midiCursor];
      if (ev.timeSec > this.midiTime) break;
      this.midiCursor++;
      if (ev.type === 'program') {
        this.midiChannelPrograms.set(ev.channel, ev.program);
      } else if (ev.type === 'on') {
        this.midiNoteOn(ev.channel, ev.note, ev.velocity);
      } else if (ev.type === 'off') {
        this.midiNoteOff(ev.channel, ev.note);
      }
    }

    if (this.midiCursor >= this.midiEvents.length) {
      if (this.midiLoop) {
        this.midiCursor = 0;
        this.midiTime = 0;
        for (const phys of this.midiVoiceMap.values()) this.channels[phys].keyOff();
        this.midiVoiceMap.clear();
        this.midiVoiceOrder.length = 0;
      } else {
        this.midiPlaying = false;
      }
    }
  }

  /** Runs commands until the stream asks to wait. */
  step() {
    if (!this.song) return;
    if (this.pauseTicks > 0) {
      this.pauseTicks--;
      return;
    }

    const commands = this.song.commands;
    // Bounded so a song with no pause command cannot wedge the audio thread.
    for (let guard = 0; guard < 10000; guard++) {
      if (this.pointer >= commands.length) {
        this.pointer = this.jumpPointer;
        if (this.pointer >= commands.length) {
          this.playing = false;
          return;
        }
      }
      const cmd = commands[this.pointer++];
      const channel = this.channels[cmd.channel];

      switch (cmd.type) {
        case 0: // pause
          this.pauseTicks = cmd.value;
          return;
        case 1: // stop note, then configure instrument
          if (channel) {
            channel.keyOff();
            const instrument = this.song.instruments[cmd.value];
            if (instrument) channel.setInstrument(instrument);
          }
          break;
        case 2: // play note
          if (channel) channel.keyOn(noteToFrequency(cmd.value));
          break;
        case 3: // stop note
          if (channel) channel.keyOff();
          break;
        case 4: // channel volume
          if (channel) channel.volume = dbToLinear(((cmd.value & 0x3f) / 0x3f) * -47.25);
          break;
        case 5: // jump to saved position
          this.pointer = this.jumpPointer;
          break;
        case 6: // save position
          this.jumpPointer = this.pointer;
          break;
        default:
          break;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1];
    if (!left) return true;

    const dt = 1 / sampleRate;

    for (let i = 0; i < left.length; i++) {
      if (this.playing) {
        this.tickAccumulator++;
        if (this.tickAccumulator >= this.samplesPerTick) {
          this.tickAccumulator -= this.samplesPerTick;
          this.step();
        }
      }
      if (this.midiPlaying) this.stepMidi(dt);

      let sample = 0;
      for (const channel of this.channels) sample += channel.render(dt);
      sample = Math.tanh(sample * this.gain); // soft clip rather than harsh wrap

      left[i] = sample;
      if (right) right[i] = sample;
    }

    return true;
  }
}

const F_NUMBERS = [0xac, 0xb6, 0xc1, 0xcd, 0xd9, 0xe6, 0xf3, 0x102, 0x111, 0x122, 0x133, 0x145];
function noteToFrequency(note) {
  const semitone = note % 12;
  const block = Math.floor(note / 12) + 2;
  return (F_NUMBERS[semitone] * 49716) / Math.pow(2, 20 - block);
}

/**
 * MIDI note numbers use the standard chromatic scale (A4 = note 69 = 440Hz),
 * which is a different numbering scheme from MUZAX's own note encoding above
 * (that one starts its octaves from the game's own offset). Kept as a
 * separate function rather than unified with noteToFrequency so neither
 * encoding's assumptions leak into the other.
 */
function midiNoteToFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * Four hand-built instrument patches standing in for General MIDI's 128
 * programs. There is no attempt at per-program fidelity -- MIDI's timbre
 * information (instrument names, GM patch numbers) doesn't carry meaning for
 * this FM engine, so program numbers are grouped into four broad characters
 * instead: plucky/percussive, sustained lead, low/punchy bass, and soft pad.
 * Real instrument identity (e.g. "should sound like a flute") is not honoured.
 */
const MIDI_PATCHES = {
  lead: {
    a: {
      multiplication: 1,
      outputLevel: -3,
      attackRate: 12,
      decayRate: 4,
      sustainLevel: -6,
      releaseRate: 6,
      waveForm: 0,
      soundSustaining: true,
    },
    b: {
      multiplication: 1,
      outputLevel: 0,
      attackRate: 13,
      decayRate: 5,
      sustainLevel: -4,
      releaseRate: 7,
      waveForm: 0,
      soundSustaining: true,
    },
    additive: false,
    feedback: 3,
  },
  pluck: {
    a: {
      multiplication: 1,
      outputLevel: -2,
      attackRate: 15,
      decayRate: 9,
      sustainLevel: -30,
      releaseRate: 9,
      waveForm: 0,
      soundSustaining: false,
    },
    b: {
      multiplication: 2,
      outputLevel: 0,
      attackRate: 15,
      decayRate: 6,
      sustainLevel: -20,
      releaseRate: 8,
      waveForm: 0,
      soundSustaining: false,
    },
    additive: false,
    feedback: 2,
  },
  bass: {
    a: {
      multiplication: 1,
      outputLevel: -4,
      attackRate: 14,
      decayRate: 5,
      sustainLevel: -10,
      releaseRate: 8,
      waveForm: 0,
      soundSustaining: true,
    },
    b: {
      multiplication: 1,
      outputLevel: 0,
      attackRate: 14,
      decayRate: 6,
      sustainLevel: -8,
      releaseRate: 9,
      waveForm: 6,
      soundSustaining: true,
    },
    additive: false,
    feedback: 1,
  },
  pad: {
    a: {
      multiplication: 1,
      outputLevel: -6,
      attackRate: 4,
      decayRate: 2,
      sustainLevel: -3,
      releaseRate: 3,
      waveForm: 0,
      soundSustaining: true,
    },
    b: {
      multiplication: 2,
      outputLevel: -6,
      attackRate: 4,
      decayRate: 2,
      sustainLevel: -3,
      releaseRate: 3,
      waveForm: 0,
      soundSustaining: true,
    },
    additive: true,
    feedback: 0,
  },
};

/** Coarse General MIDI program -> one of the four patches above. */
function patchForProgram(program) {
  if (program >= 32 && program <= 39) return 'bass';
  if ((program >= 16 && program <= 23) || (program >= 40 && program <= 55) || program >= 96) {
    return 'pad';
  }
  if (program <= 15 || (program >= 24 && program <= 31) || (program >= 104 && program <= 119)) {
    return 'pluck';
  }
  return 'lead'; // brass/reed/pipe/synth-lead ranges (56-95), and anything unmapped
}

registerProcessor('skyroads-fm', FmProcessor);
