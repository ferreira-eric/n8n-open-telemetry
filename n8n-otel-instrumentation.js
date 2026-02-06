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

    const nodeCounter = meter.createCounter('n8n.node.executions', {
      description: 'Count nodes execution',
      unit: '1',
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
            } else {
               workflowCounter.add(1, { 
                'n8n.workflow.id': workflowId, 
                'n8n.workflow.name': workflowName,
                'status': 'success' 
              });
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
          }
        ).finally(() => {
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

      nodeCounter.add(1, {
         'n8n.workflow.id': workflow?.id ?? 'unknown',
         'n8n.node.name': executionData?.node?.name ?? 'unknown',
         'n8n.node.type': executionData?.node?.type ?? 'unknown'
      });
      const executionId = additionalData?.executionId ?? 'unknown';
      const nodeAttributes = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
      };

      return tracer.startActiveSpan(
        `n8n.node.execute`,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
             try {
                return await originalRunNode.apply(this, arguments);
             } catch (error) {
                nodeSpan.recordException(error);
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