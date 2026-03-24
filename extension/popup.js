const TARGET_URL = "https://shop.royalchallengers.com/ticket";

// ── Load saved state + settings ───────────────────────────────────────────────

async function loadState() {
  const data = await chrome.storage.local.get(null);
  const settings = await new Promise((r) => chrome.storage.sync.get(null, r));

  // Status card — only show LIVE if ticketsLive was set recently (within 30 min)
  // This prevents stale "LIVE" state from previous sessions
  const isLive = data.ticketsLive && data.liveDetectedAt && (Date.now() - data.liveDetectedAt < 30 * 60 * 1000);
  const pageState = isLive ? "LIVE 🟢" : "Not live yet 🔴";
  document.getElementById("pageState").textContent = pageState;
  document.getElementById("pageState").className =
    "value " + (isLive ? "live" : "not-live");

  document.getElementById("lastCheck").textContent =
    data.lastCheck ? new Date(data.lastCheck).toLocaleTimeString() : "—";

  document.getElementById("cycleInfo").textContent =
    `Cycle #${data.checkCount || 0}`;

  const monEl = document.getElementById("monitoringStatus");
  monEl.innerHTML = `<span class="pill on">ON</span>`;

  // Settings
  if (settings.phone) document.getElementById("phone").value = settings.phone;
  if (settings.standPref) document.getElementById("standPref").value = settings.standPref;
  document.getElementById("autoBuy").checked = !!settings.autoBuy;
}

// ── Save settings ─────────────────────────────────────────────────────────────

document.getElementById("saveBtn").addEventListener("click", async () => {
  const phone = document.getElementById("phone").value.trim();
  const standPref = document.getElementById("standPref").value;
  const autoBuy = document.getElementById("autoBuy").checked;

  await new Promise((r) => chrome.storage.sync.set({ phone, standPref, autoBuy }, r));

  const msg = document.getElementById("saveMsg");
  msg.textContent = "✓ Saved!";
  setTimeout(() => (msg.textContent = ""), 2000);
});

// ── Check now ─────────────────────────────────────────────────────────────────

document.getElementById("checkNowBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  document.getElementById("checkNowBtn").textContent = "⏳ Checking...";
  setTimeout(() => {
    document.getElementById("checkNowBtn").textContent = "🔍 Check Now";
    loadState();
  }, 6000);
});

// ── Open ticket page ──────────────────────────────────────────────────────────

document.getElementById("openTabBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: TARGET_URL, active: true });
});

// ── Reset state ───────────────────────────────────────────────────────────────

document.getElementById("resetBtn").addEventListener("click", async () => {
  await new Promise((r) =>
    chrome.storage.local.remove(
      ["ticketsLive", "liveDetectedAt", "checkCount", "lastCheck", "buyerTabId", "autoBuyEnabled"],
      r
    )
  );
  loadState();
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadState();
