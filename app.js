"use strict";

/* ============================================
   Stillness — Meditation Timer
   Zero external dependencies

   Audio strategy: render bowl sounds directly
   into WAV files played via <audio> elements.
   No Web Audio API — iOS blocks it too often.
   ============================================ */

(function() {
    // ── DOM refs ──
    var $ = function(sel) { return document.querySelector(sel); };
    var mainScreen    = $("#main-screen");
    var settingsScreen = $("#settings-screen");
    var playButton    = $("#play-button");
    var playIcon      = $("#play-icon");
    var stopIcon      = $("#stop-icon");
    var statusText    = $("#status-text");
    var timerDisplay  = $("#timer-display");
    var phaseLabel    = $("#phase-label");
    var progressFill  = $("#progress-fill");
    var settingsBtn   = $("#settings-button");
    var closeSettingsBtn = $("#close-settings");
    var previewSound  = $("#preview-sound");
    var totalTimeEl   = $("#total-time");
    var settleValue   = $("#settle-value");
    var meditateValue = $("#meditate-value");
    var emergeValue   = $("#emerge-value");

    // ── Constants ──
    var CIRCUMFERENCE = 2 * Math.PI * 90;
    var SAMPLE_RATE = 44100;

    // ── State ──
    var durations = loadDurations();
    var state = "idle"; // idle | running | complete
    var currentPhase = "";
    var timerRAF = null;
    var wakeLock = null;
    var phases = [];
    var sessionEndTime = 0;
    var bellTimes = [];
    var bellFired = [];

    // The single <audio> element that plays the entire session audio
    // (silence with bowl sounds baked in at the right timestamps)
    var sessionAudio = document.createElement("audio");
    sessionAudio.setAttribute("x-webkit-airplay", "deny");
    sessionAudio.style.display = "none";
    document.body.appendChild(sessionAudio);

    // Pre-rendered bowl sound blob URL (just the ding, ~6 seconds)
    var bowlSoundUrl = null;

    /* ============================================
       WAV file generation utilities
       ============================================ */
    function writeString(view, offset, str) {
        for (var i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    function createWavBlob(samples, sampleRate) {
        var numSamples = samples.length;
        var dataSize = numSamples * 2;
        var buffer = new ArrayBuffer(44 + dataSize);
        var view = new DataView(buffer);

        writeString(view, 0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(view, 8, "WAVE");
        writeString(view, 12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);          // PCM
        view.setUint16(22, 1, true);          // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(view, 36, "data");
        view.setUint32(40, dataSize, true);

        // Write 16-bit samples
        for (var i = 0; i < numSamples; i++) {
            var s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(44 + i * 2, s * 32767, true);
        }

        return new Blob([buffer], { type: "audio/wav" });
    }

    /* ============================================
       Singing Bowl Sound — rendered to sample array
       Returns Float32Array of audio samples
       ============================================ */
    function renderBowlSamples() {
        var duration = 6; // seconds
        var numSamples = Math.ceil(SAMPLE_RATE * duration);
        var samples = new Float32Array(numSamples);

        var partials = [
            { freq: 220,  gain: 0.35, decay: 5.0 },
            { freq: 440,  gain: 0.20, decay: 4.0 },
            { freq: 528,  gain: 0.12, decay: 3.5 },
            { freq: 660,  gain: 0.08, decay: 3.0 },
            { freq: 880,  gain: 0.05, decay: 2.5 },
            { freq: 1100, gain: 0.03, decay: 2.0 },
        ];

        for (var i = 0; i < numSamples; i++) {
            var t = i / SAMPLE_RATE;
            var sample = 0;

            for (var p = 0; p < partials.length; p++) {
                var partial = partials[p];
                // Slight pitch drift for realism
                var freq = partial.freq + (partial.freq * -0.002) * (t / partial.decay);
                // Exponential decay envelope
                var envelope = partial.gain * Math.exp(-t * (5.0 / partial.decay));
                // Quick attack (first 20ms)
                var attack = t < 0.02 ? t / 0.02 : 1.0;
                sample += Math.sin(2 * Math.PI * freq * t) * envelope * attack;
            }

            // Strike transient (first 80ms): filtered noise burst
            if (t < 0.08) {
                var noiseEnv = 0.15 * Math.exp(-t * 50);
                // Simple pseudo-filtered noise using sin at various frequencies
                var noise = Math.sin(t * 800 * 2 * Math.PI + i) *
                            Math.sin(t * 1200 * 2 * Math.PI + i * 0.7) * 0.5;
                sample += noise * noiseEnv;
            }

            samples[i] = sample * 0.6; // master volume
        }

        return samples;
    }

    /**
     * Build a WAV file for the entire session:
     * silence with bowl sounds mixed in at the bell timestamps.
     * bellOffsets: array of offsets in seconds from start where bells should play
     */
    function renderSessionWav(totalDurationSeconds, bellOffsets) {
        var bowlSamples = renderBowlSamples();
        var totalSamples = Math.ceil(SAMPLE_RATE * totalDurationSeconds);
        var session = new Float32Array(totalSamples); // initialized to 0 (silence)

        for (var b = 0; b < bellOffsets.length; b++) {
            var startSample = Math.floor(bellOffsets[b] * SAMPLE_RATE);
            for (var i = 0; i < bowlSamples.length; i++) {
                var idx = startSample + i;
                if (idx < totalSamples) {
                    session[idx] += bowlSamples[i];
                }
            }
        }

        // Clamp
        for (var j = 0; j < totalSamples; j++) {
            if (session[j] > 1) session[j] = 1;
            if (session[j] < -1) session[j] = -1;
        }

        return createWavBlob(session, SAMPLE_RATE);
    }

    /**
     * Render just the bowl sound as a standalone WAV for preview
     */
    function renderBowlWav() {
        return createWavBlob(renderBowlSamples(), SAMPLE_RATE);
    }

    function showDingFlash() {
        try {
            var overlay = document.querySelector(".ding-overlay");
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.className = "ding-overlay";
                document.body.appendChild(overlay);
            }
            overlay.classList.remove("flash");
            void overlay.offsetWidth;
            overlay.classList.add("flash");
        } catch (e) { /* ignore */ }
    }

    /* ============================================
       Duration Persistence
       ============================================ */
    function loadDurations() {
        try {
            var saved = localStorage.getItem("stillness_durations");
            if (saved) {
                var parsed = JSON.parse(saved);
                if (
                    typeof parsed.settle === "number" && parsed.settle >= 1 && parsed.settle <= 30 &&
                    typeof parsed.meditate === "number" && parsed.meditate >= 1 && parsed.meditate <= 120 &&
                    typeof parsed.emerge === "number" && parsed.emerge >= 1 && parsed.emerge <= 30
                ) {
                    return parsed;
                }
            }
        } catch (e) { /* ignore */ }
        return { settle: 2, meditate: 20, emerge: 2 };
    }

    function saveDurations() {
        try {
            localStorage.setItem("stillness_durations", JSON.stringify(durations));
        } catch (e) { /* ignore */ }
    }

    /* ============================================
       Wake Lock
       ============================================ */
    function requestWakeLockAsync() {
        try {
            if ("wakeLock" in navigator) {
                navigator.wakeLock.request("screen").then(function(wl) {
                    wakeLock = wl;
                    wl.addEventListener("release", function() { wakeLock = null; });
                }).catch(function() {});
            }
        } catch (e) { /* ignore */ }
    }

    function releaseWakeLock() {
        try {
            if (wakeLock) { wakeLock.release(); wakeLock = null; }
        } catch (e) { /* ignore */ }
    }

    /* ============================================
       Session
       ============================================ */
    function startSession() {
        if (state === "running") {
            stopSession();
            return;
        }
        if (state === "complete") {
            stopSession();
        }

        var settleSeconds   = durations.settle * 60;
        var meditateSeconds = durations.meditate * 60;
        var emergeSeconds   = durations.emerge * 60;
        var totalSeconds    = settleSeconds + meditateSeconds + emergeSeconds;

        // Bell offsets from session start (in seconds)
        var bellOffsets = [
            0,                                              // bell 1: start settling
            settleSeconds,                                  // bell 2: start meditating
            settleSeconds + meditateSeconds,                // bell 3: start emerging
            settleSeconds + meditateSeconds + emergeSeconds // bell 4: complete
        ];

        // Render the entire session as a single WAV with bells baked in
        var wavBlob = renderSessionWav(totalSeconds + 8, bellOffsets);
        var wavUrl = URL.createObjectURL(wavBlob);

        // Clean up previous
        if (sessionAudio._blobUrl) { URL.revokeObjectURL(sessionAudio._blobUrl); }
        sessionAudio._blobUrl = wavUrl;
        sessionAudio.src = wavUrl;
        var playPromise = sessionAudio.play();
        if (playPromise && playPromise.catch) { playPromise.catch(function() {}); }

        // Build phase timeline using wall-clock timestamps for the UI
        var wallNow = Date.now();
        phases = [
            { name: "settle",   start: wallNow,                                            end: wallNow + settleSeconds * 1000 },
            { name: "meditate", start: wallNow + settleSeconds * 1000,                     end: wallNow + (settleSeconds + meditateSeconds) * 1000 },
            { name: "emerge",   start: wallNow + (settleSeconds + meditateSeconds) * 1000,  end: wallNow + totalSeconds * 1000 },
        ];
        sessionEndTime = wallNow + totalSeconds * 1000;

        // Bell wall-clock times for visual flash
        bellTimes = [];
        bellFired = [];
        for (var i = 0; i < bellOffsets.length; i++) {
            bellTimes.push(wallNow + bellOffsets[i] * 1000);
            bellFired.push(i === 0); // first bell fires immediately
        }

        // Update UI
        state = "running";
        currentPhase = "";
        playButton.classList.remove("breathing");
        playIcon.classList.add("hidden");
        stopIcon.classList.remove("hidden");
        requestWakeLockAsync();
        showDingFlash();

        if (timerRAF) cancelAnimationFrame(timerRAF);
        tickLoop();
    }

    function stopSession() {
        state = "idle";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        // Stop session audio
        try {
            sessionAudio.pause();
            sessionAudio.removeAttribute("src");
            if (sessionAudio._blobUrl) {
                URL.revokeObjectURL(sessionAudio._blobUrl);
                sessionAudio._blobUrl = null;
            }
        } catch (e) { /* ignore */ }

        releaseWakeLock();

        playIcon.classList.remove("hidden");
        stopIcon.classList.add("hidden");
        playButton.classList.add("breathing");

        statusText.textContent = "Ready to begin";
        statusText.className = "subtitle";
        timerDisplay.textContent = "";
        phaseLabel.textContent = "";
        setProgress(0);
        progressFill.setAttribute("class", "progress-fill");
    }

    /* ============================================
       UI Tick Loop
       ============================================ */
    function tickLoop() {
        if (state !== "running") return;

        var now = Date.now();

        if (now >= sessionEndTime) {
            completeSession();
            return;
        }

        // Fire visual flash for bells
        for (var b = 0; b < bellTimes.length; b++) {
            if (!bellFired[b] && now >= bellTimes[b]) {
                bellFired[b] = true;
                showDingFlash();
            }
        }

        // Find current phase
        var phase = null;
        for (var i = 0; i < phases.length; i++) {
            if (now >= phases[i].start && now < phases[i].end) {
                phase = phases[i];
                break;
            }
        }

        if (phase) {
            if (currentPhase !== phase.name) {
                currentPhase = phase.name;
                progressFill.setAttribute("class", "progress-fill phase-" + phase.name);
                statusText.className = "subtitle phase-" + phase.name;

                var labels = { settle: "Settling in\u2026", meditate: "Meditating\u2026", emerge: "Emerging\u2026" };
                statusText.textContent = labels[phase.name] || "";

                var phaseLabels = { settle: "Settling", meditate: "Meditation", emerge: "Emerging" };
                phaseLabel.textContent = phaseLabels[phase.name] || "";
            }

            var remaining = Math.max(0, phase.end - now) / 1000;
            var phaseDur = (phase.end - phase.start) / 1000;
            var elapsed = phaseDur - remaining;
            var progress = phaseDur > 0 ? elapsed / phaseDur : 0;

            var mins = Math.floor(remaining / 60);
            var secs = Math.floor(remaining % 60);
            timerDisplay.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
            setProgress(progress);
        }

        timerRAF = requestAnimationFrame(tickLoop);
    }

    function completeSession() {
        showDingFlash();

        state = "complete";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        statusText.textContent = "Session complete";
        statusText.className = "subtitle phase-complete";
        timerDisplay.textContent = "";
        phaseLabel.textContent = "Namaste";
        progressFill.setAttribute("class", "progress-fill phase-complete");
        setProgress(1);

        playIcon.classList.remove("hidden");
        stopIcon.classList.add("hidden");
        playButton.classList.add("breathing");

        releaseWakeLock();

        // Session audio will stop naturally when it ends.
        // Auto-reset UI after 10 seconds.
        setTimeout(function() {
            if (state === "complete") { stopSession(); }
        }, 10000);
    }

    function setProgress(fraction) {
        var clamped = Math.min(1, Math.max(0, fraction));
        progressFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - clamped);
    }

    /* ============================================
       Settings
       ============================================ */
    function openSettings() {
        if (state !== "idle") return;
        updateSettingsUI();
        mainScreen.classList.remove("active");
        settingsScreen.classList.add("active");
    }

    function closeSettingsPanel() {
        settingsScreen.classList.remove("active");
        mainScreen.classList.add("active");
    }

    function updateSettingsUI() {
        settleValue.textContent = durations.settle;
        meditateValue.textContent = durations.meditate;
        emergeValue.textContent = durations.emerge;
        var total = durations.settle + durations.meditate + durations.emerge;
        totalTimeEl.textContent = "Total: " + total + " minute" + (total !== 1 ? "s" : "");
    }

    function adjustDuration(target, direction) {
        var limits = {
            settle:   { min: 1, max: 30 },
            meditate: { min: 1, max: 120 },
            emerge:   { min: 1, max: 30 },
        };
        var lim = limits[target];
        if (!lim) return;
        durations[target] = Math.min(lim.max, Math.max(lim.min, durations[target] + direction));
        saveDurations();
        updateSettingsUI();
    }

    /* ============================================
       Event Listeners
       ============================================ */
    playButton.addEventListener("click", function() {
        startSession();
    });

    settingsBtn.addEventListener("click", openSettings);
    closeSettingsBtn.addEventListener("click", closeSettingsPanel);

    previewSound.addEventListener("click", function() {
        // Render bowl and play via <audio>
        try {
            var blob = renderBowlWav();
            var url = URL.createObjectURL(blob);
            if (sessionAudio._blobUrl) { URL.revokeObjectURL(sessionAudio._blobUrl); }
            sessionAudio._blobUrl = url;
            sessionAudio.src = url;
            var p = sessionAudio.play();
            if (p && p.catch) { p.catch(function(){}); }
        } catch (e) { /* ignore */ }
        showDingFlash();
    });

    var durationBtns = document.querySelectorAll(".duration-btn");
    for (var i = 0; i < durationBtns.length; i++) {
        (function(btn) {
            btn.addEventListener("click", function() {
                var target = btn.getAttribute("data-target");
                var dir = parseInt(btn.getAttribute("data-dir"), 10);
                adjustDuration(target, dir);
            });
        })(durationBtns[i]);
    }

    // When page becomes visible again, catch up UI
    document.addEventListener("visibilitychange", function() {
        if (document.visibilityState === "visible" && state === "running") {
            requestWakeLockAsync();
            if (timerRAF) cancelAnimationFrame(timerRAF);
            tickLoop();
        }
    });

    document.addEventListener("keydown", function(e) {
        if (e.key === "Escape" && settingsScreen.classList.contains("active")) {
            closeSettingsPanel();
        }
    });

    /* ============================================
       Init
       ============================================ */
    playButton.classList.add("breathing");
    setProgress(0);

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function() {});
    }
})();
