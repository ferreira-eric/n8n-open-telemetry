#!/bin/sh

# Garante que o Node procure os módulos na pasta /otel/node_modules
export NODE_PATH=/otel/node_modules:/usr/local/lib/node_modules
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-n8n}"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://otel-collector:4318}"

echo "Starting n8n with OpenTelemetry instrumentation..."
# Executa o node garantindo o require do tracing
exec node --require /otel/tracing.js /usr/local/bin/n8n "$@"