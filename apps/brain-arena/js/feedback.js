/*
 * Brain Arena — sound + haptic feedback.
 *
 * Tiny zero-asset feedback layer:
 *   - Sounds are synthesised on demand via WebAudio oscillators so we
 *     don't ship any .mp3/.ogg files (and don't pay for the network
 *     fetch / autoplay-policy waiver they'd need).
 *   - Vibration uses the Vibration API; quietly no-ops on devices that
 *     don't support it (desktop, iOS Safari).
 *
 * The first user-gesture-triggered play() unlocks the AudioContext on
 * iOS / Chrome's autoplay policy. Subsequent calls before that gesture
 * land cleanly suspended; ensureAudio() resumes on demand.
 *
 * UMD: CommonJS for node:test (mocked-out fallbacks let pure helpers
 * stay testable) + window.BrainArena.Feedback for the browser app.
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
    let enabled = true;    // master toggle; future Settings UI can flip it
    let vibrationEnabled = true;

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
            try { audioCtx = new Ctor(); }
            catch (e) { return null; }
        }
        // Some browsers start suspended until a user gesture happens.
        // resume() is a Promise; we don't await it because the very next
        // line schedules an oscillator and a queued schedule still plays.
        if (audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (e) { /* ignore */ }
        }
        return audioCtx;
    }

    /**
     * Play a short tone. `freq` Hz, `duration` ms, optional `type`
     * (sine/square/triangle/sawtooth), and `volume` 0-1. Linear ramps
     * on the gain envelope avoid the pop you'd get from a hard cut.
     */
    function tone({ freq = 440, duration = 120, type = 'sine', volume = 0.18, glideTo = null }) {
        if (!enabled) return;
        const ctx = ensureAudio();
        if (!ctx) return;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration / 1000);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.01);
        gain.gain.linearRampToValueAtTime(0, t + duration / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + duration / 1000 + 0.02);
    }

    function vibrate(pattern) {
        if (!vibrationEnabled || !isVibrationSupported()) return;
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }

    // --- Named feedback presets ---------------------------------------
    // Each preset is a (sound, haptic) pair tuned for the moment it
    // fires. Callers don't need to know the synthesis details — they
    // just say `Feedback.played('pin-placed')`.

    function pinPlaced()       { tone({ freq: 520, duration: 80, type: 'triangle' });        vibrate(15); }
    function pinCleared()      { tone({ freq: 280, duration: 90, type: 'triangle' });        vibrate(10); }
    function guessSubmitted()  { tone({ freq: 660, duration: 110, type: 'sine', glideTo: 880 }); vibrate([30, 40, 30]); }
    function opponentSubmitted(){ tone({ freq: 500, duration: 70, type: 'sine', volume: 0.12 }); vibrate(20); }
    function revealBullseye()  { tone({ freq: 880, duration: 200, type: 'triangle', glideTo: 1320 }); vibrate([40, 50, 80]); }
    function revealClose()     { tone({ freq: 700, duration: 160, type: 'sine' });           vibrate(30); }
    function revealFar()       { tone({ freq: 220, duration: 200, type: 'sawtooth', volume: 0.10 }); vibrate(15); }
    function gameStart()       { tone({ freq: 440, duration: 180, type: 'triangle', glideTo: 660 }); vibrate([30, 30, 30]); }
    function gameEnd()         { tone({ freq: 660, duration: 320, type: 'triangle', glideTo: 990 }); vibrate([60, 80, 60, 80, 100]); }
    function timerLow()        { tone({ freq: 880, duration: 60, type: 'square', volume: 0.10 }); }
    function chatMessage()     { tone({ freq: 720, duration: 90, type: 'sine', volume: 0.12 }); vibrate(15); }

    function setEnabled(v) { enabled = !!v; }
    function setVibrationEnabled(v) { vibrationEnabled = !!v; }
    function isEnabled() { return enabled; }

    return {
        // Lifecycle
        ensureAudio,
        setEnabled,
        setVibrationEnabled,
        isEnabled,
        // Low-level
        tone,
        vibrate,
        // Presets
        pinPlaced,
        pinCleared,
        guessSubmitted,
        opponentSubmitted,
        revealBullseye,
        revealClose,
        revealFar,
        gameStart,
        gameEnd,
        timerLow,
        chatMessage
    };
}));
