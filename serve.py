#!/usr/bin/env python3
"""
Secure local HTTPS server for Stillness meditation timer.

Generates a self-signed certificate and serves the app over HTTPS,
which is required for PWA features (service worker, wake lock) on iOS.

Usage:
    python3 serve.py          # Serves on https://0.0.0.0:8443
    python3 serve.py 3000     # Serves on https://0.0.0.0:3000
"""

import http.server
import ssl
import os
import sys
import subprocess
import tempfile
import socket

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".certs")
CERT_FILE = os.path.join(CERT_DIR, "cert.pem")
KEY_FILE = os.path.join(CERT_DIR, "key.pem")


def get_local_ip():
    """Get the local network IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def generate_cert():
    """Generate a self-signed certificate for local HTTPS."""
    os.makedirs(CERT_DIR, exist_ok=True)

    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        print("Using existing certificate.")
        return

    print("Generating self-signed certificate for local HTTPS...")
    local_ip = get_local_ip()

    # Create a config file for SAN (Subject Alternative Name)
    config = f"""[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = Stillness Local

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = {local_ip}
"""
    config_path = os.path.join(CERT_DIR, "openssl.cnf")
    with open(config_path, "w") as f:
        f.write(config)

    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", KEY_FILE, "-out", CERT_FILE,
        "-days", "365", "-nodes",
        "-config", config_path,
    ], check=True, capture_output=True)

    print("Certificate generated.")


class SecureHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with security headers."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

    def end_headers(self):
        # Security headers
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-XSS-Protection", "1; mode=block")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'"
        )
        # Cache control for development
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        """Quieter logging."""
        sys.stderr.write(f"  {args[0]}\n")

    def do_GET(self):
        # Block access to sensitive files
        blocked = [".py", ".certs", ".git", "generate_icons"]
        if any(b in self.path for b in blocked):
            self.send_error(403, "Forbidden")
            return
        super().do_GET()


def main():
    generate_cert()

    local_ip = get_local_ip()

    server = http.server.HTTPServer(("0.0.0.0", PORT), SecureHandler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_FILE, KEY_FILE)
    # Modern TLS settings
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    server.socket = context.wrap_socket(server.socket, server_side=True)

    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║          🧘  Stillness is running  🧘        ║")
    print("  ╠══════════════════════════════════════════════╣")
    print(f"  ║  Local:   https://localhost:{PORT:<18}║")
    print(f"  ║  Network: https://{local_ip}:{PORT:<14}║")
    print("  ╠══════════════════════════════════════════════╣")
    print("  ║  Open the Network URL on your iPhone.       ║")
    print("  ║  Accept the certificate warning, then       ║")
    print("  ║  tap Share → Add to Home Screen.            ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()
    print("  Press Ctrl+C to stop.")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
