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
const MAX_HISTORY_SECONDS = 1209600;    // retain up to 2 weeks of data
const MAX_HISTORY_LEN = Math.ceil(MAX_HISTORY_SECONDS * 1000 / POLL_INTERVAL_MS);

// ── History window (seconds shown in chart) ───────────────────────────
let historyWindowSeconds = 60;

// ── State ────────────────────────────────────────────────────────────────
const history = {
  labels:      [],   // Unix timestamps (ms)
  cpu:         [],
  mem:         [],
  temp:        [],
  npu:         [],
};

// ── DOM refs ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connStatus   = $("conn-status");
const elInfoPod      = $("info-pod");
const elInfoNode     = $("info-node");
const elHwModel    = $("hw-model");
const elUptime     = $("uptime");
const elCpuCount   = $("cpu-count");
const elCpuFreq    = $("cpu-freq");
const elCpuPct     = $("cpu-percent");
const elMemPct     = $("mem-percent");
const elCpuTemp    = $("cpu-temp");
const elGpuTemp    = $("gpu-temp");
const elNpuPct     = $("npu-percent");
const elMemUsed    = $("mem-used");
const elMemTotal   = $("mem-total");
const elSwapPct    = $("swap-percent");
const elSwapUsed   = $("swap-used");
const elSwapTotal  = $("swap-total");
const elSwapBar    = $("swap-bar");
const elDiskPct    = $("disk-percent");
const elDiskUsed   = $("disk-used");
const elDiskTotal  = $("disk-total");
const elDiskBar    = $("disk-bar");
const elDisk2Row   = $("disk2-row");
const elDisk2Title = $("disk2-title");
const elDisk2Pct   = $("disk2-percent");
const elDisk2Used  = $("disk2-used");
const elDisk2Total = $("disk2-total");
const elDisk2Bar   = $("disk2-bar");
const elLastUpdate = $("last-update");
const elLogSize    = $("log-size");

// ── Chart defaults ────────────────────────────────────────────────────────
Chart.defaults.color = "#8b949e";
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
      cutout: "72%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.parsed.toFixed(1)} %`,
          },
        },
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

// ── Instantiate charts ────────────────────────────────────────────────────
const cpuDonut   = makeDonut("cpuChart",  "CPU",  "#58a6ff");
const memDonut   = makeDonut("memChart",  "Mem",  "#3fb950");
const npuDonut   = makeDonut("npuChart",  "NPU",  "#bc8cff");
const tempLine      = makeTempLine("tempChart");
const gpuTempLine   = makeTempLine("gpuTempChart");
const histChart  = new Chart($("historyChart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label: "CPU %",    borderColor: "#58a6ff", backgroundColor: "#58a6ff22" },
      { label: "Memory %", borderColor: "#3fb950", backgroundColor: "#3fb95022" },
      { label: "NPU %",    borderColor: "#bc8cff", backgroundColor: "#bc8cff22" },
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
    interaction: {
      mode: "index",
      intersect: false,
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
          color: "#8b949e",
          font: { size: 11 },
          callback: function(value, index) {
            const ts = histChart.data.labels[index];
            if (ts == null) return "";
            const d = new Date(ts);
            const labels = histChart.data.labels;
            const spanMs = labels.length > 1 ? labels[labels.length - 1] - labels[0] : 0;
            if (spanMs >= 86400000) {
              // Show date + time for spans >= 1 day
              const mo = String(d.getMonth() + 1).padStart(2, "0");
              const dy = String(d.getDate()).padStart(2, "0");
              const hh = String(d.getHours()).padStart(2, "0");
              const mm = String(d.getMinutes()).padStart(2, "0");
              return mo + "/" + dy + " " + hh + ":" + mm;
            }
            // Show time only for shorter spans
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          },
        },
        grid: { color: "#21262d" },
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
          title: function(items) {
            if (!items.length) return "";
            const ts = histChart.data.labels[items[0].dataIndex];
            if (ts == null) return "";
            return new Date(ts).toLocaleString();
          },
          label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) + " %" : "N/A"}`,
        },
      },
      zoom: {
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: "x",
        },
        pan: {
          enabled: true,
          mode: "x",
        },
        limits: {
          x: { minRange: 10000 },
        },
      },
    },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────
function pct(val) {
  return val != null ? val.toFixed(1) + " %" : "N/A";
}

// Insert a null data point just after `lastTs` so Chart.js draws a visible
// break in the line instead of connecting across the missing period.
// The gap marker timestamp is lastTs + 1 ms – placing it immediately after
// the last real sample keeps it invisible on the x-axis while still signalling
// the absence of data to Chart.js (which treats null as "no value here").
function maybeInsertGap(lastTs, currentTs) {
  // Use 2× the larger of the polling interval or the 1-minute resampling
  // interval so that resampled history points (~60 s apart) are never
  // mistaken for gaps and rendered as invisible isolated nulls.
  const gapThresholdMs = 2 * Math.max(POLL_INTERVAL_MS, RESAMPLE_INTERVAL_MS);
  if (currentTs - lastTs > gapThresholdMs) {
    history.labels.push(lastTs + 1);
    history.cpu.push(null);
    history.mem.push(null);
    history.npu.push(null);
  }
}

function updateDonut(chart, value) {
  const v = value != null ? value : 0;
  chart.data.datasets[0].data = [v, 100 - v];
  chart.update("none");
}

function updateHistChart() {
  const maxPoints = Math.ceil(historyWindowSeconds * 1000 / POLL_INTERVAL_MS);
  const start = Math.max(0, history.labels.length - maxPoints);
  histChart.data.labels            = history.labels.slice(start);
  histChart.data.datasets[0].data  = history.cpu.slice(start);
  histChart.data.datasets[1].data  = history.mem.slice(start);
  histChart.data.datasets[2].data  = history.npu.slice(start);
  histChart.update("none");
}

function pushHistory(ts, cpuVal, memVal, npuVal) {
  const tsMs = ts * 1000;
  if (history.labels.length > 0) {
    const lastTs = history.labels[history.labels.length - 1];
    maybeInsertGap(lastTs, tsMs);
    if (history.labels.length > MAX_HISTORY_LEN) {
      history.labels.shift();
      history.cpu.shift();
      history.mem.shift();
      history.npu.shift();
    }
  }
  history.labels.push(tsMs);
  history.cpu.push(cpuVal);
  history.mem.push(memVal);
  history.npu.push(npuVal != null ? npuVal : null);
  if (history.labels.length > MAX_HISTORY_LEN) {
    history.labels.shift();
    history.cpu.shift();
    history.mem.shift();
    history.npu.shift();
  }
  updateHistChart();
}

function pushTempHistory(ts, tempVal) {
  tempLine.data.labels.push(new Date(ts * 1000).toLocaleTimeString());
  tempLine.data.datasets[0].data.push(tempVal);
  if (tempLine.data.labels.length > MAX_HISTORY_LEN) {
    tempLine.data.labels.shift();
    tempLine.data.datasets[0].data.shift();
  }
  tempLine.update("none");
}

function pushGpuTempHistory(ts, tempVal) {
  gpuTempLine.data.labels.push(new Date(ts * 1000).toLocaleTimeString());
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

  // Info bar
  elInfoPod.textContent  = system.pod  || "–";
  elInfoNode.textContent = system.node || "–";
  elHwModel.textContent   = system.hardware || "–";
  elUptime.textContent    = system.uptime_human || "–";
  elCpuCount.textContent  = cpu.count != null ? cpu.count + " cores" : "–";
  elCpuFreq.textContent   = cpu.freq_mhz != null
    ? `${cpu.freq_mhz} MHz (max ${cpu.freq_max_mhz} MHz)`
    : "–";

  // CPU
  elCpuPct.textContent = pct(cpu.percent);
  updateDonut(cpuDonut, cpu.percent);

  // Memory
  elMemPct.textContent   = pct(memory.percent);
  elMemUsed.textContent  = memory.used_mb + " MB";
  elMemTotal.textContent = memory.total_mb + " MB";
  updateDonut(memDonut, memory.percent);

  // Temperature
  if (cpu.temperature_c != null) {
    elCpuTemp.textContent = cpu.temperature_c + " °C";
    pushTempHistory(timestamp, cpu.temperature_c);
  } else {
    elCpuTemp.textContent = "N/A";
  }

  // GPU Temperature
  if (gpu && gpu.temperature_c != null) {
    elGpuTemp.textContent = gpu.temperature_c + " °C";
    pushGpuTempHistory(timestamp, gpu.temperature_c);
  } else {
    elGpuTemp.textContent = "N/A";
  }

  // NPU
  if (npu && npu.percent != null) {
    elNpuPct.textContent = pct(npu.percent);
    updateDonut(npuDonut, npu.percent);
  } else {
    elNpuPct.textContent = "N/A";
    updateDonut(npuDonut, 0);
  }

  // Swap
  elSwapPct.textContent   = pct(memory.swap_percent);
  elSwapUsed.textContent  = memory.swap_used_mb + " MB";
  elSwapTotal.textContent = memory.swap_total_mb + " MB";
  elSwapBar.style.width   = (memory.swap_percent || 0) + "%";

  // Disk
  if (disk) {
    elDiskPct.textContent   = pct(disk.percent);
    elDiskUsed.textContent  = disk.used_gb + " GB";
    elDiskTotal.textContent = disk.total_gb + " GB";
    elDiskBar.style.width   = (disk.percent || 0) + "%";
  }

  // Disk 2 (secondary mount point)
  const disk2 = data.disk2;
  if (disk2) {
    elDisk2Row.style.display   = "";
    elDisk2Title.textContent   = "Disk (" + disk2.mountpoint + ")";
    elDisk2Pct.textContent     = pct(disk2.percent);
    elDisk2Used.textContent    = disk2.used_gb + " GB";
    elDisk2Total.textContent   = disk2.total_gb + " GB";
    elDisk2Bar.style.width     = (disk2.percent || 0) + "%";
  } else {
    elDisk2Row.style.display   = "none";
  }

  // History
  pushHistory(timestamp, cpu.percent, memory.percent, npu ? npu.percent : null);

  // Last update
  elLastUpdate.textContent = "Last update: " + new Date(timestamp * 1000).toLocaleTimeString();
}

// ── Timeframe selector ────────────────────────────────────────────────────
document.querySelectorAll(".btn-tf[data-seconds]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".btn-tf[data-seconds]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    historyWindowSeconds = parseInt(btn.dataset.seconds, 10);
    updateHistChart();
    histChart.resetZoom();
  });
});

// Reset zoom on double-click on chart
$("historyChart").addEventListener("dblclick", () => histChart.resetZoom());

// ── WebSocket connection ──────────────────────────────────────────────────
function connectWebSocket() {
  const socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    connStatus.textContent = "Live";
    connStatus.className   = "badge connected";
  });

  socket.on("disconnect", () => {
    connStatus.textContent = "Disconnected";
    connStatus.className   = "badge error";
  });

  socket.on("connect_error", () => {
    connStatus.textContent = "Error";
    connStatus.className   = "badge error";
  });

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
      const data = await resp.json();
      render(data);
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

// ── History preload (populate charts from existing CSV log on page open) ──
async function loadHistory() {
  try {
    const resp = await fetch("/api/history");
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
      if (row.temperature_c != null) {
        tempLine.data.labels.push(new Date(tsMs).toLocaleTimeString());
        tempLine.data.datasets[0].data.push(row.temperature_c);
      }
      if (row.gpu_temperature_c != null) {
        gpuTempLine.data.labels.push(new Date(tsMs).toLocaleTimeString());
        gpuTempLine.data.datasets[0].data.push(row.gpu_temperature_c);
      }
    });

    // Trim to max allowed length
    while (history.labels.length > MAX_HISTORY_LEN) {
      history.labels.shift();
      history.cpu.shift();
      history.mem.shift();
      history.npu.shift();
    }
    while (tempLine.data.labels.length > MAX_HISTORY_LEN) {
      tempLine.data.labels.shift();
      tempLine.data.datasets[0].data.shift();
    }
    while (gpuTempLine.data.labels.length > MAX_HISTORY_LEN) {
      gpuTempLine.data.labels.shift();
      gpuTempLine.data.datasets[0].data.shift();
    }

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

// ── Bootstrap ─────────────────────────────────────────────────────────────
(function init() {
  // Pre-populate charts from the existing CSV log before live data arrives
  loadHistory();
  // Try WebSocket first; if socket.io is unavailable fall back to polling
  if (typeof io !== "undefined") {
    connectWebSocket();
  } else {
    startPolling();
  }
  // Refresh log file size once per minute
  refreshLogSize();
  setInterval(refreshLogSize, 60000);
})();
