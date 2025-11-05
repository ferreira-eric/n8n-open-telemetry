const { trace, context, SpanStatusCode, SpanKind } = require('@opentelemetry/api');
// Lightweight flatten implementation to avoid dependency issues
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

const tracer = trace.getTracer('n8n-instrumentation', '1.0.0');

function setupN8nOpenTelemetry() {
  try {
    let WorkflowExecute;
    try {
      // path n8n core
      WorkflowExecute = require('/usr/local/lib/node_modules/n8n/node_modules/.pnpm/n8n-core@file+packages+core_@opentelemetry+api@1.9.0_@opentelemetry+sdk-trace-base@1.30_5aee33ef851c7de341eb325c6a25e0ff/node_modules/n8n-core').WorkflowExecute;
      console.log("Loaded WorkflowExecute from global n8n-core");
    } catch (err) {
      console.error("Failed to load n8n-core from global path:", err);
      return;
    }

    /**
     * Patch the workflow execution to wrap the entire run in a workflow-level span.
     *
     * - Span name: "n8n.workflow.execute"
     * - Attributes prefixed with "n8n." to follow semantic conventions.
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData;
    /** @param {import('n8n-workflow').Workflow} workflow */
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {};
      const workflowId = wfData?.id ?? ""
      const workflowName = wfData?.name ?? ""

      const workflowAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        ...flat(wfData?.settings ?? {}, { delimiter: '.', transformKey: (key) => `n8n.workflow.settings.${key}` }),
      };

      const span = tracer.startSpan('n8n.workflow.execute', {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL
      });

      // Set the span as active
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
            }
          },
          (error) => {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            });
          }
        ).finally(() => {
          span.end();
        });

        return cancelable;
      });
    };

    /**
     * Patch the node execution to wrap each node's run in a child span.
     *
     * - Span name: "n8n.node.execute"
     * - Captures node-specific details as attributes.
     */
    const originalRunNode = WorkflowExecute.prototype.runNode;
    /**
     * @param {import('n8n-workflow').Workflow} workflow
     * @param {import('n8n-workflow').IExecuteData} executionData
     * @param {import('n8n-workflow').IRunExecutionData} runExecutionData
     * @param {number} runIndex
     * @param {import('n8n-workflow').IWorkflowExecuteAdditionalData} additionalData
     * @param {import('n8n-workflow').WorkflowExecuteMode} mode
     * @param {AbortSignal} [abortSignal]
     * @returns {Promise<import('n8n-workflow').IRunNodeResponse>}
     */
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal
    ) {
      // Safeguard against undefined this context
      if (!this) {
        console.warn('WorkflowExecute context is undefined');
        return originalRunNode.apply(this, arguments);
      }

      const executionId = additionalData?.executionId ?? 'unknown';
      const userId = additionalData?.userId ?? 'unknown';

      const node = executionData?.node ?? 'unknown';
      let credInfo = 'none';
      if (node?.credentials && typeof node.credentials === 'object') {
        const credTypes = Object.keys(node.credentials);
        if (credTypes.length) {
          credInfo = credTypes
            .map((type) => {
              const cred = node.credentials?.[type];
              return cred && typeof cred === 'object' 
                ? (cred.name ?? `${type} (id:${cred?.id ?? 'unknown'})`)
                : type;
            })
            .join(', ');
        }
      }
      
      const nodeAttributes = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
      };
      
      const flattenedNode = flat(node ?? {}, { delimiter: '.' });
      for (const [key, value] of Object.entries(flattenedNode)) {
        nodeAttributes[`n8n.node.${key}`] = value;
      }
      
      return tracer.startActiveSpan(
        `n8n.node.execute`,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          try {
            const result = await originalRunNode.apply(this, [workflow, executionData, runExecutionData, runIndex, additionalData, mode, abortSignal]);
            try {
              const outputData = result?.data?.[runIndex];
              const finalJson = outputData?.map((item) => item.json);
              nodeSpan.setAttribute('n8n.node.output_json', JSON.stringify(finalJson));
            } catch (error) {
              console.warn('Failed to set node output attributes: ', error);
            }
            return result;
          } catch (error) {
            nodeSpan.recordException(error);
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            });
            nodeSpan.setAttribute('n8n.node.status', 'error');
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