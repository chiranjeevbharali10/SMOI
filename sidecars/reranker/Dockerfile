FROM python:3.13.18-slim-trixie

WORKDIR /app
# CPU-only PyTorch: the GPU build is several GB larger and not needed for a small cross-encoder.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.15.0
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV HF_HOME=/app/hf-cache
COPY app.py .
# Download the pinned model at build time, so the container starts without network access.
RUN python -c "from app import load_cross_encoder; load_cross_encoder()"
ENV HF_HUB_OFFLINE=1

RUN useradd --system --no-create-home smoi && chown -R smoi /app
USER smoi
EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
