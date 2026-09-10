// Trusted host UI only. Never interpolate canvas HTML into this document.
export const sidecarHTML = `
<aside id="agent-panel" aria-label="Agent controls">
  <div class="agent-heading"><strong>Agent</strong><span id="agent-status">connecting</span><button id="agent-refresh" type="button">Refresh</button></div>
  <div id="agent-error" role="alert" hidden></div>
  <label>Agent / mode<select id="agent-select"></select></label>
  <label>Model<select id="model-select"></select></label>
  <details><summary>Commands and subagents</summary>
    <label>Command<select id="command-select"></select></label>
    <label>Arguments<input id="command-arguments"></label><button id="command-run" type="button">Run command</button>
    <div id="agent-children"></div>
  </details>
  <label class="reasoning-label"><input id="agent-reasoning" type="checkbox"> Show reasoning</label>
  <div id="agent-history" aria-label="Session history"></div>
  <form id="agent-prompt-form"><label>Prompt<textarea id="agent-prompt" required placeholder="Send the next instruction…"></textarea></label>
    <div class="agent-actions"><button type="button" id="agent-abort">Abort</button><button type="submit">Send</button></div>
  </form>
  <dialog id="agent-abort-dialog"><p>Abort the active turn for this session?</p><button id="agent-abort-cancel" type="button">Keep running</button><button id="agent-abort-confirm" type="button">Abort turn</button></dialog>
</aside>`

export const sidecarCSS = `
  #workspace { display: flex; align-items: stretch; height: calc(100dvh - 48px); min-width: 0; }
  #workspace > #session-drawer { position: static; inset: auto; flex: 0 0 220px; width: 220px; height: auto; transform: none; visibility: visible; box-shadow: none; transition: none; backdrop-filter: none; display: none; }
  #workspace > #session-drawer.open { display: block; }
  #drawer-backdrop { display: none; }
  body.drawer-open { overflow: auto; }
  #canvas-workspace { flex: 1; min-width: 0; overflow: auto; }
  body > header h1 { flex-shrink: 0; }
  #canvas-tabs { display: flex; flex: 1; min-width: 0; gap: 6px; padding-left: 10px; overflow-x: auto; border-left: 1px solid var(--edge); scrollbar-width: thin; }
  #canvas-tabs:empty { display: none; }
  #canvas-tabs button { flex-shrink: 0; height: 32px; padding: 5px 10px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #canvas-tabs button[aria-selected="true"] { border-color: #9ee6c2; color: #9ee6c2; }
  #main { min-height: calc(100dvh - 48px); }
  #main iframe, #main .empty { min-height: calc(100dvh - 48px); }
  #agent-panel { flex: 0 0 340px; width: 340px; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-right: 1px solid var(--edge); background: #0c0d0f; overflow: auto; }
  #agent-panel[hidden] { display: none; }
  .agent-heading, .agent-actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  #agent-status { color: var(--muted); font-size: 11px; }
  #agent-panel label { display: grid; gap: 4px; color: #a1a1a8; font-size: 11px; }
  #agent-panel select, #agent-panel input, #agent-panel textarea { width: 100%; min-width: 0; padding: 8px; color: var(--ink); background: #15171a; border: 1px solid #303238; border-radius: 6px; font: inherit; }
  #agent-panel textarea { min-height: 90px; resize: vertical; }
  #agent-panel .reasoning-label { display: flex; align-items: center; }
  #agent-reasoning { width: auto !important; }
  #agent-panel summary { cursor: pointer; color: #a1a1a8; }
  #agent-history { flex: 1 0 160px; overflow: auto; min-height: 160px; }
  #agent-history article { margin-bottom: 10px; border: 1px solid #282b30; border-radius: 8px; padding: 10px; overflow-wrap: anywhere; }
  #agent-history p, #agent-history pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace, monospace; }
  #agent-history pre { max-height: 280px; overflow: auto; }
  #agent-history h3 { margin: 0; font-size: 11px; color: #9ee6c2; }
  #agent-error { color: #ffb5ae; border: 1px solid #6b302d; padding: 8px; }
  #agent-prompt-form { display: grid; gap: 8px; }
  #agent-abort-dialog { max-width: calc(100vw - 24px); background: #15171a; color: var(--ink); border: 1px solid #34373d; border-radius: 10px; }
  #agent-abort-dialog::backdrop { background: #000a; }
  @media (max-width: 900px) { #workspace > #session-drawer { flex-basis: 180px; width: 180px; } #agent-panel { flex-basis: 300px; width: 300px; } }
  @media (max-width: 700px) {
    #workspace { height: auto; min-height: calc(100dvh - 48px); flex-wrap: wrap; }
    #workspace > #session-drawer { flex: 1 0 100%; width: 100%; max-height: 220px; border-bottom: 1px solid var(--edge); }
    #agent-panel { flex: 1 0 100%; width: 100%; max-height: 70dvh; border-bottom: 1px solid var(--edge); }
    #canvas-workspace { flex: 1 0 100%; width: 100%; }
  }
`

// Runs inside the shell closure; hostCall never becomes a window/iframe API.
export const sidecarScript = `
  var hostRequests = new Map();
  var hostSequence = 0;
  function hostCall(action, payload) {
    return new Promise(function (resolve, reject) {
      var id = "host:" + (++hostSequence);
      var timer = setTimeout(function () { hostRequests.delete(id); reject(new Error("Agent request timed out.")); }, 15000);
      hostRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      if (!safeSend({ type: "host-controller", id: id, action: action, payload: payload || {} })) {
        clearTimeout(timer); hostRequests.delete(id); reject(new Error("Panel is offline."));
      }
    });
  }
  var agentPanel = document.getElementById("agent-panel");
  var agentToggle = document.getElementById("agent-toggle");
  agentToggle.addEventListener("click", function () {
    agentPanel.hidden = !agentPanel.hidden;
    agentToggle.setAttribute("aria-expanded", String(!agentPanel.hidden));
  });
  var agentSelect = document.getElementById("agent-select");
  var modelSelect = document.getElementById("model-select");
  var commandSelect = document.getElementById("command-select");
  var promptInput = document.getElementById("agent-prompt");
  var argumentsInput = document.getElementById("command-arguments");
  var historyBox = document.getElementById("agent-history");
  var errorBox = document.getElementById("agent-error");
  var reasoningInput = document.getElementById("agent-reasoning");
  var snapshot = null, refreshing = false, acting = false;
  function hostError(error) { errorBox.textContent = String(error.message || error); errorBox.hidden = false; }
  function node(tag, value) { var result = document.createElement(tag); if (value != null) result.textContent = String(value); return result; }
  function options(select, items, fallback, label) {
    var value = select.dataset.chosen === "true" ? select.value : fallback || "";
    select.replaceChildren();
    var empty = node("option", label); empty.value = ""; select.append(empty);
    items.forEach(function (item) { var option = node("option", item.label); option.value = item.value; option.disabled = !!item.disabled; select.append(option); });
    select.value = value;
  }
  [agentSelect, modelSelect, commandSelect].forEach(function (select) { select.addEventListener("change", function () { select.dataset.chosen = "true"; }); });
  function selection() { var pieces = modelSelect.value.split("/"); return { agent: agentSelect.value, providerID: pieces.shift() || "", modelID: pieces.join("/") }; }
  function renderHistory() {
    if (!snapshot) return;
    var previous = historyBox.scrollTop;
    var atBottom = historyBox.scrollHeight - historyBox.clientHeight - previous < 40;
    historyBox.replaceChildren();
    if (!snapshot.messages.length) historyBox.append(node("p", "No history yet. Send a prompt to begin."));
    snapshot.messages.forEach(function (message) {
      var card = node("article"); card.append(node("h3", message.role + " · " + (message.agent || "default") + " · " + (message.model.modelID || "default model")));
      message.parts.forEach(function (part) {
        if (part.type === "text") card.append(node("p", part.text));
        else if (part.type === "reasoning") { if (reasoningInput.checked) card.append(node("pre", part.text)); }
        else if (part.type === "tool") { var detail = node("details"); detail.append(node("summary", part.tool + " · " + part.state.status)); detail.append(node("pre", [part.state.input, part.state.output, part.state.error].filter(Boolean).join("\\n"))); card.append(detail); }
        else card.append(node("pre", JSON.stringify(part, null, 2)));
      });
      if (message.error) card.append(node("pre", message.error));
      historyBox.append(card);
    });
    historyBox.scrollTop = atBottom ? historyBox.scrollHeight : previous;
  }
  async function refreshAgent() {
    if (!currentSession || refreshing || acting || !ws || ws.readyState !== WebSocket.OPEN) return;
    refreshing = true;
    try {
      snapshot = await hostCall("snapshot");
      document.getElementById("agent-status").textContent = snapshot.status.type || snapshot.status || "unknown";
      options(agentSelect, snapshot.agents.map(function (item) { return { value: item.name, label: item.name + " [" + item.mode + "]" }; }), snapshot.selection.agent, "Default agent");
      var models = [];
      snapshot.providers.forEach(function (provider) { provider.models.forEach(function (model) { models.push({ value: provider.id + "/" + model.id, label: provider.name + " / " + model.name, disabled: !provider.connected }); }); });
      options(modelSelect, models, snapshot.selection.model.providerID + "/" + snapshot.selection.model.modelID, "Default model");
      options(commandSelect, snapshot.commands.map(function (item) { return { value: item.name, label: "/" + item.name }; }), "", "Select command");
      document.getElementById("agent-children").replaceChildren(...snapshot.children.map(function (item) { return node("p", item.title + " · " + item.status.type); }));
      renderHistory();
    } catch (error) { hostError(error); } finally { refreshing = false; }
  }
  async function act(action, payload, clear) {
    if (acting) return;
    acting = true; errorBox.hidden = true;
    try { await hostCall(action, payload); if (clear) clear(); }
    catch (error) { hostError(error); }
    finally { acting = false; }
  }
  document.getElementById("agent-refresh").addEventListener("click", refreshAgent);
  reasoningInput.addEventListener("change", renderHistory);
  document.getElementById("agent-prompt-form").addEventListener("submit", function (event) {
    event.preventDefault(); var value = promptInput.value; if (!value.trim()) return;
    act("prompt", Object.assign({ prompt: value }, selection()), function () { if (promptInput.value === value) promptInput.value = ""; });
  });
  document.getElementById("command-run").addEventListener("click", function () {
    if (!commandSelect.value) return; var value = argumentsInput.value;
    act("command", Object.assign({ command: commandSelect.value, arguments: value }, selection()), function () { if (argumentsInput.value === value) argumentsInput.value = ""; });
  });
  var abortDialog = document.getElementById("agent-abort-dialog");
  document.getElementById("agent-abort").addEventListener("click", function () { abortDialog.showModal(); });
  document.getElementById("agent-abort-cancel").addEventListener("click", function () { abortDialog.close(); });
  document.getElementById("agent-abort-confirm").addEventListener("click", function () { abortDialog.close(); act("abort", {}); });
  setInterval(refreshAgent, 2000);
`
