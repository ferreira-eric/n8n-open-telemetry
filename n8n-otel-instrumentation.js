const { trace, context, SpanStatusCode, SpanKind, metrics } = require('@opentelemetry/api');

function flattenObject(obj, prefix = '', res = {}) {
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    const prefixedKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, prefixedKey, res);
    } else {
      res[prefixedKey] = value;
    }
  }
  return res;
}
const flat = (obj, options = {}) => flattenObject(obj);

function setupN8nOpenTelemetry() {
  try {
    const tracer = trace.getTracer('n8n-instrumentation', '1.0.0');
    const meter = metrics.getMeter('n8n-instrumentation', '1.0.0');

    const workflowCounter = meter.createCounter('n8n.workflow.executions', {
      description: 'Count workflow execution',
      unit: '1',
    });

    const workflowFailedCounter = meter.createCounter('n8n.workflow.executions.failed', {
      description: 'Count failed workflow executions',
      unit: '1',
    });

    const nodeCounter = meter.createCounter('n8n.node.executions', {
      description: 'Count nodes execution',
      unit: '1',
    });

    const nodeFailedCounter = meter.createCounter('n8n.node.executions.failed', {
      description: 'Count failed node executions',
      unit: '1',
    });

    // Histograms for duration measurement (Experiment 1 & 2)
    const workflowDurationHistogram = meter.createHistogram('n8n.workflow.duration', {
      description: 'Duration of workflow executions in milliseconds',
      unit: 'ms',
      advice: { explicitBucketBoundaries: [100, 500, 1000, 2000, 5000, 10000, 30000] }
    });

    const nodeDurationHistogram = meter.createHistogram('n8n.node.duration', {
      description: 'Duration of node executions in milliseconds',
      unit: 'ms',
      advice: { explicitBucketBoundaries: [10, 50, 100, 500, 1000, 5000] }
    });

    let WorkflowExecute;
    try {
      WorkflowExecute = require('/usr/local/lib/node_modules/n8n/node_modules/n8n-core').WorkflowExecute;
      console.log("Loaded WorkflowExecute from global n8n-core");
    } catch (err) {
      console.error("Failed to load n8n-core from global path:", err);
      return;
    }

    // --- PATCH WORKFLOW ---
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData;

    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {};
      const workflowId = wfData?.id ?? ""
      const workflowName = wfData?.name ?? ""

      const workflowAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        ...flat(wfData?.settings ?? {}, { delimiter: '.', transformKey: (key) => `n8n.workflow.settings.${key}` }),
      };

      workflowCounter.add(1, {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        'status': 'started'
      });

      // Capture start time for overhead measurement (Experiment 2)
      const wfStartHr = process.hrtime.bigint();

      console.log(`[OTEL_DEBUG]Starting workflow: ${workflowName}`);

      if (global.n8nLogger) {
        global.n8nLogger.info(`Starting workflow: ${workflowName}`, {
          workflowId: workflowId,
          workflowName: workflowName,
          customTag: "TCC-Observability"
        });
      }

      const span = tracer.startSpan('n8n.workflow.execute', {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL
      });

      const activeContext = trace.setSpan(context.active(), span);
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments);

        cancelable.then(
          (result) => {
            if (result?.data?.resultData?.error) {
              const err = result.data.resultData.error;
              span.recordException(err);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(err.message || err),
              });

              workflowCounter.add(1, {
                'n8n.workflow.id': workflowId,
                'n8n.workflow.name': workflowName,
                'status': 'error'
              });

              workflowFailedCounter.add(1, {
                'n8n.workflow.id': workflowId,
                'n8n.workflow.name': workflowName,
              });

              if (global.n8nLogger) {
                global.n8nLogger.error(`Error executing workflow: ${workflowName}`, {
                  workflowId: workflowId,
                  workflowName: workflowName,
                  error_message: String(err.message || err),
                  customTag: "TCC-Observability"
                });
              }

            } else {
              workflowCounter.add(1, {
                'n8n.workflow.id': workflowId,
                'n8n.workflow.name': workflowName,
                'status': 'success'
              });

              if (global.n8nLogger) {
                global.n8nLogger.info(`Workflow completed successfully: ${workflowName}`, {
                  workflowId: workflowId,
                  workflowName: workflowName,
                  customTag: "TCC-Observability"
                });
              }
            }
          },
          (error) => {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            });
            workflowCounter.add(1, {
              'n8n.workflow.id': workflowId,
              'n8n.workflow.name': workflowName,
              'status': 'error'
            });

            workflowFailedCounter.add(1, {
              'n8n.workflow.id': workflowId,
              'n8n.workflow.name': workflowName,
            });

            if (global.n8nLogger) {
              global.n8nLogger.error(`Critical workflow failure: ${workflowName}`, {
                workflowId: workflowId,
                workflowName: workflowName,
                error_message: String(error.message || error),
                customTag: "TCC-Observability"
              });
            }
          }
        ).finally(() => {
          // total_duration_ms = tempo real do workflow + overhead da instrumentação
          // Compare este valor com o tempo medido via API do n8n no modo OTEL_ENABLED=false
          const durationMs = Number(process.hrtime.bigint() - wfStartHr) / 1_000_000;
          span.setAttribute('n8n.workflow.duration_ms', durationMs);
          workflowDurationHistogram.record(durationMs, {
            'n8n.workflow.id': workflowId,
            'n8n.workflow.name': workflowName,
          });
          console.log(`[OTEL_TIMING] Workflow "${workflowName}" total_duration=${durationMs.toFixed(3)}ms`);

          if (global.n8nLogger) {
            global.n8nLogger.info('Workflow execution time', {
              workflowId,
              workflowName,
              total_duration_ms: durationMs, // inclui overhead da instrumentação
              customTag: 'TCC-Observability'
            });
          }

          span.end();
        });

        return cancelable;
      });
    };

    // --- PATCH NODE ---
    const originalRunNode = WorkflowExecute.prototype.runNode;

    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal
    ) {
      if (!this) return originalRunNode.apply(this, arguments);

      const workflowId = workflow?.id ?? 'unknown';
      const nodeName = executionData?.node?.name ?? 'unknown';
      const nodeType = executionData?.node?.type ?? 'unknown';
      const executionId = additionalData?.executionId ?? 'unknown';

      nodeCounter.add(1, {
        'n8n.workflow.id': workflowId,
        'n8n.node.name': nodeName,
        'n8n.node.type': nodeType
      });

      const nodeAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.execution.id': executionId,
        'n8n.node.name': nodeName,
        'n8n.node.type': nodeType
      };

      // LOG: Início do Nó
      if (global.n8nLogger) {
        global.n8nLogger.info(`Running node: ${nodeName}`, {
          workflowId: workflowId,
          executionId: executionId,
          nodeName: nodeName,
          nodeType: nodeType,
          customTag: "TCC-Observability"
        });
      }

      // Capture node start time for overhead measurement (Experiment 2)
      const nodeStartHr = process.hrtime.bigint();

      return tracer.startActiveSpan(
        `n8n.node.execute`,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          try {
            const result = await originalRunNode.apply(this, arguments);

            // Record node real execution duration (Experiment 2)
            const nodeDurationMs = Number(process.hrtime.bigint() - nodeStartHr) / 1_000_000;
            nodeSpan.setAttribute('n8n.node.duration_ms', nodeDurationMs);
            nodeDurationHistogram.record(nodeDurationMs, {
              'n8n.workflow.id': workflowId,
              'n8n.node.name': nodeName,
              'n8n.node.type': nodeType,
              status: 'success'
            });

            // Inject traceId for Kibana ↔ Jaeger correlation (Experiment 4)
            const spanCtx = nodeSpan.spanContext();
            if (global.n8nLogger) {
              global.n8nLogger.info(`Node successfully completed: ${nodeName}`, {
                workflowId: workflowId,
                executionId: executionId,
                nodeName: nodeName,
                duration_ms: nodeDurationMs,
                traceId: spanCtx.traceId,
                spanId: spanCtx.spanId,
                customTag: "TCC-Observability"
              });
            }

            return result;
          } catch (error) {
            nodeSpan.recordException(error);
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            });

            nodeFailedCounter.add(1, {
              'n8n.workflow.id': workflowId,
              'n8n.node.name': nodeName,
              'n8n.node.type': nodeType
            });

            // Record failed node duration too
            const nodeFailDurationMs = Number(process.hrtime.bigint() - nodeStartHr) / 1_000_000;
            nodeSpan.setAttribute('n8n.node.duration_ms', nodeFailDurationMs);
            nodeDurationHistogram.record(nodeFailDurationMs, {
              'n8n.workflow.id': workflowId,
              'n8n.node.name': nodeName,
              'n8n.node.type': nodeType,
              status: 'error'
            });

            // Inject traceId for Kibana ↔ Jaeger correlation on error (Experiment 4)
            const spanCtxErr = nodeSpan.spanContext();
            if (global.n8nLogger) {
              global.n8nLogger.error(`Error executing node: ${nodeName}`, {
                workflowId: workflowId,
                executionId: executionId,
                nodeName: nodeName,
                nodeType: nodeType,
                duration_ms: nodeFailDurationMs,
                error_message: String(error.message || error),
                traceId: spanCtxErr.traceId,
                spanId: spanCtxErr.spanId,
                customTag: "TCC-Observability"
              });
            }

            throw error;
          } finally {
            nodeSpan.end();
          }
        }
      );
    };

  } catch (e) {
    console.error("Failed to set up n8n OpenTelemetry instrumentation:", e);
  }
}

module.exports = setupN8nOpenTelemetry;