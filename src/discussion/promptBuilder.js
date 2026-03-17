const INNER_MONOLOGUE_BLOCK_RE = /\[INNER_MONOLOGUE\][\s\S]*?\[\/INNER_MONOLOGUE\]/gi;
const INNER_MONOLOGUE_TAG_RE = /\[\/?INNER_MONOLOGUE\]/gi;

function stripInnerMonologue(input) {
  return String(input || "")
    .replace(INNER_MONOLOGUE_BLOCK_RE, "")
    .replace(INNER_MONOLOGUE_TAG_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

class PromptBuilder {
  sanitizeForModel(input) {
    return stripInnerMonologue(input);
  }

  buildModelPrompt({ prompt = "", sharedResults = [] } = {}) {
    const sanitizedPrompt = this.sanitizeForModel(prompt);
    const normalizedResults = Array.isArray(sharedResults)
      ? sharedResults
          .map((item) => {
            if (typeof item === "string") {
              return this.sanitizeForModel(item);
            }
            if (!item || typeof item !== "object") {
              return "";
            }
            return this.sanitizeForModel(item.conclusion || item.result || item.output || "");
          })
          .filter(Boolean)
      : [];
    if (normalizedResults.length === 0) {
      return sanitizedPrompt;
    }
    return [
      "Shared execution results:",
      ...normalizedResults.map((item, index) => `${index + 1}. ${item}`),
      "",
      sanitizedPrompt
    ].join("\n").trim();
  }
}

module.exports = {
  PromptBuilder,
  stripInnerMonologue
};
