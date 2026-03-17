function analyzeSentiment(text = "") {
  const normalized = String(text || "").toLowerCase();
  if (/(气死|立刻|马上|紧急|angry|furious|urgent|asap|broken)/.test(normalized)) {
    return {
      tone: "urgent",
      priority_boost: 2
    };
  }
  if (/(担心|麻烦|please|concern|worried)/.test(normalized)) {
    return {
      tone: "concerned",
      priority_boost: 1
    };
  }
  return {
    tone: "neutral",
    priority_boost: 0
  };
}

function narrateSystemStatus(payload = {}) {
  const status = String(payload.status || "UNKNOWN").toUpperCase();
  if (status === "WAITING_AUTH") {
    return "我已经把危险动作停在本地，正在等待你的授权，现有现场不会继续扩大。";
  }
  if (status === "FAILED") {
    return "这次执行已经安全停下，我保留了上下文和快照，接下来可以从失败点继续恢复。";
  }
  if (status === "COMPLETED") {
    return "本地执行已经完成，结果和审计记录都落盘了，可以直接复核。";
  }
  if (status === "ROUTED") {
    return "私聊指令已经投递到目标 Agent 的私有缓冲区，不会泄露给其他角色。";
  }
  return "系统状态已更新，所有敏感动作仍保持在本地 Node.js 控制面内。";
}

module.exports = {
  analyzeSentiment,
  narrateSystemStatus
};
