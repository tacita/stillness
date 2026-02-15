"use strict";

/* ============================================
   Stillness — Meditation Timer
   Zero external dependencies

   Audio strategy (iOS-proof):
   - On session start, fetch bowl.wav and decode its raw PCM samples
   - Build a single WAV blob containing the entire session:
     silence with bowl sounds mixed in at the correct timestamps
   - Play that single WAV via one <audio> element
   - iOS plays it as one continuous stream — no timers needed for bells
   - UI updates via requestAnimationFrame + audio timeupdate fallback
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
    var sessionStartTime = 0;

    // The single <audio> element that plays the entire session
    var sessionAudio = document.createElement("audio");
    sessionAudio.preload = "auto";
    sessionAudio.style.display = "none";
    document.body.appendChild(sessionAudio);

    // Cached bowl samples (Int16Array of raw PCM)
    var bowlSamples = null;
    var bowlLoading = false;

    // Bell offsets in seconds (for ding flash UI)
    var bellOffsets = [];
    var bellFlashed = [];

    // Preview player
    var previewEl = document.createElement("audio");
    previewEl.preload = "auto";
    previewEl.src = "bowl.wav";
    previewEl.style.display = "none";
    document.body.appendChild(previewEl);

    /* ============================================
       Load and decode bowl.wav into raw PCM samples
       ============================================ */
    function loadBowlSamples(callback) {
        if (bowlSamples) {
            callback(bowlSamples);
            return;
        }
        if (bowlLoading) {
            // Wait for it
            var check = setInterval(function() {
                if (bowlSamples) {
                    clearInterval(check);
                    callback(bowlSamples);
                }
            }, 50);
            return;
        }
        bowlLoading = true;

        // Fetch the raw bytes of bowl.wav
        fetch("bowl.wav").then(function(resp) {
            return resp.arrayBuffer();
        }).then(function(arrayBuf) {
            // Parse the WAV file manually to extract Int16 PCM samples
            // (We don't use Web Audio decodeAudioData because we need Int16,
            //  and this avoids creating an AudioContext entirely)
            var view = new DataView(arrayBuf);

            // Find the "data" chunk
            var offset = 12; // skip RIFF header
            while (offset < view.byteLength - 8) {
                var chunkId = String.fromCharCode(
                    view.getUint8(offset),
                    view.getUint8(offset + 1),
                    view.getUint8(offset + 2),
                    view.getUint8(offset + 3)
                );
                var chunkSize = view.getUint32(offset + 4, true);
                if (chunkId === "data") {
                    var numSamples = chunkSize / 2; // 16-bit = 2 bytes per sample
                    bowlSamples = new Int16Array(numSamples);
                    for (var i = 0; i < numSamples; i++) {
                        bowlSamples[i] = view.getInt16(offset + 8 + i * 2, true);
                    }
                    break;
                }
                offset += 8 + chunkSize;
                if (chunkSize % 2 !== 0) offset++; // WAV chunks are word-aligned
            }

            if (!bowlSamples) {
                bowlSamples = new Int16Array(0);
            }
            bowlLoading = false;
            callback(bowlSamples);
        }).catch(function() {
            bowlSamples = new Int16Array(0);
            bowlLoading = false;
            callback(bowlSamples);
        });
    }

    /* ============================================
       Build a WAV blob for the entire session
       ============================================ */
    function buildSessionWav(bowlPCM, totalSeconds, bellOffsetsSeconds) {
        var totalSamples = totalSeconds * SAMPLE_RATE;
        // Add a few seconds of padding after the last bell for it to ring out
        var padSamples = Math.min(bowlPCM.length, 6 * SAMPLE_RATE);
        var bufferLength = totalSamples + padSamples;

        // Create buffer initialized to silence (zeros)
        var buffer = new Int16Array(bufferLength);

        // Mix in bowl sounds at each bell offset
        for (var b = 0; b < bellOffsetsSeconds.length; b++) {
            var startSample = Math.round(bellOffsetsSeconds[b] * SAMPLE_RATE);
            for (var s = 0; s < bowlPCM.length; s++) {
                var idx = startSample + s;
                if (idx >= 0 && idx < bufferLength) {
                    // Mix (clamp to Int16 range)
                    var mixed = buffer[idx] + bowlPCM[s];
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;
                    buffer[idx] = mixed;
                }
            }
        }

        // Encode as WAV
        var dataSize = bufferLength * 2;
        var wavSize = 44 + dataSize;
        var wav = new ArrayBuffer(wavSize);
        var v = new DataView(wav);

        // RIFF header
        writeString(v, 0, "RIFF");
        v.setUint32(4, wavSize - 8, true);
        writeString(v, 8, "WAVE");

        // fmt chunk
        writeString(v, 12, "fmt ");
        v.setUint32(16, 16, true);       // chunk size
        v.setUint16(20, 1, true);        // PCM format
        v.setUint16(22, 1, true);        // mono
        v.setUint32(24, SAMPLE_RATE, true);
        v.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
        v.setUint16(32, 2, true);        // block align
        v.setUint16(34, 16, true);       // bits per sample

        // data chunk
        writeString(v, 36, "data");
        v.setUint32(40, dataSize, true);

        // Write PCM samples
        for (var i = 0; i < bufferLength; i++) {
            v.setInt16(44 + i * 2, buffer[i], true);
        }

        return new Blob([wav], { type: "audio/wav" });
    }

    function writeString(view, offset, str) {
        for (var i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    /* ============================================
       Ding flash (visual indicator when bell plays)
       ============================================ */
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

        // Show loading state
        statusText.textContent = "Preparing\u2026";
        playButton.classList.remove("breathing");

        loadBowlSamples(function(bowlPCM) {
            if (bowlPCM.length === 0) {
                statusText.textContent = "Audio error — please reload";
                playButton.classList.add("breathing");
                return;
            }

            var settleSeconds   = durations.settle * 60;
            var meditateSeconds = durations.meditate * 60;
            var emergeSeconds   = durations.emerge * 60;
            var totalSeconds    = settleSeconds + meditateSeconds + emergeSeconds;

            // Bell offsets in seconds from start of audio
            bellOffsets = [
                0,
                settleSeconds,
                settleSeconds + meditateSeconds,
                totalSeconds,
            ];
            bellFlashed = [false, false, false, false];

            // Build the full session WAV
            var blob = buildSessionWav(bowlPCM, totalSeconds, bellOffsets);
            var url = URL.createObjectURL(blob);

            // Clean up previous blob URL
            if (sessionAudio._blobUrl) {
                URL.revokeObjectURL(sessionAudio._blobUrl);
            }
            sessionAudio._blobUrl = url;
            sessionAudio.src = url;

            // Phase timeline (wall-clock for UI)
            var wallNow = Date.now();
            sessionStartTime = wallNow;
            phases = [
                { name: "settle",   start: wallNow, end: wallNow + settleSeconds * 1000 },
                { name: "meditate", start: wallNow + settleSeconds * 1000, end: wallNow + (settleSeconds + meditateSeconds) * 1000 },
                { name: "emerge",   start: wallNow + (settleSeconds + meditateSeconds) * 1000, end: wallNow + totalSeconds * 1000 },
            ];
            sessionEndTime = wallNow + totalSeconds * 1000;

            // Play the session audio (we're still in user gesture context)
            var p = sessionAudio.play();
            if (p && p.catch) { p.catch(function() {}); }

            // Update UI
            state = "running";
            currentPhase = "";
            playIcon.classList.add("hidden");
            stopIcon.classList.remove("hidden");
            requestWakeLockAsync();

            // Flash for the first bell immediately
            bellFlashed[0] = true;
            showDingFlash();

            if (timerRAF) cancelAnimationFrame(timerRAF);
            tickLoop();
        });
    }

    function stopSession() {
        state = "idle";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        // Stop session audio
        try {
            sessionAudio.pause();
            sessionAudio.currentTime = 0;
        } catch (e) {}

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
       UI Updates
       ============================================ */
    function updateUI() {
        var now = Date.now();

        if (now >= sessionEndTime) {
            // Wait for the last bell to finish ringing (6 seconds)
            // before completing the session
            var lastBellEnd = sessionEndTime + 6000;
            if (now >= lastBellEnd) {
                completeSession();
                return;
            }
        }

        // Check for ding flashes based on audio currentTime
        var audioTime = sessionAudio.currentTime;
        for (var b = 0; b < bellOffsets.length; b++) {
            if (!bellFlashed[b] && audioTime >= bellOffsets[b]) {
                bellFlashed[b] = true;
                showDingFlash();
            }
        }

        var phase = null;
        for (var i = 0; i < phases.length; i++) {
            if (now >= phases[i].start && now < phases[i].end) {
                phase = phases[i];
                break;
            }
        }
        // If past all phases but before session truly ends, show last phase
        if (!phase && now >= sessionEndTime && phases.length > 0) {
            phase = phases[phases.length - 1];
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
    }

    // RAF loop for smooth UI updates
    function tickLoop() {
        if (state !== "running") return;
        updateUI();
        timerRAF = requestAnimationFrame(tickLoop);
    }

    // Also update on audio timeupdate (fires even when RAF is throttled)
    sessionAudio.addEventListener("timeupdate", function() {
        if (state === "running") {
            updateUI();
        }
    });

    sessionAudio.addEventListener("ended", function() {
        if (state === "running") {
            completeSession();
        }
    });

    function completeSession() {
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
        previewEl.currentTime = 0;
        var p = previewEl.play();
        if (p && p.catch) { p.catch(function() {}); }
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
            updateUI();
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

    // Pre-load bowl samples so session start is instant
    loadBowlSamples(function() {});

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function() {});
    }
})();
