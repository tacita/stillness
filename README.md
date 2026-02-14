# Stillness — Meditation Timer

A simple, beautiful meditation timer that runs as a Progressive Web App on your iPhone.

## Quick Start

```bash
cd timer
python3 serve.py
```

Then open the **Network URL** shown in the terminal on your iPhone's Safari browser.

## Installing on iPhone

1. Run `python3 serve.py` on your Mac (both devices must be on the same Wi-Fi network)
2. On your iPhone, open Safari and go to the Network URL (e.g., `https://192.168.1.x:8443`)
3. You'll see a certificate warning — tap **Advanced → Continue** (this is safe; it's your own self-signed cert)
4. Once the app loads, tap the **Share** button (square with arrow) → **Add to Home Screen**
5. The app will now appear on your home screen and work like a native app, even offline

## How It Works

1. Tap the **play button** to start a meditation session
2. You'll hear a gentle singing bowl sound
3. **Settling in** phase (default 2 min) — get comfortable
4. Another bowl sound marks the start of meditation
5. **Meditation** phase (default 20 min) — meditate
6. Bowl sound marks the beginning of emergence
7. **Emerging** phase (default 2 min) — gently come back
8. Final bowl sound — session complete

Tap the **Adjust** button to change the duration of each phase.

## Features

- **Zero dependencies** — no npm, no frameworks, no CDN. Just HTML, CSS, and JavaScript
- **Synthesized bowl sound** — created with Web Audio API, no audio files needed
- **Works offline** — service worker caches everything after first load
- **Screen stays on** — uses Wake Lock API during meditation
- **Secure** — Content Security Policy, no external resources, HTTPS server with security headers
- **Responsive** — works on any screen size, optimized for iPhone

## Security

This app is built with security as a priority:

- **No external dependencies** — nothing to supply-chain attack
- **No CDN resources** — everything is local
- **Content Security Policy** — blocks inline scripts, external resources
- **HTTPS only** — required for PWA features, prevents MITM
- **Security headers** — X-Frame-Options, X-Content-Type-Options, etc.
- **Server blocks sensitive files** — .py, .certs, .git are not served

## Apple Watch

While this PWA works great on iPhone, Apple Watch doesn't support web apps directly.
For Watch support, you would need a native watchOS app. The PWA on your iPhone is the
recommended way to use Stillness.

## File Structure

```
timer/
├── index.html          # Main HTML
├── style.css           # All styles
├── app.js              # App logic, timer, audio synthesis
├── sw.js               # Service worker for offline support
├── manifest.json       # PWA manifest
├── serve.py            # Secure local HTTPS server
├── icons/
│   ├── icon.svg        # Source icon
│   ├── icon-192.png    # PWA icon (192×192)
│   └── icon-512.png    # PWA icon (512×512)
└── README.md           # This file
```

## Customization

Edit the durations in the app's Settings screen, or modify the defaults in `app.js`:

```javascript
return { settle: 2, meditate: 20, emerge: 2 };
```

To change the bowl sound, modify the `playBowlSound()` function's `partials` array in `app.js`.
