// video-feed-page.js
// PURPOSE:
// 1) Capture screen share or webcam.
// 2) Fetch a character string from column B of a public Google Sheet (GViz).
// 3) Render live video as “colored text pixels” using the fetched string in order, repeated.
// 4) Broadcast the rendered canvas frames to a WebSocket relay so viewers can see the same output.

const RELAY_WS_URL = "wss://answering-machine-relay.onrender.com";

// How often to broadcast frames to viewers.
const BROADCAST_EVERY_MS = 150;

// Broadcast image format and quality.
const BROADCAST_FORMAT = "image/jpeg";
const BROADCAST_QUALITY = 0.5;

// =============================
// SHEET CONFIG (GViz)
// =============================
const SHEET_ID = "1uhvL6gKOnxxMY07sg2nkICktceQI_nCMi6AEbSMCMvM";
const GID = "364222692";
const SHEET_POLL_MS = 3000;
const SHEET_VALUE_COL_INDEX = 1; // Column B

// =============================
// RENDER TUNING
// =============================
//THIS is where you control THE RESOLUTION of the output (so how many characters make the image)
const TARGET_COLS = 167;
const MIN_CELL_SIZE = 6;

// =============================
// STATE
// =============================
let stream = null;
let rafId = null;

// Updated from the sheet. Default is "@" so you always see something.
let charset = "@";

// Broadcast state.
let relaySocket = null;
let lastBroadcastAt = 0;

// Cycling state (operator-controlled; affects everyone watching).
let promptList = [];
let cycleEnabled = false;
let cycleIndex = 0;

// Cycle-all state (operator-controlled; affects everyone watching).
let cycleAllEnabled = false;

// How often to advance when cycling is ON.
const CYCLE_EVERY_MS = 2500;

// How many recent submissions to cycle through when cycling is ON.
const CYCLE_MAX_RECENT = 30;

// Which sheet column we are currently reading from (0-based): 1=B, 2=C, 3=D...
let activeSheetColIndex = SHEET_VALUE_COL_INDEX;

// Which columns are included in Cycle ALL mode (B..F by default).
const CYCLE_ALL_COLS = [1, 2, 3, 4, 5];

// Hidden video element used as the source.
const video = document.createElement("video");
video.autoplay = true;
video.playsInline = true;
video.muted = true;

// Offscreen sampling canvas.
const off = document.createElement("canvas");
const offCtx = off.getContext("2d", { willReadFrequently: true });

window.addEventListener("DOMContentLoaded", () => {
  const btnScreen = document.getElementById("btn-screen");
  const btnWebcam = document.getElementById("btn-webcam");
  const btnStop = document.getElementById("btn-stop");

  // OPTIONAL: If you add a button with id="btn-cycle" in video-feed-page.html,
  // this will enable cycling controls on the operator page.
  const btnCycle = document.getElementById("btn-cycle");

  // OPTIONAL: If you add a button with id="btn-cycle-all" in video-feed-page.html,
  // this will enable Cycle ALL controls on the operator page.
  const btnCycleAll = document.getElementById("btn-cycle-all");

  // OPTIONAL: If you add a select with id="column-select" in video-feed-page.html,
  // this will enable switching which sheet column we read from.
  const columnSelect = document.getElementById("column-select");

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("render");
  const ctx = canvas.getContext("2d", { alpha: false });

  function log(msg, obj) {
    if (obj !== undefined) console.log(msg, obj);
    else console.log(msg);
  }

  // =============================
  // RELAY CONNECT
  // =============================
  // PURPOSE: Reconnect only when the browser fires a real close/error event.
  let relayReconnectTimer = null;
  let relayReconnectDelayMs = 800;
  const RELAY_RECONNECT_MAX_MS = 8000;

  function clearRelayReconnectTimer() {
    if (relayReconnectTimer) {
      clearTimeout(relayReconnectTimer);
      relayReconnectTimer = null;
    }
  }

  function scheduleRelayReconnect() {
    // PURPOSE: Avoid reconnect storms.
    if (relayReconnectTimer) return;

    relayReconnectTimer = setTimeout(() => {
      relayReconnectTimer = null;
      connectRelay();
    }, relayReconnectDelayMs);

    relayReconnectDelayMs = Math.min(
      RELAY_RECONNECT_MAX_MS,
      Math.floor(relayReconnectDelayMs * 1.5)
    );
  }

  function connectRelay() {
    clearRelayReconnectTimer();

    // Close any existing socket cleanly before replacing it.
    if (relaySocket && (relaySocket.readyState === 0 || relaySocket.readyState === 1)) {
      try {
        relaySocket.close();
      } catch (e) {
        // PURPOSE: Keep render running even if relay close throws.
      }
    }

    relaySocket = new WebSocket(RELAY_WS_URL);

    relaySocket.addEventListener("open", () => {
      relayReconnectDelayMs = 800;
      log("Relay connected:", RELAY_WS_URL);
    });

    relaySocket.addEventListener("close", () => {
      log("Relay disconnected.");
      scheduleRelayReconnect();
    });

    relaySocket.addEventListener("error", (e) => {
      log("Relay error:", e);
      scheduleRelayReconnect();
    });
  }

  connectRelay();

  // =============================
  // CANVAS SIZE (FIXED TO STAGE)
  // =============================
  function resizeCanvasToStage() {
    // PURPOSE: Keep the render surface tied to the stage box, not the browser window.
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect(); // CSS pixels

    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    // Draw in CSS pixels with DPR scaling.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = "top";
  }

  // Stage is meant to be fixed-size via CSS, so we size once on load.
  resizeCanvasToStage();

  // =============================
  // SHEET FETCH (GViz)
  // =============================
  function buildGvizUrl() {
    const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;
    const params = new URLSearchParams({
      gid: GID,
      tq: "select *",
      tqx: "out:json",
    });
    return `${base}?${params.toString()}`;
  }

  function parseGviz(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) {
      throw new Error("GViz response did not include JSON (sheet may be blocked/private).");
    }
    return JSON.parse(text.slice(start, end + 1));
  }

  function gvizRows(gvizJson) {
    const table = gvizJson?.table;
    if (!table || !Array.isArray(table.rows)) {
      throw new Error("Unexpected GViz structure.");
    }
    return table.rows.map((r) => (r.c || []).map((cell) => (cell ? cell.v : "")));
  }

  function chooseLatestNonEmptyFromColumn(rows, colIndex) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const cell = rows[i]?.[colIndex];
      if (cell !== null && cell !== undefined) {
        const val = String(cell);
        if (val.length > 0) return val;
      }
    }
    return "";
  }

  function getRecentNonEmptyFromColumn(rows, colIndex, maxCount) {
    // PURPOSE: Collect up to maxCount most recent non-empty strings from a column.
    // IMPORTANT: Preserves exactly what the user entered (no trimming).
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const cell = rows[i]?.[colIndex];
      if (cell === null || cell === undefined) continue;
      const val = String(cell);
      if (val.length === 0) continue;

      out.push(val);
      if (out.length >= maxCount) break;
    }
    out.reverse(); // oldest -> newest
    return out;
  }

  function getRecentNonEmptyFromMultipleColumns(rows, colIndices, maxPerCol) {
    // PURPOSE: Build one combined list for Cycle ALL mode by pulling recent values from each column.
    // Order is column-major (B, then C, then D...) while preserving each column’s internal order.
    const combined = [];
    for (const idx of colIndices) {
      const list = getRecentNonEmptyFromColumn(rows, idx, maxPerCol);
      for (const v of list) combined.push(v);
    }
    return combined;
  }

  async function pollSheetOnce() {
    const url = buildGvizUrl();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    const gvizJson = parseGviz(text);
    const rows = gvizRows(gvizJson);

    // Cycle ALL mode: build one combined list across multiple columns.
    if (cycleAllEnabled) {
      const list = getRecentNonEmptyFromMultipleColumns(rows, CYCLE_ALL_COLS, CYCLE_MAX_RECENT);
      if (list.length) {
        promptList = list;
        if (cycleIndex >= promptList.length) cycleIndex = 0;
        log("Updated prompt list from sheet (cycle all):", promptList.length);
      } else {
        log("Sheet fetch succeeded, but the selected columns had no non-empty values yet.");
      }
      return;
    }

    // If cycling is enabled, keep a list of recent prompts from the active column.
    if (cycleEnabled) {
      const list = getRecentNonEmptyFromColumn(rows, activeSheetColIndex, CYCLE_MAX_RECENT);
      if (list.length) {
        promptList = list;
        if (cycleIndex >= promptList.length) cycleIndex = 0;
        log("Updated prompt list from sheet (cycling):", promptList.length);
      } else {
        log("Sheet fetch succeeded, but the selected column had no non-empty values yet.");
      }
      return;
    }

    // If cycling is disabled, behave exactly like before (latest only).
    const v = chooseLatestNonEmptyFromColumn(rows, activeSheetColIndex);

    if (v.length) {
      charset = v + " "; // Add a space at the end so you can get blanks.
      log("Updated charset from sheet:", charset);
    } else {
      log("Sheet fetch succeeded, but the selected column had no non-empty values yet.");
    }
  }

  function startSheetPolling() {
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
    setInterval(() => {
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
    }, SHEET_POLL_MS);
  }

  // =============================
  // COLUMN SELECT (OPERATOR DROPDOWN)
  // =============================
  function setActiveColumnFromSelect() {
    if (!columnSelect) return;

    const parsed = Number(columnSelect.value);
    if (Number.isFinite(parsed)) {
      activeSheetColIndex = parsed;

      // Reset cycling index so it starts clean on a new column.
      cycleIndex = 0;

      // Force a refresh immediately so the new column takes effect right away.
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));

      log("Active sheet column index set to:", activeSheetColIndex);
    }
  }

  if (columnSelect) {
    // Default dropdown to B (value "1") unless you change the HTML.
    columnSelect.value = String(activeSheetColIndex);
    columnSelect.addEventListener("change", setActiveColumnFromSelect);
  }

  // =============================
  // CYCLING CONTROL (OPERATOR BUTTON)
  // =============================
  function applyCycleButtonLabel() {
    if (!btnCycle) return;
    btnCycle.textContent = cycleEnabled ? "Cycle: ON" : "Cycle: OFF";
  }

  function enableCycling() {
    cycleEnabled = true;
    cycleAllEnabled = false;
    cycleIndex = 0;
    applyCycleButtonLabel();
    applyCycleAllButtonLabel();
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableCycling() {
    cycleEnabled = false;
    cycleIndex = 0;
    applyCycleButtonLabel();
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnCycle) {
    applyCycleButtonLabel();
    btnCycle.addEventListener("click", () => {
      if (cycleEnabled) disableCycling();
      else enableCycling();
    });
  }

  // =============================
  // CYCLE ALL CONTROL (OPERATOR BUTTON)
  // =============================
  function applyCycleAllButtonLabel() {
    if (!btnCycleAll) return;
    btnCycleAll.textContent = cycleAllEnabled ? "Cycle ALL: ON" : "Cycle ALL: OFF";
  }

  function enableCycleAll() {
    cycleAllEnabled = true;
    cycleEnabled = false;
    cycleIndex = 0;
    applyCycleAllButtonLabel();
    applyCycleButtonLabel();
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableCycleAll() {
    cycleAllEnabled = false;
    cycleIndex = 0;
    applyCycleAllButtonLabel();
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnCycleAll) {
    applyCycleAllButtonLabel();
    btnCycleAll.addEventListener("click", () => {
      if (cycleAllEnabled) disableCycleAll();
      else enableCycleAll();
    });
  }

  // Advance the charset while cycling is ON.
  setInterval(() => {
    if (!cycleEnabled && !cycleAllEnabled) return;
    if (!promptList.length) return;

    const current = promptList[cycleIndex % promptList.length];
    charset = current + " "; // Add a space at the end so you can get blanks.
    cycleIndex = (cycleIndex + 1) % promptList.length;
  }, CYCLE_EVERY_MS);

  // =============================
  // MEDIA CAPTURE
  // =============================
  async function startScreenShare() {
    try {
      log("Requesting display media…");

      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      log("Display media granted.");
      attachStream(s);
    } catch (e) {
      log("Screen share error:", e);
    }
  }

  async function startWebcam() {
    try {
      log("Starting webcam…");
      const s = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      attachStream(s);
    } catch (e) {
      log("Webcam error:", e);
    }
  }

  function attachStream(s) {
    stream = s;
    video.srcObject = s;

    btnStop.disabled = false;
    btnScreen.disabled = true;
    btnWebcam.disabled = true;

    s.getTracks().forEach((t) => t.addEventListener("ended", stopAll));

    Promise.resolve()
      .then(() => video.play())
      .then(() => {
        log("Media stream attached. Rendering…");
        startRenderLoop();
      })
      .catch((e) => log("video.play() error:", e));
  }

  function stopAll() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    video.srcObject = null;

    btnStop.disabled = true;
    btnScreen.disabled = false;
    btnWebcam.disabled = false;

    // Clear the canvas to black.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Re-apply stage sizing transform.
    resizeCanvasToStage();

    log("Stopped.");
  }

  btnScreen.addEventListener("click", startScreenShare);
  btnWebcam.addEventListener("click", startWebcam);
  btnStop.addEventListener("click", stopAll);

  // =============================
  // BROADCAST
  // =============================
  function broadcastFrameIfDue() {
    const now = performance.now();
    if (now - lastBroadcastAt < BROADCAST_EVERY_MS) return;
    lastBroadcastAt = now;

    if (!relaySocket) return;
    if (relaySocket.readyState !== 1) return;

    // Backpressure: if the socket is still flushing previous frames, skip this one.
    // This keeps the viewer live instead of seconds behind.
    const MAX_BUFFERED_BYTES = 1_000_000; // ~1MB
    if (relaySocket.bufferedAmount > MAX_BUFFERED_BYTES) return;

    const frame = canvas.toDataURL(BROADCAST_FORMAT, BROADCAST_QUALITY);

    // PURPOSE: If send throws, it counts as a real failure and we reconnect with backoff.
    try {
      relaySocket.send(frame);
    } catch (e) {
      log("Relay send error:", e);
      scheduleRelayReconnect();
    }
  }

  // =============================
  // RENDER: REPEATING STRING + RGB GLYPHS
  // =============================
  function startRenderLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    const tick = () => {
      rafId = requestAnimationFrame(tick);

      // IMPORTANT: size comes from the stage, not the viewport, so window resizing doesn't warp output.
      const rect = stage.getBoundingClientRect();
      const viewW = rect.width;
      const viewH = rect.height;

      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, viewW, viewH);

      if (!stream) return;
      if (video.readyState < 2) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const cellSize = Math.max(MIN_CELL_SIZE, Math.floor(viewW / TARGET_COLS));
      const cols = Math.max(1, Math.floor(viewW / cellSize));
      const rows = Math.max(1, Math.floor(viewH / cellSize));

      off.width = cols;
      off.height = rows;

      try {
        offCtx.drawImage(video, 0, 0, cols, rows);
      } catch (e) {
        log("drawImage error:", e);
        return;
      }

      const img = offCtx.getImageData(0, 0, cols, rows);
      const data = img.data;

      const usable = String(charset ?? "").length ? String(charset) : "@";
      const L = usable.length;

      ctx.font = `${cellSize}px Consolas, monospace`;
      ctx.textBaseline = "top";

      let charIndex = 0;
      let i = 0;

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          ctx.fillStyle = `rgb(${r},${g},${b})`;

          const ch = usable[charIndex % L];
          charIndex++;

          ctx.fillText(ch, x * cellSize, y * cellSize);

          i += 4;
        }
      }

      broadcastFrameIfDue();
    };

    tick();
  }

  // =============================
  // STARTUP
  // =============================
  applyCycleButtonLabel();
  applyCycleAllButtonLabel();
  startSheetPolling();
  log("Ready. Click a capture button.");
});