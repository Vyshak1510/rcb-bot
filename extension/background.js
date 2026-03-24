const TARGET_URL = "https://shop.royalchallengers.com/ticket";
const API_URL = "https://rcbscaleapi.ticketgenie.in/ticket/eventlist/O";

const TEAM_NAMES = [
  "chennai", "delhi", "gujarat", "kolkata",
  "lucknow", "mumbai", "punjab", "rajasthan", "hyderabad"
];

// ── Polling via chrome.alarms (1-min, guaranteed by Chrome) ──────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("ticketCheck", { periodInMinutes: 1 });
  console.log("[RCB] Extension installed, alarm set for every 1 min.");
  checkPage(); // immediate first check
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ticketCheck") checkPage();
});

// ── Page check (API first, HTML fallback — no tabs opened) ───────────────────

async function checkPage() {
  try {
    const { ticketsLive, liveDetectedAt } = await getState();
    // Clear stale live state (older than 30 min) so monitoring resumes
    if (ticketsLive && liveDetectedAt && (Date.now() - liveDetectedAt > 30 * 60 * 1000)) {
      await setState({ ticketsLive: false, liveDetectedAt: null });
    } else if (ticketsLive) {
      return;
    }

    const { checkCount = 0 } = await getState();
    let detected = false;
    let detectedTeams = [];

    // ── Signal 1: API check (fast, reliable) ──
    try {
      const apiRes = await fetch(API_URL, { cache: "no-store" });
      const apiData = await apiRes.json();
      if (apiData.status === "Success" && apiData.result && apiData.result.length > 0) {
        console.log(`[RCB] API: ${apiData.result.length} events found!`, apiData.result);
        detected = true;
        detectedTeams = apiData.result.map(e => e.eventName || e.name || "event");
      } else {
        console.log(`[RCB] Cycle ${checkCount + 1} | API: no events yet`);
      }
    } catch (e) {
      console.error("[RCB] API check failed:", e);
    }

    // ── Signal 2: HTML check (bundle hash + size change) ──
    if (!detected) {
      try {
        const res = await fetch(TARGET_URL, { cache: "no-store" });
        const html = await res.text();

        const bundleMatch = html.match(/\/assets\/index-([a-zA-Z0-9]+)\.js/);
        const bundleHash = bundleMatch ? bundleMatch[1] : null;
        const { lastBundleHash } = await getState();

        const sizeChanged = html.length > 10000;
        const hashChanged = bundleHash && lastBundleHash && bundleHash !== lastBundleHash;

        await setState({ lastBundleHash: bundleHash || lastBundleHash, lastSize: html.length });

        if (hashChanged) {
          console.log(`[RCB] Bundle hash changed: ${lastBundleHash} → ${bundleHash}`);
        }

        if (sizeChanged || hashChanged) {
          detected = true;
          detectedTeams = ["change detected via HTML"];
        }
      } catch (e) {
        console.error("[RCB] HTML check failed:", e);
      }
    }

    await setState({ checkCount: checkCount + 1, lastCheck: Date.now() });

    if (detected) {
      console.log("[RCB] TICKETS DETECTED! Opening tab...");
      handleTicketsLive(detectedTeams, null);
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
