// video-feed-page.js
// PURPOSE:
// 1) Capture screen share or webcam.
// 2) Fetch a character string from a public Google Sheet (GViz).
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
const SHEET_VALUE_COL_INDEX = 1; // Column B (default)

// =============================
// RENDER TUNING
// =============================
// THIS is where you control THE RESOLUTION of the output (so how many characters make the image)
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

// Pause state for cycling (operator-controlled; affects everyone watching).
// PURPOSE:
// - Pause DOES NOT turn cycling off.
// - Pause freezes on the current line.
// - Prev/Next while cycling forces pause and steps.
let cyclePaused = false;

// Manual browse state (operator-controlled; affects everyone watching).
// PURPOSE: Let the operator step up/down through entries in the selected scope (single column OR ALL).
let manualEnabled = false;
let manualList = []; // oldest -> newest
let manualIndex = 0;

// Most-recent mode state (operator-controlled; affects everyone watching).
// PURPOSE: Force the system to display ONLY the newest entry from the selected scope (column or ALL).
// IMPORTANT: This mode is the default when cycling and manual browsing are OFF.
let mostRecentEnabled = true;

// How often to advance when cycling is ON.
let cycleIntervalMs = 2500;

// How many recent submissions to use for lists (manual/cycle/most recent).
const CYCLE_MAX_RECENT = 30;

// Which sheet column we are currently reading from (0-based): 1=B, 2=C, 3=D...
let activeSheetColIndex = SHEET_VALUE_COL_INDEX;

// Selected scope: either one column (by index) or ALL columns.
let scopeIsAll = false;

// Which columns are included in ALL-scope operations.
// NOTE: This array is updated dynamically after each GViz poll so newly-added columns are included.
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

  // OPTIONAL: If you add a button with id="btn-pause" in video-feed-page.html,
  // this will enable Pause/Resume for cycling.
  const btnPause = document.getElementById("btn-pause");

  // OPTIONAL: If you add a button with id="btn-most-recent" in video-feed-page.html,
  // this will force "most recent only" mode for the selected scope (column or ALL).
  const btnMostRecent = document.getElementById("btn-most-recent");

  // OPTIONAL: If you add a select with id="column-select" in video-feed-page.html,
  // this will enable switching which sheet column we read from.
  const columnSelect = document.getElementById("column-select");

  // OPTIONAL: If you add buttons with id="btn-manual-prev" / id="btn-manual-next" in video-feed-page.html,
  // this will enable Prev/Next stepping:
  // - If cycling is ON, Prev/Next pauses and steps the cycle list (wraps).
  // - If cycling is OFF, Prev/Next steps the manual list for the selected scope (wraps).
  const btnManualPrev = document.getElementById("btn-manual-prev");
  const btnManualNext = document.getElementById("btn-manual-next");

  // OPTIONAL: If you add a div with id="manual-status" in video-feed-page.html,
  // this will show the unified status line.
  // IMPORTANT: Status text format is ALWAYS:
  //   COLUMN X : current / total
  // where X is a column letter (B, C, D...) or ALL.
  const manualStatus = document.getElementById("manual-status");

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("render");
  const ctx = canvas.getContext("2d", { alpha: false });

  function log(msg, obj) {
    if (obj !== undefined) console.log(msg, obj);
    else console.log(msg);
  }

  // =============================
  // STATUS LINE (UNIFIED / ALWAYS ON)
  // =============================
  function setManualStatus(text) {
    if (manualStatus) manualStatus.textContent = text;
  }

  function colIndexToLetter(idx) {
    let n = idx + 1;
    let s = "";
    while (n > 0) {
      const mod = (n - 1) % 26;
      s = String.fromCharCode(65 + mod) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function setUnifiedStatus(position, total) {
    const columnLabel = scopeIsAll ? "ALL" : colIndexToLetter(activeSheetColIndex);
    const p = Number.isFinite(position) && position >= 0 ? position : 0;
    const t = Number.isFinite(total) && total >= 0 ? total : 0;
    setManualStatus(`COLUMN ${columnLabel} : ${p} / ${t}`);
  }

  setUnifiedStatus(0, 0);

  // =============================
  // RELAY CONNECT
  // =============================
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

    if (relaySocket && (relaySocket.readyState === 0 || relaySocket.readyState === 1)) {
      try {
        relaySocket.close();
      } catch (e) {}
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
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();

    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = "top";
  }

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

  function getRecentNonEmptyFromColumn(rows, colIndex, maxCount) {
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const cell = rows[i]?.[colIndex];
      if (cell === null || cell === undefined) continue;
      const val = String(cell);
      if (val.length === 0) continue;

      out.push(val);
      if (out.length >= maxCount) break;
    }
    out.reverse();
    return out;
  }

  function getRecentNonEmptyFromMultipleColumns(rows, colIndices, maxPerCol) {
    const combined = [];
    for (const idx of colIndices) {
      const list = getRecentNonEmptyFromColumn(rows, idx, maxPerCol);
      for (const v of list) combined.push(v);
    }
    return combined;
  }

  // =============================
  // COLUMN DISCOVERY (AUTO-POPULATE DROPDOWN)
  // =============================
  function rebuildColumnSelectFromGviz(gvizJson, rows) {
    if (!columnSelect) return;

    const cols = gvizJson?.table?.cols;
    if (!Array.isArray(cols) || cols.length === 0) return;

    const firstPromptCol = cols.length > 1 ? 1 : 0;

    function columnHasAnyData(colIndex) {
      for (let i = 0; i < rows.length; i++) {
        const cell = rows[i]?.[colIndex];
        if (cell === null || cell === undefined) continue;
        const val = String(cell);
        if (val.length > 0) return true;
      }
      return false;
    }

    const prevRaw = String(columnSelect.value);
    const prevScopeIsAll = prevRaw === "ALL";
    const prevCol = Number(prevRaw);

    columnSelect.innerHTML = "";

    // Always include ALL.
    const optAll = document.createElement("option");
    optAll.value = "ALL";
    optAll.textContent = "ALL";
    columnSelect.appendChild(optAll);

    const included = [];

    for (let i = firstPromptCol; i < cols.length; i++) {
      if (!columnHasAnyData(i)) continue;

      const letter = colIndexToLetter(i);
      const label = String(cols[i]?.label ?? "").trim();

      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = label ? `${letter} — ${label}` : letter;

      columnSelect.appendChild(opt);
      included.push(i);
    }

    if (!included.length) {
      const fallback = firstPromptCol;

      const letter = colIndexToLetter(fallback);
      const label = String(cols[fallback]?.label ?? "").trim();

      const opt = document.createElement("option");
      opt.value = String(fallback);
      opt.textContent = label ? `${letter} — ${label}` : letter;

      columnSelect.appendChild(opt);

      scopeIsAll = false;
      columnSelect.value = String(fallback);
      activeSheetColIndex = fallback;
      return;
    }

    if (prevScopeIsAll) {
      scopeIsAll = true;
      columnSelect.value = "ALL";
      return;
    }

    const keepPrev = Number.isFinite(prevCol) && included.includes(prevCol);
    const next = keepPrev ? prevCol : included[0];

    scopeIsAll = false;
    columnSelect.value = String(next);
    activeSheetColIndex = next;
  }

  function getDynamicCycleAllCols(gvizJson) {
    const cols = gvizJson?.table?.cols;
    if (!Array.isArray(cols)) return [1, 2, 3, 4, 5];

    const out = [];
    for (let i = 1; i < cols.length; i++) out.push(i);
    return out;
  }

  function buildListForCurrentScope(rows) {
    if (scopeIsAll) {
      return getRecentNonEmptyFromMultipleColumns(rows, CYCLE_ALL_COLS, CYCLE_MAX_RECENT);
    }
    return getRecentNonEmptyFromColumn(rows, activeSheetColIndex, CYCLE_MAX_RECENT);
  }

  // =============================
  // MODE HELPERS
  // =============================
  function applyCycleButtonLabel() {
    if (!btnCycle) return;
    btnCycle.textContent = cycleEnabled ? "Cycle: ON" : "Cycle: OFF";
  }

  function applyPauseButtonLabel() {
    if (!btnPause) return;

    if (!cycleEnabled) {
      btnPause.textContent = "Pause";
      btnPause.disabled = true;
      return;
    }

    btnPause.disabled = false;
    btnPause.textContent = cyclePaused ? "Resume" : "Pause";
  }

  function enableMostRecentMode() {
    mostRecentEnabled = true;

    manualEnabled = false;
    manualList = [];
    manualIndex = 0;

    cyclePaused = false;
    cycleEnabled = false;

    applyCycleButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnMostRecent) {
    btnMostRecent.addEventListener("click", () => {
      enableMostRecentMode();
    });
  }

  // =============================
  // MANUAL BROWSE HELPERS
  // =============================
  function applyManualCharset() {
    if (!manualList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = manualList.length;
    manualIndex = ((manualIndex % N) + N) % N;

    const current = manualList[manualIndex];
    charset = current + " ";

    setUnifiedStatus(manualIndex + 1, N);
  }

  function enableManualMode() {
    manualEnabled = true;
    mostRecentEnabled = false;

    cyclePaused = false;
    cycleEnabled = false;

    applyCycleButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableManualMode() {
    manualEnabled = false;
    manualList = [];
    manualIndex = 0;
  }

  function stepManual(delta) {
    if (!manualEnabled) enableManualMode();
    if (!manualList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = manualList.length;
    manualIndex = ((manualIndex + delta) % N + N) % N;
    applyManualCharset();
  }

  // =============================
  // CYCLING STEP HELPERS
  // =============================
  function applyCycleCharsetFromIndex() {
    if (!promptList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = promptList.length;
    cycleIndex = ((cycleIndex % N) + N) % N;

    const current = promptList[cycleIndex];
    charset = current + " ";

    setUnifiedStatus(cycleIndex + 1, N);
  }

  function stepCycle(delta) {
    if (!promptList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = promptList.length;
    cycleIndex = ((cycleIndex + delta) % N + N) % N;
    applyCycleCharsetFromIndex();
  }

  // =============================
  // PAUSE CONTROL (CYCLE)
  // =============================
  function pauseCycling() {
    if (!cycleEnabled) return;
    cyclePaused = true;
    applyPauseButtonLabel();
  }

  function resumeCycling() {
    if (!cycleEnabled) return;
    cyclePaused = false;
    applyPauseButtonLabel();
  }

  function togglePauseCycling() {
    if (cyclePaused) resumeCycling();
    else pauseCycling();
  }

  if (btnPause) {
    btnPause.addEventListener("click", () => {
      togglePauseCycling();
    });
  }

  // =============================
  // SHEET POLL (ONE SHOT)
  // =============================
  async function pollSheetOnce() {
    const url = buildGvizUrl();
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    const gvizJson = parseGviz(text);
    const rows = gvizRows(gvizJson);

    rebuildColumnSelectFromGviz(gvizJson, rows);

    const dynamicCols = getDynamicCycleAllCols(gvizJson);
    CYCLE_ALL_COLS.splice(0, CYCLE_ALL_COLS.length, ...dynamicCols);

    const scopeList = buildListForCurrentScope(rows);

    if (manualEnabled) {
      manualList = scopeList;

      if (manualList.length) {
        const N = manualList.length;
        manualIndex = ((manualIndex % N) + N) % N;
      } else {
        manualIndex = 0;
      }

      applyManualCharset();
      return;
    }

    if (cycleEnabled) {
      promptList = scopeList;

      if (promptList.length) {
        const N = promptList.length;
        cycleIndex = ((cycleIndex % N) + N) % N;
      } else {
        cycleIndex = 0;
      }

      applyCycleCharsetFromIndex();
      applyPauseButtonLabel();
      return;
    }

    if (mostRecentEnabled) {
      if (scopeList.length) {
        const N = scopeList.length;
        const lastIndex = N - 1;
        const newest = scopeList[lastIndex];

        charset = newest + " ";
        setUnifiedStatus(lastIndex + 1, N);
      } else {
        setUnifiedStatus(0, 0);
      }

      applyPauseButtonLabel();
      return;
    }

    mostRecentEnabled = true;
    if (scopeList.length) {
      const N = scopeList.length;
      const lastIndex = N - 1;
      const newest = scopeList[lastIndex];

      charset = newest + " ";
      setUnifiedStatus(lastIndex + 1, N);
    } else {
      setUnifiedStatus(0, 0);
    }

    applyPauseButtonLabel();
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

    const raw = String(columnSelect.value);

    if (raw === "ALL") {
      scopeIsAll = true;
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
      return;
    }

    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      scopeIsAll = false;
      activeSheetColIndex = parsed;
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
    }
  }

  if (columnSelect) {
    columnSelect.value = String(activeSheetColIndex);
    columnSelect.addEventListener("change", setActiveColumnFromSelect);
  }

  // =============================
  // CYCLING CONTROL (OPERATOR BUTTON)
  // =============================
  function enableCycling() {
    cycleEnabled = true;
    mostRecentEnabled = false;

    disableManualMode();

    // Keep current index as the currently displayed index.
    cyclePaused = false;

    applyCycleButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableCycling() {
    cycleEnabled = false;
    cyclePaused = false;

    mostRecentEnabled = true;

    applyCycleButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnCycle) {
    applyCycleButtonLabel();
    btnCycle.addEventListener("click", () => {
      if (!cycleEnabled) enableCycling();
      else disableCycling();
    });
  }

  // =============================
  // PREV/NEXT CONTROL (OPERATOR BUTTONS)
  // =============================
  function stepPrev() {
    if (cycleEnabled) {
      cyclePaused = true;
      applyPauseButtonLabel();
      stepCycle(-1);
      return;
    }
    stepManual(-1);
  }

  function stepNext() {
    if (cycleEnabled) {
      cyclePaused = true;
      applyPauseButtonLabel();
      stepCycle(1);
      return;
    }
    stepManual(1);
  }

  if (btnManualPrev) {
    btnManualPrev.addEventListener("click", () => {
      stepPrev();
    });
  }

  if (btnManualNext) {
    btnManualNext.addEventListener("click", () => {
      stepNext();
    });
  }

  // =============================
  // CYCLE TIMER (AUTO ADVANCE)
  // =============================
  // Keeps cycleIndex aligned to the on-screen item, and prevents advancing while paused.
  let cycleTimer = null;

  function startCycleTimer() {
    if (cycleTimer) clearInterval(cycleTimer);

    cycleTimer = setInterval(() => {
      if (!cycleEnabled) return;
      if (cyclePaused) return;
      if (!promptList.length) return;

      const N = promptList.length;

      // Advance first, then render (so cycleIndex always equals the visible line).
      cycleIndex = ((cycleIndex + 1) % N + N) % N;
      applyCycleCharsetFromIndex();
    }, cycleIntervalMs);
  }

  startCycleTimer();

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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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

    const MAX_BUFFERED_BYTES = 1_000_000;
    if (relaySocket.bufferedAmount > MAX_BUFFERED_BYTES) return;

    const frame = canvas.toDataURL(BROADCAST_FORMAT, BROADCAST_QUALITY);

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
  applyPauseButtonLabel();
  startSheetPolling();
  log("Ready. Click a capture button.");
});