FROM python:3.11-slim

WORKDIR /app

# Hugging Face Spaces expects 7860
EXPOSE 7860

# Copy requirements and install. BGE is loaded lazily at runtime and only when
# TAWFEERY_AI=1 is set (off by default for Render free 512MB RAM).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all project files
COPY . .

# Use PORT if set (HF sets 7860), fallback to 7860, 1 worker for free-tier RAM
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 4 --timeout 60 --keep-alive 30 wsgi:app"]
