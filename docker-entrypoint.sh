#!/bin/sh

# Garante que o Node procure os módulos na pasta /otel/node_modules
export NODE_PATH=/otel/node_modules:/usr/local/lib/node_modules
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-n8n}"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://otel-collector:4318}"

# ─── Controle de Instrumentação ───────────────────────────────────────────────
# OTEL_ENABLED=true  → inicia com instrumentação completa (padrão)
# OTEL_ENABLED=false → inicia SEM instrumentação (baseline para comparação)
# ──────────────────────────────────────────────────────────────────────────────
if [ "${OTEL_ENABLED:-true}" = "false" ]; then
  echo "[OTEL] Instrumentação DESABILITADA — modo baseline (sem overhead)"
  exec node /usr/local/bin/n8n "$@"
else
  echo "[OTEL] Instrumentação HABILITADA — iniciando com tracing completo"
  exec node --require /otel/tracing.js /usr/local/bin/n8n "$@"
fi