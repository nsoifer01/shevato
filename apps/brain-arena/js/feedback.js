/*
 * Brain Arena — sound + haptic feedback.
 *
 * Zero-asset audio: tones are synthesised on demand via WebAudio so
 * we don't ship any .mp3 / .ogg files and don't need an autoplay-
 * policy waiver. Haptics use the Vibration API (silently no-ops on
 * desktop / iOS).
 *
 * Synthesis style:
 *   - Multi-oscillator chords (3 voices for reveals, 2 for chimes) so
 *     tones feel like music rather than beeps.
 *   - Detuned secondary voices for warmth, mixed below the fundamental.
 *   - Per-note ADSR via gain ramps (linearAttack + exponentialDecay).
 *   - Lowpass filter on warm presets, highpass on bright ones, so the
 *     reveal sound for a great score sounds OBVIOUSLY brighter than the
 *     one for a poor score.
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
    let masterGain = null;
    let enabled = true;
    let vibrationEnabled = true;

    // Note frequencies (4th octave) — keep it musical and predictable.
    const N = {
        C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00,
        A4: 440.00, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25,
        G5: 783.99, C6: 1046.50
    };

    function isAudioSupported() {
        return typeof window !== 'undefined'
            && (typeof window.AudioContext !== 'undefined'
                || typeof window.webkitAudioContext !== 'undefined');
    }

    function isVibrationSupported() {
        return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    }

    function ensureAudio() {
        if (!isAudioSupported()) return null;
        if (!audioCtx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            try {
                audioCtx = new Ctor();
                masterGain = audioCtx.createGain();
                // -6 dB-ish so we have headroom for chord stacks without
                // clipping when three voices ring out at once.
                masterGain.gain.value = 0.5;
                masterGain.connect(audioCtx.destination);
            } catch (e) { return null; }
        }
        if (audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) { /* ignore */ }
        }
        return audioCtx;
    }

    /**
     * Schedule a single voice with an ADSR envelope and optional filter.
     * Internal helper — most callers use the preset functions below.
     */
    function voice({ freq, type = 'sine', startAt, duration, peakVol = 0.18, attack = 0.012, release = 0.08, filter = null, filterFreq = 1200, glideTo = null, dest }) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, startAt);
        if (glideTo) {
            osc.frequency.exponentialRampToValueAtTime(glideTo, startAt + duration);
        }
        const peakAt = startAt + attack;
        const endAt = startAt + duration;
        const releaseStart = Math.max(peakAt, endAt - release);
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(peakVol, peakAt);
        gain.gain.setValueAtTime(peakVol, releaseStart);
        gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
        let last = osc;
        last.connect(gain);
        if (filter) {
            const f = ctx.createBiquadFilter();
            f.type = filter;
            f.frequency.value = filterFreq;
            f.Q.value = 0.8;
            gain.connect(f);
            last = f;
        } else {
            last = gain;
        }
        last.connect(dest || masterGain);
        osc.start(startAt);
        osc.stop(endAt + 0.05);
    }

    /**
     * Play a stack of notes (chord). `notes` is an array of frequencies;
     * `arpMs` adds a small ascending delay between voices for a strummed
     * feel (0 = simultaneous chord).
     */
    function chord({ notes, type = 'triangle', duration = 0.45, peakVol = 0.13, arpMs = 0, filter = null, filterFreq = 1500, dest }) {
        if (!enabled) return;
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.005;
        notes.forEach((f, i) => {
            const offset = (arpMs / 1000) * i;
            voice({
                freq: f,
                type,
                startAt: t0 + offset,
                duration,
                peakVol,
                attack: 0.015,
                release: Math.min(0.18, duration * 0.4),
                filter,
                filterFreq,
                dest
            });
            // Add a quiet detuned voice 8 cents below for warmth; only on
            // sustained chords (duration >= 0.25) to keep short pings clean.
            if (duration >= 0.25) {
                voice({
                    freq: f * 0.995,
                    type,
                    startAt: t0 + offset,
                    duration,
                    peakVol: peakVol * 0.45,
                    attack: 0.02,
                    release: Math.min(0.18, duration * 0.4),
                    filter,
                    filterFreq,
                    dest
                });
            }
        });
    }

    /**
     * Filtered noise burst — used for crisp pin-tap textures so the click
     * sounds physical instead of like a pure tone blip.
     */
    function noiseBurst({ duration = 0.06, peakVol = 0.08, filterFreq = 3000 }) {
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
        src.connect(gain).connect(f).connect(masterGain);
        src.start(t0);
        src.stop(t0 + duration + 0.02);
    }

    function vibrate(pattern) {
        if (!vibrationEnabled || !isVibrationSupported()) return;
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }

    // --- Named presets ------------------------------------------------

    function pinPlaced() {
        // Crisp warm tap: short triangle blip + a high-pass noise tick
        // so it sounds like a physical pin landing rather than a beep.
        noiseBurst({ duration: 0.04, peakVol: 0.05, filterFreq: 4000 });
        chord({ notes: [N.E5], type: 'triangle', duration: 0.10, peakVol: 0.10 });
        vibrate(12);
    }

    function pinCleared() {
        // Descending two-note: G then D, soft.
        chord({ notes: [N.G4], type: 'sine', duration: 0.10, peakVol: 0.10 });
        const ctx = ensureAudio(); if (!ctx) return;
        voice({ freq: N.D4, type: 'sine', startAt: ctx.currentTime + 0.06, duration: 0.14, peakVol: 0.10, dest: masterGain });
        vibrate(10);
    }

    function guessSubmitted() {
        // Confident ascending C-major arpeggio.
        chord({
            notes: [N.C4, N.E4, N.G4, N.C5],
            type: 'triangle',
            duration: 0.35,
            peakVol: 0.10,
            arpMs: 55,
            filter: 'lowpass',
            filterFreq: 2200
        });
        vibrate([20, 30, 30]);
    }

    function opponentSubmitted() {
        // Small high blip, quiet enough not to interrupt focus.
        chord({ notes: [N.A4, N.E5], type: 'sine', duration: 0.12, peakVol: 0.07, arpMs: 30 });
        vibrate(15);
    }

    /**
     * Reveal sound tiered by points earned. The thresholds line up with
     * how the game feels:
     *
     *    points >= 200   → "excellent" — bright major chord with shimmer
     *    100 <= points < 200 → "great" — warm major triad
     *    40 <= points < 100  → "ok"   — pleasant single-note ping
     *    points < 40         → "rough" — low understated descent
     *                                    (still musical, never a buzzer)
     */
    function revealForScore(points) {
        const p = Math.max(0, Number(points) || 0);
        if (p >= 200) return revealExcellent();
        if (p >= 100) return revealGreat();
        if (p >= 40)  return revealOk();
        return revealRough();
    }

    function revealExcellent() {
        // C major with the 5th and octave — bright, celebratory, with a
        // delayed high shimmer voice for sparkle.
        chord({
            notes: [N.C5, N.E5, N.G5, N.C6],
            type: 'triangle',
            duration: 0.7,
            peakVol: 0.13,
            arpMs: 35,
            filter: 'lowpass',
            filterFreq: 4500
        });
        const ctx = ensureAudio(); if (!ctx) return;
        // High twinkle voice 200ms in.
        voice({
            freq: N.C6 * 2, type: 'sine',
            startAt: ctx.currentTime + 0.20, duration: 0.45,
            peakVol: 0.05, attack: 0.04, release: 0.25,
            filter: 'highpass', filterFreq: 2000, dest: masterGain
        });
        vibrate([40, 40, 60, 40, 80]);
    }

    function revealGreat() {
        // C major triad, warm.
        chord({
            notes: [N.C5, N.E5, N.G5],
            type: 'triangle',
            duration: 0.55,
            peakVol: 0.12,
            arpMs: 40,
            filter: 'lowpass',
            filterFreq: 3000
        });
        vibrate([35, 45, 60]);
    }

    function revealOk() {
        // Single-note ping, settled and gentle.
        chord({
            notes: [N.E5],
            type: 'sine',
            duration: 0.35,
            peakVol: 0.11,
            filter: 'lowpass',
            filterFreq: 2200
        });
        vibrate(25);
    }

    function revealRough() {
        // Low descending sine — minor mood without being harsh.
        const ctx = ensureAudio(); if (!ctx) return;
        voice({
            freq: N.G4, type: 'sine',
            startAt: ctx.currentTime + 0.005, duration: 0.45,
            peakVol: 0.09, attack: 0.04, release: 0.25,
            filter: 'lowpass', filterFreq: 1600,
            glideTo: N.E4,
            dest: masterGain
        });
        vibrate(20);
    }

    // Back-compat: prior call sites used these named tiers. Kept as
    // aliases so any leftover hand-tuned call site still produces sound.
    function revealBullseye() { return revealExcellent(); }
    function revealClose()    { return revealGreat(); }
    function revealFar()      { return revealRough(); }

    function gameStart() {
        // Rising fifth + octave — anticipatory.
        chord({
            notes: [N.C4, N.G4, N.C5],
            type: 'triangle',
            duration: 0.45,
            peakVol: 0.11,
            arpMs: 80,
            filter: 'lowpass',
            filterFreq: 2400
        });
        vibrate([30, 40, 30]);
    }

    function gameEnd() {
        // Full C major triad, longer release — resolves.
        chord({
            notes: [N.C4, N.E4, N.G4, N.C5],
            type: 'triangle',
            duration: 0.85,
            peakVol: 0.12,
            arpMs: 50,
            filter: 'lowpass',
            filterFreq: 3500
        });
        vibrate([60, 60, 80, 60, 100]);
    }

    function timerLow() {
        // Two short square ticks at 880Hz — urgent but tasteful.
        chord({ notes: [N.A4 * 2], type: 'square', duration: 0.07, peakVol: 0.08 });
    }

    function chatMessage() {
        // Gentle two-note "you have mail" ping.
        chord({ notes: [N.G4, N.B4], type: 'sine', duration: 0.18, peakVol: 0.09, arpMs: 40 });
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
        chatMessage
    };
}));
