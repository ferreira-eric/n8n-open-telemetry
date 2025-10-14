#!/bin/sh

export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-n8n}"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://otel-collector:4318}"
export OTEL_LOG_LEVEL="info"

echo "Starting n8n with OpenTelemetry instrumentation..."
exec node --require /otel/tracing.js /usr/local/bin/n8n "$@"
