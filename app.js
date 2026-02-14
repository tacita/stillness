"use strict";

/* ============================================
   Stillness — Meditation Timer
   Zero external dependencies

   Audio strategy:
   - bowl.wav is a pre-rendered singing bowl sound
   - A hidden <audio> element plays bowl.wav on loop at zero volume
     as a "heartbeat" — iOS keeps it alive and fires timeupdate events
   - On each timeupdate, we check if a bell is due and play it
   - Bell playback uses separate <audio> elements with bowl.wav
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

    /* ============================================
       Audio elements
       ============================================ */

    // Heartbeat: loops bowl.wav at near-zero volume.
    // iOS keeps <audio> elements alive and fires timeupdate events,
    // which we use as a reliable timer to trigger bells.
    var heartbeat = document.createElement("audio");
    heartbeat.preload = "auto";
    heartbeat.loop = true;
    heartbeat.src = "bowl.wav";
    heartbeat.volume = 0.01; // near-silent but not zero (iOS may skip zero-volume)
    heartbeat.style.display = "none";
    document.body.appendChild(heartbeat);

    // Bell players: 4 <audio> elements for playing the actual bowl sounds
    var bellPlayers = [];
    for (var a = 0; a < 4; a++) {
        var el = document.createElement("audio");
        el.preload = "auto";
        el.src = "bowl.wav";
        el.style.display = "none";
        document.body.appendChild(el);
        bellPlayers.push(el);
    }
    var nextBellIndex = 0;

    function playBell() {
        var el = bellPlayers[nextBellIndex % bellPlayers.length];
        nextBellIndex++;
        el.currentTime = 0;
        el.volume = 1.0;
        var p = el.play();
        if (p && p.catch) { p.catch(function() {}); }
        showDingFlash();
    }

    // Heartbeat timeupdate handler — checks if any bells are due
    heartbeat.addEventListener("timeupdate", function() {
        if (state !== "running") return;
        checkBells();
        updateUI();
    });

    function checkBells() {
        var now = Date.now();
        for (var i = 0; i < bellTimes.length; i++) {
            if (!bellFired[i] && now >= bellTimes[i]) {
                bellFired[i] = true;
                playBell();
            }
        }
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

        var settleSeconds   = durations.settle * 60;
        var meditateSeconds = durations.meditate * 60;
        var emergeSeconds   = durations.emerge * 60;
        var totalSeconds    = settleSeconds + meditateSeconds + emergeSeconds;

        var wallNow = Date.now();

        // Bell times (absolute wall-clock)
        bellTimes = [
            wallNow,                                                    // bell 1
            wallNow + settleSeconds * 1000,                            // bell 2
            wallNow + (settleSeconds + meditateSeconds) * 1000,        // bell 3
            wallNow + (settleSeconds + meditateSeconds + emergeSeconds) * 1000, // bell 4
        ];
        bellFired = [false, false, false, false];

        // Phase timeline
        phases = [
            { name: "settle",   start: wallNow, end: wallNow + settleSeconds * 1000 },
            { name: "meditate", start: wallNow + settleSeconds * 1000, end: wallNow + (settleSeconds + meditateSeconds) * 1000 },
            { name: "emerge",   start: wallNow + (settleSeconds + meditateSeconds) * 1000, end: wallNow + totalSeconds * 1000 },
        ];
        sessionEndTime = wallNow + totalSeconds * 1000;

        // Start the heartbeat (keeps iOS audio alive, drives our timer)
        heartbeat.currentTime = 0;
        var hp = heartbeat.play();
        if (hp && hp.catch) { hp.catch(function() {}); }

        // Play first bell immediately (we're in user gesture context)
        bellFired[0] = true;
        playBell();

        // Update UI
        state = "running";
        currentPhase = "";
        playButton.classList.remove("breathing");
        playIcon.classList.add("hidden");
        stopIcon.classList.remove("hidden");
        requestWakeLockAsync();

        if (timerRAF) cancelAnimationFrame(timerRAF);
        tickLoop();
    }

    function stopSession() {
        state = "idle";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        // Stop heartbeat
        try { heartbeat.pause(); } catch (e) {}

        // Stop any playing bells
        for (var j = 0; j < bellPlayers.length; j++) {
            try { bellPlayers[j].pause(); bellPlayers[j].currentTime = 0; } catch (e) {}
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
       UI Updates
       ============================================ */
    function updateUI() {
        var now = Date.now();

        if (now >= sessionEndTime) {
            completeSession();
            return;
        }

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
    }

    // RAF loop for smooth UI updates (timeupdate fires ~4x/sec which is choppy)
    function tickLoop() {
        if (state !== "running") return;

        var now = Date.now();
        if (now >= sessionEndTime) {
            completeSession();
            return;
        }

        // Also check bells from RAF in case timeupdate is slow
        checkBells();
        updateUI();

        timerRAF = requestAnimationFrame(tickLoop);
    }

    function completeSession() {
        state = "complete";
        currentPhase = "";
        if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }

        // Stop heartbeat
        try { heartbeat.pause(); } catch (e) {}

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
        playBell();
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
            checkBells();
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

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function() {});
    }
})();
