"""
RCB Ticket Auto-Buyer
Run this on your Mac when you get the alert that tickets are live.
It opens a real browser, fills in your phone, waits for you to enter OTP,
then auto-selects the best seat and gets you to the payment page.
"""

import os
import sys
import time
import json
import math
import requests
import argparse
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

load_dotenv()

# --- Config ---
TICKET_URL = os.getenv("TARGET_URL", "https://shop.royalchallengers.com/ticket")
PHONE = os.getenv("PHONE_NUMBER", "9686193992")

# Stand preference: first available wins
STAND_PREFERENCE = ["B STAND", "C STAND", "D CORPORATE", "A STAND"]

NUM_TICKETS = 2  # max 2 per account


def find_optimal_seats(seats: list, num: int = 2) -> list:
    """
    Given a list of available seat dicts (from seatlist API),
    find the most central group of `num` adjacent seats.
    Each seat has: row, seat_No, row_Order, serial_No, status
    """
    # Filter only available seats
    available = [s for s in seats if s.get("status") == "U"]
    if not available:
        return []

    # Group by row
    rows = {}
    for s in available:
        r = s["row"]
        if r not in rows:
            rows[r] = []
        rows[r].append(s)

    # Find overall middle row_order
    all_orders = sorted(set(s["row_Order"] for s in available))
    mid_order = all_orders[len(all_orders) // 2]

    # Try rows closest to the middle first
    sorted_rows = sorted(rows.keys(), key=lambda r: abs(rows[r][0]["row_Order"] - mid_order))

    for row_name in sorted_rows:
        row_seats = sorted(rows[row_name], key=lambda s: s["seat_No"])
        seat_nums = [s["seat_No"] for s in row_seats]
        max_seat = max(seat_nums)
        min_seat = min(seat_nums)
        mid_seat = (max_seat + min_seat) // 2

        # Find `num` adjacent seats closest to the middle
        for start_idx in range(len(row_seats)):
            group = row_seats[start_idx:start_idx + num]
            if len(group) < num:
                continue
            # Check they are truly adjacent (consecutive seat numbers)
            nums = [s["seat_No"] for s in group]
            if nums != list(range(nums[0], nums[0] + num)):
                continue
            # Score by distance of group center from row middle
            group_center = sum(nums) / num
            return group

        # Fallback: any num seats in this row closest to middle
        best_group = None
        best_dist = float("inf")
        for start_idx in range(len(row_seats) - num + 1):
            group = row_seats[start_idx:start_idx + num]
            nums = [s["seat_No"] for s in group]
            if nums == list(range(nums[0], nums[0] + num)):
                center = sum(nums) / num
                dist = abs(center - mid_seat)
                if dist < best_dist:
                    best_dist = dist
                    best_group = group
        if best_group:
            return best_group

    return []


def get_seat_canvas_coords(seat: dict, seat_template: list, canvas_w: int, canvas_h: int) -> tuple:
    """
    Calculate the (x, y) pixel position of a seat on the natural canvas.
    Uses the seat template to determine the coordinate grid.
    """
    # Find max column index across all seats in template
    max_col = max(s["lm"] + s["seat_No"] for s in seat_template)
    num_rows = max(s["row_Order"] for s in seat_template)

    # seat position
    col = seat["lm"] + seat["seat_No"]
    row_order = seat["row_Order"]

    # lm is per-row — need to fetch the row's lm
    row_name = seat["row"]
    row_lm = next((s["lm"] for s in seat_template if s["row"] == row_name and s["lm"] > 0), 0)
    col = row_lm + seat["seat_No"]

    x = (col / max_col) * canvas_w
    y = (row_order / num_rows) * canvas_h
    return (x, y)


def wait_for_otp_validated(page, timeout=120):
    """Wait until user has entered OTP and page moves past /auth"""
    print("\n⏳ OTP sent to your phone. Enter it in the browser window...")
    start = time.time()
    while time.time() - start < timeout:
        if "/auth" not in page.url:
            print(f"✅ Logged in! Now at: {page.url}")
            return True
        time.sleep(1)
    raise TimeoutError("OTP not entered within 2 minutes")


def get_available_seats(page, match_id: int, category_id: int) -> list:
    """Fetch seatlist from API using the browser's authenticated session."""
    result = page.evaluate(f"""
        async () => {{
            const resp = await fetch('/ticket/seatlist/2/{match_id}/{category_id}');
            if (!resp.ok) return null;
            return await resp.json();
        }}
    """)
    return result or []


def get_seat_template(category_id: int) -> list:
    """Fetch seat template from S3."""
    url = f"https://tg3.s3.ap-south-1.amazonaws.com/revents/seat-template/{category_id}.json"
    resp = requests.get(url, timeout=10)
    if resp.ok:
        return resp.json()
    return []


def click_seat_on_canvas(page, seat: dict, seat_template: list):
    """Click a seat on the Konva canvas using real mouse events."""
    canvas = page.locator('[role="dialog"] canvas')
    box = canvas.bounding_box()
    if not box:
        raise RuntimeError("Canvas not found")

    # Canvas natural size
    canvas_natural_w = page.evaluate('document.querySelector(\'[role="dialog"] canvas\').width')
    canvas_natural_h = page.evaluate('document.querySelector(\'[role="dialog"] canvas\').height')

    # CSS scale factor
    scale_x = box["width"] / canvas_natural_w
    scale_y = box["height"] / canvas_natural_h

    # Get scroll offset of the canvas container
    scroll_left = page.evaluate("""
        (() => {
            const canvas = document.querySelector('[role="dialog"] canvas');
            let el = canvas?.parentElement;
            while (el) {
                if (el.scrollWidth > el.clientWidth && el.scrollLeft !== undefined) {
                    return el.scrollLeft;
                }
                el = el.parentElement;
            }
            return 0;
        })()
    """)

    # Natural canvas coordinates of the seat
    nat_x, nat_y = get_seat_canvas_coords(seat, seat_template, canvas_natural_w, canvas_natural_h)

    # Convert to screen coordinates
    screen_x = box["x"] + (nat_x * scale_x) - scroll_left
    screen_y = box["y"] + (nat_y * scale_y)

    print(f"  Clicking seat Row {seat['row']} Seat {seat['seat_No']} at screen ({screen_x:.0f}, {screen_y:.0f})")
    page.mouse.click(screen_x, screen_y)
    time.sleep(0.5)


def run(dev_mode=False):
    base_url = "https://devrcbshop.ticketgenie.in" if dev_mode else "https://shop.royalchallengers.com"
    ticket_list_url = f"{base_url}/ticket"

    print(f"🏏 RCB Ticket Auto-Buyer {'[DEV MODE]' if dev_mode else ''}")
    print(f"   Target: {ticket_list_url}")
    print(f"   Phone: +91{PHONE}")
    print(f"   Stand preference: {STAND_PREFERENCE}")
    print(f"   Tickets: {NUM_TICKETS}\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1400, "height": 800},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        # --- Step 1: Navigate to ticket listing ---
        print("📍 Step 1: Opening ticket page...")
        page.goto(ticket_list_url, wait_until="networkidle")
        page.wait_for_timeout(2000)

        # --- Step 2: Click first available BUY TICKETS ---
        print("📍 Step 2: Clicking BUY TICKETS on first available match...")
        buy_btns = page.locator('button:has-text("BUY TICKETS")')
        if buy_btns.count() == 0:
            print("❌ No BUY TICKETS buttons found. Tickets may not be live yet.")
            browser.close()
            return
        buy_btns.first.click()
        page.wait_for_load_state("networkidle")

        # Extract match ID from URL
        match_id = int(page.url.rstrip("/").split("/")[-1]) if page.url.split("/")[-1].isdigit() else None

        # --- Step 3: Login ---
        if "/auth" in page.url:
            print("📍 Step 3: Logging in with phone number...")
            page.locator('input[placeholder="Mobile No."]').wait_for(timeout=10000)
            page.locator('input[placeholder="Mobile No."]').fill(PHONE)
            page.locator('button:has-text("Continue")').click()
            page.wait_for_timeout(1500)

            # Wait for OTP fields to appear
            page.locator('input[placeholder="○"]').first.wait_for(timeout=10000)
            wait_for_otp_validated(page)
        else:
            print("📍 Step 3: Already logged in, skipping OTP")

        page.wait_for_timeout(2000)

        # --- Step 4: Dismiss info dialog ---
        print("📍 Step 4: Dismissing info dialog...")
        try:
            page.locator('[role="alertdialog"] button:has-text("Continue")').click(timeout=5000)
        except PWTimeout:
            pass  # No dialog, that's fine

        page.wait_for_timeout(1000)

        # --- Step 5: Select preferred stand ---
        print("📍 Step 5: Selecting stand...")
        category_id = None
        selected_stand = None

        for stand in STAND_PREFERENCE:
            try:
                # Look for a category card containing the stand name
                locator = page.locator(f'text=/{stand}/i').first
                if locator.count() > 0 or True:
                    locator.click(timeout=3000)
                    selected_stand = stand
                    print(f"  ✅ Selected: {stand}")
                    break
            except PWTimeout:
                print(f"  ⚠️  {stand} not available, trying next...")
                continue

        if not selected_stand:
            print("❌ None of the preferred stands are available!")
            input("Press Enter to close browser...")
            browser.close()
            return

        page.wait_for_timeout(2000)

        # --- Step 6: Get category ID from network call ---
        print("📍 Step 6: Loading seat map...")
        canvas = page.locator('[role="dialog"] canvas')
        canvas.wait_for(timeout=10000)

        # Intercept the seatlist call to get category ID
        category_id = page.evaluate("""
            () => {
                // Look at performance entries for the seatlist URL
                const entries = performance.getEntriesByType('resource');
                const seatlistEntry = entries.find(e => e.name.includes('/ticket/seatlist/'));
                if (seatlistEntry) {
                    const parts = seatlistEntry.name.split('/');
                    return parseInt(parts[parts.length - 1]);
                }
                return null;
            }
        """)
        print(f"  Category ID: {category_id}")

        # Extract match ID from URL now
        current_url = page.url
        url_parts = current_url.rstrip("/").split("/")
        match_id = int(url_parts[-1]) if url_parts[-1].isdigit() else match_id
        print(f"  Match ID: {match_id}")

        # --- Step 7: Find optimal seats ---
        print("📍 Step 7: Finding best available seats...")

        if category_id and match_id:
            available_seats = get_available_seats(page, match_id, category_id)
            seat_template = get_seat_template(category_id)

            if not available_seats or not seat_template:
                print("  ⚠️  Could not fetch seat data via API, will select seats manually")
                optimal_seats = []
            else:
                # Merge template data (for coords) with availability
                serial_to_template = {s["serial_No"]: s for s in seat_template}
                # Add row_Order and lm from template to available seats
                for s in available_seats:
                    tmpl = serial_to_template.get(s.get("serial_No"), {})
                    s["row_Order"] = tmpl.get("row_Order", 1)
                    s["lm"] = tmpl.get("lm", 0)

                optimal_seats = find_optimal_seats(available_seats, NUM_TICKETS)

                if optimal_seats:
                    rows_info = [f"Row {s['row']} Seat {s['seat_No']}" for s in optimal_seats]
                    print(f"  ✅ Best seats found: {', '.join(rows_info)}")
                else:
                    print("  ⚠️  Could not find optimal adjacent seats")
        else:
            optimal_seats = []
            seat_template = []

        # --- Step 8: Click seats on canvas ---
        if optimal_seats and seat_template:
            print("📍 Step 8: Selecting seats on map...")
            for seat in optimal_seats:
                click_seat_on_canvas(page, seat, seat_template)
                page.wait_for_timeout(800)
        else:
            print("📍 Step 8: Please select your seats manually in the browser window...")
            input("  Press Enter once you've selected your seats...")

        # --- Step 9: Click Proceed ---
        print("📍 Step 9: Clicking Proceed...")
        try:
            page.locator('button:has-text("Proceed")').click(timeout=10000)
            page.wait_for_load_state("networkidle")
            print(f"  ✅ Proceeded! Now at: {page.url}")
        except PWTimeout:
            print("  ⚠️  Proceed button not found — may need to select seats first")
            input("  Select seats manually, then press Enter to continue...")
            page.locator('button:has-text("Proceed")').click(timeout=30000)
            page.wait_for_load_state("networkidle")

        # --- Step 10: At payment page ---
        print("\n🎉 You're at the checkout/payment page!")
        print(f"   URL: {page.url}")
        print("\n💳 Complete the Razorpay payment in the browser window.")
        print("   The browser will stay open until you close it.\n")

        # Keep browser open until user closes it
        try:
            page.wait_for_event("close", timeout=600000)  # wait up to 10 min
        except Exception:
            pass

        browser.close()
        print("Done!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev", action="store_true", help="Use dev site (devrcbshop.ticketgenie.in)")
    args = parser.parse_args()
    run(dev_mode=args.dev)
