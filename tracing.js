process.env.NODE_PATH = '/usr/local/lib/node_modules';
require('module').Module._initPaths();

"use strict";

const opentelemetry = require("@opentelemetry/sdk-node");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { logs } = require('@opentelemetry/api-logs'); // API Global
const winston = require("winston");
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');

const loggerConsole = winston.createLogger({
  transports: [new winston.transports.Console()],
});


const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "n8n",
});

const loggerProvider = new LoggerProvider({
  resource: resource,
});

loggerProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(
    new OTLPLogExporter({
      url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || "http://otel-collector:4318/v1/logs",
    })
  )
);

logs.setGlobalLoggerProvider(loggerProvider);

const sdk = new opentelemetry.NodeSDK({
  resource: resource,
  // Traces
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://otel-collector:4318/v1/traces",
  }),
  // Metrics
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || "http://otel-collector:4318/v1/metrics",
    }),
    exportIntervalMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
      "@opentelemetry/instrumentation-tls": { enabled: false },
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-pg": { enabled: false }
    }),
    new RuntimeNodeInstrumentation(),
  ],
});

sdk.start();

const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console(), 
    new OpenTelemetryTransportV3(),   
  ],
});

global.n8nLogger = logger;

const setupN8nOpenTelemetry = require("./n8n-otel-instrumentation");
setupN8nOpenTelemetry();

console.log("OpenTelemetry SDK & Logging started for n8n (Manual Provider Mode)");

process.on("uncaughtException", async (err) => {
  console.error("Uncaught Exception", err);
  if (global.n8nLogger) global.n8nLogger.error("Uncaught Exception", { error: err.message });
  try {
    await sdk.shutdown();
  } catch (e) {}
  process.exit(1);
});