// viewer.js
// PURPOSE:
// 1) Connect to the WebSocket relay.
// 2) Receive base64 image frames (data URLs) from the operator.
// 3) Display the latest frame in the <img id="frame">.
// 4) Auto-reconnect if the relay sleeps / disconnects.
// 5) Prevent flicker at end-of-stream by ignoring late frames and requiring “2 fresh frames” to go online.

const RELAY_WS_URL = "wss://answering-machine-relay.onrender.com";

// Reconnect timing (Render free tier can spin down).
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8000;

// If frames stop arriving, we hide the <img> and reconnect.
const STALE_FRAME_MS = 4000;

// When we declare the stream stale, ignore any late frames for this long.
// This prevents “last frame flashes back” flicker.
const STALE_COOLDOWN_MS = 2000;

// Require multiple fresh frames to go “online” again.
// This prevents one stray/late frame from flipping online.
const ONLINE_MIN_FRAMES = 2;
const ONLINE_WINDOW_MS = 700;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;

let lastFrameAt = 0;

// Offline/online gating to prevent flicker
let isOnline = false;
let staleUntil = 0;

// For “needs two frames” rule
let onlineWindowStart = 0;
let onlineFrameCount = 0;

window.addEventListener("DOMContentLoaded", () => {
  const img = document.getElementById("frame");

  function log(msg, obj) {
    if (obj !== undefined) console.log(msg, obj);
    else console.log(msg);
  }

  function showOfflineState() {
    // PURPOSE: Keep the border visible (your CSS) while removing the image itself.
    img.style.opacity = "0";
    isOnline = false;
  }

  function showOnlineState() {
    // PURPOSE: Show live frames only after we have confidence the stream is truly live.
    img.style.opacity = "1";
    isOnline = true;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      connect();
    }, reconnectDelay);

    reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.floor(reconnectDelay * 1.5));
  }

  async function coerceMessageToString(data) {
    // PURPOSE: Normalize relay messages into a string data URL.
    if (typeof data === "string") return data;

    if (data instanceof Blob) {
      return await data.text();
    }

    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(data));
    }

    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }

    return "";
  }

  function connect() {
    clearReconnectTimer();

    try {
      ws = new WebSocket(RELAY_WS_URL);
    } catch (e) {
      log("Viewer WebSocket constructor error:", e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      log("Viewer connected to relay:", RELAY_WS_URL);
      reconnectDelay = RECONNECT_BASE_MS;
    });

    ws.addEventListener("message", async (evt) => {
      const dataUrl = await coerceMessageToString(evt.data);
      if (!dataUrl.startsWith("data:image/")) return;

      const now = Date.now();

      // PURPOSE: Ignore late frames during the stale cooldown window to prevent flicker.
      if (now < staleUntil) return;

      // Record receipt time.
      lastFrameAt = now;

      // Always update the src (so when we go online, it’s already current).
      img.src = dataUrl;

      // PURPOSE: Only go “online” after receiving 2 frames within a short window.
      if (!isOnline) {
        if (!onlineWindowStart || now - onlineWindowStart > ONLINE_WINDOW_MS) {
          onlineWindowStart = now;
          onlineFrameCount = 1;
        } else {
          onlineFrameCount += 1;
        }

        if (onlineFrameCount >= ONLINE_MIN_FRAMES) {
          showOnlineState();
        }
      } else {
        // Already online: keep showing.
        showOnlineState();
      }
    });

    ws.addEventListener("close", () => {
      log("Viewer relay connection closed. Reconnecting…");
      scheduleReconnect();
    });

    ws.addEventListener("error", (e) => {
      log("Viewer relay error:", e);
      try {
        ws.close();
      } catch (_) {}
    });
  }

  // If the stream goes stale, hide the image, start a cooldown, and reconnect.
  setInterval(() => {
    if (!ws) return;
    if (ws.readyState !== 1) return;

    const now = Date.now();

    if (lastFrameAt && now - lastFrameAt > STALE_FRAME_MS) {
      showOfflineState();

      // PURPOSE: Prevent late frames from briefly appearing.
      staleUntil = now + STALE_COOLDOWN_MS;

      // Reset online gating window.
      onlineWindowStart = 0;
      onlineFrameCount = 0;
      lastFrameAt = 0;

      log("Viewer stale frames detected. Reconnecting…");
      try {
        ws.close();
      } catch (_) {}
    }
  }, 500);

  showOfflineState();
  connect();
});