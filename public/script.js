
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getDatabase, ref, onValue, query, orderByChild,
  limitToLast, update, push
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { firebaseConfig, DEVICE_ID, HEARTBEAT_TIMEOUT_MS } from "./firebase-config.js";

const $ = id => document.getElementById(id);

const state = {
  status: null,
  history: [],
  filteredHistory: [],
  connected: false,
  lastSeen: 0,
  historyReady: false,
  db: null,
  activeSession: null,
  sessions: [],
  resetPending: false,
  sessionInitPending: false
};

const chart = $("flowChart");
const ctx = chart.getContext("2d");
let heartbeatTimer = null;

function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function timeLabel(value = Date.now(), includeDate = false) {
  const date = value instanceof Date ? value : new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString([], includeDate
    ? { year:"numeric", month:"short", day:"2-digit",
        hour:"2-digit", minute:"2-digit", second:"2-digit" }
    : { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function validConfig() {
  return firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.includes("PASTE_") &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.includes("YOUR_") &&
    firebaseConfig.databaseURL &&
    !firebaseConfig.databaseURL.includes("YOUR_");
}

function setBanner(mode, title, message, tag) {
  const notice = $("demoNotice");
  notice.classList.toggle("connected-notice", mode === "connected");
  notice.classList.toggle("disconnected-notice", mode !== "connected");
  $("noticeTitle").textContent = title;
  $("noticeText").textContent = message;
  $("noticeTag").textContent = tag;
}

function setConnection(online, lastSeen = 0) {
  state.connected = online;
  state.lastSeen = lastSeen;

  const pill = $("modePill");
  pill.classList.toggle("connected", online);
  pill.classList.toggle("disconnected", !online);
  pill.innerHTML = `<span class="tiny-dot"></span> ${online ? "DEVICE CONNECTED" : "DEVICE OFFLINE"}`;

  $("connectionDot").classList.toggle("online", online);
  $("connectionDot").classList.toggle("offline", !online);
  $("connectionText").textContent = online ? "Connected" : "Offline";
  $("connectionText").classList.toggle("online", online);
  $("connectionText").classList.toggle("offline", !online);

  $("signalText").textContent = online
    ? (state.status?.wifiRssi != null ? `${state.status.wifiRssi} dBm Wi-Fi` : "Heartbeat received")
    : (lastSeen ? `Last seen ${timeLabel(lastSeen)}` : "No heartbeat received");

  $("wifiSignal").textContent = state.status?.wifiRssi != null
    ? `${state.status.wifiRssi} dBm`
    : "—";

  $("linkStatus").textContent = online
    ? `Receiving data from ${DEVICE_ID}`
    : (lastSeen ? `Last heartbeat ${timeLabel(lastSeen)}` : "Waiting for first heartbeat");

  $("linkState").textContent = online ? "CONNECTED" : "OFFLINE";
  $("linkState").classList.toggle("pending-text", !online);
  $("linkIcon").className = online ? "status-icon good" : "status-icon pending";
  $("linkIcon").textContent = online ? "✓" : "↗";
  $("sidebarDevice").textContent = online ? "ESP32 connected" : "Device offline";
  $("liveLabel").textContent = online ? "LIVE DEVICE DATA" : "NO LIVE DATA";
  $("flowTrend").textContent = online ? `Updated ${timeLabel(lastSeen)}` : "Waiting for device heartbeat";
  $("dataSource").textContent = online ? "Firebase / ESP32" : "Firebase · no recent heartbeat";

  $("systemFoot").innerHTML = online
    ? '<span class="pulse-dot"></span> Live device heartbeat received'
    : '<span class="pulse-dot"></span> Device is not currently reporting';

  if (online) {
    setBanner("connected", "ESP32 is connected",
      "Live readings are arriving from the monitoring node. Historical samples are being saved to Firebase.", "LIVE");
  } else {
    setBanner("offline",
      lastSeen ? "ESP32 connection lost or stale" : "Waiting for ESP32 connection",
      lastSeen
        ? "No recent heartbeat has arrived. The dashboard will reconnect when fresh data is received."
        : "Check Firebase configuration and power on the ESP32.",
      validConfig() ? "OFFLINE" : "SETUP");
  }

  renderSessions();
}

function drawChart() {
  const rect = chart.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  chart.width = Math.round(rect.width * dpr);
  chart.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width, h = rect.height;
  const pad = { left:4, right:6, top:10, bottom:7 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const samples = state.history.slice(-50);
  const max = Math.max(5, ...samples.map(x => Number(x.flowRate) || 0)) * 1.1;

  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch * i / 4;
    ctx.strokeStyle = "#edf2f4";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const points = samples.map((sample, i) => ({
    x: pad.left + (samples.length < 2 ? cw : cw * i / (samples.length - 1)),
    y: pad.top + ch - Math.max(0, Number(sample.flowRate) || 0) / max * ch
  }));

  if (!points.length) {
    $("chartStart").textContent = "No data yet";
    return;
  }

  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, h - pad.bottom);
  ctx.lineTo(points[0].x, h - pad.bottom);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, pad.top, 0, h);
  gradient.addColorStop(0, "rgba(17,168,160,.18)");
  gradient.addColorStop(1, "rgba(17,168,160,.01)");
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = "#0fa79d";
  ctx.lineWidth = 2.3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  $("chartStart").textContent = timeLabel(samples[0].timestamp);
}

function renderRecent() {
  const body = $("readingsBody");
  body.replaceChildren();

  const rows = state.history.slice(-6).reverse();

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-history">No readings received yet.</td></tr>';
  }

  rows.forEach(sample => {
    const tr = document.createElement("tr");
    const values = [
      timeLabel(sample.timestamp),
      `${fmt(sample.flowRate)} L/min`,
      `${fmt(sample.totalLitres)} L`,
      Number(sample.flowRate) > 0.05 ? "Flowing" : "No flow"
    ];

    values.forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (i === 1 || i === 2) td.className = "flow-number";
      tr.appendChild(td);
    });

    body.appendChild(tr);
  });

  $("sampleCount").textContent = `${state.history.length} samples`;
}

function renderHistory() {
  const from = $("historyFrom").value
    ? new Date(`${$("historyFrom").value}T00:00:00`).getTime()
    : -Infinity;

  const to = $("historyTo").value
    ? new Date(`${$("historyTo").value}T23:59:59.999`).getTime()
    : Infinity;

  state.filteredHistory = state.history
    .filter(x => Number(x.timestamp) >= from && Number(x.timestamp) <= to)
    .slice()
    .reverse();

  const body = $("historyBody");
  body.replaceChildren();

  if (!state.filteredHistory.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-history">No saved readings match this date range.</td></tr>';
  }

  state.filteredHistory.forEach(sample => {
    const tr = document.createElement("tr");
    [
      timeLabel(sample.timestamp, true),
      `${fmt(sample.flowRate)} L/min`,
      `${fmt(sample.totalLitres)} L`,
      sample.nodeId || DEVICE_ID
    ].forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });

  $("historyCount").textContent = `${state.filteredHistory.length} records`;
}

/* ---------- Measurement Sessions ---------- */

function lifetimeTotal() {
  return Math.max(0, Number(state.status?.totalLitres) || 0);
}

function currentSessionVolume() {
  const session = state.activeSession;
  if (!session || !state.status) return 0;

  const startTotal = Number(session.startTotalLitres) || 0;
  return Math.max(0, lifetimeTotal() - startTotal);
}

function renderSessions() {
  const active = state.activeSession;

  $("currentSessionVolume").textContent =
    active && state.status ? fmt(currentSessionVolume(), 3) : "—";

  $("lifetimeSessionVolume").textContent =
    state.status ? fmt(lifetimeTotal(), 3) : "—";

  $("currentSessionStarted").textContent =
    active ? timeLabel(active.startedAt, true) : "Waiting for device data";

  $("resetMeasurementBtn").disabled =
    !state.db || !state.status || !active || state.resetPending;

  $("resetMeasurementBtn").textContent =
    state.resetPending ? "Saving session…" : "↻ Reset Measurement";

  const body = $("sessionsBody");
  body.replaceChildren();

  const rows = state.sessions
    .slice()
    .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0));

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-history">No completed sessions yet.</td></tr>';
  }

  rows.forEach((session, index) => {
    const duration = Math.max(0, Number(session.endedAt) - Number(session.startedAt));
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);

    const values = [
      session.sessionLabel || `Session ${rows.length - index}`,
      timeLabel(session.startedAt, true),
      timeLabel(session.endedAt, true),
      `${fmt(session.volumeLitres, 3)} L`,
      `${minutes}m ${seconds}s`
    ];

    const tr = document.createElement("tr");
    values.forEach(value => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });

  $("sessionCount").textContent = `${rows.length} completed`;
}

async function ensureActiveSession() {
  if (!state.db || !state.status || state.activeSession || state.sessionInitPending) return;

  state.sessionInitPending = true;

  try {
    const startedAt = Date.now();
    const newSession = {
      sessionId: `session_${startedAt}`,
      sessionLabel: `Session ${state.sessions.length + 1}`,
      startedAt,
      startTotalLitres: lifetimeTotal(),
      status: "active",
      nodeId: DEVICE_ID
    };

    await update(ref(state.db), {
      [`devices/${DEVICE_ID}/activeSession`]: newSession
    });
  } catch (error) {
    console.error("Could not initialize measurement session:", error);
    $("sessionsBody").innerHTML =
      `<tr><td colspan="5" class="empty-history">Could not initialize session: ${error.message}</td></tr>`;
  } finally {
    state.sessionInitPending = false;
  }
}

async function resetMeasurement() {
  if (state.resetPending || !state.db || !state.status || !state.activeSession) return;

  const active = state.activeSession;
  const endedAt = Date.now();
  const sessionRef = ref(state.db, `devices/${DEVICE_ID}/measurementSessions`);
  const completedKey = push(sessionRef).key;

  if (!completedKey) {
    alert("Could not create a session record. Please try again.");
    return;
  }

  const completed = {
    ...active,
    sessionId: active.sessionId || `session_${active.startedAt}`,
    sessionLabel: active.sessionLabel || `Session ${state.sessions.length + 1}`,
    startedAt: Number(active.startedAt),
    endedAt,
    startTotalLitres: Number(active.startTotalLitres) || 0,
    endTotalLitres: lifetimeTotal(),
    volumeLitres: Number(currentSessionVolume().toFixed(6)),
    status: "completed",
    nodeId: DEVICE_ID
  };

  const nextSession = {
    sessionId: `session_${endedAt}`,
    sessionLabel: `Session ${state.sessions.length + 2}`,
    startedAt: endedAt,
    startTotalLitres: lifetimeTotal(),
    status: "active",
    nodeId: DEVICE_ID
  };

  state.resetPending = true;
  renderSessions();

  try {
    // Both changes commit together or neither change commits.
    await update(ref(state.db), {
      [`devices/${DEVICE_ID}/measurementSessions/${completedKey}`]: completed,
      [`devices/${DEVICE_ID}/activeSession`]: nextSession
    });

    state.activeSession = nextSession;
    state.sessions.push(completed);
    renderSessions();
  } catch (error) {
    console.error("Measurement reset failed:", error);
    alert(
      "The measurement session could not be saved. No reset was completed.\n\n" +
      "Check Firebase rules and try again.\n" + error.message
    );
  } finally {
    state.resetPending = false;
    renderSessions();
  }
}

/* ---------- Dashboard rendering ---------- */

function render() {
  const sample = state.status;
  if (!sample) {
    renderSessions();
    return;
  }

  $("flowRate").textContent = fmt(sample.flowRate);
  $("totalLitres").textContent = fmt(sample.totalLitres);
  $("chartCurrent").textContent = fmt(sample.flowRate);
  $("lastUpdate").textContent = timeLabel(
    sample.lastSeen || sample.updatedAt || sample.timestamp, true
  );

  const flowing = Number(sample.flowRate) > 0.05;
  $("flowState").textContent = flowing ? "Flow detected" : "No flow";
  $("stateBadge").textContent = flowing ? "ACTIVE" : "IDLE";
  $("stateBadge").style.background = flowing ? "#e2f7ed" : "#eef2f5";
  $("stateBadge").style.color = flowing ? "#168d68" : "#758792";
  $("footerTime").textContent = timeLabel(Date.now());

  renderRecent();
  renderHistory();
  drawChart();
  renderSessions();
  ensureActiveSession();
}

function startHeartbeatWatch() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(() => {
    const age = Date.now() - Number(state.lastSeen || 0);
    setConnection(
      Boolean(state.lastSeen && age <= HEARTBEAT_TIMEOUT_MS),
      state.lastSeen
    );
  }, 2000);
}

function showSetupError(message) {
  setConnection(false, 0);
  setBanner("offline", "Firebase setup required", message, "SETUP");
  $("linkStatus").textContent = "Configuration incomplete";
}

async function connect() {
  if (!validConfig()) {
    showSetupError("Check public/firebase-config.js and confirm your Firebase web app configuration.");
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getDatabase(app);
    state.db = db;

    await signInAnonymously(auth);

    const statusRef = ref(db, `devices/${DEVICE_ID}/status`);

    onValue(statusRef, snapshot => {
      state.status = snapshot.val();

      if (!state.status) {
        setConnection(false, 0);
        renderSessions();
        return;
      }

      state.lastSeen = Number(
        state.status.lastSeen ||
        state.status.updatedAt ||
        state.status.timestamp || 0
      );

      setConnection(
        Boolean(state.lastSeen && Date.now() - state.lastSeen <= HEARTBEAT_TIMEOUT_MS),
        state.lastSeen
      );
      render();
    }, error => {
      showSetupError(`Could not read device status: ${error.message}. Check Firebase rules.`);
    });

    const historyRef = query(
      ref(db, `devices/${DEVICE_ID}/history`),
      orderByChild("timestamp"),
      limitToLast(1000)
    );

    onValue(historyRef, snapshot => {
      const values = snapshot.val() || {};
      state.history = Object.values(values)
        .filter(x => x && Number.isFinite(Number(x.timestamp)))
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

      state.historyReady = true;
      renderRecent();
      renderHistory();
      drawChart();
    }, error => {
      $("historyBody").innerHTML =
        `<tr><td colspan="4" class="empty-history">History read failed: ${error.message}</td></tr>`;
    });

    onValue(ref(db, `devices/${DEVICE_ID}/activeSession`), snapshot => {
      state.activeSession = snapshot.val();
      renderSessions();

      if (!state.activeSession && state.status) {
        ensureActiveSession();
      }
    }, error => {
      console.error("Active session read failed:", error);
      $("sessionsBody").innerHTML =
        `<tr><td colspan="5" class="empty-history">Could not read active session. Check Firebase rules.</td></tr>`;
    });

    onValue(ref(db, `devices/${DEVICE_ID}/measurementSessions`), snapshot => {
      const values = snapshot.val() || {};

      state.sessions = Object.entries(values)
        .map(([key, value]) => ({
          ...value,
          sessionId: value?.sessionId || key
        }))
        .filter(session =>
          session &&
          Number.isFinite(Number(session.startedAt)) &&
          Number.isFinite(Number(session.endedAt))
        );

      renderSessions();
    }, error => {
      console.error("Session history read failed:", error);
    });

    startHeartbeatWatch();
  } catch (error) {
    showSetupError(
      `Connection failed: ${error.message}. Check internet access, Firebase config and Anonymous Authentication.`
    );
  }
}

function exportCsv() {
  const rows = state.filteredHistory;

  if (!rows.length) {
    alert("There are no history records to export for this filter.");
    return;
  }

  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [
    ["timestamp", "date_time", "node_id", "flow_rate_l_min", "total_litres"],
    ...rows.map(x => [
      x.timestamp, timeLabel(x.timestamp, true), x.nodeId || DEVICE_ID,
      x.flowRate, x.totalLitres
    ])
  ].map(row => row.map(quote).join(","));

  const blob = new Blob([lines.join("\r\n")], { type:"text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `flowguard-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openDialog(title, bodyHtml) {
  $("dialogTitle").textContent = title;
  if (bodyHtml) $("dialogBody").innerHTML = bodyHtml;
  $("infoDialog").showModal();
}

$("helpBtn").addEventListener("click", () => openDialog("About FlowGuard"));
$("connectInfoBtn").addEventListener("click", () => openDialog(
  "Connect your ESP32",
  "<p>The ESP32 sends live readings to Firebase Realtime Database. The website reads those values and displays the current state and saved history.</p>"
));

$("deviceMenu").addEventListener("click", () => openDialog(
  "Monitoring node details",
  `<p><b>Node ID:</b> ${DEVICE_ID}</p>
   <p><b>Connection:</b> ${state.connected ? "Connected" : "Offline"}</p>
   <p><b>Data source:</b> Firebase Realtime Database</p>`
));

$("closeDialog").addEventListener("click", () => $("infoDialog").close());
$("infoDialog").addEventListener("click", event => {
  if (event.target === $("infoDialog")) $("infoDialog").close();
});

$("filterHistoryBtn").addEventListener("click", renderHistory);
$("clearHistoryFilterBtn").addEventListener("click", () => {
  $("historyFrom").value = "";
  $("historyTo").value = "";
  renderHistory();
});
$("exportCsvBtn").addEventListener("click", exportCsv);
$("resetMeasurementBtn").addEventListener("click", resetMeasurement);

$("todayLabel").textContent = new Date().toLocaleDateString([], {
  weekday:"short", month:"short", day:"numeric"
});

setConnection(false, 0);
drawChart();
connect();
window.addEventListener("resize", drawChart);
