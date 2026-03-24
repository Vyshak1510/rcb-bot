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

  // First verify tickets are actually available (not just the merch "Buy Now")
  const bodyText = document.body.innerText.toLowerCase();
  if (bodyText.includes("tickets not available") || bodyText.includes("please await further")) {
    throw new Error("Tickets not available yet — page says 'await further announcements'");
  }

  const teamsOnPage = TEAM_NAMES.filter((t) => bodyText.includes(t));
  if (teamsOnPage.length === 0) {
    throw new Error("No match listings found on page — tickets not live yet");
  }

  const btn = await waitForElement(() => {
    const buttons = [...document.querySelectorAll("button, a")];
    return buttons.find((b) => {
      const text = b.innerText.trim().toUpperCase();
      // Match ticket buy buttons, but NOT merchandise buttons
      // Check that the button is near match/ticket content, not merch section
      const isBuyBtn = text.includes("BUY TICKET") || text.includes("BOOK NOW") || text.includes("BUY NOW");
      if (!isBuyBtn) return false;

      // Exclude if the button is inside a merchandise section
      const parent = b.closest("[class*='merch'], [class*='Merch'], [class*='merchandise']");
      if (parent) return false;

      // Exclude if nearby text says "merchandise"
      const parentText = (b.parentElement?.innerText || "").toLowerCase();
      if (parentText.includes("merchandise")) return false;

      return true;
    });
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
  await delay(3000); // wait for Konva seat map to render

  // Strategy 1: Use Konva's internal API (React-Konva exposes the stage)
  const konvaSuccess = await tryKonvaSeatSelection();
  if (konvaSuccess) return;

  // Strategy 2: Intercept network requests for seat data + simulate canvas clicks
  const apiSuccess = await tryAPISeatSelection();
  if (apiSuccess) return;

  // Strategy 3: Fallback - click centre of canvas with proper Konva event simulation
  await konvaCanvasFallback();
}

// ── Strategy 1: Konva internal API ───────────────────────────────────────────

async function tryKonvaSeatSelection() {
  try {
    // Konva stores all stages globally
    const Konva = window.Konva;
    if (!Konva || !Konva.stages || Konva.stages.length === 0) {
      console.log("[RCB] Konva not found or no stages");
      return false;
    }

    const stage = Konva.stages[0];
    const allShapes = stage.find("Rect, Circle, Path, RegularPolygon");
    console.log(`[RCB] Found ${allShapes.length} Konva shapes`);

    // Identify seat shapes: small, repeated shapes (not background/containers)
    // Seats are typically uniform-sized small shapes
    const shapeSizes = {};
    allShapes.forEach((s) => {
      const key = `${Math.round(s.width())}_${Math.round(s.height())}`;
      shapeSizes[key] = (shapeSizes[key] || 0) + 1;
    });

    // The most common size is likely the seat shape
    const seatSizeKey = Object.entries(shapeSizes)
      .sort(([, a], [, b]) => b - a)[0]?.[0];

    if (!seatSizeKey) return false;
    const [seatW, seatH] = seatSizeKey.split("_").map(Number);
    console.log(`[RCB] Seat size detected: ${seatW}x${seatH}`);

    // Filter to seat-shaped elements
    const seatShapes = allShapes.filter((s) => {
      const w = Math.round(s.width());
      const h = Math.round(s.height());
      return w === seatW && h === seatH;
    });

    // Identify available seats by color (green/available, grey or red/taken)
    // Available seats are usually green, blue, or have a lighter fill
    // Taken seats are usually grey, red, or darker
    const TAKEN_COLORS = ["#808080", "#999", "#ccc", "#ddd", "#eee", "#ff0000", "#f00",
      "gray", "grey", "red", "#d3d3d3", "#a9a9a9"];
    const available = seatShapes.filter((s) => {
      const fill = (s.fill() || "").toLowerCase();
      const listening = s.listening(); // disabled shapes are not listening
      const visible = s.visible();
      const isTaken = TAKEN_COLORS.some((c) => fill.includes(c));
      return visible && listening && !isTaken && fill !== "";
    });

    console.log(`[RCB] Available seats: ${available.length} / ${seatShapes.length}`);
    if (available.length === 0) return false;

    // Find the most central seat (middle row + middle column)
    const positions = available.map((s) => ({
      shape: s,
      x: s.absolutePosition().x,
      y: s.absolutePosition().y,
    }));

    const minX = Math.min(...positions.map((p) => p.x));
    const maxX = Math.max(...positions.map((p) => p.x));
    const minY = Math.min(...positions.map((p) => p.y));
    const maxY = Math.max(...positions.map((p) => p.y));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    // Sort by distance from center
    positions.sort((a, b) => {
      const da = Math.hypot(a.x - midX, a.y - midY);
      const db = Math.hypot(b.x - midX, b.y - midY);
      return da - db;
    });

    // Click the most central seat
    const best = positions[0];
    updateOverlay(`💺 Clicking optimal seat at (${Math.round(best.x)}, ${Math.round(best.y)})...`);

    // Fire Konva's internal click event
    best.shape.fire("click", { evt: new MouseEvent("click") });
    best.shape.fire("tap");
    await delay(500);

    // Verify seat was selected (shape might change color)
    console.log(`[RCB] Clicked seat, fill is now: ${best.shape.fill()}`);
    return true;

  } catch (e) {
    console.warn("[RCB] Konva seat selection failed:", e);
    return false;
  }
}

// ── Strategy 2: API-based seat data + canvas coordinate click ────────────────

async function tryAPISeatSelection() {
  try {
    // Try to find seat data from intercepted network requests
    // or from React component state via fiber tree
    const seatData = await findSeatDataInReact();
    if (!seatData || seatData.length === 0) return false;

    const available = seatData.filter((s) =>
      s.available || s.status === "available" || s.status === "AVAILABLE"
    );
    if (available.length === 0) return false;

    const optimal = findCentralSeat(available);
    if (!optimal) return false;

    updateOverlay(`💺 Clicking seat Row ${optimal.row}, Seat ${optimal.col}...`);
    await clickSeatViaKonvaCoords(optimal);
    return true;
  } catch (e) {
    console.warn("[RCB] API seat selection failed:", e);
    return false;
  }
}

function findSeatDataInReact() {
  // Walk the React fiber tree to find seat data in component state/props
  const root = document.getElementById("rcb-shop");
  if (!root || !root._reactRootContainer && !root.__reactFiber$) return null;

  // Try React 18 fiber
  const fiberKey = Object.keys(root).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) return null;

  const seats = [];
  function walkFiber(fiber, depth = 0) {
    if (!fiber || depth > 50) return;
    const state = fiber.memoizedState;
    const props = fiber.memoizedProps;

    // Look for seat arrays in state or props
    if (props?.seats) seats.push(...props.seats);
    if (props?.seatData) seats.push(...props.seatData);
    if (state?.seats) seats.push(...state.seats);

    // Check for arrays that look like seat data
    if (Array.isArray(props?.children)) {
      props.children.forEach((c) => {
        if (c?.props?.row !== undefined && c?.props?.col !== undefined) {
          seats.push({ row: c.props.row, col: c.props.col, ...c.props });
        }
      });
    }

    walkFiber(fiber.child, depth + 1);
    walkFiber(fiber.sibling, depth + 1);
  }
  walkFiber(root[fiberKey]);
  return seats.length > 0 ? seats : null;
}

function findCentralSeat(seats) {
  if (!seats.length) return null;
  const rows = seats.map((s) => s.row || s.y || 0);
  const cols = seats.map((s) => s.col || s.seat || s.column || s.x || 0);
  const midRow = (Math.min(...rows) + Math.max(...rows)) / 2;
  const midCol = (Math.min(...cols) + Math.max(...cols)) / 2;

  seats.sort((a, b) => {
    const ar = a.row || a.y || 0, ac = a.col || a.seat || a.column || a.x || 0;
    const br = b.row || b.y || 0, bc = b.col || b.seat || b.column || b.x || 0;
    return Math.hypot(ar - midRow, ac - midCol) - Math.hypot(br - midRow, bc - midCol);
  });
  return seats[0];
}

async function clickSeatViaKonvaCoords(seat) {
  const Konva = window.Konva;
  if (!Konva || !Konva.stages[0]) return;

  const stage = Konva.stages[0];
  const stagePos = stage.container().getBoundingClientRect();

  // Convert seat row/col to stage coordinates
  // Find shapes near the expected position
  const allShapes = stage.find("Rect, Circle");
  const target = allShapes.reduce((closest, s) => {
    if (!s.visible() || !s.listening()) return closest;
    const pos = s.absolutePosition();
    const dist = Math.hypot(pos.x - (seat.x || 0), pos.y - (seat.y || 0));
    return dist < (closest?.dist || Infinity) ? { shape: s, dist } : closest;
  }, null);

  if (target?.shape) {
    target.shape.fire("click", { evt: new MouseEvent("click") });
    target.shape.fire("tap");
  }
}

// ── Strategy 3: Fallback canvas click ────────────────────────────────────────

async function konvaCanvasFallback() {
  updateOverlay("💺 Trying canvas click fallback...");
  const Konva = window.Konva;

  if (Konva && Konva.stages[0]) {
    // Use Konva's getIntersection to find clickable shapes near centre
    const stage = Konva.stages[0];
    const w = stage.width();
    const h = stage.height();

    // Spiral outward from centre to find a clickable seat
    const cx = w / 2, cy = h / 2;
    for (let r = 0; r < Math.max(w, h) / 2; r += 10) {
      for (let angle = 0; angle < 360; angle += 15) {
        const px = cx + r * Math.cos(angle * Math.PI / 180);
        const py = cy + r * Math.sin(angle * Math.PI / 180);
        const shape = stage.getIntersection({ x: px, y: py });
        if (shape && shape.listening() && shape.visible()) {
          updateOverlay(`💺 Found seat at (${Math.round(px)}, ${Math.round(py)})`);
          shape.fire("click", { evt: new MouseEvent("click") });
          shape.fire("tap");
          await delay(300);

          // Check if it was selected (look for UI change)
          const proceedBtn = [...document.querySelectorAll("button")].find((b) =>
            /proceed|pay|checkout|confirm/i.test(b.innerText.trim())
          );
          if (proceedBtn && !proceedBtn.disabled) return;
        }
      }
    }
  }

  // Last resort: raw DOM canvas events
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    updateOverlay("⚠️ No seat map found — please select seats manually");
    return;
  }

  updateOverlay("⚠️ Couldn't auto-select seats. Please pick manually, bot will handle the rest.");
  // Wait for user to select seats manually, then proceed
  await waitForManualSeatSelection();
}

async function waitForManualSeatSelection() {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /proceed|pay|checkout|confirm/i.test(b.innerText.trim())
        && !b.disabled
      );
      if (btn) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
    // Timeout after 5 minutes
    setTimeout(() => { clearInterval(check); resolve(); }, 300000);
  });
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
