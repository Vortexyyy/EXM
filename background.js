// EXM background: owns the offscreen document (where Stockfish lives) and relays messages.
const OFFSCREEN_URL = "offscreen.html";
let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctx.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run the Stockfish engine in a Web Worker",
      })
      .finally(() => (creating = null));
  }
  await creating;
}

// The offscreen listener can lag a beat behind createDocument resolving.
async function sendToOffscreen(msg, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!String(e).includes("Receiving end does not exist")) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Engine page never came up");
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "exm-analyze" && sender.tab) {
    const tabId = sender.tab.id;
    ensureOffscreen()
      .then(() =>
        sendToOffscreen({ target: "exm-offscreen", type: "analyze", id: msg.id, fen: msg.fen, depth: msg.depth, tabId })
      )
      .catch((e) =>
        chrome.tabs.sendMessage(tabId, { type: "exm-update", id: msg.id, error: String(e) }).catch(() => {})
      );
  } else if (msg?.target === "exm-bg" && msg.type === "update") {
    chrome.tabs.sendMessage(msg.tabId, { ...msg, type: "exm-update" }).catch(() => {});
  }
});
