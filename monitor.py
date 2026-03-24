import os
import re
import sys
import time
import signal
import logging
import hashlib
import smtplib
import argparse
import threading
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

# --- Config ---
TARGET_URL = os.getenv("TARGET_URL", "https://shop.royalchallengers.com/ticket")
API_URL = os.getenv("API_URL", "https://rcbscaleapi.ticketgenie.in/ticket/eventlist/O")
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL", "60"))
NOTIFICATION_COOLDOWN = 1800  # 30 minutes

GMAIL_ADDRESS = os.getenv("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
NOTIFY_EMAIL = os.getenv("NOTIFY_EMAIL", "")

TEXTMEBOT_PHONE = os.getenv("TEXTMEBOT_PHONE", "")
TEXTMEBOT_APIKEY = os.getenv("TEXTMEBOT_APIKEY", "")

# IPL opponent team cities to detect (case-insensitive)
TEAM_NAMES = [
    "chennai", "delhi", "gujarat", "kolkata",
    "lucknow", "mumbai", "punjab", "rajasthan", "hyderabad",
]

TICKET_KEYWORDS = [
    "book now", "buy ticket", "buy now", "add to cart",
    "select seat", "select match", "match ticket", "₹", "inr",
]

# Known baseline JS bundle pattern
BASELINE_BUNDLE_RE = re.compile(r'/assets/index-([a-zA-Z0-9]+)\.js')

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("rcb-monitor")

# --- User agents ---
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


# --- Notification functions ---

def send_email(subject: str, body: str) -> bool:
    if not all([GMAIL_ADDRESS, GMAIL_APP_PASSWORD, NOTIFY_EMAIL]):
        log.warning("Gmail credentials not configured, skipping email")
        return False
    try:
        msg = MIMEMultipart()
        msg["From"] = GMAIL_ADDRESS
        msg["To"] = NOTIFY_EMAIL
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.ehlo()
            server.starttls()
            server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_ADDRESS, NOTIFY_EMAIL, msg.as_string())
        log.info("Email sent to %s", NOTIFY_EMAIL)
        return True
    except Exception as e:
        log.error("Failed to send email: %s", e)
        return False


def send_whatsapp(body: str) -> bool:
    if not all([TEXTMEBOT_PHONE, TEXTMEBOT_APIKEY]):
        log.warning("TextMeBot credentials not configured, skipping WhatsApp")
        return False
    try:
        resp = requests.get(
            "https://api.textmebot.com/send.php",
            params={"recipient": TEXTMEBOT_PHONE, "apikey": TEXTMEBOT_APIKEY, "text": body},
            timeout=10,
        )
        if resp.status_code == 200:
            log.info("WhatsApp sent to %s", TEXTMEBOT_PHONE)
            return True
        log.error("WhatsApp send failed: HTTP %d %s", resp.status_code, resp.text)
        return False
    except Exception as e:
        log.error("Failed to send WhatsApp: %s", e)
        return False


def notify(subject: str, body: str, last_notified_at: float) -> float:
    """Send all notifications. Returns updated last_notified_at."""
    now = time.time()
    if now - last_notified_at < NOTIFICATION_COOLDOWN:
        log.info("Notification cooldown active, skipping (%.0f min remaining)",
                 (NOTIFICATION_COOLDOWN - (now - last_notified_at)) / 60)
        return last_notified_at

    email_ok = send_email(subject, body)
    wa_ok = send_whatsapp(f"{subject}\n\n{body}")
    if email_ok or wa_ok:
        return now
    return last_notified_at


# --- Detection functions ---

def api_check() -> dict:
    """Tier 0: Direct API check — fastest and most reliable."""
    try:
        resp = requests.get(API_URL, timeout=10)
        data = resp.json()
        events = data.get("result", [])
        has_events = len(events) > 0
        event_names = [e.get("eventName", e.get("name", "unknown")) for e in events]
        return {
            "has_events": has_events,
            "event_count": len(events),
            "event_names": event_names,
            "raw": events[:3],  # first 3 for logging
        }
    except Exception as e:
        log.error("API check failed: %s", e)
        return {"has_events": False, "event_count": 0, "event_names": [], "raw": []}


def quick_http_check(url: str, cycle: int) -> dict:
    """Tier 1: Quick HTTP check for content size and bundle changes."""
    ua = USER_AGENTS[cycle % len(USER_AGENTS)]
    resp = requests.get(url, timeout=10, headers={"User-Agent": ua})
    html = resp.text
    content_length = len(html)

    # Extract JS bundle hash
    bundle_match = BASELINE_BUNDLE_RE.search(html)
    bundle_hash = bundle_match.group(1) if bundle_match else None

    return {
        "status_code": resp.status_code,
        "content_length": content_length,
        "bundle_hash": bundle_hash,
        "html": html,
    }


def playwright_check(url: str, browser) -> dict:
    """Tier 2: Render page with headless browser and analyze content."""
    context = browser.new_context(
        user_agent=USER_AGENTS[0],
        viewport={"width": 1920, "height": 1080},
    )
    page = context.new_page()
    try:
        page.goto(url, wait_until="networkidle", timeout=30000)
        # Wait a bit more for React to render
        page.wait_for_timeout(3000)

        body_text = page.inner_text("body")
        content_hash = hashlib.md5(body_text.strip().encode()).hexdigest()
        body_lower = body_text.lower()

        # Check for team names
        teams_found = [t for t in TEAM_NAMES if t in body_lower]

        # Check for ticket keywords
        keywords_found = [k for k in TICKET_KEYWORDS if k in body_lower]

        has_tickets = len(teams_found) >= 1

        return {
            "body_text": body_text[:500],  # first 500 chars for logging
            "content_hash": content_hash,
            "teams_found": teams_found,
            "keywords_found": keywords_found,
            "has_tickets": has_tickets,
        }
    finally:
        context.close()


# --- Health check server ---

# Shared state for the health server to read
health_state = {
    "status": "starting",
    "cycle": 0,
    "last_check": None,
    "page_state": "not_live",
    "uptime_start": time.time(),
}


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            uptime = int(time.time() - health_state["uptime_start"])
            payload = {
                "status": health_state["status"],
                "cycle": health_state["cycle"],
                "last_check": health_state["last_check"],
                "page_state": health_state["page_state"],
                "uptime_seconds": uptime,
                "target": TARGET_URL,
            }
            body = json.dumps(payload, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        elif self.path == "/notify-test":
            log.info("Test notifications triggered via /notify-test endpoint")
            msg = f"Bot is alive!\n\nCycle: {health_state['cycle']}\nPage state: {health_state['page_state']}\nTarget: {TARGET_URL}"
            email_ok = send_email("RCB Monitor - Health Check ✅", msg)
            wa_ok = send_whatsapp(f"RCB Monitor - Health Check ✅\n\n{msg}")
            body = json.dumps({"email_sent": email_ok, "whatsapp_sent": wa_ok}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress default HTTP server logs


def start_health_server():
    port = int(os.getenv("PORT", "8080"))
    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    log.info("Health server running on port %d", port)
    server.serve_forever()


# --- Main loop ---

def main():
    parser = argparse.ArgumentParser(description="RCB Ticket Monitor Bot")
    parser.add_argument("--test-notify", action="store_true",
                        help="Send a test notification and exit")
    args = parser.parse_args()

    if args.test_notify:
        log.info("Sending test notifications...")
        send_email(
            "RCB Monitor - Test Notification",
            "This is a test notification from the RCB Ticket Monitor Bot. If you see this, email notifications are working!"
        )
        log.info("Test complete.")
        return

    # Start health check server in background thread
    t = threading.Thread(target=start_health_server, daemon=True)
    t.start()

    log.info("Starting RCB Ticket Monitor")
    log.info("Target: %s", TARGET_URL)
    log.info("Check interval: %ds", CHECK_INTERVAL)

    state = "not_live"
    last_notified_at = 0.0
    consecutive_errors = 0
    baseline_bundle_hash = "CYLMQKss"  # updated 2026-03-24
    baseline_content_hash = None
    cycle = 0
    running = True

    def shutdown(signum, frame):
        nonlocal running
        log.info("Shutdown signal received, exiting...")
        running = False

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    log.info("Playwright browser launched")

    try:
        while running:
            cycle += 1
            current_interval = CHECK_INTERVAL

            try:
                health_state["status"] = "running"
                health_state["cycle"] = cycle
                health_state["last_check"] = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())

                detected = False

                # --- Tier 0: API check (fastest, most reliable) ---
                api = api_check()
                if api["has_events"]:
                    log.info("Cycle %d | API: %d events found! %s",
                             cycle, api["event_count"], api["event_names"])
                    detected = True
                else:
                    log.info("Cycle %d | API: no events yet", cycle)

                # --- Tier 1: HTML check (fallback) ---
                if not detected:
                    http = quick_http_check(TARGET_URL, cycle)
                    log.info("Cycle %d | HTTP %d | Size: %d bytes | Bundle: %s",
                             cycle, http["status_code"], http["content_length"],
                             http["bundle_hash"])

                    bundle_changed = (http["bundle_hash"] is not None and
                                      http["bundle_hash"] != baseline_bundle_hash)
                    size_changed = http["content_length"] > 10000

                    if bundle_changed:
                        log.info("JS bundle hash changed: %s -> %s",
                                 baseline_bundle_hash, http["bundle_hash"])
                        baseline_bundle_hash = http["bundle_hash"]

                    if bundle_changed or size_changed:
                        detected = True

                # --- Tier 2: Playwright (every 10th cycle or on HTML change) ---
                if not detected and (cycle % 10 == 1):
                    log.info("Running Playwright check...")
                    try:
                        pw_result = playwright_check(TARGET_URL, browser)
                        log.info("Playwright | Hash: %s | Teams: %s | Keywords: %s",
                                 pw_result["content_hash"],
                                 pw_result["teams_found"],
                                 pw_result["keywords_found"])

                        if baseline_content_hash is None:
                            baseline_content_hash = pw_result["content_hash"]

                        if pw_result["has_tickets"]:
                            detected = True
                    except Exception as e:
                        log.error("Playwright check failed: %s", e)
                        try:
                            browser.close()
                        except Exception:
                            pass
                        browser = pw.chromium.launch(headless=True)
                        log.info("Browser restarted")

                # --- Notify if detected ---
                if detected and state != "live":
                    log.info("TICKETS DETECTED!")
                    subject = "🏏 RCB TICKETS ARE LIVE!"
                    body = (
                        f"Tickets detected!\n\n"
                        f"API events: {api['event_count']} — {', '.join(api['event_names'])}\n\n"
                        f"GO GO GO: {TARGET_URL}"
                    )
                    last_notified_at = notify(subject, body, last_notified_at)
                    state = "live"
                    health_state["page_state"] = "live"
                elif not detected and state == "live":
                    log.info("State changed back to not_live")
                    state = "not_live"
                    health_state["page_state"] = "not_live"

                consecutive_errors = 0

            except requests.exceptions.HTTPError as e:
                consecutive_errors += 1
                status = e.response.status_code if e.response else None
                if status in (429, 403):
                    current_interval = 300
                    log.warning("Rate limited (HTTP %s), backing off to 5 min", status)
                else:
                    log.error("HTTP error: %s", e)

            except Exception as e:
                consecutive_errors += 1
                log.error("Check failed (attempt %d): %s", consecutive_errors, e)

                if consecutive_errors >= 3:
                    backoff = min(CHECK_INTERVAL * (2 ** consecutive_errors), 900)
                    current_interval = backoff
                    log.warning("Backing off to %ds after %d consecutive errors",
                                backoff, consecutive_errors)

            if running:
                time.sleep(current_interval)

    finally:
        log.info("Shutting down browser...")
        browser.close()
        pw.stop()
        log.info("Bye!")


if __name__ == "__main__":
    main()
