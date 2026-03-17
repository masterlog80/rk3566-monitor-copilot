# RK3566 System Monitor

A real-time web dashboard for monitoring RK3566 (Rockchip) and other Linux-based single-board computers. Displays CPU usage, memory, temperature, NPU usage, and uptime with live Chart.js visualizations served over WebSockets.

## Instructions:
1. Copy all the file on the same folder
```
git clone https://github.com/masterlog80/rk3566-monitor-copilot.git
cd rk3566-monitor-copilot
```
2. Build the docker image:
```
yes | docker image prune --all
docker build -t rk3566-monitor-copilot .
```
3. Deploy the composer file:
```
docker compose -f docker-compose.yml up -d --remove-orphans
```
4. Open [http://localhost:5000](http://localhost:5000) in your browser.

## Screenshot

![RK3566 System Monitor Dashboard](https://github.com/user-attachments/assets/d1a10c7e-624d-462a-b2c9-1d1fab55ffa1)

## Features

- **Real-time metrics** via Socket.IO WebSocket (configurable refresh rate, default 10 s)
- **REST API** fallback with polling support
- **Charts**: donut gauges for CPU / memory / NPU, line chart for temperature history, combined history chart
- **NPU monitoring**: real-time Neural Processing Unit utilisation via the `rknpu2` kernel driver
- **System info**: hostname, hardware model, uptime, CPU frequency
- **CSV export**: one-click download of a full metrics snapshot as a `.csv` file
- **Local metrics log**: graph values (CPU%, memory%, temperature, NPU%) are automatically appended to a local CSV file at each poll interval, with automatic pruning and resampling
- **Prometheus metrics**: a `/metrics` endpoint exposes all system metrics in Prometheus text format for scraping by Prometheus, Grafana, or any OpenMetrics-compatible tool
- **Fully containerised** with Docker and Docker Compose
- **Responsive** dark-themed UI – works on desktop and mobile

### Docker Compose

```bash
docker compose up --build -d
```

The dashboard is available at [http://localhost:5000](http://localhost:5000).  
To expose host `/proc` and `/sys` for accurate metrics inside the container the compose file mounts them read-only.

### Docker (manual)

```bash
docker build -t rk3566-monitor .
docker run -d \
  --name rk3566-monitor \
  -p 5000:5000 \
  -v /proc:/proc:ro \
  -v /sys:/sys:ro \
  rk3566-monitor
```

## Configuration

Copy `.env` and adjust as needed:

| Variable               | Default                     | Description                                          |
|------------------------|-----------------------------|------------------------------------------------------|
| `HOST`                 | `0.0.0.0`                   | Bind address                                         |
| `PORT`                 | `5000`                      | TCP port                                             |
| `SECRET_KEY`           | `change-me-in-production`   | Flask session secret (change this)                   |
| `FLASK_ENV`            | `production`                | Flask environment                                    |
| `LOG_LEVEL`            | `INFO`                      | Python logging level                                 |
| `METRICS_LOG_FILE`     | `metrics_log.csv`           | Path of the local CSV file that logs graph values. When using Docker Compose this is automatically set to `/data/metrics_log.csv` (mapped to `./data/` on the host). |
| `POLL_INTERVAL_SECONDS`| `10`                        | How often (in seconds) metrics are collected and broadcast to clients via WebSocket and logged to CSV. |
| `RETENTION_DAYS`       | `14`                        | Number of days to retain rows in the local CSV log. Rows older than this are pruned during hourly maintenance. |
| `RESAMPLE_AFTER_HOURS` | `24`                        | After this many hours, high-frequency CSV rows are averaged into 1-minute buckets to keep the log file compact. |

## CSV Export

Click the **⬇ Export CSV** button in the top-right corner of the dashboard to download a snapshot of all current metrics as a `.csv` file.

The file contains the following fields:

| Metric               | Unit    | Description                   |
|----------------------|---------|-------------------------------|
| `cpu_percent`        | %       | Current CPU utilisation       |
| `cpu_count`          | cores   | Logical CPU core count        |
| `cpu_freq_mhz`       | MHz     | Current CPU frequency         |
| `cpu_freq_max_mhz`   | MHz     | Maximum CPU frequency         |
| `cpu_temperature_c`  | °C      | CPU temperature (if available)|
| `memory_percent`     | %       | RAM utilisation               |
| `memory_used_mb`     | MB      | RAM in use                    |
| `memory_total_mb`    | MB      | Total RAM                     |
| `memory_available_mb`| MB      | Available RAM                 |
| `swap_percent`       | %       | Swap utilisation              |
| `swap_used_mb`       | MB      | Swap in use                   |
| `swap_total_mb`      | MB      | Total swap                    |
| `disk_percent`       | %       | Disk (/) utilisation          |
| `disk_used_gb`       | GB      | Disk (/) space in use         |
| `disk_total_gb`      | GB      | Total disk (/) space          |
| `disk_free_gb`       | GB      | Free disk (/) space           |
| `npu_percent`        | %       | NPU utilisation (if available)|
| `hostname`           |         | System hostname               |
| `hardware`           |         | Hardware / CPU model          |
| `uptime_seconds`     | s       | Uptime in seconds             |
| `uptime_human`       |         | Human-readable uptime         |
| `timestamp`          | unix    | Unix epoch of the snapshot    |

You can also download the CSV directly via the API endpoint `GET /api/metrics/csv`.

## Local Metrics Log

In addition to the on-demand CSV export, the monitor **automatically appends** the graph values to a local CSV file at every poll interval (default: every 10 seconds) while the server is running. The file records the metrics that are plotted in the dashboard charts:

| Column            | Unit  | Description                       |
|-------------------|-------|-----------------------------------|
| `timestamp`       | unix  | Unix epoch of the sample          |
| `datetime`        |       | Human-readable local date/time    |
| `cpu_percent`     | %     | CPU utilisation                   |
| `memory_percent`  | %     | RAM utilisation                   |
| `temperature_c`   | °C    | CPU temperature (null if N/A)     |
| `npu_percent`     | %     | NPU utilisation (null if N/A)     |

The file path is controlled by the `METRICS_LOG_FILE` environment variable (default `metrics_log.csv`).  
When running via Docker Compose it is automatically written to `/data/metrics_log.csv` inside the container, which is bind-mounted to `./data/metrics_log.csv` on the host so the log **persists across container restarts**.

### Automatic maintenance

Once per hour the server runs a maintenance pass on the CSV log:

1. **Pruning** – rows with a timestamp older than `RETENTION_DAYS` (default: 14 days) are deleted.
2. **Resampling** – rows older than `RESAMPLE_AFTER_HOURS` (default: 24 hours) are averaged into 1-minute buckets. This keeps the file compact while preserving a long-term trend record. Data within the last 24 hours is always kept at full poll-interval resolution.

Example log snippet:

```
timestamp,datetime,cpu_percent,memory_percent,temperature_c,npu_percent
1714000000,2024-04-25 10:06:40,12.3,45.1,52.0,0.0
1714000002,2024-04-25 10:06:42,14.7,45.2,52.1,0.0
```

## API Endpoints

| Method | Path                | Description                                  |
|--------|---------------------|----------------------------------------------|
| GET    | `/`                 | Dashboard UI                                 |
| GET    | `/metrics`          | Prometheus metrics (text exposition format)  |
| GET    | `/api/metrics`      | All metrics (JSON)                           |
| GET    | `/api/metrics/csv`  | All metrics as a downloadable CSV file       |
| GET    | `/api/history`      | Historical graph metrics from the CSV log (JSON) |
| GET    | `/api/cpu`          | CPU metrics only                             |
| GET    | `/api/memory`       | Memory metrics only                          |
| GET    | `/api/npu`          | NPU metrics only                             |
| GET    | `/api/system`       | System info only                             |
| GET    | `/health`           | Health check (`{"status":"ok"}`)             |

## Prometheus Integration

The `/metrics` endpoint exposes all system metrics in the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/).  
You can open it directly from the dashboard using the **📊 Prometheus** button in the top bar.

### Exposed metrics

| Metric name                        | Type  | Description                              |
|------------------------------------|-------|------------------------------------------|
| `rk3566_cpu_usage_percent`         | Gauge | CPU usage (%)                            |
| `rk3566_cpu_temperature_celsius`   | Gauge | CPU temperature (°C)                     |
| `rk3566_cpu_frequency_mhz`         | Gauge | Current CPU frequency (MHz)              |
| `rk3566_memory_usage_percent`      | Gauge | Memory usage (%)                         |
| `rk3566_memory_used_mb`            | Gauge | Memory used (MB)                         |
| `rk3566_memory_total_mb`           | Gauge | Total memory (MB)                        |
| `rk3566_swap_usage_percent`        | Gauge | Swap usage (%)                           |
| `rk3566_disk_usage_percent`        | Gauge | Disk usage – root filesystem (%)         |
| `rk3566_disk_used_gb`              | Gauge | Disk space used (GB)                     |
| `rk3566_disk_total_gb`             | Gauge | Total disk space (GB)                    |
| `rk3566_npu_usage_percent`         | Gauge | NPU usage (%) – only set when available  |
| `rk3566_uptime_seconds`            | Gauge | System uptime (seconds)                  |

### Example `prometheus.yml` scrape config

```yaml
scrape_configs:
  - job_name: rk3566_monitor
    static_configs:
      - targets: ['<host>:5000']
    metrics_path: /metrics
```

WebSocket events (Socket.IO):

| Event             | Direction       | Description                      |
|-------------------|-----------------|----------------------------------|
| `connect`         | server → client | Confirms connection               |
| `metrics`         | server → client | Metrics payload (every `POLL_INTERVAL_SECONDS`) |
| `request_metrics` | client → server | Request an immediate snapshot     |
| `error`           | server → client | Error notification                |

## Project Structure

```
rk3566-monitor-copilot/
├── app.py               # Flask + Socket.IO backend
├── requirements.txt     # Python dependencies
├── Dockerfile
├── docker-compose.yml
├── .env                 # Environment variables
├── templates/
│   └── index.html       # Dashboard HTML
├── static/
│   ├── styles.css       # Responsive dark-theme CSS
│   ├── script.js        # Chart.js + Socket.IO client
│   └── favicon.svg
└── data/                # Auto-created at runtime; contains metrics_log.csv
```

## Requirements

- Python 3.10+ (or Docker)
- Linux host with `/proc` and `/sys` filesystems for full hardware metrics
- Works on any Linux system (non-Linux metrics gracefully fall back to psutil)
