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
    var currentPhase = ""; // settle | meditate | emerge
    var timerRAF = null;
    var wakeLock = null;

    // Phase timeline (absolute Date.now() timestamps)
    var phases = []; // [{name, start, end}, ...]
    var sessionEndTime = 0;

    // ── Audio ──
    var audioCtx = null;

    // Hidden <audio> element that plays a silent track for the full session.
    // iOS keeps <audio> elements alive even when the screen locks (like music).
    // This keeps the AudioContext timeline running so our scheduled bells fire.
    var keepAliveAudio = document.createElement("audio");
    keepAliveAudio.setAttribute("x-webkit-airplay", "deny");
    keepAliveAudio.style.display = "none";
    document.body.appendChild(keepAliveAudio);

    function getOrCreateAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioCtx;
    }

    /**
     * Generate a silent WAV blob URL of the given duration in seconds.
     * This is a valid audio file that iOS will happily play in the background,
     * keeping the audio session alive for our Web Audio API bells.
     */
    function createSilentWavUrl(durationSeconds) {
        var sampleRate = 22050; // low rate to keep file small
        var numSamples = Math.ceil(sampleRate * durationSeconds);
        var dataSize = numSamples * 2; // 16-bit mono = 2 bytes per sample
        var fileSize = 44 + dataSize;  // 44-byte WAV header + data

        var buffer = new ArrayBuffer(fileSize);
        var view = new DataView(buffer);

        // WAV header
        writeString(view, 0, "RIFF");
        view.setUint32(4, fileSize - 8, true);
        writeString(view, 8, "WAVE");
        writeString(view, 12, "fmt ");
        view.setUint32(16, 16, true);           // chunk size
        view.setUint16(20, 1, true);            // PCM format
        view.setUint16(22, 1, true);            // mono
        view.setUint32(24, sampleRate, true);   // sample rate
        view.setUint32(28, sampleRate * 2, true); // byte rate
        view.setUint16(32, 2, true);            // block align
        view.setUint16(34, 16, true);           // bits per sample
        writeString(view, 36, "data");
        view.setUint32(40, dataSize, true);
        // Data is all zeros (silence) — ArrayBuffer is zero-initialized

        var blob = new Blob([buffer], { type: "audio/wav" });
        return URL.createObjectURL(blob);
    }

    function writeString(view, offset, str) {
        for (var i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    /* ============================================
       Singing Bowl Sound — scheduled on AudioContext timeline
       `when` is in AudioContext seconds (ctx.currentTime based)
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
                }).catch(function() { /* ignore */ });
            }
        } catch (e) { /* ignore */ }
    }

    function releaseWakeLock() {
        try {
            if (wakeLock) { wakeLock.release(); wakeLock = null; }
        } catch (e) { /* ignore */ }
    }

    /* ============================================
       Session — pre-schedules ALL sounds at start
       ============================================ */
    function startSession() {
        if (state === "running") {
            stopSession();
            return;
        }
        if (state === "complete") {
            stopSession();
        }

        // 1. Create/resume audio context
        var ctx = getOrCreateAudioContext();
        if (ctx.state === "suspended") { ctx.resume(); }

        // 3. Calculate the timeline
        var settleSeconds  = durations.settle * 60;
        var meditateSeconds = durations.meditate * 60;
        var emergeSeconds  = durations.emerge * 60;

        var now = ctx.currentTime;
        //
        // Timeline (in AudioContext seconds from `now`):
        //   0s          — bell 1 (start settling)
        //   settle      — bell 2 (start meditating)
        //   settle+med  — bell 3 (start emerging)
        //   settle+med+emerge — bell 4 (complete)
        //
        var bell1 = now;
        var bell2 = now + settleSeconds;
        var bell3 = now + settleSeconds + meditateSeconds;
        var bell4 = now + settleSeconds + meditateSeconds + emergeSeconds;

        // 4. Schedule ALL four bells right now (from user gesture context)
        try {
            scheduleBowlSound(ctx, bell1);
            scheduleBowlSound(ctx, bell2);
            scheduleBowlSound(ctx, bell3);
            scheduleBowlSound(ctx, bell4);
        } catch (e) { /* ignore */ }

        // 5. Start a silent <audio> track for the full session duration.
        //    iOS keeps <audio> alive when the screen locks, which in turn
        //    keeps our AudioContext timeline running so the bells fire on time.
        var totalSeconds = settleSeconds + meditateSeconds + emergeSeconds + 10; // +10s buffer
        try {
            // Revoke any previous blob URL
            if (keepAliveAudio._blobUrl) { URL.revokeObjectURL(keepAliveAudio._blobUrl); }
            var wavUrl = createSilentWavUrl(totalSeconds);
            keepAliveAudio._blobUrl = wavUrl;
            keepAliveAudio.src = wavUrl;
            var playPromise = keepAliveAudio.play();
            if (playPromise && playPromise.catch) { playPromise.catch(function() {}); }
        } catch (e) { /* ignore — bells still work, just may not survive screen lock */ }

        // 6. Build phase timeline using wall-clock timestamps for the UI
        var wallNow = Date.now();
        phases = [
            { name: "settle",   start: wallNow,                                          end: wallNow + settleSeconds * 1000 },
            { name: "meditate", start: wallNow + settleSeconds * 1000,                   end: wallNow + (settleSeconds + meditateSeconds) * 1000 },
            { name: "emerge",   start: wallNow + (settleSeconds + meditateSeconds) * 1000, end: wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000 },
        ];
        sessionEndTime = wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000;

        // Also store bell wall-clock times for visual flash
        window._bellTimes = [
            wallNow,
            wallNow + settleSeconds * 1000,
            wallNow + (settleSeconds + meditateSeconds) * 1000,
            wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000,
        ];
        window._bellFired = [true, false, false, false]; // first bell fires immediately

        // 6. Update UI
        state = "running";
        playButton.classList.remove("breathing");
        playIcon.classList.add("hidden");
        stopIcon.classList.remove("hidden");
        requestWakeLockAsync();
        showDingFlash();

        // 7. Start the UI tick loop
        if (timerRAF) cancelAnimationFrame(timerRAF);
        tickLoop();
    }

    function stopSession() {
        state = "idle";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        // Stop the keep-alive audio track
        try {
            keepAliveAudio.pause();
            keepAliveAudio.removeAttribute("src");
            if (keepAliveAudio._blobUrl) {
                URL.revokeObjectURL(keepAliveAudio._blobUrl);
                keepAliveAudio._blobUrl = null;
            }
        } catch (e) { /* ignore */ }

        // Stop all scheduled audio by closing and discarding the context
        if (audioCtx) {
            try { audioCtx.close(); } catch (e) { /* ignore */ }
            audioCtx = null;
        }

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
       UI Tick Loop — purely visual, no audio logic
       ============================================ */
    function tickLoop() {
        if (state !== "running") return;

        var now = Date.now();

        // Check if session is complete
        if (now >= sessionEndTime) {
            completeSession();
            return;
        }

        // Fire visual flash for bells
        if (window._bellTimes && window._bellFired) {
            for (var b = 0; b < window._bellTimes.length; b++) {
                if (!window._bellFired[b] && now >= window._bellTimes[b]) {
                    window._bellFired[b] = true;
                    showDingFlash();
                }
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
            // Update phase label and color if changed
            if (currentPhase !== phase.name) {
                currentPhase = phase.name;
                progressFill.setAttribute("class", "progress-fill phase-" + phase.name);
                statusText.className = "subtitle phase-" + phase.name;

                var labels = { settle: "Settling in\u2026", meditate: "Meditating\u2026", emerge: "Emerging\u2026" };
                statusText.textContent = labels[phase.name] || "";

                var phaseLabels = { settle: "Settling", meditate: "Meditation", emerge: "Emerging" };
                phaseLabel.textContent = phaseLabels[phase.name] || "";
            }

            // Timer countdown for current phase
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
        // Fire final flash
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
        // Play a short silent wav to unlock iOS audio session, then play bowl
        try {
            var url = createSilentWavUrl(1);
            keepAliveAudio.src = url;
            var p = keepAliveAudio.play();
            if (p && p.then) { p.then(function() { setTimeout(function() { keepAliveAudio.pause(); URL.revokeObjectURL(url); }, 500); }).catch(function(){}); }
        } catch (e) {}
        var ctx = getOrCreateAudioContext();
        if (ctx.state === "suspended") { ctx.resume(); }
        try { scheduleBowlSound(ctx, ctx.currentTime); } catch (e) {}
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

    // When page becomes visible again, resume audio and catch up UI
    document.addEventListener("visibilitychange", function() {
        if (document.visibilityState === "visible" && state === "running") {
            requestWakeLockAsync();
            if (audioCtx && audioCtx.state === "suspended") {
                try { audioCtx.resume(); } catch (e) {}
            }
            // Restart tick loop to update UI
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
