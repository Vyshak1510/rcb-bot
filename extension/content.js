// RCB Ticket Bot - Content Script
// Runs on shop.royalchallengers.com/ticket and ticketgenie.in/ticket

const TEAM_NAMES = [
  "chennai", "delhi", "gujarat", "kolkata",
  "lucknow", "mumbai", "punjab", "rajasthan", "hyderabad"
];

// Stand preference order
const STAND_PREFERENCE = ["B Stand", "C Stand", "D Stand", "A Stand"];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Entry points ──────────────────────────────────────────────────────────────

// 1. Passive check: called when background opens a silent check tab
async function passiveCheck() {
  await delay(4000); // wait for React to render
  const bodyText = document.body.innerText.toLowerCase();
  const teamsFound = TEAM_NAMES.filter((t) => bodyText.includes(t));

  if (teamsFound.length > 0) {
    chrome.runtime.sendMessage({ type: "TICKETS_DETECTED", teams: teamsFound });
  } else {
    chrome.runtime.sendMessage({ type: "CHECK_TAB_CLEAN" });
  }
}

// 2. Active buy: triggered by background when tickets are confirmed live
async function autoBuy() {
  showOverlay("🏏 RCB Bot is buying your tickets...");
  try {
    await delay(3000); // let page fully load

    // Step 1: click BUY TICKETS on first available match
    await clickBuyTickets();

    // Step 2: fill phone number + wait for OTP
    const phone = await getConfig("phone");
    await fillPhone(phone);
    updateOverlay("📱 OTP sent — enter it in the form");
    await waitForOTPSuccess();

    // Step 3: dismiss info dialog if present
    await dismissInfoDialog();

    // Step 4: select stand
    await selectStand();

    // Step 5: select optimal seats
    await selectOptimalSeats();

    // Step 6: proceed to payment
    await clickProceed();

    updateOverlay("✅ Done! Complete payment to confirm.");
  } catch (e) {
    updateOverlay(`❌ Error: ${e.message}. Please continue manually.`);
    console.error("[RCB] autoBuy error:", e);
  }
}

// ── Step implementations ──────────────────────────────────────────────────────

async function clickBuyTickets() {
  updateOverlay("🎟 Finding BUY TICKETS button...");
  const btn = await waitForElement(() => {
    const buttons = [...document.querySelectorAll("button, a")];
    return buttons.find((b) =>
      b.innerText.trim().toUpperCase().includes("BUY TICKET") ||
      b.innerText.trim().toUpperCase().includes("BOOK NOW")
    );
  }, 15000);
  btn.click();
  await delay(2000);
}

async function fillPhone(phone) {
  updateOverlay("📱 Entering phone number...");
  const input = await waitForElement(() =>
    document.querySelector('input[type="tel"], input[placeholder*="phone"], input[placeholder*="Phone"], input[placeholder*="mobile"], input[placeholder*="Mobile"]'),
    10000
  );
  input.focus();
  input.value = "";
  // Use native input setter to trigger React's onChange
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  nativeInputValueSetter.call(input, phone);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await delay(500);

  // Click Send OTP
  const sendBtn = await waitForElement(() => {
    const btns = [...document.querySelectorAll("button")];
    return btns.find((b) =>
      b.innerText.toUpperCase().includes("SEND OTP") ||
      b.innerText.toUpperCase().includes("GET OTP")
    );
  }, 5000);
  sendBtn.click();
  await delay(1000);
}

async function waitForOTPSuccess() {
  // Wait until the OTP dialog disappears or we land on the ticket page
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      // Check if modal/login is gone and ticket content is visible
      const bodyText = document.body.innerText.toLowerCase();
      const hasTeams = TEAM_NAMES.some((t) => bodyText.includes(t));
      const noModal = !document.querySelector('[class*="modal"], [class*="login"], [class*="otp"]');
      if (hasTeams || noModal) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
    // Timeout after 3 minutes (user might take time with OTP)
    setTimeout(() => { clearInterval(interval); resolve(); }, 180000);
  });
}

async function dismissInfoDialog() {
  await delay(1000);
  const closeBtn = document.querySelector('[class*="close"], [aria-label="close"], [aria-label="Close"]');
  if (closeBtn) {
    closeBtn.click();
    await delay(500);
  }
  // Also try clicking an OK/Got it button
  const okBtn = [...document.querySelectorAll("button")].find((b) =>
    /^(ok|got it|continue|proceed|close)$/i.test(b.innerText.trim())
  );
  if (okBtn) {
    okBtn.click();
    await delay(500);
  }
}

async function selectStand() {
  updateOverlay("🏟 Selecting stand...");
  for (const standName of STAND_PREFERENCE) {
    const el = await findStandElement(standName);
    if (el) {
      el.click();
      await delay(2000);
      updateOverlay(`✅ Selected ${standName}`);
      return;
    }
  }
  throw new Error("No preferred stand found");
}

function findStandElement(standName) {
  return new Promise((resolve) => {
    // Try for up to 5 seconds
    const deadline = Date.now() + 5000;
    const check = () => {
      const all = [...document.querySelectorAll("button, div, span, li, a")];
      const el = all.find((e) =>
        e.innerText && e.innerText.trim().toLowerCase().includes(standName.toLowerCase())
        && isVisible(e)
      );
      if (el) return resolve(el);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(check, 200);
    };
    check();
  });
}

async function selectOptimalSeats() {
  updateOverlay("💺 Finding optimal seats...");
  await delay(2000); // wait for seat map to render

  // Try API-based seat selection first
  const apiSuccess = await trySeatAPISelection();
  if (apiSuccess) return;

  // Fallback: click centre of canvas
  await canvasCentreClick();
}

async function trySeatAPISelection() {
  try {
    // Extract event/section IDs from current URL or page state
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Try to find seat data from XHR responses by intercepting fetch
    // The seat map API returns rows/columns; we find the central available seat
    const seats = await fetchAvailableSeats();
    if (!seats || seats.length === 0) return false;

    const optimal = findCentralSeat(seats);
    if (!optimal) return false;

    updateOverlay(`💺 Clicking seat Row ${optimal.row}, Seat ${optimal.col}...`);
    await clickSeatOnCanvas(optimal);
    await delay(500);

    return true;
  } catch (e) {
    console.warn("[RCB] API seat selection failed:", e);
    return false;
  }
}

async function fetchAvailableSeats() {
  // Look for seat data already in the page (React state / window globals)
  const scripts = [...document.querySelectorAll("script")];
  // Try window.__SEATS__ or similar injected data
  if (window.__SEAT_DATA__) return window.__SEAT_DATA__;

  // Try fetching from the API endpoint pattern we saw on the dev site
  const sectionId = extractSectionId();
  const eventId = extractEventId();
  if (!sectionId || !eventId) return null;

  const apiBase = window.location.origin;
  const resp = await fetch(`${apiBase}/api/v1/event/${eventId}/section/${sectionId}/seats`, {
    credentials: "include",
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  // Flatten to array of {row, col, available}
  return (data.seats || data.rows || []).flat();
}

function extractEventId() {
  const match = window.location.href.match(/event[_/-]?id[=/-]?([a-zA-Z0-9]+)/i)
    || document.cookie.match(/eventId=([^;]+)/);
  return match ? match[1] : null;
}

function extractSectionId() {
  // Look in URL, page data attributes, or React props
  const el = document.querySelector("[data-section-id]");
  if (el) return el.dataset.sectionId;
  const match = window.location.href.match(/section[_/-]?id[=/-]?([a-zA-Z0-9]+)/i);
  return match ? match[1] : null;
}

function findCentralSeat(seats) {
  const available = seats.filter((s) => s.available || s.status === "available");
  if (!available.length) return null;

  // Find bounds
  const rows = available.map((s) => s.row);
  const cols = available.map((s) => s.col || s.seat || s.column);
  const midRow = (Math.min(...rows) + Math.max(...rows)) / 2;
  const midCol = (Math.min(...cols) + Math.max(...cols)) / 2;

  // Sort by distance from centre, pick closest
  available.sort((a, b) => {
    const da = Math.hypot(a.row - midRow, (a.col || a.seat || a.column) - midCol);
    const db = Math.hypot(b.row - midRow, (b.col || b.seat || b.column) - midCol);
    return da - db;
  });

  return available[0];
}

async function clickSeatOnCanvas(seat) {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();

  // Normalise seat position to canvas pixel coords
  // Assume seat row/col are 1-indexed; scale to canvas size
  const allSeats = await fetchAvailableSeats() || [];
  const maxRow = Math.max(...allSeats.map((s) => s.row), 1);
  const maxCol = Math.max(...allSeats.map((s) => s.col || s.seat || s.column), 1);

  const x = rect.left + (seat.col / maxCol) * rect.width;
  const y = rect.top + (seat.row / maxRow) * rect.height;

  for (const evtType of ["mousedown", "mouseup", "click"]) {
    canvas.dispatchEvent(new MouseEvent(evtType, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
    }));
    await delay(100);
  }
}

async function canvasCentreClick() {
  updateOverlay("💺 Clicking canvas centre (fallback)...");
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    updateOverlay("⚠️ No seat map found — please select seats manually");
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  for (const evtType of ["mousedown", "mouseup", "click"]) {
    canvas.dispatchEvent(new MouseEvent(evtType, {
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy,
    }));
    await delay(100);
  }
}

async function clickProceed() {
  updateOverlay("💳 Proceeding to payment...");
  await delay(1500);
  const btn = await waitForElement(() => {
    const btns = [...document.querySelectorAll("button")];
    return btns.find((b) =>
      /proceed|pay|checkout|confirm/i.test(b.innerText.trim())
    );
  }, 10000);
  btn.click();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForElement(finder, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      const el = finder();
      if (el) return resolve(el);
      if (Date.now() > deadline) return reject(new Error("Element not found within timeout"));
      setTimeout(check, 300);
    };
    check();
  });
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 &&
    getComputedStyle(el).display !== "none" &&
    getComputedStyle(el).visibility !== "hidden";
}

function getConfig(key) {
  return new Promise((resolve) =>
    chrome.storage.sync.get(key, (data) => resolve(data[key] || ""))
  );
}

// ── Overlay UI ────────────────────────────────────────────────────────────────

let overlayEl = null;

function showOverlay(msg) {
  if (overlayEl) { overlayEl.remove(); }
  overlayEl = document.createElement("div");
  overlayEl.id = "rcb-bot-overlay";
  overlayEl.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 999999;
    background: #1a1a2e; color: #e94560; font-family: monospace;
    font-size: 14px; padding: 14px 18px; border-radius: 10px;
    border: 1px solid #e94560; max-width: 320px; line-height: 1.5;
    box-shadow: 0 4px 20px rgba(233,69,96,0.3);
  `;
  overlayEl.innerText = msg;
  document.body.appendChild(overlayEl);
}

function updateOverlay(msg) {
  if (overlayEl) overlayEl.innerText = msg;
  else showOverlay(msg);
  console.log("[RCB]", msg);
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const { autoBuyEnabled } = await new Promise((r) =>
    chrome.storage.local.get("autoBuyEnabled", r)
  );

  if (autoBuyEnabled) {
    // This tab was opened by background.js to buy — run auto-buy
    autoBuy();
  } else {
    // Background check tab — just detect and report back
    passiveCheck();
  }

  // Also listen for manual trigger from popup or notification click
  window.addEventListener("RCB_START_BUY", () => autoBuy());
})();
