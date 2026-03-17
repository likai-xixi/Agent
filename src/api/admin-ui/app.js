const state = {
  tasks: [],
  filtered: [],
  selectedTaskId: "",
  loading: false,
  settingsLoading: false,
  settings: {
    feature_flags: {},
    provider_profiles: {},
    rbac: {
      rbac_enabled: false,
      default_roles: []
    },
    secrets: {
      available: false,
      master_key_env: "SECRET_VAULT_MASTER_KEY",
      reason: "",
      secrets: []
    }
  }
};

const elements = {
  summaryCards: document.getElementById("summary-cards"),
  lastUpdated: document.getElementById("last-updated"),
  stateFilter: document.getElementById("state-filter"),
  searchInput: document.getElementById("search-input"),
  tableBody: document.getElementById("task-table-body"),
  detailJson: document.getElementById("task-detail-json"),
  selectedTaskLabel: document.getElementById("selected-task-label"),
  actionInput: document.getElementById("action-input"),
  providerSelect: document.getElementById("provider-select"),
  fallbackInput: document.getElementById("fallback-input"),
  resultBanner: document.getElementById("result-banner"),
  refreshButton: document.getElementById("refresh-button"),
  actionButtons: [...document.querySelectorAll(".button-row button")],
  settingsStatus: document.getElementById("settings-status"),
  flagsFields: document.getElementById("flags-fields"),
  profilesBody: document.getElementById("profiles-body"),
  rbacEnabled: document.getElementById("rbac-enabled"),
  roleSuperAdmin: document.getElementById("role-super-admin"),
  roleTaskAdmin: document.getElementById("role-task-admin"),
  roleReadOnlyAuditor: document.getElementById("role-read-only-auditor"),
  secretsList: document.getElementById("secrets-list"),
  secretName: document.getElementById("secret-name"),
  secretValue: document.getElementById("secret-value"),
  saveFlagsButton: document.getElementById("save-flags"),
  saveProfilesButton: document.getElementById("save-profiles"),
  saveRbacButton: document.getElementById("save-rbac"),
  saveSecretButton: document.getElementById("save-secret")
};

const PROVIDERS = ["openai", "gemini", "claude", "local"];

function setBanner(message, type = "") {
  elements.resultBanner.textContent = message || "";
  elements.resultBanner.classList.remove("ok", "error");
  if (type) {
    elements.resultBanner.classList.add(type);
  }
}

function setSettingsStatus(message) {
  elements.settingsStatus.textContent = message || "";
}

function updateSettingsButtonState(disabled) {
  elements.saveFlagsButton.disabled = disabled;
  elements.saveProfilesButton.disabled = disabled;
  elements.saveRbacButton.disabled = disabled;
  elements.saveSecretButton.disabled = disabled;
}

async function request(pathname, method = "GET", body = null) {
  const payload = body ? JSON.stringify(body) : "";
  const response = await fetch(pathname, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: payload || undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function applyFilter() {
  const term = String(elements.searchInput.value || "").trim().toLowerCase();
  const stateFilter = String(elements.stateFilter.value || "").trim().toUpperCase();
  state.filtered = state.tasks.filter((task) => {
    const matchesTerm = !term || task.task_id.toLowerCase().includes(term);
    const matchesState = !stateFilter || task.state === stateFilter;
    return matchesTerm && matchesState;
  });
}

function renderSummary() {
  const summary = {};
  for (const task of state.filtered) {
    const key = String(task.state || "UNKNOWN");
    summary[key] = (summary[key] || 0) + 1;
  }
  if (state.filtered.length === 0) {
    elements.summaryCards.innerHTML = "<p class='dim'>No tasks found for current filter.</p>";
    return;
  }
  const cards = Object.entries(summary)
    .sort((left, right) => right[1] - left[1])
    .map(([taskState, count]) => `
      <article class="summary-card">
        <div class="state">${taskState}</div>
        <div class="count">${count}</div>
      </article>
    `)
    .join("");
  elements.summaryCards.innerHTML = cards;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

function renderTaskRows() {
  if (state.filtered.length === 0) {
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="dim">No tasks available.</td>
      </tr>
    `;
    return;
  }
  elements.tableBody.innerHTML = state.filtered.map((task) => {
    const isActive = state.selectedTaskId === task.task_id ? "active" : "";
    return `
      <tr class="${isActive}" data-task-id="${task.task_id}">
        <td>${task.task_id}</td>
        <td>${task.task_type || "-"}</td>
        <td>${task.state}</td>
        <td>${task.attempt}</td>
        <td>${formatTime(task.updated_at || task.created_at)}</td>
      </tr>
    `;
  }).join("");
}

function renderDetail(task, takeover) {
  if (!task) {
    elements.selectedTaskLabel.textContent = "No task selected";
    elements.detailJson.textContent = "Select a task to inspect details.";
    return;
  }
  elements.selectedTaskLabel.textContent = task.task_id;
  const detail = {
    task,
    takeover: takeover || null,
    audit_link: `/audit/events?task_id=${encodeURIComponent(task.task_id)}`
  };
  elements.detailJson.textContent = JSON.stringify(detail, null, 2);
}

function renderFeatureFlags() {
  const flags = state.settings.feature_flags || {};
  const rows = Object.keys(flags)
    .sort()
    .map((flag) => `
      <label class="inline-checkbox">
        <input type="checkbox" data-flag-key="${flag}" ${flags[flag] ? "checked" : ""} />
        ${flag}
      </label>
    `)
    .join("");
  elements.flagsFields.innerHTML = rows || "<p class='dim'>No flags found.</p>";
}

function renderProviderProfiles() {
  const profiles = state.settings.provider_profiles || {};
  elements.profilesBody.innerHTML = PROVIDERS.map((provider) => {
    const profile = profiles[provider] || {};
    return `
      <tr>
        <td>${provider}</td>
        <td>
          <input data-provider="${provider}" data-key="default_model" value="${profile.default_model || ""}" />
        </td>
        <td>
          <input data-provider="${provider}" data-key="cost_per_1k_tokens" value="${profile.cost_per_1k_tokens ?? ""}" />
        </td>
      </tr>
    `;
  }).join("");
}

function renderRbacDefaults() {
  const rbac = state.settings.rbac || {};
  const roles = Array.isArray(rbac.default_roles) ? rbac.default_roles : [];
  elements.rbacEnabled.checked = rbac.rbac_enabled === true;
  elements.roleSuperAdmin.checked = roles.includes("super_admin");
  elements.roleTaskAdmin.checked = roles.includes("task_admin");
  elements.roleReadOnlyAuditor.checked = roles.includes("read_only_auditor");
}

function renderSecrets() {
  const secretsState = state.settings.secrets || {};
  if (!secretsState.available) {
    const reason = secretsState.reason || "SECRET_VAULT_UNAVAILABLE";
    const envName = secretsState.master_key_env || "SECRET_VAULT_MASTER_KEY";
    elements.secretsList.textContent = `Secret vault unavailable (${reason}). Set ${envName} and refresh.`;
    return;
  }
  const lines = (secretsState.secrets || []).map((item) => {
    const updated = item.updated_at ? `updated ${formatTime(item.updated_at)}` : "never set";
    return `${item.name}: ${item.masked_value || "(empty)"} (${updated})`;
  });
  elements.secretsList.textContent = lines.length > 0 ? lines.join("\n") : "No provider secrets found.";
}

async function loadTaskDetail(taskId) {
  if (!taskId) {
    renderDetail(null, null);
    return;
  }
  const taskResponse = await request(`/tasks/${encodeURIComponent(taskId)}`);
  let takeover = null;
  try {
    const takeoverResponse = await request(`/tasks/${encodeURIComponent(taskId)}/takeover`);
    takeover = takeoverResponse.takeover || null;
  } catch {
    takeover = null;
  }
  renderDetail(taskResponse.task, takeover);
}

async function loadTasks() {
  if (state.loading) {
    return;
  }
  state.loading = true;
  try {
    const response = await request("/tasks?limit=200");
    state.tasks = Array.isArray(response.tasks) ? response.tasks : [];
    applyFilter();
    renderSummary();
    renderTaskRows();
    elements.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (!state.selectedTaskId && state.filtered.length > 0) {
      state.selectedTaskId = state.filtered[0].task_id;
    }
    if (state.selectedTaskId) {
      const stillVisible = state.filtered.some((task) => task.task_id === state.selectedTaskId);
      if (!stillVisible && state.filtered.length > 0) {
        state.selectedTaskId = state.filtered[0].task_id;
      }
      if (!stillVisible && state.filtered.length === 0) {
        state.selectedTaskId = "";
      }
      await loadTaskDetail(state.selectedTaskId);
      renderTaskRows();
    } else {
      renderDetail(null, null);
    }
  } catch (error) {
    setBanner(error.message || "Failed to load tasks", "error");
  } finally {
    state.loading = false;
  }
}

function parseFallbackProviders() {
  return String(elements.fallbackInput.value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function submitAction(action) {
  if (!state.selectedTaskId) {
    setBanner("Select a task first.", "error");
    return;
  }
  const payload = {
    action,
    actor: "web-admin",
    metadata: {
      channel: "admin_ui"
    }
  };
  const input = String(elements.actionInput.value || "").trim();
  const provider = String(elements.providerSelect.value || "").trim();
  const fallbackProviders = parseFallbackProviders();
  if (input) {
    payload.input = input;
  }
  if (provider) {
    payload.provider = provider;
  }
  if (fallbackProviders.length > 0) {
    payload.fallback_providers = fallbackProviders;
  }
  try {
    const response = await request(`/tasks/${encodeURIComponent(state.selectedTaskId)}/actions`, "POST", payload);
    const nextState = response.task && response.task.state ? response.task.state : "UNKNOWN";
    setBanner(`Action ${action} succeeded. Task state: ${nextState}`, "ok");
    await loadTasks();
    await loadTaskDetail(state.selectedTaskId);
  } catch (error) {
    const code = error && error.payload && error.payload.error ? error.payload.error : "ACTION_FAILED";
    setBanner(`${action} failed: ${code}`, "error");
  }
}

async function loadSettings() {
  if (state.settingsLoading) {
    return;
  }
  state.settingsLoading = true;
  updateSettingsButtonState(true);
  try {
    const [flags, profiles, rbac, secrets] = await Promise.all([
      request("/settings/feature-flags"),
      request("/settings/provider-profiles"),
      request("/settings/rbac"),
      request("/settings/provider-secrets")
    ]);
    state.settings.feature_flags = flags.feature_flags || {};
    state.settings.provider_profiles = profiles.provider_profiles || {};
    state.settings.rbac = rbac.rbac || {
      rbac_enabled: false,
      default_roles: []
    };
    state.settings.secrets = secrets || {
      available: false,
      master_key_env: "SECRET_VAULT_MASTER_KEY",
      reason: "UNKNOWN",
      secrets: []
    };

    renderFeatureFlags();
    renderProviderProfiles();
    renderRbacDefaults();
    renderSecrets();
    setSettingsStatus(`Settings refreshed ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setSettingsStatus(`Settings load failed: ${error.message}`);
  } finally {
    updateSettingsButtonState(false);
    state.settingsLoading = false;
  }
}

function collectFlagsPayload() {
  const payload = {};
  const inputs = elements.flagsFields.querySelectorAll("input[type='checkbox'][data-flag-key]");
  for (const input of inputs) {
    const key = input.getAttribute("data-flag-key");
    payload[key] = input.checked;
  }
  return payload;
}

function collectProfilesPayload() {
  const payload = {};
  for (const provider of PROVIDERS) {
    const modelInput = elements.profilesBody.querySelector(`input[data-provider='${provider}'][data-key='default_model']`);
    const costInput = elements.profilesBody.querySelector(`input[data-provider='${provider}'][data-key='cost_per_1k_tokens']`);
    payload[provider] = {
      default_model: modelInput ? String(modelInput.value || "").trim() : "",
      cost_per_1k_tokens: Number(costInput ? costInput.value : 0) || 0.02
    };
  }
  return payload;
}

function collectRbacPayload() {
  const roles = [];
  if (elements.roleSuperAdmin.checked) {
    roles.push("super_admin");
  }
  if (elements.roleTaskAdmin.checked) {
    roles.push("task_admin");
  }
  if (elements.roleReadOnlyAuditor.checked) {
    roles.push("read_only_auditor");
  }
  return {
    rbac_enabled: elements.rbacEnabled.checked,
    default_roles: roles
  };
}

async function saveFeatureFlags() {
  try {
    const feature_flags = collectFlagsPayload();
    await request("/settings/feature-flags", "PUT", { feature_flags });
    setBanner("Feature flags saved.", "ok");
    await loadSettings();
  } catch (error) {
    setBanner(`Failed to save feature flags: ${error.message}`, "error");
  }
}

async function saveProviderProfiles() {
  try {
    const provider_profiles = collectProfilesPayload();
    await request("/settings/provider-profiles", "PUT", { provider_profiles });
    setBanner("Provider profiles saved.", "ok");
    await loadSettings();
  } catch (error) {
    setBanner(`Failed to save provider profiles: ${error.message}`, "error");
  }
}

async function saveRbacDefaults() {
  try {
    const rbac = collectRbacPayload();
    await request("/settings/rbac", "PUT", { rbac });
    setBanner("RBAC defaults saved.", "ok");
    await loadSettings();
  } catch (error) {
    setBanner(`Failed to save RBAC defaults: ${error.message}`, "error");
  }
}

async function saveProviderSecret() {
  const name = String(elements.secretName.value || "").trim();
  const value = String(elements.secretValue.value || "");
  if (!name || !value) {
    setBanner("Secret name and value are required.", "error");
    return;
  }
  try {
    await request("/settings/provider-secrets", "POST", {
      name,
      value,
      actor: "web-admin"
    });
    elements.secretValue.value = "";
    setBanner(`${name} updated in secret vault.`, "ok");
    await loadSettings();
  } catch (error) {
    setBanner(`Failed to save secret: ${error.message}`, "error");
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => {
    loadTasks();
    loadSettings();
  });
  elements.stateFilter.addEventListener("change", () => {
    applyFilter();
    renderSummary();
    renderTaskRows();
  });
  elements.searchInput.addEventListener("input", () => {
    applyFilter();
    renderSummary();
    renderTaskRows();
  });
  elements.tableBody.addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-task-id]");
    if (!row) {
      return;
    }
    state.selectedTaskId = row.getAttribute("data-task-id") || "";
    renderTaskRows();
    await loadTaskDetail(state.selectedTaskId);
  });
  for (const button of elements.actionButtons) {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      submitAction(action);
    });
  }
  elements.saveFlagsButton.addEventListener("click", saveFeatureFlags);
  elements.saveProfilesButton.addEventListener("click", saveProviderProfiles);
  elements.saveRbacButton.addEventListener("click", saveRbacDefaults);
  elements.saveSecretButton.addEventListener("click", saveProviderSecret);
}

bindEvents();
loadTasks();
loadSettings();
