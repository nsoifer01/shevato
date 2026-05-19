/*
 * Brain Arena — sound + haptic feedback (v3).
 *
 * Zero-asset audio synthesised on demand via WebAudio. The audio graph
 * runs every voice through a shared FX bus: dry signal → master gain;
 * a parallel reverb send (convolver + low gain) gives every tone tail,
 * a compressor at the output keeps the chord stacks from clipping.
 *
 *   voice ─┬─> master ─> compressor ─> destination
 *          └─> reverb send ─> convolver ─> compressor ─> destination
 *
 * Tones are richer than v2: FM-style modulation for warm "bell"-like
 * sustains, layered triangle + sine for body, percussive noise bursts
 * for clicks, and proper ADSR per voice. Reveal sounds are score-tier
 * dispatched so a great score gets an actual celebratory phrase instead
 * of a single chord.
 *
 * UMD: CommonJS for node:test + window.BrainArena.Feedback in the app.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.Feedback = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    let audioCtx = null;
    let dryGain = null;
    let wetGain = null;
    let compressor = null;
    let convolver = null;
    let enabled = true;
    let vibrationEnabled = true;

    // Notes in 4th/5th/6th octaves so reveals can leap an octave when
    // they need to celebrate without sounding shrill.
    const N = {
        C3: 130.81, E3: 164.81, G3: 196.00, A3: 220.00, B3: 246.94,
        C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00,
        A4: 440.00, B4: 493.88,
        C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, B5: 987.77,
        C6: 1046.50, D6: 1174.66, E6: 1318.51, G6: 1567.98
    };

    function isAudioSupported() {
        return typeof window !== 'undefined'
            && (typeof window.AudioContext !== 'undefined'
                || typeof window.webkitAudioContext !== 'undefined');
    }

    function isVibrationSupported() {
        return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    }

    /**
     * Generate a short impulse response (procedural reverb tail) so we
     * don't have to ship an audio asset. Exponential-decay white noise
     * approximates a small-room reverb well enough for game SFX.
     */
    function makeImpulseBuffer(ctx, durationSec = 1.4, decay = 2.6) {
        const sampleRate = ctx.sampleRate;
        const length = Math.max(1, Math.floor(sampleRate * durationSec));
        const buf = ctx.createBuffer(2, length, sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buf.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                // White noise with exponential decay envelope.
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return buf;
    }

    function ensureAudio() {
        if (!isAudioSupported()) return null;
        if (!audioCtx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            try {
                audioCtx = new Ctor();
                // Output bus: compressor → destination so chord stacks
                // don't clip when 4 voices ring at once.
                compressor = audioCtx.createDynamicsCompressor();
                compressor.threshold.value = -14;
                compressor.knee.value = 18;
                compressor.ratio.value = 6;
                compressor.attack.value = 0.005;
                compressor.release.value = 0.18;
                compressor.connect(audioCtx.destination);
                // Dry bus: voices land here for the main signal.
                dryGain = audioCtx.createGain();
                dryGain.gain.value = 0.7;
                dryGain.connect(compressor);
                // Reverb send: voices also tap a wet bus going through
                // the convolver, mixed back at low level for tail.
                wetGain = audioCtx.createGain();
                wetGain.gain.value = 0.18;
                convolver = audioCtx.createConvolver();
                convolver.buffer = makeImpulseBuffer(audioCtx, 1.6, 2.8);
                wetGain.connect(convolver).connect(compressor);
            } catch (e) { return null; }
        }
        if (audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) { /* ignore */ }
        }
        return audioCtx;
    }

    /**
     * Schedule a single ADSR voice. `mod` adds an FM modulator on the
     * carrier frequency — non-zero `modDepth` gives the tone a bell-like
     * inharmonic shimmer. `bright` swaps the lowpass for a highpass.
     */
    function voice({ freq, type = 'sine', startAt, duration, peakVol = 0.18, attack = 0.012, release = 0.12, filterFreq = 1600, bright = false, glideTo = null, modFreq = 0, modDepth = 0, sendWet = 0.7 }) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, startAt);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, startAt + duration);
        const peakAt = startAt + attack;
        const endAt = startAt + duration;
        const releaseStart = Math.max(peakAt, endAt - release);
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(peakVol, peakAt);
        gain.gain.setValueAtTime(peakVol, releaseStart);
        gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
        // Optional FM modulator — feeds an LFO-ish oscillator into the
        // carrier frequency for inharmonic richness.
        let modOsc = null;
        if (modDepth > 0 && modFreq > 0) {
            modOsc = ctx.createOscillator();
            modOsc.type = 'sine';
            modOsc.frequency.setValueAtTime(modFreq, startAt);
            const modGain = ctx.createGain();
            modGain.gain.value = modDepth;
            modOsc.connect(modGain).connect(osc.frequency);
            modOsc.start(startAt);
            modOsc.stop(endAt + 0.05);
        }
        const filt = ctx.createBiquadFilter();
        filt.type = bright ? 'highpass' : 'lowpass';
        filt.frequency.value = filterFreq;
        filt.Q.value = 0.7;
        osc.connect(gain).connect(filt);
        // Split filter output to dry + wet busses.
        filt.connect(dryGain);
        if (sendWet > 0) {
            const send = ctx.createGain();
            send.gain.value = sendWet;
            filt.connect(send).connect(wetGain);
        }
        osc.start(startAt);
        osc.stop(endAt + 0.05);
    }

    /**
     * Play a chord with optional arpeggiation. `voices` = how many
     * stacked oscillators per note (1 = single, 2 = octave doubled).
     */
    function chord({ notes, type = 'triangle', duration = 0.45, peakVol = 0.13, arpMs = 0, filterFreq = 2000, bright = false, modFreq = 0, modDepth = 0, voices = 1, sendWet = 0.7 }) {
        if (!enabled) return;
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.005;
        notes.forEach((f, i) => {
            const offset = (arpMs / 1000) * i;
            voice({
                freq: f, type, startAt: t0 + offset, duration,
                peakVol, attack: 0.014, release: Math.min(0.32, duration * 0.5),
                filterFreq, bright, modFreq, modDepth, sendWet
            });
            // Octave shimmer (very quiet, only for long notes).
            if (voices > 1 && duration >= 0.4) {
                voice({
                    freq: f * 2, type: 'sine',
                    startAt: t0 + offset + 0.03, duration,
                    peakVol: peakVol * 0.25, attack: 0.05, release: duration * 0.4,
                    filterFreq: 4000, bright: true, sendWet: 0.9
                });
            }
            // Detuned warmth voice below (5 cents flat).
            if (duration >= 0.25) {
                voice({
                    freq: f * 0.997, type,
                    startAt: t0 + offset, duration,
                    peakVol: peakVol * 0.45, attack: 0.025,
                    release: Math.min(0.32, duration * 0.5),
                    filterFreq, bright, sendWet
                });
            }
        });
    }

    /**
     * Schedule a musical phrase — sequence of {freq, dur} pairs played
     * back-to-back. Used for reveal celebrations.
     */
    function phrase(notes, opts = {}) {
        if (!enabled) return;
        const ctx = ensureAudio();
        if (!ctx) return;
        let t = ctx.currentTime + 0.005;
        const { type = 'triangle', peakVol = 0.12, filterFreq = 2500, modFreq = 0, modDepth = 0, sendWet = 0.7 } = opts;
        notes.forEach((n) => {
            voice({
                freq: n.freq, type, startAt: t, duration: n.dur,
                peakVol, attack: 0.012, release: Math.min(0.28, n.dur * 0.5),
                filterFreq, modFreq, modDepth, sendWet
            });
            t += n.dur * 0.85; // slight overlap for legato feel
        });
    }

    function noiseBurst({ duration = 0.06, peakVol = 0.08, filterFreq = 3000, sendWet = 0.4 }) {
        if (!enabled) return;
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.002;
        const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peakVol, t0 + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        const f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = filterFreq;
        src.connect(gain).connect(f);
        f.connect(dryGain);
        if (sendWet > 0) {
            const send = ctx.createGain();
            send.gain.value = sendWet;
            f.connect(send).connect(wetGain);
        }
        src.start(t0);
        src.stop(t0 + duration + 0.02);
    }

    function vibrate(pattern) {
        if (!vibrationEnabled || !isVibrationSupported()) return;
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }

    // --- Presets ------------------------------------------------------

    function pinPlaced() {
        // Crisp warm tap: bell-like FM blip + a high-pass noise tick.
        noiseBurst({ duration: 0.035, peakVol: 0.05, filterFreq: 4500, sendWet: 0.3 });
        chord({
            notes: [N.E5], type: 'sine', duration: 0.16, peakVol: 0.12,
            filterFreq: 3500, modFreq: 880, modDepth: 60, sendWet: 0.4
        });
        vibrate(12);
    }

    function pinCleared() {
        // Descending two-note: B then F#, soft.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.B4, type: 'sine', startAt: t + 0.005, duration: 0.10, peakVol: 0.10, filterFreq: 2500 });
        voice({ freq: N.F4, type: 'sine', startAt: t + 0.07,  duration: 0.14, peakVol: 0.10, filterFreq: 2200 });
        vibrate(10);
    }

    function guessSubmitted() {
        // Confident ascending arpeggio C-E-G-C with octave shimmer.
        chord({
            notes: [N.C4, N.E4, N.G4, N.C5],
            type: 'triangle', duration: 0.42, peakVol: 0.11, arpMs: 60,
            filterFreq: 2400, voices: 2, sendWet: 0.8
        });
        vibrate([20, 30, 30]);
    }

    function opponentSubmitted() {
        // Soft two-note chime, quiet so it doesn't interrupt focus.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.D5, type: 'sine', startAt: t + 0.005, duration: 0.14, peakVol: 0.07, filterFreq: 3200, sendWet: 0.5 });
        voice({ freq: N.A5, type: 'sine', startAt: t + 0.05,  duration: 0.18, peakVol: 0.06, filterFreq: 4500, sendWet: 0.6 });
        vibrate(15);
    }

    /**
     * Reveal sound tiered by points earned. Each tier is a small musical
     * phrase, not a single chord, so the celebration feels composed.
     *
     *   p >= 200  → "excellent": rising C-E-G-C5 with bell + shimmer
     *   p >= 100  → "great":      C-E-G triad triumph
     *    40 <= p  → "ok":         resolved 2-note ping
     *      p < 40 → "rough":      minor descending arc (musical, not buzzer)
     */
    function revealForScore(points) {
        const p = Math.max(0, Number(points) || 0);
        if (p >= 200) return revealExcellent();
        if (p >= 100) return revealGreat();
        if (p >= 40)  return revealOk();
        return revealRough();
    }

    function revealExcellent() {
        // Mini fanfare: 4-note ascending phrase + bell triad on top.
        phrase([
            { freq: N.G4, dur: 0.14 },
            { freq: N.C5, dur: 0.14 },
            { freq: N.E5, dur: 0.14 },
            { freq: N.G5, dur: 0.34 }
        ], { type: 'triangle', peakVol: 0.13, filterFreq: 4000, sendWet: 0.9 });
        // Bell triad ringing over the top, FM-modulated for chime.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime + 0.42;
        [N.C6, N.E6, N.G6].forEach((f, i) => {
            voice({
                freq: f, type: 'sine', startAt: t + i * 0.04, duration: 0.95,
                peakVol: 0.08, attack: 0.03, release: 0.7,
                filterFreq: 6000, modFreq: f * 1.5, modDepth: 35, sendWet: 1.0
            });
        });
        vibrate([40, 40, 60, 40, 80]);
    }

    function revealGreat() {
        // C major triad triumph with octave shimmer.
        chord({
            notes: [N.C5, N.E5, N.G5],
            type: 'triangle', duration: 0.7, peakVol: 0.12, arpMs: 50,
            filterFreq: 3500, voices: 2, sendWet: 0.9
        });
        const ctx = ensureAudio(); if (!ctx) return;
        // FM bell at the top for sparkle.
        voice({
            freq: N.C6, type: 'sine', startAt: ctx.currentTime + 0.2,
            duration: 0.55, peakVol: 0.07, attack: 0.04, release: 0.4,
            filterFreq: 5500, modFreq: 990, modDepth: 40, sendWet: 1.0
        });
        vibrate([35, 45, 60]);
    }

    function revealOk() {
        // Two-note resolution: E5 → G5, gentle.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.E5, type: 'sine', startAt: t + 0.005, duration: 0.22, peakVol: 0.11, filterFreq: 2800, sendWet: 0.8 });
        voice({ freq: N.G5, type: 'sine', startAt: t + 0.16,  duration: 0.36, peakVol: 0.11, filterFreq: 3200, sendWet: 0.9 });
        vibrate(25);
    }

    function revealRough() {
        // Descending minor third with a tiny tail — bluesy, not a buzzer.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.G4, type: 'sine', startAt: t + 0.005, duration: 0.28, peakVol: 0.10, filterFreq: 1800, sendWet: 0.8, glideTo: N.E4 });
        voice({ freq: N.C4, type: 'sine', startAt: t + 0.20,  duration: 0.42, peakVol: 0.08, filterFreq: 1500, sendWet: 0.9 });
        vibrate(20);
    }

    // Back-compat aliases for any older call sites.
    function revealBullseye() { return revealExcellent(); }
    function revealClose()    { return revealGreat(); }
    function revealFar()      { return revealRough(); }

    function gameStart() {
        // Anticipatory rising arpeggio C-G-C up the octave.
        phrase([
            { freq: N.C4, dur: 0.18 },
            { freq: N.G4, dur: 0.18 },
            { freq: N.C5, dur: 0.34 }
        ], { type: 'triangle', peakVol: 0.12, filterFreq: 2800, sendWet: 0.9 });
        vibrate([30, 40, 30]);
    }

    function gameEnd() {
        // Full C-major resolution: chord + bell on top.
        chord({
            notes: [N.C4, N.E4, N.G4, N.C5],
            type: 'triangle', duration: 0.9, peakVol: 0.12, arpMs: 70,
            filterFreq: 3800, voices: 2, sendWet: 0.95
        });
        const ctx = ensureAudio(); if (!ctx) return;
        voice({
            freq: N.E6, type: 'sine', startAt: ctx.currentTime + 0.35,
            duration: 0.85, peakVol: 0.07, attack: 0.05, release: 0.6,
            filterFreq: 5500, modFreq: 990, modDepth: 30, sendWet: 1.0
        });
        vibrate([60, 60, 80, 60, 100]);
    }

    function timerLow() {
        // Brief square pip at 880Hz — urgent but tasteful, no reverb.
        chord({ notes: [N.A4 * 2], type: 'square', duration: 0.07, peakVol: 0.07, filterFreq: 2200, sendWet: 0 });
    }

    function timerExpired() {
        // Sad descending "wah-wah" — clearly says "time ran out / you
        // didn't get it in." Two-note glide down, fuller body than the
        // timerLow tick, with a tail of reverb so it lingers.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.E4, type: 'sawtooth', startAt: t + 0.00, duration: 0.22, peakVol: 0.10, filterFreq: 1400, sendWet: 0.6 });
        voice({ freq: N.C4, type: 'sawtooth', startAt: t + 0.18, duration: 0.32, peakVol: 0.10, filterFreq: 1200, sendWet: 0.75 });
        vibrate(70);
    }

    function chatMessage() {
        // Gentle "you have mail" two-note chime.
        const ctx = ensureAudio(); if (!ctx) return;
        const t = ctx.currentTime;
        voice({ freq: N.G4, type: 'sine', startAt: t + 0.005, duration: 0.14, peakVol: 0.09, filterFreq: 2800, sendWet: 0.7 });
        voice({ freq: N.B4, type: 'sine', startAt: t + 0.08,  duration: 0.20, peakVol: 0.09, filterFreq: 3000, sendWet: 0.8 });
        vibrate(12);
    }

    function setEnabled(v) { enabled = !!v; }
    function setVibrationEnabled(v) { vibrationEnabled = !!v; }
    function isEnabled() { return enabled; }

    return {
        ensureAudio,
        setEnabled,
        setVibrationEnabled,
        isEnabled,
        // Low-level
        chord,
        phrase,
        noiseBurst,
        vibrate,
        // Presets
        pinPlaced,
        pinCleared,
        guessSubmitted,
        opponentSubmitted,
        revealForScore,
        revealBullseye,
        revealClose,
        revealFar,
        revealExcellent,
        revealGreat,
        revealOk,
        revealRough,
        gameStart,
        gameEnd,
        timerLow,
        timerExpired,
        chatMessage
    };
}));
