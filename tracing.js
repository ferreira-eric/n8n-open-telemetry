process.env.NODE_PATH = '/usr/local/lib/node_modules';
require('module').Module._initPaths();

"use strict";

// Enable proper async context propagation globally.
/*
const { AsyncHooksContextManager } = require("@opentelemetry/context-async-hooks");
const { context } = require("@opentelemetry/api");
const contextManager = new AsyncHooksContextManager();
context.setGlobalContextManager(contextManager.enable());
*/

const opentelemetry = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const setupN8nOpenTelemetry = require("./n8n-otel-instrumentation");
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

const autoInstrumentations = getNodeAutoInstrumentations({
  "@opentelemetry/instrumentation-dns": { enabled: false },
  "@opentelemetry/instrumentation-net": { enabled: false },
  "@opentelemetry/instrumentation-tls": { enabled: false },
  "@opentelemetry/instrumentation-fs": { enabled: false },
  "@opentelemetry/instrumentation-pg": {
    enhancedDatabaseReporting: true,
  }
});

registerInstrumentations({
  instrumentations: [autoInstrumentations],
});

setupN8nOpenTelemetry();

const sdk = new opentelemetry.NodeSDK({
  logRecordProcessors: [
    new opentelemetry.logs.SimpleLogRecordProcessor(new OTLPLogExporter({
      url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || "http://otel-collector:4318/v1/logs",
    })),
  ],
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "n8n",
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://otel-collector:4318/v1/traces",
  }),
});


process.on("uncaughtException", async (err) => {
  logger.error("Uncaught Exception", { error: err });
  const span = opentelemetry.trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
  }
  try {
    await sdk.forceFlush();
  } catch (flushErr) {
    logger.error("Error flushing telemetry data", { error: flushErr });
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection", { error: reason });
});

sdk.start();

console.log("OpenTelemetry SDK started for n8n");