const TARGET_URL = "https://shop.royalchallengers.com/ticket";
const CHECK_INTERVAL_MINUTES = 1;

const TEAM_NAMES = [
  "chennai", "delhi", "gujarat", "kolkata",
  "lucknow", "mumbai", "punjab", "rajasthan", "hyderabad"
];

// ── Alarm setup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("ticketCheck", { periodInMinutes: CHECK_INTERVAL_MINUTES });
  console.log("[RCB] Extension installed, alarm set.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ticketCheck") checkPage();
});

// Also check immediately on service worker startup
checkPage();

// ── Page check (fetch only — no tabs opened during monitoring) ───────────────

async function checkPage() {
  try {
    const res = await fetch(TARGET_URL, { cache: "no-store" });
    const html = await res.text();

    const bundleMatch = html.match(/\/assets\/index-([a-zA-Z0-9]+)\.js/);
    const bundleHash = bundleMatch ? bundleMatch[1] : null;

    const { lastBundleHash, checkCount = 0, ticketsLive, liveDetectedAt } = await getState();
    // Clear stale live state (older than 30 min) so monitoring resumes
    if (ticketsLive && liveDetectedAt && (Date.now() - liveDetectedAt > 30 * 60 * 1000)) {
      await setState({ ticketsLive: false, liveDetectedAt: null });
    } else if (ticketsLive) {
      return; // actively handling, skip check
    }

    const sizeChanged = html.length > 10000;
    const hashChanged = bundleHash && lastBundleHash && bundleHash !== lastBundleHash;

    await setState({
      lastBundleHash: bundleHash || lastBundleHash,
      lastSize: html.length,
      checkCount: checkCount + 1,
      lastCheck: Date.now(),
    });

    if (hashChanged) {
      console.log(`[RCB] Bundle hash changed: ${lastBundleHash} → ${bundleHash} — tickets may be live!`);
    }

    // Signal detected: open the buying tab (content.js will confirm + buy)
    if (sizeChanged || hashChanged) {
      console.log("[RCB] Change detected, opening ticket tab...");
      handleTicketsLive(["change detected"], null);
    }

  } catch (e) {
    console.error("[RCB] Check failed:", e);
  }
}

// ── Messages from content.js ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "TICKETS_DETECTED") {
    handleTicketsLive(msg.teams, msg.tabId || sender.tab?.id);
  }

  if (msg.type === "CHECK_TAB_CLEAN") {
    // No-op: we no longer open check windows
  }

  if (msg.type === "AUTO_BUY_TRIGGER") {
    // User clicked notification or popup — run buying flow in tab
    triggerAutoBuy(msg.tabId);
  }
});

// ── Tickets live ─────────────────────────────────────────────────────────────

async function handleTicketsLive(teams, checkTabId) {
  const { ticketsLive } = await getState();
  if (ticketsLive) return; // already notified

  await setState({ ticketsLive: true, liveDetectedAt: Date.now() });
  console.log("[RCB] TICKETS LIVE! Teams:", teams);

  // Open the real ticket tab for buying
  chrome.tabs.create({ url: TARGET_URL, active: true }, (tab) => {
    // Store the tab ID so we can inject the buyer later
    setState({ buyerTabId: tab.id });
  });


  // Fire desktop notification
  chrome.notifications.create("ticketsLive", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "🏏 RCB TICKETS ARE LIVE!",
    message: `Tickets detected! Teams: ${teams.join(", ")}. Auto-buying now...`,
    priority: 2,
    requireInteraction: true,
  });
}

// Click on notification → focus the buyer tab
chrome.notifications.onClicked.addListener((id) => {
  if (id === "ticketsLive") {
    chrome.storage.local.get("buyerTabId", ({ buyerTabId }) => {
      if (buyerTabId) chrome.tabs.update(buyerTabId, { active: true });
    });
  }
});

// ── Auto-buy trigger ──────────────────────────────────────────────────────────

function triggerAutoBuy(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.dispatchEvent(new CustomEvent("RCB_START_BUY")),
  });
}

// ── State helpers ─────────────────────────────────────────────────────────────

function getState() {
  return new Promise((resolve) => chrome.storage.local.get(null, resolve));
}

function setState(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}
