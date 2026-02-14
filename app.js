"use strict";

/* ============================================
   Stillness — Meditation Timer
   Zero external dependencies
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

    // ── Audio ──
    // Single AudioContext, created once on first user gesture, never closed.
    var audioCtx = null;

    function ensureAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }
        return audioCtx;
    }

    /* ============================================
       Singing Bowl Sound
       Schedules a bowl ding at `when` (AudioContext time).
       All scheduling must happen within a user gesture
       call stack for iOS to allow playback.
       ============================================ */
    function scheduleBowlSound(ctx, when) {
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
        masterGain.gain.setValueAtTime(0.6, when);
        masterGain.connect(ctx.destination);

        for (var i = 0; i < partials.length; i++) {
            var p = partials[i];
            var osc = ctx.createOscillator();
            var oscGain = ctx.createGain();

            osc.type = "sine";
            osc.frequency.setValueAtTime(p.freq, when);
            oscGain.gain.setValueAtTime(0.001, when);
            oscGain.gain.linearRampToValueAtTime(p.gain, when + 0.02);
            oscGain.gain.exponentialRampToValueAtTime(0.0001, when + p.decay);
            osc.frequency.linearRampToValueAtTime(p.freq * 0.998, when + p.decay);

            osc.connect(oscGain);
            oscGain.connect(masterGain);
            osc.start(when);
            osc.stop(when + duration);
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
        noiseGain.gain.setValueAtTime(0.15, when);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, when + 0.08);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(masterGain);
        noise.start(when);
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
            state = "idle";
        }

        // 1. Ensure AudioContext exists and is running
        var ctx = ensureAudioContext();

        // 2. Calculate timeline
        var settleSeconds   = durations.settle * 60;
        var meditateSeconds = durations.meditate * 60;
        var emergeSeconds   = durations.emerge * 60;

        // 3. Schedule all four bells on the AudioContext timeline
        //    This all happens synchronously within the click handler,
        //    so iOS treats it as user-gesture-initiated audio.
        var now = ctx.currentTime;
        scheduleBowlSound(ctx, now);
        scheduleBowlSound(ctx, now + settleSeconds);
        scheduleBowlSound(ctx, now + settleSeconds + meditateSeconds);
        scheduleBowlSound(ctx, now + settleSeconds + meditateSeconds + emergeSeconds);

        // 4. Build phase timeline (wall-clock for UI)
        var wallNow = Date.now();
        phases = [
            { name: "settle",   start: wallNow, end: wallNow + settleSeconds * 1000 },
            { name: "meditate", start: wallNow + settleSeconds * 1000, end: wallNow + (settleSeconds + meditateSeconds) * 1000 },
            { name: "emerge",   start: wallNow + (settleSeconds + meditateSeconds) * 1000, end: wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000 },
        ];
        sessionEndTime = wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000;

        bellTimes = [
            wallNow,
            wallNow + settleSeconds * 1000,
            wallNow + (settleSeconds + meditateSeconds) * 1000,
            wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000,
        ];
        bellFired = [true, false, false, false];

        // 5. Update UI
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

        // Don't close the AudioContext — just let scheduled sounds finish
        // or they'll be cut off. Closing and recreating causes iOS issues.

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

        // Visual flash for bells
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
        var ctx = ensureAudioContext();
        scheduleBowlSound(ctx, ctx.currentTime);
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

    document.addEventListener("visibilitychange", function() {
        if (document.visibilityState === "visible" && state === "running") {
            requestWakeLockAsync();
            // Resume audio context if iOS suspended it
            if (audioCtx && audioCtx.state === "suspended") {
                audioCtx.resume();
            }
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
