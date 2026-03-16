# RK3566 System Monitor

A real-time web dashboard for monitoring RK3566 (Rockchip) and other Linux-based single-board computers. Displays CPU usage, memory, temperature, NPU usage, and uptime with live Chart.js visualizations served over WebSockets.

## Screenshot

![RK3566 System Monitor Dashboard](https://github.com/user-attachments/assets/e59bd797-58d9-41d8-85f1-8b613252e1e9)

## Features

- **Real-time metrics** via Socket.IO WebSocket (2-second refresh)
- **REST API** fallback with polling support
- **Charts**: donut gauges for CPU / memory / NPU, line chart for temperature history, combined history chart
- **NPU monitoring**: real-time Neural Processing Unit utilisation via the `rknpu2` kernel driver
- **System info**: hostname, hardware model, uptime, CPU frequency
- **CSV export**: one-click download of a full metrics snapshot as a `.csv` file
- **Fully containerised** with Docker and Docker Compose
- **Responsive** dark-themed UI – works on desktop and mobile

Instructions:
1. Copy all the file on the same folder
```
git clone https://github.com/masterlog80/rk3566-monitor-copilot.git
cd rk3566-monitor-copilot
```
2. Build the docker image:
```
y | docker image prune --all
docker build -t rk3566-monitor .
```
3. Deploy the composer file:
```
docker compose -f docker-compose.yml up -d --remove-orphans
```

Open [http://localhost:5000](http://localhost:5000) in your browser.

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

| Variable     | Default                     | Description                       |
|--------------|-----------------------------|-----------------------------------|
| `HOST`       | `0.0.0.0`                   | Bind address                      |
| `PORT`       | `5000`                      | TCP port                          |
| `SECRET_KEY` | `change-me-in-production`   | Flask session secret (change this)|
| `FLASK_ENV`  | `production`                | Flask environment                 |
| `LOG_LEVEL`  | `INFO`                      | Python logging level              |

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

## API Endpoints

| Method | Path                | Description                                  |
|--------|---------------------|----------------------------------------------|
| GET    | `/`                 | Dashboard UI                                 |
| GET    | `/api/metrics`      | All metrics (JSON)                           |
| GET    | `/api/metrics/csv`  | All metrics as a downloadable CSV file       |
| GET    | `/api/cpu`          | CPU metrics only                             |
| GET    | `/api/memory`       | Memory metrics only                          |
| GET    | `/api/npu`          | NPU metrics only                             |
| GET    | `/api/system`       | System info only                             |
| GET    | `/health`           | Health check (`{"status":"ok"}`)             |

WebSocket events (Socket.IO):

| Event             | Direction       | Description                      |
|-------------------|-----------------|----------------------------------|
| `connect`         | server → client | Confirms connection               |
| `metrics`         | server → client | Metrics payload (every ~2 s)      |
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
└── static/
    ├── styles.css       # Responsive dark-theme CSS
    ├── script.js        # Chart.js + Socket.IO client
    └── favicon.svg
```

## Requirements

- Python 3.10+ (or Docker)
- Linux host with `/proc` and `/sys` filesystems for full hardware metrics
- Works on any Linux system (non-Linux metrics gracefully fall back to psutil)
