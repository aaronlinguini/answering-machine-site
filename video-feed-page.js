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

// Cycle-all state (operator-controlled; affects everyone watching).
let cycleAllEnabled = false;

// Pause state for cycling (operator-controlled; affects everyone watching).
// PURPOSE: Pause stops cycling (turns it OFF) while preserving cycleIndex so resuming continues from the same line.
let cyclePaused = false;

// Manual browse state (operator-controlled; affects everyone watching).
// PURPOSE: Let the operator step up/down through entries in the selected scope (single column OR ALL).
let manualEnabled = false;
let manualList = []; // oldest -> newest
let manualIndex = 0;

// How often to advance when cycling is ON.
let cycleIntervalMs = 2500;

// How many recent submissions to use for lists (manual/cycle/latest).
const CYCLE_MAX_RECENT = 30;

// Which sheet column we are currently reading from (0-based): 1=B, 2=C, 3=D...
let activeSheetColIndex = SHEET_VALUE_COL_INDEX;

// Selected scope: either one column (by index) or ALL columns.
let scopeIsAll = false;

// Which columns are included in ALL-scope operations.
// NOTE: This array is updated dynamically after each GViz poll so newly-added columns are included.
const CYCLE_ALL_COLS = [1, 2, 3, 4, 5];

// Remembers which cycling mode was active when Pause was pressed.
// PURPOSE: Pause turns cycling OFF; this lets us resume the same mode later.
let pausedMode = null; // "cycle" | "cycleAll" | null

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

  // OPTIONAL: If you add a button with id="btn-pause" in video-feed-page.html,
  // this will enable Pause/Resume for cycling.
  // IMPORTANT: Pause STOPS cycling (turns it OFF) but preserves the current line.
  const btnPause = document.getElementById("btn-pause");

  // OPTIONAL: If you add a select with id="column-select" in video-feed-page.html,
  // this will enable switching which sheet column we read from.
  const columnSelect = document.getElementById("column-select");

  // OPTIONAL: If you add buttons with id="btn-manual-prev" / id="btn-manual-next" in video-feed-page.html,
  // this will enable Prev/Next stepping:
  // - If cycling is ON, Prev/Next stops cycling and steps the cycle list (wraps).
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
  // PURPOSE:
  // - Always display a stable line so the UI layout doesn't shift.
  // - Never display extra mode words ("manual", "latest", "cycle", etc).
  // - Always display: "COLUMN X : current / total"
  function setManualStatus(text) {
    // PURPOSE: Single UI output location shared across ALL modes.
    if (manualStatus) manualStatus.textContent = text;
  }

  function colIndexToLetter(idx) {
    // PURPOSE: Convert 0-based column index to sheet letters (A, B, ..., Z, AA, AB...)
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
    // PURPOSE: Centralized formatter so EVERY mode prints identical UI text.
    const columnLabel = scopeIsAll ? "ALL" : colIndexToLetter(activeSheetColIndex);
    const p = Number.isFinite(position) && position >= 0 ? position : 0;
    const t = Number.isFinite(total) && total >= 0 ? total : 0;
    setManualStatus(`COLUMN ${columnLabel} : ${p} / ${t}`);
  }

  // Ensure something is visible immediately.
  setUnifiedStatus(0, 0);

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
    // PURPOSE: Build one combined list for ALL-scope operations by pulling recent values from each column.
    // Order is column-major (B, then C, then D...) while preserving each column’s internal order.
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
  // PURPOSE:
  // - Every time the Google Form adds a new question, the response sheet adds a new column.
  // - GViz exposes those columns in gvizJson.table.cols.
  // - We rebuild the dropdown from that live list so new columns become selectable automatically.
  // - We filter out columns that have NO DATA so the dropdown stays clean.
  function rebuildColumnSelectFromGviz(gvizJson, rows) {
    if (!columnSelect) return;

    const cols = gvizJson?.table?.cols;
    if (!Array.isArray(cols) || cols.length === 0) return;

    // PURPOSE: Skip column A (index 0). Google Forms response sheets usually store Timestamp there.
    const firstPromptCol = cols.length > 1 ? 1 : 0;

    // PURPOSE: Only show columns that have at least one non-empty value.
    // This keeps the dropdown clean when new questions exist but have no submissions yet.
    function columnHasAnyData(colIndex) {
      for (let i = 0; i < rows.length; i++) {
        const cell = rows[i]?.[colIndex];
        if (cell === null || cell === undefined) continue;
        const val = String(cell);
        if (val.length > 0) return true;
      }
      return false;
    }

    // Preserve previous selection in a scope-aware way.
    const prevRaw = String(columnSelect.value);
    const prevScopeIsAll = prevRaw === "ALL";
    const prevCol = Number(prevRaw);

    // Rebuild options from live sheet metadata.
    columnSelect.innerHTML = "";

    // Always include ALL as the first option.
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

      // PURPOSE: Show question text when available.
      // Example: "D — Prompt?" if your form question has that label.
      // NOTE: Your unified status line STILL only prints "COLUMN D : x / y".
      opt.textContent = label ? `${letter} — ${label}` : letter;

      columnSelect.appendChild(opt);
      included.push(i);
    }

    // PURPOSE: Keep a valid selection even when filtering removes columns.
    if (!included.length) {
      // If nothing has data yet, fall back to showing B (or first prompt col) so the UI isn't empty.
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

    // Restore previous selection if it still exists.
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
    // PURPOSE: Include every prompt column that exists right now.
    // Strategy: treat column A (index 0) as Timestamp, and include B onward.
    const cols = gvizJson?.table?.cols;
    if (!Array.isArray(cols)) return [1, 2, 3, 4, 5];

    const out = [];
    for (let i = 1; i < cols.length; i++) out.push(i);
    return out;
  }

  function buildListForCurrentScope(rows) {
    // PURPOSE:
    // Single source of truth for list-building across modes:
    // - Manual browsing uses this.
    // - Cycling uses this.
    // - Latest-only uses this.
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

  function applyCycleAllButtonLabel() {
    if (!btnCycleAll) return;
    btnCycleAll.textContent = cycleAllEnabled ? "Cycle ALL: ON" : "Cycle ALL: OFF";
  }

  function applyPauseButtonLabel() {
    if (!btnPause) return;

    // PURPOSE:
    // Pause is meaningful in two cases:
    // 1) Cycling is ON -> button reads "Pause"
    // 2) Cycling is OFF because it was paused -> button reads "Resume"
    if (cycleEnabled || cycleAllEnabled) {
      btnPause.disabled = false;
      btnPause.textContent = "Pause";
      return;
    }

    if (cyclePaused) {
      btnPause.disabled = false;
      btnPause.textContent = "Resume";
      return;
    }

    btnPause.disabled = true;
    btnPause.textContent = "Pause";
  }

  function stopCyclingKeepIndex() {
    // PURPOSE:
    // - Stop auto-advance.
    // - Preserve cycleIndex so resuming continues from the same line.
    cycleEnabled = false;
    cycleAllEnabled = false;

    applyCycleButtonLabel();
    applyCycleAllButtonLabel();
    applyPauseButtonLabel();
  }

  // =============================
  // MANUAL BROWSE HELPERS
  // =============================
  // PURPOSE:
  // - Manual mode allows the operator to step through entries.
  // - Status text ALWAYS stays: "COLUMN X : current / total"
  function applyManualCharset() {
    // PURPOSE: Apply currently selected manual entry to charset AND update status.
    if (!manualList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = manualList.length;

    // Wrap index safely (circular navigation).
    manualIndex = ((manualIndex % N) + N) % N;

    const current = manualList[manualIndex];

    // IMPORTANT: trailing space preserves visual blank pixels in renderer.
    charset = current + " ";

    setUnifiedStatus(manualIndex + 1, N);
  }

  function enableManualMode() {
    // PURPOSE:
    // Manual browsing cannot coexist with cycling modes.
    manualEnabled = true;

    cyclePaused = false;
    pausedMode = null;
    stopCyclingKeepIndex();

    applyPauseButtonLabel();

    // Immediately refresh list for selected scope.
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableManualMode() {
    // PURPOSE: Exit manual browsing cleanly.
    manualEnabled = false;
    manualList = [];
    manualIndex = 0;
  }

  function stepManual(delta) {
    // PURPOSE:
    // Move forward/backward through entries with infinite wrapping.
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
  // PURPOSE:
  // - Apply cycleIndex -> charset.
  // - Update unified COLUMN status line.
  // - Navigation wraps infinitely.
  function applyCycleCharsetFromIndex() {
    if (!promptList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = promptList.length;

    // Wrap safely.
    cycleIndex = ((cycleIndex % N) + N) % N;

    const current = promptList[cycleIndex];

    // Preserve renderer spacing behaviour.
    charset = current + " ";

    setUnifiedStatus(cycleIndex + 1, N);
  }

  function stepCycle(delta) {
    if (!promptList.length) {
      setUnifiedStatus(0, 0);
      return;
    }

    const N = promptList.length;

    // Wrap infinitely on both ends.
    cycleIndex = ((cycleIndex + delta) % N + N) % N;

    applyCycleCharsetFromIndex();
  }

  function setCycleSpeed(ms) {
    // PURPOSE:
    // Runtime adjustment of cycling speed.
    // Restart timer so change applies immediately.
    cycleIntervalMs = ms;
    startCycleTimer();
  }

  // =============================
  // PAUSE CONTROL (CYCLE)
  // =============================
  // REQUIREMENT YOU STATED:
  // - Pressing Pause STOPS cycling (turns it OFF).
  // - It stays on the current line.
  // - Turning Cycle back ON resumes from that same line (cycleIndex preserved).
  function pauseCycling() {
    // PURPOSE:
    // - Freeze on the current line.
    // - Turn cycling OFF while keeping the index so resuming starts from the same line.
    if (!cycleEnabled && !cycleAllEnabled) return;

    cyclePaused = true;
    pausedMode = cycleAllEnabled ? "cycleAll" : "cycle";

    stopCyclingKeepIndex();

    // Keep the current charset + status stable immediately.
    applyCycleCharsetFromIndex();
  }

  function resumeCyclingFromPause(preferMode) {
    // PURPOSE:
    // - Resume whichever mode was paused.
    // - If preferMode is provided ("cycle" or "cycleAll"), that wins.
    if (!cyclePaused) return;

    const mode = preferMode || pausedMode || "cycle";

    cyclePaused = false;
    pausedMode = null;

    // Manual is mutually exclusive.
    disableManualMode();
    manualEnabled = false;

    if (mode === "cycleAll") {
      cycleAllEnabled = true;
      cycleEnabled = false;
    } else {
      cycleEnabled = true;
      cycleAllEnabled = false;
    }

    applyCycleButtonLabel();
    applyCycleAllButtonLabel();
    applyPauseButtonLabel();

    // Poll refreshes promptList for the current scope and applies charset/status.
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function togglePauseCycling() {
    // PURPOSE:
    // - If cycling is ON -> Pause it (turn it OFF).
    // - If cycling is paused -> Resume it (turn it back ON).
    if (cycleEnabled || cycleAllEnabled) pauseCycling();
    else resumeCyclingFromPause();
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

    // PURPOSE: Keep the operator dropdown synced to the sheet's current columns.
    // This makes new Google Form questions appear automatically as selectable options.
    // This also filters out columns that currently have NO DATA.
    rebuildColumnSelectFromGviz(gvizJson, rows);

    // PURPOSE: Keep ALL-scope columns synced to the sheet's current columns.
    // This replaces the fixed B..F list with whatever exists now (B..last).
    const dynamicCols = getDynamicCycleAllCols(gvizJson);
    CYCLE_ALL_COLS.splice(0, CYCLE_ALL_COLS.length, ...dynamicCols);

    // Build the list for the current scope once, then route it to the current mode.
    const scopeList = buildListForCurrentScope(rows);

    // Manual mode: browse the scope list and apply current selection.
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

    // Cycling modes: use the scope list as the cycle list and apply cycleIndex.
    if (cycleEnabled || cycleAllEnabled) {
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

    // Latest-only mode (default): show the last entry of the scope list (if any).
    // IMPORTANT:
    // - This is where your "1/1" bug came from previously: you were hardcoding totals.
    // - Here we always use the REAL list length.
    if (scopeList.length) {
      const N = scopeList.length;
      const lastIndex = N - 1;
      const latest = scopeList[lastIndex];

      charset = latest + " ";
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

    // PURPOSE: Allow selecting ALL columns from the dropdown.
    if (raw === "ALL") {
      scopeIsAll = true;

      // Manual/cycle lists depend on scope; keep indices stable where possible.
      // We do NOT reset cycleIndex here because you asked for resuming from the current line.
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
      return;
    }

    // PURPOSE: Single-column selection (B=1, C=2, ...)
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      scopeIsAll = false;
      activeSheetColIndex = parsed;

      // Lists depend on column; keep indices stable by wrapping after refresh.
      pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
    }
  }

  if (columnSelect) {
    // Default dropdown to B unless you change it.
    // NOTE: This will be overwritten by rebuildColumnSelectFromGviz() after the first poll.
    columnSelect.value = String(activeSheetColIndex);
    columnSelect.addEventListener("change", setActiveColumnFromSelect);
  }

  // =============================
  // CYCLING CONTROL (OPERATOR BUTTON)
  // =============================
  function enableCycling() {
    // PURPOSE:
    // Cycle button cycles the CURRENTLY SELECTED SCOPE:
    // - If dropdown is ALL -> it cycles the ALL combined list.
    // - If dropdown is a column -> it cycles that column list.
    cycleEnabled = true;
    cycleAllEnabled = false;

    // Entering cycle clears manual mode.
    disableManualMode();
    manualEnabled = false;

    // When starting fresh (not resuming from Pause), keep current index if it already exists,
    // because you want Cycle to resume from where you left off when you turned it off.
    cyclePaused = false;
    pausedMode = null;

    applyCycleButtonLabel();
    applyCycleAllButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableCycling() {
    // PURPOSE:
    // Turn Cycle OFF but keep cycleIndex as-is so turning it back ON resumes from the same line.
    cycleEnabled = false;
    cyclePaused = false;
    pausedMode = null;

    applyCycleButtonLabel();
    applyPauseButtonLabel();

    // Refresh into latest-only mode so status shows real N (not 1/1).
    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnCycle) {
    applyCycleButtonLabel();
    btnCycle.addEventListener("click", () => {
      // If paused, Cycle resumes from that paused line.
      if (cyclePaused) {
        resumeCyclingFromPause("cycle");
        return;
      }

      if (!cycleEnabled) enableCycling();
      else disableCycling();
    });
  }

  // =============================
  // CYCLE ALL CONTROL (OPERATOR BUTTON)
  // =============================
  // NOTE:
  // This button forces scopeIsAll = true and cycles across ALL columns explicitly.
  function enableCycleAll() {
    scopeIsAll = true;
    if (columnSelect) columnSelect.value = "ALL";

    cycleAllEnabled = true;
    cycleEnabled = false;

    // Entering cycle-all clears manual mode.
    disableManualMode();
    manualEnabled = false;

    cyclePaused = false;
    pausedMode = null;

    applyCycleAllButtonLabel();
    applyCycleButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  function disableCycleAll() {
    // PURPOSE:
    // Turn Cycle ALL OFF but keep cycleIndex as-is so turning it back ON resumes from the same line.
    cycleAllEnabled = false;
    cyclePaused = false;
    pausedMode = null;

    applyCycleAllButtonLabel();
    applyPauseButtonLabel();

    pollSheetOnce().catch((e) => log("Sheet fetch error:", e));
  }

  if (btnCycleAll) {
    applyCycleAllButtonLabel();
    btnCycleAll.addEventListener("click", () => {
      // If paused, Cycle ALL resumes from that paused line.
      if (cyclePaused) {
        resumeCyclingFromPause("cycleAll");
        return;
      }

      if (!cycleAllEnabled) enableCycleAll();
      else disableCycleAll();
    });
  }

  // =============================
  // PREV/NEXT CONTROL (OPERATOR BUTTONS)
  // =============================
  // REQUIREMENT YOU STATED:
  // - Prev/Next wraps:
  //   - At the beginning, Prev goes to the last entry.
  //   - At the end, Next goes to the first entry.
  function stepPrev() {
    if (cycleEnabled || cycleAllEnabled) {
      // Stop cycling and step the cycle list (wraps).
      pauseCycling();
      stepCycle(-1);
      return;
    }

    // Cycling is OFF -> manual stepping (wraps).
    stepManual(-1);
  }

  function stepNext() {
    if (cycleEnabled || cycleAllEnabled) {
      pauseCycling();
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
  // PURPOSE:
  // - Advance while cycling is enabled.
  // - Pause button stops cycling by turning it OFF, so the timer naturally stops advancing.
  let cycleTimer = null;

  function startCycleTimer() {
    if (cycleTimer) clearInterval(cycleTimer);

    cycleTimer = setInterval(() => {
      if (!cycleEnabled && !cycleAllEnabled) return;
      if (!promptList.length) return;

      // Apply current index, then advance (wraps).
      applyCycleCharsetFromIndex();
      const N = promptList.length;
      cycleIndex = ((cycleIndex + 1) % N + N) % N;
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
  applyPauseButtonLabel();
  startSheetPolling();
  log("Ready. Click a capture button.");
});