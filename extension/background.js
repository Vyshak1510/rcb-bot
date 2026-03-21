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

// ── Page check ───────────────────────────────────────────────────────────────

async function checkPage() {
  try {
    const res = await fetch(TARGET_URL, { cache: "no-store" });
    const html = await res.text();

    // Tier 1: check raw HTML size + bundle hash change
    const bundleMatch = html.match(/\/assets\/index-([a-zA-Z0-9]+)\.js/);
    const bundleHash = bundleMatch ? bundleMatch[1] : null;

    const { lastBundleHash, lastSize, ticketsLive } = await getState();

    const sizeChanged = html.length > 10000;
    const hashChanged = bundleHash && bundleHash !== lastBundleHash;

    if (lastBundleHash && hashChanged) {
      console.log(`[RCB] Bundle hash changed: ${lastBundleHash} → ${bundleHash}`);
    }

    await setState({ lastBundleHash: bundleHash || lastBundleHash, lastSize: html.length });

    // Tier 2: open a background tab to let content script check rendered DOM
    // Only do this every 5th check or when Tier 1 signals a change
    const { checkCount = 0 } = await getState();
    await setState({ checkCount: checkCount + 1 });

    if (sizeChanged || hashChanged || checkCount % 5 === 0) {
      openCheckTab();
    }

  } catch (e) {
    console.error("[RCB] Check failed:", e);
  }
}

// Open the ticket page in a background tab so content.js can inspect the DOM
function openCheckTab() {
  chrome.tabs.create({ url: TARGET_URL, active: false }, (tab) => {
    // content.js will handle detection and message us back
    console.log("[RCB] Opened check tab:", tab.id);
  });
}

// ── Messages from content.js ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "TICKETS_DETECTED") {
    handleTicketsLive(msg.teams, msg.tabId || sender.tab?.id);
  }

  if (msg.type === "CHECK_TAB_CLEAN") {
    // Page not live yet — close the background check tab silently
    if (sender.tab?.id) chrome.tabs.remove(sender.tab.id);
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

  await setState({ ticketsLive: true });
  console.log("[RCB] TICKETS LIVE! Teams:", teams);

  // Open the real ticket tab for buying
  chrome.tabs.create({ url: TARGET_URL, active: true }, (tab) => {
    // Store the tab ID so we can inject the buyer later
    setState({ buyerTabId: tab.id });
  });

  // Close the background check tab
  if (checkTabId) chrome.tabs.remove(checkTabId);

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
