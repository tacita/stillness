"use strict";

/* ============================================
   Stillness — Meditation Timer
   Zero external dependencies
   ============================================ */

(() => {
    // ── DOM refs ──
    const $ = (sel) => document.querySelector(sel);
    const mainScreen    = $("#main-screen");
    const settingsScreen = $("#settings-screen");
    const playButton    = $("#play-button");
    const playIcon      = $("#play-icon");
    const stopIcon      = $("#stop-icon");
    const statusText    = $("#status-text");
    const timerDisplay  = $("#timer-display");
    const phaseLabel    = $("#phase-label");
    const progressFill  = $("#progress-fill");
    const settingsBtn   = $("#settings-button");
    const closeSettings = $("#close-settings");
    const previewSound  = $("#preview-sound");
    const totalTimeEl   = $("#total-time");
    const settleValue   = $("#settle-value");
    const meditateValue = $("#meditate-value");
    const emergeValue   = $("#emerge-value");

    // ── State ──
    const CIRCUMFERENCE = 2 * Math.PI * 90; // matches SVG circle r=90

    let durations = loadDurations();
    let state = "idle"; // idle | settle | meditate | emerge | complete
    let timerRAF = null;
    let phaseEndTime = 0;
    let phaseDuration = 0;
    let wakeLock = null;

    // ── Audio ──
    let audioCtx = null;
    let audioUnlocked = false;

    // Hidden <audio> element — playing this on a user gesture unlocks
    // the iOS audio session (bypasses mute switch for Web Audio API).
    let silentAudio = null;
    try {
        silentAudio = document.createElement("audio");
        silentAudio.setAttribute("x-webkit-airplay", "deny");
        silentAudio.preload = "auto";
        silentAudio.src = "silence.wav";
        silentAudio.style.display = "none";
        document.body.appendChild(silentAudio);
    } catch (e) {
        // If this fails, we'll still try Web Audio directly
    }

    function getAudioContext() {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === "suspended") {
                audioCtx.resume();
            }
        } catch (e) {
            // AudioContext not available
        }
        return audioCtx;
    }

    /**
     * Must be called from a direct user gesture (click/touchend).
     * Unlocks iOS audio session so subsequent programmatic playback works.
     */
    function unlockAudio() {
        // 1. Play the silent <audio> element (unlocks mute switch)
        if (silentAudio) {
            try {
                var p = silentAudio.play();
                if (p && p.then) {
                    p.then(function() {
                        setTimeout(function() { silentAudio.pause(); }, 250);
                    }).catch(function() { /* ignore */ });
                }
            } catch (e) { /* ignore */ }
        }

        // 2. Create/resume AudioContext
        var ctx = getAudioContext();
        if (!ctx) return;

        // 3. Play a silent buffer through Web Audio
        try {
            var buf = ctx.createBuffer(1, 1, ctx.sampleRate);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) { /* ignore */ }

        audioUnlocked = true;
    }

    /* ============================================
       Singing Bowl Sound Synthesis
       ============================================ */
    function playBowlSound() {
        var ctx = getAudioContext();
        if (!ctx) return;

        try {
            // Force resume every time
            if (ctx.state === "suspended") {
                ctx.resume();
            }

            var now = ctx.currentTime;
            var duration = 6;

            var partials = [
                { freq: 220,  gain: 0.35, decay: 5.0 },
                { freq: 440,  gain: 0.20, decay: 4.0 },
                { freq: 528,  gain: 0.12, decay: 3.5 },
                { freq: 660,  gain: 0.08, decay: 3.0 },
                { freq: 880,  gain: 0.05, decay: 2.5 },
                { freq: 1100, gain: 0.03, decay: 2.0 },
            ];

            var masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(0.6, now);
            masterGain.connect(ctx.destination);

            for (var i = 0; i < partials.length; i++) {
                var p = partials[i];
                var osc = ctx.createOscillator();
                var oscGain = ctx.createGain();

                osc.type = "sine";
                osc.frequency.setValueAtTime(p.freq, now);

                oscGain.gain.setValueAtTime(0.001, now);
                oscGain.gain.linearRampToValueAtTime(p.gain, now + 0.02);
                oscGain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);

                osc.frequency.linearRampToValueAtTime(p.freq * 0.998, now + p.decay);

                osc.connect(oscGain);
                oscGain.connect(masterGain);

                osc.start(now);
                osc.stop(now + duration);
            }

            // Strike transient
            var noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
            var noiseData = noiseBuf.getChannelData(0);
            for (var j = 0; j < noiseData.length; j++) {
                noiseData[j] = (Math.random() * 2 - 1) * 0.3;
            }
            var noise = ctx.createBufferSource();
            noise.buffer = noiseBuf;

            var noiseFilter = ctx.createBiquadFilter();
            noiseFilter.type = "bandpass";
            noiseFilter.frequency.value = 800;
            noiseFilter.Q.value = 1.5;

            var noiseGain = ctx.createGain();
            noiseGain.gain.setValueAtTime(0.15, now);
            noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

            noise.connect(noiseFilter);
            noiseFilter.connect(noiseGain);
            noiseGain.connect(masterGain);
            noise.start(now);
        } catch (e) {
            // Audio synthesis failed — continue silently
        }

        showDingFlash();
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
    async function requestWakeLock() {
        try {
            if ("wakeLock" in navigator) {
                wakeLock = await navigator.wakeLock.request("screen");
                wakeLock.addEventListener("release", function() { wakeLock = null; });
            }
        } catch (e) { /* ignore */ }
    }

    function releaseWakeLock() {
        try {
            if (wakeLock) {
                wakeLock.release();
                wakeLock = null;
            }
        } catch (e) { /* ignore */ }
    }

    /* ============================================
       Timer Engine
       Uses requestAnimationFrame instead of setInterval.
       RAF is more reliable on iOS — setInterval gets
       aggressively throttled or stopped when the page
       is not in the foreground.
       ============================================ */
    function startSession() {
        // If already running, stop first
        if (state !== "idle" && state !== "complete") {
            stopSession();
            return;
        }

        // Reset if was complete
        if (state === "complete") {
            stopSession();
        }

        // Unlock audio (must be in user gesture handler)
        unlockAudio();

        requestWakeLock();
        playButton.classList.remove("breathing");
        playIcon.classList.add("hidden");
        stopIcon.classList.remove("hidden");

        // Phase 1: ding, then settle
        playBowlSound();
        startPhase("settle", durations.settle * 60);
    }

    function stopSession() {
        if (timerRAF) {
            cancelAnimationFrame(timerRAF);
            timerRAF = null;
        }
        state = "idle";
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

    function startPhase(phaseName, seconds) {
        state = phaseName;
        phaseDuration = seconds;
        phaseEndTime = Date.now() + seconds * 1000;

        // Update UI colors
        progressFill.setAttribute("class", "progress-fill phase-" + phaseName);
        statusText.className = "subtitle phase-" + phaseName;

        var labels = {
            settle: "Settling in\u2026",
            meditate: "Meditating\u2026",
            emerge: "Emerging\u2026",
        };
        statusText.textContent = labels[phaseName] || "";

        var phaseLabels = {
            settle: "Settling",
            meditate: "Meditation",
            emerge: "Emerging",
        };
        phaseLabel.textContent = phaseLabels[phaseName] || "";

        // Start the tick loop using RAF
        if (timerRAF) cancelAnimationFrame(timerRAF);
        scheduleNextTick();
    }

    function scheduleNextTick() {
        timerRAF = requestAnimationFrame(function() {
            tick();
        });
    }

    function tick() {
        // Guard: if we're not in an active phase, don't tick
        if (state === "idle" || state === "complete") return;

        var now = Date.now();
        var remaining = Math.max(0, phaseEndTime - now) / 1000;
        var elapsed = phaseDuration - remaining;
        var progress = phaseDuration > 0 ? elapsed / phaseDuration : 0;

        // Update display
        var mins = Math.floor(remaining / 60);
        var secs = Math.floor(remaining % 60);
        timerDisplay.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
        setProgress(progress);

        if (remaining <= 0) {
            // Phase complete — advance
            advancePhase();
        } else {
            // Schedule next tick
            scheduleNextTick();
        }
    }

    function advancePhase() {
        if (state === "settle") {
            playBowlSound();
            startPhase("meditate", durations.meditate * 60);
        } else if (state === "meditate") {
            playBowlSound();
            startPhase("emerge", durations.emerge * 60);
        } else if (state === "emerge") {
            playBowlSound();
            completeSession();
        }
    }

    function completeSession() {
        state = "complete";
        if (timerRAF) {
            cancelAnimationFrame(timerRAF);
            timerRAF = null;
        }

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

        // Auto-reset after 10 seconds
        setTimeout(function() {
            if (state === "complete") {
                stopSession();
            }
        }, 10000);
    }

    function setProgress(fraction) {
        var clamped = Math.min(1, Math.max(0, fraction));
        var offset = CIRCUMFERENCE * (1 - clamped);
        progressFill.style.strokeDashoffset = offset;
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
    closeSettings.addEventListener("click", closeSettingsPanel);
    previewSound.addEventListener("click", function() {
        unlockAudio();
        playBowlSound();
    });

    // Duration +/- buttons
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

    // When page becomes visible again, catch up
    document.addEventListener("visibilitychange", function() {
        if (document.visibilityState === "visible" && state !== "idle" && state !== "complete") {
            requestWakeLock();
            // Resume audio context if iOS suspended it
            if (audioCtx) {
                try { audioCtx.resume(); } catch (e) { /* ignore */ }
            }
            // Restart the tick loop to catch up
            scheduleNextTick();
        }
    });

    // Handle escape key
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

    // Register service worker
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function() {
            // SW registration failed — app still works
        });
    }
})();
