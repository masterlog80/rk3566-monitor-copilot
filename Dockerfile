# RK3566 Monitor – Docker image
FROM python:3.11-slim

LABEL org.opencontainers.image.title="RK3566 System Monitor" \
      org.opencontainers.image.description="A real-time web dashboard for monitoring RK3566 (Rockchip) and other Linux-based single-board computers" \
      org.opencontainers.image.source="https://github.com/masterlog80/rk3566-monitor-copilot" \
      org.opencontainers.image.url="https://github.com/masterlog80/rk3566-monitor-copilot" \
      org.opencontainers.image.documentation="https://github.com/masterlog80/rk3566-monitor-copilot" \
      org.opencontainers.image.authors="Lorenzo (via Github Copilot/Claude)" \
      org.opencontainers.image.vendor="Lorenzo (via Github Copilot/Claude)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="2.7" \
      org.opencontainers.image.created="2026-05-31T00:10:00Z"

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

RUN mkdir -p /data

EXPOSE 5000

ENV HOST=0.0.0.0
ENV PORT=5000
ENV FLASK_ENV=production

CMD ["python", "app.py"]
