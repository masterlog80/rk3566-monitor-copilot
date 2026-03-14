# RK3566 System Monitor

A real-time web dashboard for monitoring RK3566 (Rockchip) and other Linux-based single-board computers. Displays CPU usage, memory, temperature, disk, and uptime with live Chart.js visualizations served over WebSockets.

## Features

- **Real-time metrics** via Socket.IO WebSocket (2-second refresh)
- **REST API** fallback with polling support
- **Charts**: donut gauges for CPU / memory / disk, line chart for temperature history, combined history chart
- **System info**: hostname, hardware model, uptime, CPU frequency
- **Fully containerised** with Docker and Docker Compose
- **Responsive** dark-themed UI – works on desktop and mobile

## Quick Start

### Local (Python)

```bash
# Install dependencies
pip install -r requirements.txt

# Run the server
python app.py
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

## API Endpoints

| Method | Path           | Description                    |
|--------|----------------|--------------------------------|
| GET    | `/`            | Dashboard UI                   |
| GET    | `/api/metrics` | All metrics (JSON)             |
| GET    | `/api/cpu`     | CPU metrics only               |
| GET    | `/api/memory`  | Memory metrics only            |
| GET    | `/api/system`  | System info only               |
| GET    | `/health`      | Health check (`{"status":"ok"}`) |

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
