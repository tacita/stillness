"use strict";

/* ============================================
   Service Worker for Stillness
   Network-first strategy: always try to fetch
   fresh content, fall back to cache if offline.
   ============================================ */

var CACHE_NAME = "stillness-v4";

// Use relative paths so this works on any subpath (e.g. /stillness/)
var ASSETS = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
];

// Install: cache all assets, skip waiting to activate immediately
self.addEventListener("install", function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: clean up old caches, claim clients immediately
self.addEventListener("activate", function(event) {
    event.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(
                keys
                    .filter(function(key) { return key !== CACHE_NAME; })
                    .map(function(key) { return caches.delete(key); })
            );
        })
    );
    self.clients.claim();
});

// Fetch: network-first, fallback to cache
self.addEventListener("fetch", function(event) {
    if (event.request.method !== "GET") return;

    var url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(event.request).then(function(response) {
            if (response && response.status === 200 && response.type === "basic") {
                var clone = response.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, clone);
                });
            }
            return response;
        }).catch(function() {
            return caches.match(event.request);
        })
    );
});
