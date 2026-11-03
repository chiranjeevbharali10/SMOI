FROM python:3.13.18-slim-trixie

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV HF_HOME=/app/hf-cache
COPY app.py .
# Download the pinned model at build time (about 145 MB), so the container starts without
# network access.
RUN python -c "from app import model_path; model_path()"
ENV HF_HUB_OFFLINE=1

RUN useradd --system --no-create-home smoi && chown -R smoi /app
USER smoi
EXPOSE 8002
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002"]
