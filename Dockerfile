# RK3566 Monitor – Docker image
FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

EXPOSE 5000

ENV HOST=0.0.0.0
ENV PORT=5000
ENV FLASK_ENV=production

CMD ["python", "app.py"]