const crypto = require("crypto");

const {
  AUTHORIZATION_RESOLVED,
  IM_COMMAND_RECEIVED,
  IM_COMMAND_ROUTED,
  LOCAL_RUNNER_OPERATION_BLOCKED,
  LOCAL_RUNNER_OPERATION_COMPLETED,
  createAuditEvent
} = require("../platform/audit");
const { AuthorizationRequiredError } = require("../platform/authorizationWorkflow");
const { ValidationError } = require("../platform/contracts");
const { scrubSensitiveData } = require("../platform/sensitiveData");
const { analyzeSentiment, narrateSystemStatus } = require("../platform/statusNarrator");
const { ensureTraceId } = require("../platform/trace");

function signPayload(secret, payload, algorithm = "sha256", prefix = "sha256=") {
  if (!secret) {
    return "";
  }
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(JSON.stringify(payload));
  return `${prefix}${hmac.digest("hex")}`;
}

class ImCommandBridge {
  constructor(options = {}) {
    this.authorizationWorkflow = options.authorizationWorkflow;
    this.localExecutor = options.localExecutor || null;
    this.notifier = options.notifier || null;
    this.signatureSecret = options.signatureSecret || "";
    this.signatureHeader = String(options.signatureHeader || "x-im-signature").toLowerCase();
    this.signatureAlgorithm = options.signatureAlgorithm || "sha256";
    this.signaturePrefix = options.signaturePrefix || "sha256=";
  }

  verifySignature(headers = {}, payload = {}) {
    if (!this.signatureSecret) {
      return true;
    }
    const incoming = String(headers[this.signatureHeader] || headers[this.signatureHeader.toUpperCase()] || "").trim();
    const expected = signPayload(this.signatureSecret, payload, this.signatureAlgorithm, this.signaturePrefix);
    return incoming && incoming === expected;
  }

  appendAudit(orchestrator, traceId, taskId, eventType, payload, actor = "im-bridge") {
    if (!orchestrator || !orchestrator.eventStore) {
      return;
    }
    orchestrator.eventStore.append(createAuditEvent({
      trace_id: traceId,
      task_id: taskId,
      attempt_id: "attempt-0",
      actor,
      source: "im-bridge",
      event_type: eventType,
      payload
    }));
  }

  async notifyStatus(result) {
    if (!this.notifier || typeof this.notifier.sendStatusUpdate !== "function") {
      return null;
    }
    return this.notifier.sendStatusUpdate({
      trace_id: result.trace_id,
      task_id: result.task_id,
      status: result.status,
      summary: result.summary
    });
  }

  async handleIncoming({
    payload = {},
    headers = {},
    orchestrator
  }) {
    if (!this.verifySignature(headers, payload)) {
      throw new ValidationError("IM bridge signature validation failed");
    }
    const traceId = ensureTraceId(payload.trace_id || payload.task_id, "im");
    const taskId = String(payload.task_id || `im-${traceId}`).trim();
    const actor = String(payload.actor || "im-user").trim();
    const text = String(payload.text || "").trim();
    const sentiment = analyzeSentiment(text);
    this.appendAudit(orchestrator, traceId, taskId, IM_COMMAND_RECEIVED, {
      text: scrubSensitiveData(text),
      command: payload.command || "",
      actor,
      tone: sentiment.tone
    }, actor);

    if (text && orchestrator && orchestrator.discussionEngine && text.startsWith("@")) {
      const routed = orchestrator.discussionEngine.routePrivateMessage({
        trace_id: traceId,
        actor,
        text
      });
      const result = {
        trace_id: traceId,
        task_id: taskId,
        status: "ROUTED",
        summary: narrateSystemStatus({
          status: "ROUTED"
        }),
        priority_boost: sentiment.priority_boost,
        routed
      };
      this.appendAudit(orchestrator, traceId, taskId, IM_COMMAND_ROUTED, {
        agent: routed.agent,
        direct: routed.direct
      }, actor);
      await this.notifyStatus(result);
      return result;
    }

    if (payload.request_id && payload.action && this.authorizationWorkflow) {
      const resolved = this.authorizationWorkflow.resolveRequest({
        request_id: payload.request_id,
        action: payload.action,
        actor,
        note: payload.note || text || "",
        mode: payload.mode || ""
      });
      const result = {
        trace_id: traceId,
        task_id: taskId,
        status: resolved.status,
        summary: narrateSystemStatus({
          status: resolved.status === "APPROVED" ? "COMPLETED" : "FAILED"
        }),
        priority_boost: sentiment.priority_boost,
        authorization: resolved
      };
      this.appendAudit(orchestrator, traceId, taskId, AUTHORIZATION_RESOLVED, {
        request_id: resolved.request_id,
        status: resolved.status
      }, actor);
      await this.notifyStatus(result);
      return result;
    }

    const command = String(payload.command || "").trim().toUpperCase();
    if (command === "RESUME_INTERRUPTED" && this.localExecutor) {
      const recovered = this.localExecutor.resumeInterruptedWork();
      const result = {
        trace_id: traceId,
        task_id: taskId,
        status: "COMPLETED",
        summary: narrateSystemStatus({
          status: "COMPLETED"
        }),
        priority_boost: sentiment.priority_boost,
        recovered
      };
      await this.notifyStatus(result);
      return result;
    }

    if (command === "LOCAL_EXEC" && this.localExecutor) {
      try {
        let execution;
        if (payload.operation === "WRITE_FILE") {
          execution = await this.localExecutor.writeFile({
            trace_id: traceId,
            task_id: taskId,
            actor,
            target_path: payload.target_path,
            content: payload.content || ""
          });
        } else if (payload.operation === "DELETE_FILE") {
          execution = await this.localExecutor.deleteFile({
            trace_id: traceId,
            task_id: taskId,
            actor,
            target_path: payload.target_path
          });
        } else if (payload.operation === "MOVE_FILE") {
          execution = await this.localExecutor.moveFile({
            trace_id: traceId,
            task_id: taskId,
            actor,
            source_path: payload.source_path,
            destination_path: payload.destination_path
          });
        } else {
          execution = await this.localExecutor.execCommand({
            trace_id: traceId,
            task_id: taskId,
            actor,
            command: payload.exec_command,
            args: Array.isArray(payload.args) ? payload.args : [],
            cwd: payload.cwd || this.localExecutor.workspaceRoot,
            network_isolation: payload.network_isolation !== false
          });
        }
        const result = {
          trace_id: traceId,
          task_id: taskId,
          status: "COMPLETED",
          summary: narrateSystemStatus({
            status: "COMPLETED"
          }),
          priority_boost: sentiment.priority_boost,
          execution
        };
        this.appendAudit(orchestrator, traceId, taskId, LOCAL_RUNNER_OPERATION_COMPLETED, {
          operation: payload.operation || "EXEC"
        }, actor);
        await this.notifyStatus(result);
        return result;
      } catch (err) {
        if (err instanceof AuthorizationRequiredError) {
          const result = {
            trace_id: traceId,
            task_id: taskId,
            status: "WAITING_AUTH",
            summary: narrateSystemStatus({
              status: "WAITING_AUTH"
            }),
            priority_boost: sentiment.priority_boost,
            authorization: err.request
          };
          this.appendAudit(orchestrator, traceId, taskId, LOCAL_RUNNER_OPERATION_BLOCKED, {
            reason: err.code,
            request_id: err.request ? err.request.request_id : ""
          }, actor);
          await this.notifyStatus(result);
          return result;
        }
        throw err;
      }
    }

    if (payload.task_id && payload.action && orchestrator) {
      const resolved = orchestrator.handleTakeoverAction({
        task_id: payload.task_id,
        action: payload.action,
        actor,
        note: payload.note || text || "",
        metadata: payload.metadata || {}
      });
      const result = {
        trace_id: traceId,
        task_id: payload.task_id,
        status: "COMPLETED",
        summary: narrateSystemStatus({
          status: "COMPLETED"
        }),
        priority_boost: sentiment.priority_boost,
        resolved
      };
      await this.notifyStatus(result);
      return result;
    }

    throw new ValidationError("Unsupported IM bridge payload");
  }
}

module.exports = {
  ImCommandBridge,
  signPayload
};
