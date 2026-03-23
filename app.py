import csv
import io
import os
import logging
import re
import time
import psutil
from flask import Flask, jsonify, render_template, Response
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv
from prometheus_client import Gauge, generate_latest, CONTENT_TYPE_LATEST

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "rk3566-monitor-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 5000))
METRICS_LOG_FILE = os.getenv("METRICS_LOG_FILE", "metrics_log.csv")
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", 10))
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", 14))
RESAMPLE_AFTER_HOURS = int(os.getenv("RESAMPLE_AFTER_HOURS", 24))
NPU_LOAD_PATH = os.getenv("NPU_LOAD_PATH", "/sys/kernel/debug/rknpu/load")
DISK2_MOUNTPOINT = os.getenv("DISK2_MOUNTPOINT", "").strip()


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------

_prom_cpu_percent    = Gauge("rk3566_cpu_usage_percent",        "CPU usage percentage")
_prom_cpu_temp       = Gauge("rk3566_cpu_temperature_celsius",  "CPU temperature in Celsius")
_prom_gpu_temp       = Gauge("rk3566_gpu_temperature_celsius",  "GPU temperature in Celsius")
_prom_cpu_freq_mhz   = Gauge("rk3566_cpu_frequency_mhz",        "Current CPU frequency in MHz")
_prom_mem_percent    = Gauge("rk3566_memory_usage_percent",     "Memory usage percentage")
_prom_mem_used_mb    = Gauge("rk3566_memory_used_mb",           "Memory used in MB")
_prom_mem_total_mb   = Gauge("rk3566_memory_total_mb",          "Total memory in MB")
_prom_swap_percent   = Gauge("rk3566_swap_usage_percent",       "Swap usage percentage")
_prom_disk_percent   = Gauge("rk3566_disk_usage_percent",       "Disk usage percentage (root filesystem)")
_prom_disk_used_gb   = Gauge("rk3566_disk_used_gb",             "Disk space used in GB")
_prom_disk_total_gb  = Gauge("rk3566_disk_total_gb",            "Total disk space in GB")
_prom_disk2_percent  = Gauge("rk3566_disk2_usage_percent",      "Disk2 usage percentage (secondary mount)")
_prom_disk2_used_gb  = Gauge("rk3566_disk2_used_gb",            "Disk2 space used in GB")
_prom_disk2_total_gb = Gauge("rk3566_disk2_total_gb",           "Disk2 total space in GB")
_prom_npu_percent    = Gauge("rk3566_npu_usage_percent",        "NPU usage percentage")
_prom_uptime_seconds = Gauge("rk3566_uptime_seconds",           "System uptime in seconds")


def _update_prometheus_gauges(data: dict) -> None:
    """Update all Prometheus gauges from the latest collected metrics dict."""
    _prom_cpu_percent.set(data["cpu"]["percent"])
    if data["cpu"]["temperature_c"] is not None:
        _prom_cpu_temp.set(data["cpu"]["temperature_c"])
    if data["gpu"]["temperature_c"] is not None:
        _prom_gpu_temp.set(data["gpu"]["temperature_c"])
    if data["cpu"]["freq_mhz"] is not None:
        _prom_cpu_freq_mhz.set(data["cpu"]["freq_mhz"])
    _prom_mem_percent.set(data["memory"]["percent"])
    _prom_mem_used_mb.set(data["memory"]["used_mb"])
    _prom_mem_total_mb.set(data["memory"]["total_mb"])
    _prom_swap_percent.set(data["memory"]["swap_percent"])
    _prom_disk_percent.set(data["disk"]["percent"])
    _prom_disk_used_gb.set(data["disk"]["used_gb"])
    _prom_disk_total_gb.set(data["disk"]["total_gb"])
    if data.get("disk2") is not None:
        _prom_disk2_percent.set(data["disk2"]["percent"])
        _prom_disk2_used_gb.set(data["disk2"]["used_gb"])
        _prom_disk2_total_gb.set(data["disk2"]["total_gb"])
    if data["npu"]["percent"] is not None:
        _prom_npu_percent.set(data["npu"]["percent"])
    _prom_uptime_seconds.set(data["system"]["uptime_seconds"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_file(path: str, default: str = "") -> str:
    """Read and strip the contents of a file safely."""
    try:
        with open(path, "r") as fh:
            return fh.read().strip()
    except OSError:
        return default


def _read_proc_file(path: str, default: str = "") -> str:
    """Read a single-line value from a /proc file safely."""
    return _read_file(path, default)


def _get_cpu_temp() -> float | None:
    """Return the CPU temperature in °C from the thermal zone, or None."""
    # Standard Linux thermal zone path used by most ARM SBCs
    for zone in range(10):
        path = f"/sys/class/thermal/thermal_zone{zone}/type"
        try:
            zone_type = _read_proc_file(path)
        except OSError:
            break
        if "cpu" in zone_type.lower() or zone == 0:
            temp_raw = _read_proc_file(
                f"/sys/class/thermal/thermal_zone{zone}/temp"
            )
            if temp_raw:
                try:
                    return round(int(temp_raw) / 1000.0, 1)
                except ValueError:
                    pass
    # Fallback: psutil sensors_temperatures
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for name, entries in temps.items():
                if entries:
                    return round(entries[0].current, 1)
    except AttributeError:
        pass
    return None


def _get_gpu_temp() -> float | None:
    """Return the GPU temperature in °C from the thermal zone, or None."""
    for zone in range(10):
        path = f"/sys/class/thermal/thermal_zone{zone}/type"
        try:
            zone_type = _read_proc_file(path)
        except OSError:
            break
        if "gpu" in zone_type.lower():
            temp_raw = _read_proc_file(
                f"/sys/class/thermal/thermal_zone{zone}/temp"
            )
            if temp_raw:
                try:
                    return round(int(temp_raw) / 1000.0, 1)
                except ValueError:
                    pass
    return None


def _get_npu_usage() -> float | None:
    """Return the NPU utilisation percentage for Rockchip RK3566 (and similar).

    Tries the kernel debug interface first, then the devfreq load sysfs node.
    Returns a float in [0, 100] or None if the value cannot be read.
    """
    # Path exposed by the rknpu2 kernel driver (most RK356x / RK3588 boards).
    # Overridable via the NPU_LOAD_PATH environment variable.
    raw = _read_proc_file(NPU_LOAD_PATH)
    if raw:
        # Handles both formats:
        #   Simple:     "NPU load:  0%"
        #   Multi-core: "NPU load:  Core0: 67%, Core1:  0%, Core2:  0%,"
        percentages = re.findall(r"(\d+)\s*%", raw)
        if percentages:
            values = [int(p) for p in percentages]
            # Average across all reported cores
            return round(sum(values) / len(values), 1)

    # Alternative: devfreq load node (some BSP kernels)
    devfreq_path = "/sys/class/devfreq/fde40000.npu/device/load"
    raw = _read_proc_file(devfreq_path)
    if raw:
        try:
            return round(float(raw.strip().rstrip("%")), 1)
        except ValueError:
            pass

    return None


def _get_uptime_seconds() -> int:
    """Return system uptime in seconds from /proc/uptime."""
    raw = _read_proc_file("/proc/uptime")
    if raw:
        try:
            return int(float(raw.split()[0]))
        except (ValueError, IndexError):
            pass
    return int(time.time() - psutil.boot_time())


def _format_uptime(seconds: int) -> str:
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, secs = divmod(remainder, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


_CSV_HEADER = [
    "timestamp",
    "datetime",
    "cpu_percent",
    "memory_percent",
    "temperature_c",
    "gpu_temperature_c",
    "npu_percent",
]


def _append_metrics_to_csv(data: dict) -> None:
    """Append graph-relevant metrics (timestamp, cpu%, mem%, temp, npu%) to the local CSV log.

    The file is created with a header row on first write and appended to on
    subsequent calls, so the full history accumulates across restarts only when
    the file is retained between runs.
    """
    file_path = METRICS_LOG_FILE
    parent_dir = os.path.dirname(file_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)
    write_header = not os.path.exists(file_path)
    try:
        with open(file_path, "a", newline="") as fh:
            writer = csv.writer(fh)
            if write_header:
                writer.writerow(_CSV_HEADER)
            ts = data["timestamp"]
            writer.writerow([
                ts,
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)),
                data["cpu"]["percent"],
                data["memory"]["percent"],
                data["cpu"]["temperature_c"],
                data["gpu"]["temperature_c"],
                data["npu"]["percent"],
            ])
    except OSError:
        logger.exception("Failed to write metrics to CSV log '%s'", file_path)


def _maintain_csv_log() -> None:
    """Prune entries older than RETENTION_DAYS and resample entries older than
    RESAMPLE_AFTER_HOURS to 1-minute resolution in the local CSV log.

    This keeps the log file size manageable:
    - Data within the last RESAMPLE_AFTER_HOURS is kept at full resolution.
    - Older data is averaged into 1-minute buckets.
    - Data beyond RETENTION_DAYS is removed entirely.
    """
    file_path = METRICS_LOG_FILE
    if not os.path.exists(file_path):
        return
    try:
        now = int(time.time())
        cutoff_prune = now - RETENTION_DAYS * 86400
        cutoff_resample = now - RESAMPLE_AFTER_HOURS * 3600

        rows = []
        with open(file_path, "r", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                try:
                    ts = int(row["timestamp"])
                except (ValueError, KeyError):
                    continue
                if ts < cutoff_prune:
                    continue  # prune beyond retention window
                rows.append(row)

        if not rows:
            return

        old_rows = [r for r in rows if int(r["timestamp"]) < cutoff_resample]
        recent_rows = [r for r in rows if int(r["timestamp"]) >= cutoff_resample]

        # Resample old rows into 1-minute buckets by averaging numeric columns
        buckets: dict[int, dict] = {}
        for row in old_rows:
            ts = int(row["timestamp"])
            bucket = (ts // 60) * 60  # truncate to the start of the minute
            if bucket not in buckets:
                buckets[bucket] = {
                    "count": 0,
                    "cpu": 0.0,
                    "mem": 0.0,
                    "temp_sum": 0.0,
                    "temp_count": 0,
                    "gpu_temp_sum": 0.0,
                    "gpu_temp_count": 0,
                    "npu_sum": 0.0,
                    "npu_count": 0,
                }
            b = buckets[bucket]
            b["count"] += 1
            b["cpu"] += float(row.get("cpu_percent") or 0)
            b["mem"] += float(row.get("memory_percent") or 0)
            temp_raw = row.get("temperature_c", "")
            if temp_raw not in ("", "None", None):
                b["temp_sum"] += float(temp_raw)
                b["temp_count"] += 1
            gpu_temp_raw = row.get("gpu_temperature_c", "")
            if gpu_temp_raw not in ("", "None", None):
                b["gpu_temp_sum"] += float(gpu_temp_raw)
                b["gpu_temp_count"] += 1
            npu_raw = row.get("npu_percent", "")
            if npu_raw not in ("", "None", None):
                b["npu_sum"] += float(npu_raw)
                b["npu_count"] += 1

        resampled_rows = []
        for bucket_ts in sorted(buckets.keys()):
            b = buckets[bucket_ts]
            cnt = b["count"]
            resampled_rows.append({
                "timestamp": bucket_ts,
                "datetime": time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(bucket_ts)
                ),
                "cpu_percent": round(b["cpu"] / cnt, 2),
                "memory_percent": round(b["mem"] / cnt, 2),
                "temperature_c": (
                    round(b["temp_sum"] / b["temp_count"], 2)
                    if b["temp_count"]
                    else ""
                ),
                "gpu_temperature_c": (
                    round(b["gpu_temp_sum"] / b["gpu_temp_count"], 2)
                    if b["gpu_temp_count"]
                    else ""
                ),
                "npu_percent": (
                    round(b["npu_sum"] / b["npu_count"], 2)
                    if b["npu_count"]
                    else ""
                ),
            })

        all_rows = resampled_rows + list(recent_rows)

        tmp_path = file_path + ".tmp"
        with open(tmp_path, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=_CSV_HEADER)
            writer.writeheader()
            writer.writerows(all_rows)
        os.replace(tmp_path, file_path)

        logger.info(
            "CSV maintenance: %d resampled (>%dh) + %d recent rows; "
            "pruned data older than %d days",
            len(resampled_rows),
            RESAMPLE_AFTER_HOURS,
            len(recent_rows),
            RETENTION_DAYS,
        )
    except OSError:
        logger.exception("Failed to maintain CSV log '%s'", file_path)


def collect_metrics() -> dict:
    """Collect and return all system metrics as a dict."""
    cpu_percent = psutil.cpu_percent(interval=0.2)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count(logical=True)

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")

    disk2_data = None
    if DISK2_MOUNTPOINT:
        try:
            disk2 = psutil.disk_usage(DISK2_MOUNTPOINT)
            disk2_data = {
                "mountpoint": DISK2_MOUNTPOINT,
                "total_gb": round(disk2.total / 1024 / 1024 / 1024, 1),
                "used_gb": round(disk2.used / 1024 / 1024 / 1024, 1),
                "free_gb": round(disk2.free / 1024 / 1024 / 1024, 1),
                "percent": disk2.percent,
            }
        except OSError:
            logger.warning("Could not read disk usage for DISK2_MOUNTPOINT=%r", DISK2_MOUNTPOINT)

    uptime_sec = _get_uptime_seconds()
    cpu_temp = _get_cpu_temp()
    gpu_temp = _get_gpu_temp()
    npu_percent = _get_npu_usage()

    # /proc/cpuinfo – grab Model name / Hardware line
    hw_model = "Unknown"
    try:
        with open("/proc/cpuinfo", "r") as fh:
            for line in fh:
                if line.lower().startswith("hardware"):
                    hw_model = line.split(":", 1)[1].strip()
                    break
                if line.lower().startswith("model name"):
                    hw_model = line.split(":", 1)[1].strip()
    except OSError:
        hw_model = "N/A (not Linux)"

    # Fallback: /proc/device-tree/model (common on ARM SBCs like RK3566)
    if hw_model == "Unknown":
        try:
            with open("/proc/device-tree/model", "r") as fh:
                dt_model = fh.read().rstrip("\x00").strip()
                if dt_model:
                    hw_model = dt_model
        except OSError:
            pass

    return {
        "cpu": {
            "percent": cpu_percent,
            "count": cpu_count,
            "freq_mhz": round(cpu_freq.current, 1) if cpu_freq else None,
            "freq_max_mhz": round(cpu_freq.max, 1) if cpu_freq else None,
            "temperature_c": cpu_temp,
        },
        "memory": {
            "total_mb": round(mem.total / 1024 / 1024, 1),
            "used_mb": round(mem.used / 1024 / 1024, 1),
            "available_mb": round(mem.available / 1024 / 1024, 1),
            "percent": mem.percent,
            "swap_total_mb": round(swap.total / 1024 / 1024, 1),
            "swap_used_mb": round(swap.used / 1024 / 1024, 1),
            "swap_percent": swap.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1024 / 1024 / 1024, 1),
            "used_gb": round(disk.used / 1024 / 1024 / 1024, 1),
            "free_gb": round(disk.free / 1024 / 1024 / 1024, 1),
            "percent": disk.percent,
        },
        "disk2": disk2_data,
        "npu": {
            "percent": npu_percent,
        },
        "gpu": {
            "temperature_c": gpu_temp,
        },
        "system": {
            "uptime_seconds": uptime_sec,
            "uptime_human": _format_uptime(uptime_sec),
            "hardware": hw_model,
            "pod": _read_proc_file("/proc/sys/kernel/hostname", "unknown"),
            "node": _read_file("/etc/hostname", "unknown"),
            "os_release": _read_proc_file("/proc/version", "N/A").split(" ", 3)[:3],
        },
        "timestamp": int(time.time()),
    }


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

def _get_log_file_size_kb() -> float:
    """Return the current size of METRICS_LOG_FILE in kilobytes, or 0.0 if not found."""
    try:
        return round(os.path.getsize(METRICS_LOG_FILE) / 1024, 1)
    except OSError:
        return 0.0


@app.route("/")
def index():
    return render_template(
        "index.html",
        poll_interval_ms=POLL_INTERVAL_SECONDS * 1000,
        poll_interval_seconds=POLL_INTERVAL_SECONDS,
        retention_days=RETENTION_DAYS,
        resample_after_hours=RESAMPLE_AFTER_HOURS,
        log_file_size_kb=_get_log_file_size_kb(),
    )


@app.route("/api/log/size")
def api_log_size():
    return jsonify({"size_kb": _get_log_file_size_kb()})


@app.route("/api/history")
def api_history():
    """Return all in-retention metrics from the local CSV log as JSON.

    Each element in the ``history`` list contains the fields stored in the
    CSV (timestamp, cpu_percent, memory_percent, temperature_c, npu_percent).
    Entries outside the configured RETENTION_DAYS window are excluded so the
    client only receives data it would normally be allowed to display.
    """

    def _float_or_none(val):
        if val in ("", "None", None):
            return None
        try:
            return float(val)
        except ValueError:
            return None

    result = []
    if not os.path.exists(METRICS_LOG_FILE):
        return jsonify({"history": result})
    try:
        cutoff = int(time.time()) - RETENTION_DAYS * 86400
        with open(METRICS_LOG_FILE, "r", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                try:
                    ts = int(row["timestamp"])
                except (ValueError, KeyError):
                    continue
                if ts < cutoff:
                    continue
                result.append({
                    "timestamp": ts,
                    "cpu_percent": _float_or_none(row.get("cpu_percent")),
                    "memory_percent": _float_or_none(row.get("memory_percent")),
                    "temperature_c": _float_or_none(row.get("temperature_c")),
                    "gpu_temperature_c": _float_or_none(row.get("gpu_temperature_c")),
                    "npu_percent": _float_or_none(row.get("npu_percent")),
                })
    except OSError:
        logger.exception("Failed to read history from CSV log '%s'", METRICS_LOG_FILE)
    return jsonify({"history": result})


@app.route("/api/metrics")
def api_metrics():
    try:
        data = collect_metrics()
        return jsonify(data)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to collect metrics")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/cpu")
def api_cpu():
    try:
        m = collect_metrics()
        return jsonify(m["cpu"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to collect CPU metrics")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/memory")
def api_memory():
    try:
        m = collect_metrics()
        return jsonify(m["memory"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to collect memory metrics")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/npu")
def api_npu():
    try:
        m = collect_metrics()
        return jsonify(m["npu"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to collect NPU metrics")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/system")
def api_system():
    try:
        m = collect_metrics()
        return jsonify(m["system"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to collect system metrics")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/metrics/csv")
def api_metrics_csv():
    try:
        data = collect_metrics()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["metric", "value", "unit"])
        # CPU
        writer.writerow(["cpu_percent", data["cpu"]["percent"], "%"])
        writer.writerow(["cpu_count", data["cpu"]["count"], "cores"])
        writer.writerow(["cpu_freq_mhz", data["cpu"]["freq_mhz"], "MHz"])
        writer.writerow(["cpu_freq_max_mhz", data["cpu"]["freq_max_mhz"], "MHz"])
        writer.writerow(["cpu_temperature_c", data["cpu"]["temperature_c"], "°C"])
        writer.writerow(["gpu_temperature_c", data["gpu"]["temperature_c"], "°C"])
        # Memory
        writer.writerow(["memory_percent", data["memory"]["percent"], "%"])
        writer.writerow(["memory_used_mb", data["memory"]["used_mb"], "MB"])
        writer.writerow(["memory_total_mb", data["memory"]["total_mb"], "MB"])
        writer.writerow(["memory_available_mb", data["memory"]["available_mb"], "MB"])
        writer.writerow(["swap_percent", data["memory"]["swap_percent"], "%"])
        writer.writerow(["swap_used_mb", data["memory"]["swap_used_mb"], "MB"])
        writer.writerow(["swap_total_mb", data["memory"]["swap_total_mb"], "MB"])
        # Disk
        writer.writerow(["disk_percent", data["disk"]["percent"], "%"])
        writer.writerow(["disk_used_gb", data["disk"]["used_gb"], "GB"])
        writer.writerow(["disk_total_gb", data["disk"]["total_gb"], "GB"])
        writer.writerow(["disk_free_gb", data["disk"]["free_gb"], "GB"])
        # Disk 2 (secondary mount, only when DISK2_MOUNTPOINT is configured)
        if data.get("disk2") is not None:
            writer.writerow(["disk2_mountpoint", data["disk2"]["mountpoint"], ""])
            writer.writerow(["disk2_percent", data["disk2"]["percent"], "%"])
            writer.writerow(["disk2_used_gb", data["disk2"]["used_gb"], "GB"])
            writer.writerow(["disk2_total_gb", data["disk2"]["total_gb"], "GB"])
            writer.writerow(["disk2_free_gb", data["disk2"]["free_gb"], "GB"])
        # NPU
        writer.writerow(["npu_percent", data["npu"]["percent"], "%"])
        # System
        writer.writerow(["pod", data["system"]["pod"], ""])
        writer.writerow(["node", data["system"]["node"], ""])
        writer.writerow(["hardware", data["system"]["hardware"], ""])
        writer.writerow(["uptime_seconds", data["system"]["uptime_seconds"], "s"])
        writer.writerow(["uptime_human", data["system"]["uptime_human"], ""])
        writer.writerow(["timestamp", data["timestamp"], "unix"])
        output.seek(0)
        filename = f"rk3566_metrics_{data['timestamp']}.csv"
        return Response(
            output.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to export metrics as CSV")
        return jsonify({"error": str(exc)}), 500


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/metrics")
def prometheus_metrics():
    """Prometheus-compatible metrics endpoint.

    Exposes all system metrics in the Prometheus text exposition format so
    that a Prometheus server (or any OpenMetrics-compatible scraper) can
    scrape this endpoint directly.  Point your ``prometheus.yml`` at::

        scrape_configs:
          - job_name: rk3566_monitor
            static_configs:
              - targets: ['<host>:5000']
            metrics_path: /metrics
    """
    return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@socketio.on("connect")
def ws_connect():
    logger.info("WebSocket client connected")
    emit("connected", {"message": "Connected to RK3566 Monitor"})


@socketio.on("disconnect")
def ws_disconnect():
    logger.info("WebSocket client disconnected")


@socketio.on("request_metrics")
def ws_request_metrics():
    try:
        data = collect_metrics()
        emit("metrics", data)
    except Exception as exc:  # noqa: BLE001
        logger.exception("WebSocket metrics error")
        emit("error", {"message": str(exc)})


# ---------------------------------------------------------------------------
# Background task: push metrics every POLL_INTERVAL_SECONDS to all clients
# ---------------------------------------------------------------------------

_MAINTENANCE_INTERVAL_SECONDS = 3600  # run CSV maintenance once per hour


def _metrics_broadcast_task():
    _maintain_csv_log()  # run once at startup
    last_maintenance = int(time.time())
    while True:
        try:
            data = collect_metrics()
            socketio.emit("metrics", data)
            _append_metrics_to_csv(data)
            _update_prometheus_gauges(data)
            now = int(time.time())
            if now - last_maintenance >= _MAINTENANCE_INTERVAL_SECONDS:
                _maintain_csv_log()
                last_maintenance = now
        except Exception:  # noqa: BLE001
            logger.exception("Background metrics broadcast error")
        socketio.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    socketio.start_background_task(_metrics_broadcast_task)
    logger.info("Starting RK3566 Monitor on %s:%s", HOST, PORT)
    socketio.run(app, host=HOST, port=PORT, debug=False)