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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_proc_file(path: str, default: str = "") -> str:
    """Read a single-line value from a /proc file safely."""
    try:
        with open(path, "r") as fh:
            return fh.read().strip()
    except OSError:
        return default


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


def _get_npu_usage() -> float | None:
    """Return the NPU utilisation percentage for Rockchip RK3566 (and similar).

    Tries the kernel debug interface first, then the devfreq load sysfs node.
    Returns a float in [0, 100] or None if the value cannot be read.
    """
    # Path exposed by the rknpu2 kernel driver (most RK356x / RK3588 boards)
    debug_path = "/sys/kernel/debug/rknpu/load"
    raw = _read_proc_file(debug_path)
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


def collect_metrics() -> dict:
    """Collect and return all system metrics as a dict."""
    cpu_percent = psutil.cpu_percent(interval=0.2)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count(logical=True)

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")

    uptime_sec = _get_uptime_seconds()
    cpu_temp = _get_cpu_temp()
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
        "npu": {
            "percent": npu_percent,
        },
        "system": {
            "uptime_seconds": uptime_sec,
            "uptime_human": _format_uptime(uptime_sec),
            "hardware": hw_model,
            "hostname": _read_proc_file("/proc/sys/kernel/hostname", "unknown"),
            "os_release": _read_proc_file("/proc/version", "N/A").split(" ", 3)[:3],
        },
        "timestamp": int(time.time()),
    }


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


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
        # NPU
        writer.writerow(["npu_percent", data["npu"]["percent"], "%"])
        # System
        writer.writerow(["hostname", data["system"]["hostname"], ""])
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
# Background task: push metrics every 2 seconds to all connected clients
# ---------------------------------------------------------------------------

def _metrics_broadcast_task():
    while True:
        try:
            data = collect_metrics()
            socketio.emit("metrics", data)
        except Exception:  # noqa: BLE001
            logger.exception("Background metrics broadcast error")
        socketio.sleep(2)


if __name__ == "__main__":
    socketio.start_background_task(_metrics_broadcast_task)
    logger.info("Starting RK3566 Monitor on %s:%s", HOST, PORT)
    socketio.run(app, host=HOST, port=PORT, debug=False)