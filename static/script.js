/* =====================================================================
   RK3566 Monitor – Client-side JavaScript
   ===================================================================== */

"use strict";

// ── Config ──────────────────────────────────────────────────────────────
// Poll interval is injected by the server via window.SERVER_CONFIG so that
// the client stays in sync with the backend's POLL_INTERVAL_SECONDS setting.
const POLL_INTERVAL_MS = (window.SERVER_CONFIG && window.SERVER_CONFIG.pollIntervalMs)
  ? window.SERVER_CONFIG.pollIntervalMs
  : 10000;                                // fallback: 10 s
const RESAMPLE_INTERVAL_MS = 60 * 1000; // server resamples old data to 1-minute buckets
// Maximum data points held in every in-memory JS array.
// A fixed cap prevents unbounded memory growth and keeps Chart.js render
// time constant regardless of how long the service has been running.
const MAX_HISTORY_LEN = 5000;

// ── History window (seconds shown in chart) ───────────────────────────
let historyWindowSeconds = 3600;         // default: 1 hour

// ── Zoom state ────────────────────────────────────────────────────────
// isZoomed: when true, updateHistChart() skips its normal slice-and-replace
// so that a live WebSocket tick never destroys the user's zoom viewport.
// New samples still accumulate in history[] in the background.
let isZoomed      = false;
let _refetchTimer = null;   // debounce handle for zoom/pan refetch

// ── In-memory history buffers ─────────────────────────────────────────
const history = {
  labels:      [],   // Unix timestamps (ms)
  cpu:         [],
  mem:         [],
  temp:        [],
  npu:         [],
  freq:        [],   // CPU frequency (MHz)
};

// ── DOM refs ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connStatus    = $("conn-status");
const elInfoPod     = $("info-pod");
const elInfoNode    = $("info-node");
const elHwModel     = $("hw-model");
const elUptime      = $("uptime");
const elCpuCount    = $("cpu-count");
const elCpuFreq     = $("cpu-freq");
const elCpuGovernor = $("cpu-governor");
const elCpuPct      = $("cpu-percent");
const elMemPct      = $("mem-percent");
const elCpuTemp     = $("cpu-temp");
const elGpuTemp     = $("gpu-temp");
const elNpuPct      = $("npu-percent");
const elMemUsed     = $("mem-used");
const elMemTotal    = $("mem-total");
const elSwapPct     = $("swap-percent");
const elSwapUsed    = $("swap-used");
const elSwapTotal   = $("swap-total");
const elSwapBar     = $("swap-bar");
const elDiskPct     = $("disk-percent");
const elDiskUsed    = $("disk-used");
const elDiskTotal   = $("disk-total");
const elDiskBar     = $("disk-bar");
const elDisk2Row    = $("disk2-row");
const elDisk2Title  = $("disk2-title");
const elDisk2Pct    = $("disk2-percent");
const elDisk2Used   = $("disk2-used");
const elDisk2Total  = $("disk2-total");
const elDisk2Bar    = $("disk2-bar");
const elLastUpdate  = $("last-update");
const elLogSize     = $("log-size");

// ── Chart defaults ────────────────────────────────────────────────────────
Chart.defaults.color       = "#8b949e";
Chart.defaults.borderColor = "#30363d";
Chart.defaults.font.family = "'Segoe UI', system-ui, -apple-system, sans-serif";

function makeDonut(id, label, color) {
  return new Chart($(id), {
    type: "doughnut",
    data: {
      labels: [label, "Free"],
      datasets: [{
        data: [0, 100],
        backgroundColor: [color, "#21262d"],
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "75%",
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
    },
  });
}

function makeLine(id, datasets) {
  return new Chart($(id), {
    type: "line",
    data: {
      labels: [],
      datasets: datasets.map(d => ({
        label: d.label,
        data: [],
        borderColor: d.color,
        backgroundColor: d.color + "22",
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          display: false,
        },
        y: {
          min: 0,
          max: 100,
          ticks: { callback: v => v + "%" },
          grid: { color: "#21262d" },
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: { boxWidth: 12, padding: 10 },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} %`,
          },
        },
      },
    },
  });
}

// Temperature line chart (range 0–100 °C)
function makeTempLine(id) {
  return new Chart($(id), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Temp (°C)",
        data: [],
        borderColor: "#f0883e",
        backgroundColor: "#f0883e22",
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 100,
          ticks: { callback: v => v + "°" },
          grid: { color: "#21262d" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.parsed.y.toFixed(1)} °C`,
          },
        },
      },
    },
  });
}

// ── Instantiate small charts ───────────────────────────────────────────────
const cpuDonut   = makeDonut("cpuChart",  "CPU",  "#58a6ff");
const memDonut   = makeDonut("memChart",  "Mem",  "#3fb950");
const npuDonut   = makeDonut("npuChart",  "NPU",  "#bc8cff");
const tempLine     = makeTempLine("tempChart");
const gpuTempLine  = makeTempLine("gpuTempChart");

// ── History chart ─────────────────────────────────────────────────────────
//
// X-axis tick callback design
// ---------------------------
// The x scale is a CATEGORY scale; the zoom plugin tracks the visible
// viewport as fractional indices (scale.min … scale.max).
// To format tick labels correctly at any zoom level we must derive spanMs
// from the *visible* index range, not from the full labels array.
//
// Zoom / pan design
// -----------------
// After zoom or pan completes, onZoomOrPanComplete() sets isZoomed=true and
// schedules refetchVisibleRange() (debounced 350 ms).  While isZoomed is
// true, updateHistChart() returns early so live ticks never overwrite the
// drilled-down view.  exitZoom() (double-click / timeframe button) clears
// the flag and restores the live view.
//
const histChart = new Chart($("historyChart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label: "CPU %",         borderColor: "#58a6ff", backgroundColor: "#58a6ff22", yAxisID: "y"  },
      { label: "Memory %",      borderColor: "#3fb950", backgroundColor: "#3fb95022", yAxisID: "y"  },
      { label: "NPU %",         borderColor: "#bc8cff", backgroundColor: "#bc8cff22", yAxisID: "y"  },
      { label: "CPU Freq (MHz)",borderColor: "#e3b341", backgroundColor: "#e3b34122", yAxisID: "y1" },
    ].map(d => Object.assign(d, {
      data: [],
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.3,
      spanGaps: false,
    })),
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        display: true,
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
          color: "#8b949e",
          font: { size: 11 },
          // 'this' is the scale; this.min / this.max are the visible index bounds.
          callback: function(value, index) {
            const labels = this.chart.data.labels;
            const ts = labels[value];
            if (ts == null) return "";
            const d = new Date(ts);
            // Compute spanMs from the *visible* index range, not the full array.
            const minIdx = Math.max(0, Math.floor(this.min));
            const maxIdx = Math.min(labels.length - 1, Math.ceil(this.max));
            const minTs  = labels[minIdx] || ts;
            const maxTs  = labels[maxIdx] || ts;
            const spanMs = maxTs - minTs;
            if (spanMs >= 86400000) {
              // Span ≥ 1 day → show date + hour:minute
              const mo = String(d.getMonth() + 1).padStart(2, "0");
              const dy = String(d.getDate()).padStart(2, "0");
              const hh = String(d.getHours()).padStart(2, "0");
              const mm = String(d.getMinutes()).padStart(2, "0");
              return mo + "/" + dy + " " + hh + ":" + mm;
            }
            if (spanMs >= 3600000) {
              // Span ≥ 1 hour → show hour:minute
              return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            }
            // Span < 1 hour → show hour:minute:second
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          },
        },
        grid: { color: "#21262d" },
      },
      y: {
        min: 0,
        max: 100,
        position: "left",
        ticks: { callback: v => v + "%" },
        grid: { color: "#21262d" },
      },
      y1: {
        min: 0,
        position: "right",
        ticks: { callback: v => v + " MHz", color: "#e3b341" },
        grid: { drawOnChartArea: false },
      },
    },
    plugins: {
      legend: {
        position: "top",
        labels: { boxWidth: 12, padding: 10 },
      },
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: {
          title: function(items) {
            if (!items.length) return "";
            const ts = histChart.data.labels[items[0].dataIndex];
            if (ts == null) return "";
            return new Date(ts).toLocaleString();
          },
          label: ctx => {
            if (ctx.parsed.y === null) return ` ${ctx.dataset.label}: N/A`;
            if (ctx.dataset.yAxisID === "y1") {
              return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(0)} MHz`;
            }
            return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} %`;
          },
        },
      },
      zoom: {
        zoom: {
          wheel:  { enabled: true, speed: 0.1 },
          pinch:  { enabled: true },
          mode:   "x",
          onZoomComplete: () => onZoomOrPanComplete(),
        },
        pan: {
          enabled: true,
          mode:    "x",
          onPanComplete: () => onZoomOrPanComplete(),
        },
        limits: {
          // Minimum visible span: 5 data points (updated dynamically below)
          x: { min: 0, max: 0, minRange: 5 },
        },
      },
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────
function pct(val) {
  return val != null ? val.toFixed(1) + " %" : "N/A";
}

// Insert a null gap marker so Chart.js draws a visible break instead of
// connecting across a missing period.
function maybeInsertGap(lastTs, currentTs) {
  const gapThresholdMs = 2 * Math.max(POLL_INTERVAL_MS, RESAMPLE_INTERVAL_MS);
  if (currentTs - lastTs > gapThresholdMs) {
    history.labels.push(lastTs + 1);
    history.cpu.push(null);
    history.mem.push(null);
    history.npu.push(null);
    history.freq.push(null);
  }
}

function updateDonut(chart, value) {
  const v = value != null ? value : 0;
  chart.data.datasets[0].data = [v, 100 - v];
  chart.update("none");
}

// ── updateHistChart ───────────────────────────────────────────────────────
// Slices the in-memory history buffers to the selected timeframe window and
// feeds the result to Chart.js.
// IMPORTANT: while the user is zoomed/panning we skip this entirely so the
// viewport is not destroyed by incoming live ticks.
function updateHistChart() {
  if (isZoomed) return;

  const maxPoints = Math.ceil(historyWindowSeconds * 1000 / POLL_INTERVAL_MS);
  const start = Math.max(0, history.labels.length - maxPoints);

  const lbls = history.labels.slice(start);
  histChart.data.labels           = lbls;
  histChart.data.datasets[0].data = history.cpu.slice(start);
  histChart.data.datasets[1].data = history.mem.slice(start);
  histChart.data.datasets[2].data = history.npu.slice(start);
  histChart.data.datasets[3].data = history.freq.slice(start);

  // Keep the pan limits in sync with the actual data length so the user can
  // always pan all the way to either edge without hitting an invisible wall.
  const lastIdx = Math.max(0, lbls.length - 1);
  histChart.options.plugins.zoom.limits.x.max = lastIdx;

  histChart.update("none");
}

// ── Zoom / pan callbacks ──────────────────────────────────────────────────

function onZoomOrPanComplete() {
  isZoomed = true;
  if (_refetchTimer) clearTimeout(_refetchTimer);
  // Debounce: wait until the user stops interacting before hitting the server.
  _refetchTimer = setTimeout(refetchVisibleRange, 350);
}

// Fetch native-resolution data for the exact visible time range and replace
// the chart data in-place (without touching the live history[] buffers).
async function refetchVisibleRange() {
  const scale = histChart.scales.x;
  if (!scale) return;

  const labels = histChart.data.labels;
  if (!labels || labels.length === 0) return;

  // scale.min / scale.max are fractional category indices; clamp them.
  const minIdx = Math.max(0, Math.floor(scale.min));
  const maxIdx = Math.min(labels.length - 1, Math.ceil(scale.max));
  const sinceMs = labels[minIdx];
  const untilMs = labels[maxIdx];
  if (!sinceMs || !untilMs || sinceMs >= untilMs) return;

  const sinceS = Math.floor(sinceMs / 1000);
  const untilS = Math.ceil(untilMs  / 1000);

  try {
    const resp = await fetch(
      `/api/history?since=${sinceS}&until=${untilS}&max_points=${MAX_HISTORY_LEN}`
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const rows = data.history;
    if (!Array.isArray(rows) || rows.length === 0) return;

    // Replace chart data directly; do NOT touch history[] live buffers.
    histChart.data.labels           = rows.map(r => r.timestamp * 1000);
    histChart.data.datasets[0].data = rows.map(r => r.cpu_percent);
    histChart.data.datasets[1].data = rows.map(r => r.memory_percent);
    histChart.data.datasets[2].data = rows.map(r => r.npu_percent);
    histChart.data.datasets[3].data = rows.map(r => r.cpu_freq_mhz);

    // Reset zoom to show all the newly fetched (high-res) data for this range,
    // then re-apply the viewport so the x-axis snaps to the correct window.
    histChart.resetZoom();
    histChart.update("none");
  } catch (err) {
    console.warn("Zoom refetch failed:", err);
  }
}

// Exit zoom mode: restore the live timeframe view.
function exitZoom() {
  isZoomed = false;
  if (_refetchTimer) { clearTimeout(_refetchTimer); _refetchTimer = null; }
  histChart.resetZoom();
  updateHistChart();
}

// ── Adaptive timeframe buttons ────────────────────────────────────────────
// Hide buttons whose window is larger than the actual available data.
// Called once at startup after /api/history/bounds is known, and again
// after a log reset.
function updateTimeframeButtons(oldestTs) {
  const availableSeconds = oldestTs
    ? Math.floor(Date.now() / 1000) - oldestTs
    : 0;

  document.querySelectorAll(".btn-tf[data-seconds]").forEach(btn => {
    const btnSec = parseInt(btn.dataset.seconds, 10);
    // Keep the button if it covers ≤ 110 % of the available data (small
    // margin so the "current" button is never hidden by clock drift).
    const show = !oldestTs || btnSec <= availableSeconds * 1.1;
    btn.style.display = show ? "" : "none";

    // If the active button just became unavailable, reset to 1 hr (or the
    // smallest button that is still visible).
    if (!show && btn.classList.contains("active")) {
      btn.classList.remove("active");
      // Pick the largest still-visible button as the new active one.
      const visible = [...document.querySelectorAll(".btn-tf[data-seconds]")]
        .filter(b => b.style.display !== "none");
      if (visible.length) {
        const largest = visible.reduce((a, b) =>
          parseInt(b.dataset.seconds) > parseInt(a.dataset.seconds) ? b : a
        );
        largest.classList.add("active");
        historyWindowSeconds = parseInt(largest.dataset.seconds, 10);
      }
    }
  });
}

// ── Timeframe selector ────────────────────────────────────────────────────
document.querySelectorAll(".btn-tf[data-seconds]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".btn-tf[data-seconds]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    historyWindowSeconds = parseInt(btn.dataset.seconds, 10);
    // Exit zoom mode; clear buffers and re-fetch the correct window.
    isZoomed = false;
    if (_refetchTimer) { clearTimeout(_refetchTimer); _refetchTimer = null; }
    history.labels.length = 0;
    history.cpu.length    = 0;
    history.mem.length    = 0;
    history.npu.length    = 0;
    history.freq.length   = 0;
    histChart.resetZoom();
    loadHistory();
  });
});

// Double-click exits zoom and restores the live view.
$("historyChart").addEventListener("dblclick", exitZoom);

// ── History push helpers ──────────────────────────────────────────────────
function pushHistory(ts, cpuVal, memVal, npuVal, freqVal) {
  const tsMs = ts * 1000;
  if (history.labels.length > 0) {
    maybeInsertGap(history.labels[history.labels.length - 1], tsMs);
  }
  history.labels.push(tsMs);
  history.cpu.push(cpuVal);
  history.mem.push(memVal);
  history.npu.push(npuVal != null ? npuVal : null);
  history.freq.push(freqVal != null ? freqVal : null);
  if (history.labels.length > MAX_HISTORY_LEN) {
    history.labels.shift();
    history.cpu.shift();
    history.mem.shift();
    history.npu.shift();
    history.freq.shift();
  }
  updateHistChart();
}

function pushTempHistory(ts, tempVal) {
  tempLine.data.labels.push(ts * 1000);
  tempLine.data.datasets[0].data.push(tempVal);
  if (tempLine.data.labels.length > MAX_HISTORY_LEN) {
    tempLine.data.labels.shift();
    tempLine.data.datasets[0].data.shift();
  }
  tempLine.update("none");
}

function pushGpuTempHistory(ts, tempVal) {
  gpuTempLine.data.labels.push(ts * 1000);
  gpuTempLine.data.datasets[0].data.push(tempVal);
  if (gpuTempLine.data.labels.length > MAX_HISTORY_LEN) {
    gpuTempLine.data.labels.shift();
    gpuTempLine.data.datasets[0].data.shift();
  }
  gpuTempLine.update("none");
}

// ── Render metrics ────────────────────────────────────────────────────────
function render(data) {
  const { cpu, memory, disk, npu, gpu, system, timestamp } = data;

  elInfoPod.textContent  = system.pod  || "–";
  elInfoNode.textContent = system.node || "–";
  elHwModel.textContent     = system.hardware || "–";
  elUptime.textContent      = system.uptime_human || "–";
  elCpuCount.textContent    = cpu.count != null ? cpu.count + " cores" : "–";
  elCpuFreq.textContent     = cpu.freq_mhz != null
    ? `${cpu.freq_mhz} MHz (max ${cpu.freq_max_mhz} MHz)` : "–";
  elCpuGovernor.textContent = cpu.governor || "–";

  elCpuPct.textContent = pct(cpu.percent);
  updateDonut(cpuDonut, cpu.percent);

  elMemPct.textContent   = pct(memory.percent);
  elMemUsed.textContent  = memory.used_mb + " MB";
  elMemTotal.textContent = memory.total_mb + " MB";
  updateDonut(memDonut, memory.percent);

  if (cpu.temperature_c != null) {
    elCpuTemp.textContent = cpu.temperature_c + " °C";
    pushTempHistory(timestamp, cpu.temperature_c);
  } else {
    elCpuTemp.textContent = "N/A";
  }

  if (gpu && gpu.temperature_c != null) {
    elGpuTemp.textContent = gpu.temperature_c + " °C";
    pushGpuTempHistory(timestamp, gpu.temperature_c);
  } else {
    elGpuTemp.textContent = "N/A";
  }

  if (npu && npu.percent != null) {
    elNpuPct.textContent = pct(npu.percent);
    updateDonut(npuDonut, npu.percent);
  } else {
    elNpuPct.textContent = "N/A";
    updateDonut(npuDonut, 0);
  }

  elSwapPct.textContent   = pct(memory.swap_percent);
  elSwapUsed.textContent  = memory.swap_used_mb + " MB";
  elSwapTotal.textContent = memory.swap_total_mb + " MB";
  elSwapBar.style.width   = (memory.swap_percent || 0) + "%";

  if (disk) {
    elDiskPct.textContent   = pct(disk.percent);
    elDiskUsed.textContent  = disk.used_gb + " GB";
    elDiskTotal.textContent = disk.total_gb + " GB";
    elDiskBar.style.width   = (disk.percent || 0) + "%";
  }

  const disk2 = data.disk2;
  if (disk2) {
    elDisk2Row.style.display  = "";
    elDisk2Title.textContent  = "Disk (" + disk2.mountpoint + ")";
    elDisk2Pct.textContent    = pct(disk2.percent);
    elDisk2Used.textContent   = disk2.used_gb + " GB";
    elDisk2Total.textContent  = disk2.total_gb + " GB";
    elDisk2Bar.style.width    = (disk2.percent || 0) + "%";
  } else {
    elDisk2Row.style.display = "none";
  }

  pushHistory(timestamp, cpu.percent, memory.percent, npu ? npu.percent : null, cpu.freq_mhz);

  elLastUpdate.textContent = "Last update: " + new Date(timestamp * 1000).toLocaleTimeString();

  // Populate image name + version once (idempotent – same value every tick)
  const elImgVer = document.getElementById("image-version");
  if (elImgVer && !elImgVer.dataset.set) {
    const cfg  = window.SERVER_CONFIG || {};
    const name = cfg.imageName    || "rk3566-monitor-copilot";
    const ver  = cfg.imageVersion || "?";
    elImgVer.textContent = "Image: " + name + ":" + ver;
    elImgVer.dataset.set = "1";
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────
function connectWebSocket() {
  const socket = io({ transports: ["websocket", "polling"] });
  socket.on("connect",       () => { connStatus.textContent = "Live";         connStatus.className = "badge connected"; });
  socket.on("disconnect",    () => { connStatus.textContent = "Disconnected"; connStatus.className = "badge error"; });
  socket.on("connect_error", () => { connStatus.textContent = "Error";        connStatus.className = "badge error"; });
  socket.on("metrics", data => {
    try { render(data); } catch (e) { console.error("render error", e); }
  });
  return socket;
}

// ── Fallback REST polling (if WebSocket unavailable) ─────────────────────
function startPolling() {
  async function poll() {
    try {
      const resp = await fetch("/api/metrics");
      if (!resp.ok) throw new Error(resp.statusText);
      render(await resp.json());
      connStatus.textContent = "Polling";
      connStatus.className   = "badge connected";
    } catch (err) {
      console.warn("Poll error:", err);
      connStatus.textContent = "Error";
      connStatus.className   = "badge error";
    }
  }
  poll();
  return setInterval(poll, POLL_INTERVAL_MS);
}

// ── History preload ───────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const resp = await fetch(
      `/api/history?window=${historyWindowSeconds}&max_points=${MAX_HISTORY_LEN}`
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const rows = data.history;
    if (!Array.isArray(rows) || rows.length === 0) return;

    rows.forEach(row => {
      const tsMs = row.timestamp * 1000;
      if (history.labels.length > 0) {
        maybeInsertGap(history.labels[history.labels.length - 1], tsMs);
      }
      history.labels.push(tsMs);
      history.cpu.push(row.cpu_percent);
      history.mem.push(row.memory_percent);
      history.npu.push(row.npu_percent);
      history.freq.push(row.cpu_freq_mhz != null ? row.cpu_freq_mhz : null);
      if (row.temperature_c != null) {
        tempLine.data.labels.push(tsMs);
        tempLine.data.datasets[0].data.push(row.temperature_c);
      }
      if (row.gpu_temperature_c != null) {
        gpuTempLine.data.labels.push(tsMs);
        gpuTempLine.data.datasets[0].data.push(row.gpu_temperature_c);
      }
    });

    const trim = arr => { while (arr.length > MAX_HISTORY_LEN) arr.shift(); };
    [history.labels, history.cpu, history.mem, history.npu, history.freq,
     tempLine.data.labels, tempLine.data.datasets[0].data,
     gpuTempLine.data.labels, gpuTempLine.data.datasets[0].data].forEach(trim);

    updateHistChart();
    tempLine.update("none");
    gpuTempLine.update("none");
  } catch (err) {
    console.warn("Failed to load history:", err);
  }
}

// ── Log file size refresh ─────────────────────────────────────────────────
async function refreshLogSize() {
  try {
    const resp = await fetch("/api/log/size");
    if (!resp.ok) return;
    const data = await resp.json();
    if (elLogSize) elLogSize.textContent = data.size_kb + " KB";
  } catch (_) { /* silent */ }
}

// ── Reset Log ────────────────────────────────────────────────────────────
async function confirmResetLog() {
  if (!confirm(
    "Delete the metrics log file and reset all graphs?\n" +
    "Data collection will resume automatically on the next poll."
  )) return;

  try {
    const resp = await fetch("/api/log", { method: "DELETE" });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) { alert("Reset failed: " + (body.message || resp.statusText)); return; }
  } catch (err) {
    alert("Reset failed: " + err); return;
  }

  history.labels.length = 0;
  history.cpu.length    = 0;
  history.mem.length    = 0;
  history.npu.length    = 0;
  history.freq.length   = 0;

  isZoomed = false;
  histChart.resetZoom();
  histChart.data.labels = [];
  histChart.data.datasets.forEach(ds => { ds.data = []; });
  histChart.update("none");

  tempLine.data.labels = [];
  tempLine.data.datasets[0].data = [];
  tempLine.update("none");

  gpuTempLine.data.labels = [];
  gpuTempLine.data.datasets[0].data = [];
  gpuTempLine.update("none");

  const elLU = document.getElementById("last-update");
  if (elLU) elLU.textContent = "–";

  refreshLogSize();

  try {
    const boundsResp = await fetch("/api/history/bounds");
    if (boundsResp.ok) {
      const bounds = await boundsResp.json();
      updateTimeframeButtons(bounds.oldest || null);
    }
  } catch (_) { /* non-fatal */ }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  // 1. Fetch data bounds first so buttons are correct before any data arrives.
  try {
    const boundsResp = await fetch("/api/history/bounds");
    if (boundsResp.ok) {
      const bounds = await boundsResp.json();
      updateTimeframeButtons(bounds.oldest || null);
    }
  } catch (_) { /* non-fatal – all buttons remain visible */ }

  // Ensure the default active button matches historyWindowSeconds.
  // Find the button matching the default, falling back to the first visible.
  const defaultBtn = document.querySelector(`.btn-tf[data-seconds="${historyWindowSeconds}"]`);
  if (defaultBtn && defaultBtn.style.display !== "none") {
    document.querySelectorAll(".btn-tf").forEach(b => b.classList.remove("active"));
    defaultBtn.classList.add("active");
  }

  // 2. Pre-populate history chart from the CSV log.
  await loadHistory();

  // 3. Start live data stream (WebSocket preferred, polling fallback).
  if (typeof io !== "undefined") {
    connectWebSocket();
  } else {
    startPolling();
  }

  // 4. Keep log file size refreshed.
  refreshLogSize();
  setInterval(refreshLogSize, 60000);
})();
