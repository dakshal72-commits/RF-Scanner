const STORAGE_KEY = "rf-stock-move-draft-v1";
const HISTORY_KEY = "rf-stock-move-history-v1";
const SYNC_QUEUE_KEY = "rf-stock-move-sync-queue-v1";
const MASTER_DATA_KEY = "rf-stock-move-master-data-v1";
const SUPABASE_URL = window.RF_CONFIG?.supabaseUrl;
const SUPABASE_KEY = window.RF_CONFIG?.supabasePublishableKey;
let connectionHealthy = navigator.onLine;
let offlineReady = false;

const state = {
  sourceBin: "",
  destinationBin: "",
  items: [],
  currentStep: "source",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  stockWorkspace: $("#stock-workspace"),
  sourceStep: $("#source-step"),
  itemsStep: $("#items-step"),
  destinationStep: $("#destination-step"),
  reviewStep: $("#review-step"),
  successStep: $("#success-step"),
  sourceBin: $("#source-bin"),
  destinationBin: $("#destination-bin"),
  sku: $("#sku"),
  quantity: $("#quantity"),
  bucketList: $("#bucket-list"),
  emptyBucket: $("#empty-bucket"),
  itemError: $("#item-error"),
  destinationError: $("#destination-error"),
  continueButton: $("#continue-destination"),
  draftStatus: $("#draft-status"),
  notice: $("#notice"),
  activeSourceBin: $("#active-source-bin"),
  iosInstallTip: $("#ios-install-tip"),
  connectionStatus: $("#connection-status"),
  retrySync: $("#retry-sync"),
};

function normalize(value) {
  return value.trim().toUpperCase();
}

async function readSupabase(table, query) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Database configuration is missing.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!response.ok) throw new Error("Warehouse database could not be reached.");
    connectionHealthy = true;
    updateConnectionStatus();
    return response.json();
  } catch {
    connectionHealthy = false;
    updateConnectionStatus();
    throw new Error("Warehouse database could not be reached.");
  } finally {
    window.clearTimeout(timeout);
  }
}

function getMasterData() {
  try {
    return JSON.parse(localStorage.getItem(MASTER_DATA_KEY)) || { bins: [], items: [], inventory: [] };
  } catch {
    return { bins: [], items: [], inventory: [] };
  }
}

async function refreshMasterData() {
  try {
    const [bins, items, inventory] = await Promise.all([
      readSupabase("bins", "active=eq.true&select=id"),
      readSupabase("items", "active=eq.true&select=sku,description,unit"),
      readSupabase("inventory", "select=bin_id,sku,quantity"),
    ]);
    localStorage.setItem(MASTER_DATA_KEY, JSON.stringify({ bins, items, inventory, cachedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

async function findBin(binId) {
  try {
    const rows = await readSupabase("bins", `id=eq.${encodeURIComponent(binId)}&active=eq.true&select=id&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = getMasterData().bins.find((bin) => bin.id === binId);
    if (cached) return cached;
    throw error;
  }
}

async function findItem(sku) {
  try {
    const rows = await readSupabase("items", `sku=eq.${encodeURIComponent(sku)}&active=eq.true&select=sku,description,unit&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = getMasterData().items.find((item) => item.sku === sku);
    if (cached) return cached;
    throw error;
  }
}

async function findInventory(binId, sku) {
  try {
    const rows = await readSupabase("inventory", `bin_id=eq.${encodeURIComponent(binId)}&sku=eq.${encodeURIComponent(sku)}&select=quantity&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = getMasterData().inventory.find((row) => row.bin_id === binId && row.sku === sku);
    if (cached) return cached;
    throw error;
  }
}

function showMessage(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, 2600);
}

function showFieldError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearFieldError(element) {
  element.textContent = "";
  element.hidden = true;
}

async function setSourceBin() {
  const source = normalize(elements.sourceBin.value);
  if (!source) {
    showMessage("Scan or enter a source bin first.");
    elements.sourceBin.focus();
    return;
  }
  const button = $("#set-source");
  button.disabled = true;
  button.textContent = "Checking bin...";
  try {
    if (!await findBin(source)) {
      showMessage(`${source} is not a valid active bin.`);
      elements.sourceBin.focus();
      elements.sourceBin.select();
      return;
    }
  } catch (error) {
    showMessage(error.message);
    return;
  } finally {
    button.disabled = false;
    button.textContent = "Continue";
  }

  state.sourceBin = source;
  elements.activeSourceBin.textContent = source;
  elements.sourceBin.value = source;
  elements.sourceBin.readOnly = true;
  markDraftChanged();
  renderBucket();
  showStep("items");
  window.setTimeout(() => elements.sku.focus(), 150);
}

async function addItem(event) {
  event.preventDefault();
  clearFieldError(elements.itemError);

  if (!state.sourceBin) {
    showFieldError(elements.itemError, "Set the source bin before adding an item.");
    elements.sourceBin.focus();
    return;
  }

  const sku = normalize(elements.sku.value);
  const quantity = Number(elements.quantity.value);

  if (!sku) {
    showFieldError(elements.itemError, "Scan or enter a SKU.");
    elements.sku.focus();
    return;
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    showFieldError(elements.itemError, "Quantity must be a whole number greater than zero.");
    elements.quantity.focus();
    return;
  }

  const submitButton = event.submitter || $("#item-form button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "Checking inventory...";
  let itemRecord;
  let inventoryRecord;
  try {
    [itemRecord, inventoryRecord] = await Promise.all([
      findItem(sku),
      findInventory(state.sourceBin, sku),
    ]);
  } catch (error) {
    showFieldError(elements.itemError, error.message);
    return;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Add to transfer bucket";
  }

  if (!itemRecord) {
    showFieldError(elements.itemError, `${sku} is not a valid active SKU.`);
    elements.sku.focus();
    elements.sku.select();
    return;
  }
  if (!inventoryRecord) {
    showFieldError(elements.itemError, `${sku} is not stocked in ${state.sourceBin}.`);
    elements.sku.focus();
    elements.sku.select();
    return;
  }

  const existing = state.items.find((item) => item.sku === sku);
  const requestedTotal = quantity + (existing?.quantity || 0);
  if (requestedTotal > inventoryRecord.quantity) {
    showFieldError(elements.itemError, `Only ${inventoryRecord.quantity} units of ${sku} are available in ${state.sourceBin}.`);
    elements.quantity.focus();
    elements.quantity.select();
    return;
  }

  if (existing) {
    existing.quantity += quantity;
    existing.available = inventoryRecord.quantity;
    showMessage(`${sku} already existed, so the quantity was combined.`);
  } else {
    state.items.push({
      id: crypto.randomUUID(),
      sku,
      quantity,
      available: inventoryRecord.quantity,
      description: itemRecord.description,
      unit: itemRecord.unit,
    });
  }

  elements.sku.value = "";
  elements.quantity.value = "";
  markDraftChanged();
  renderBucket();
  elements.sku.focus();
}

function updateItem(id, value) {
  const quantity = Number(value);
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  if (!Number.isInteger(quantity) || quantity < 1) {
    renderBucket();
    showMessage("Quantity must remain a whole number greater than zero.");
    return;
  }
  if (Number.isInteger(item.available) && quantity > item.available) {
    renderBucket();
    showMessage(`Only ${item.available} units of ${item.sku} are available.`);
    return;
  }
  item.quantity = quantity;
  markDraftChanged();
  renderBucket();
}

function removeItem(id) {
  state.items = state.items.filter((item) => item.id !== id);
  markDraftChanged();
  renderBucket();
}

function totalQuantity() {
  return state.items.reduce((sum, item) => sum + item.quantity, 0);
}

function renderBucket() {
  elements.bucketList.innerHTML = "";
  const hasItems = state.items.length > 0;
  elements.emptyBucket.hidden = hasItems;
  elements.bucketList.hidden = !hasItems;

  state.items.forEach((item) => {
    const fragment = $("#bucket-item-template").content.cloneNode(true);
    fragment.querySelector(".item-sku").textContent = item.sku;
    fragment.querySelector(".item-meta").textContent = Number.isInteger(item.available)
      ? `${item.available} units available`
      : `Source ${state.sourceBin || "not set"}`;
    const quantityInput = fragment.querySelector(".item-quantity");
    quantityInput.value = item.quantity;
    const editButton = fragment.querySelector(".edit-item");
    editButton.addEventListener("click", () => {
      if (quantityInput.readOnly) {
        quantityInput.readOnly = false;
        editButton.textContent = "Save qty";
        quantityInput.focus();
        quantityInput.select();
        return;
      }
      updateItem(item.id, quantityInput.value);
    });
    quantityInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !quantityInput.readOnly) updateItem(item.id, quantityInput.value);
    });
    fragment.querySelector(".remove-item").addEventListener("click", () => removeItem(item.id));
    elements.bucketList.append(fragment);
  });

  $("#bucket-count").textContent = `${state.items.length} ${state.items.length === 1 ? "item" : "items"}`;
  elements.continueButton.disabled = !state.sourceBin || !hasItems;
}

function markDraftChanged() {
  elements.draftStatus.textContent = "Unsaved changes";
  elements.draftStatus.classList.remove("is-saved");
}

function saveDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    sourceBin: state.sourceBin,
    destinationBin: state.destinationBin,
    items: state.items,
  }));
  elements.draftStatus.textContent = "Draft saved";
  elements.draftStatus.classList.add("is-saved");
  showMessage("Draft saved on this device.");
}

function loadDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    state.sourceBin = draft.sourceBin || "";
    state.destinationBin = draft.destinationBin || "";
    state.items = Array.isArray(draft.items) ? draft.items : [];
    elements.sourceBin.value = state.sourceBin;
    elements.activeSourceBin.textContent = state.sourceBin || "Not set";
    elements.sourceBin.readOnly = Boolean(state.sourceBin);
    elements.destinationBin.value = state.destinationBin;
    elements.draftStatus.textContent = "Draft restored";
    elements.draftStatus.classList.add("is-saved");
    renderBucket();
    showMessage("Saved transfer restored.");
    if (state.sourceBin) showStep("items");
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function showStep(step) {
  state.currentStep = step;
  elements.stockWorkspace.hidden = !["source", "items"].includes(step);
  elements.sourceStep.hidden = step !== "source";
  elements.itemsStep.hidden = step !== "items";
  elements.destinationStep.hidden = step !== "destination";
  elements.reviewStep.hidden = step !== "review";
  elements.successStep.hidden = step !== "success";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goToSource() {
  elements.sourceBin.readOnly = false;
  showStep("source");
  window.setTimeout(() => {
    elements.sourceBin.focus();
    elements.sourceBin.select();
  }, 150);
}

function goToDestination() {
  if (!state.sourceBin || state.items.length === 0) return;
  showStep("destination");
  window.setTimeout(() => elements.destinationBin.focus(), 150);
}

async function prepareReview() {
  clearFieldError(elements.destinationError);
  const destination = normalize(elements.destinationBin.value);
  if (!destination) {
    showFieldError(elements.destinationError, "Scan or enter a destination bin.");
    elements.destinationBin.focus();
    return;
  }
  if (destination === state.sourceBin) {
    showFieldError(elements.destinationError, "Destination bin must be different from the source bin.");
    elements.destinationBin.focus();
    return;
  }

  const button = $("#review-transfer");
  button.disabled = true;
  button.textContent = "Checking bin...";
  try {
    if (!await findBin(destination)) {
      showFieldError(elements.destinationError, `${destination} is not a valid active bin.`);
      elements.destinationBin.focus();
      elements.destinationBin.select();
      return;
    }
  } catch (error) {
    showFieldError(elements.destinationError, error.message);
    return;
  } finally {
    button.disabled = false;
    button.textContent = "Review transfer";
  }

  state.destinationBin = destination;
  elements.destinationBin.value = destination;
  $("#review-source").textContent = state.sourceBin;
  $("#review-destination").textContent = state.destinationBin;
  $("#review-items").innerHTML = state.items
    .map((item) => `<div class="review-row"><strong>${escapeHtml(item.sku)}</strong><span>Qty ${item.quantity}</span></div>`)
    .join("");
  markDraftChanged();
  showStep("review");
}

function getSyncQueue() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveSyncQueue(queue) {
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const pending = getSyncQueue().length;
  const online = navigator.onLine && connectionHealthy;
  elements.connectionStatus.classList.toggle("is-offline", !online);
  elements.connectionStatus.classList.toggle("has-pending", pending > 0);
  elements.connectionStatus.textContent = !online
    ? `Offline${pending ? ` • ${pending} waiting` : ""}`
    : pending
      ? `Online • ${pending} waiting`
      : offlineReady
        ? "Online • Offline ready"
        : "Online • Preparing offline";
  elements.retrySync.hidden = pending === 0;
}

function updateHistorySyncStatus(clientId, syncStatus) {
  const history = getHistory();
  const transfer = history.find((entry) => entry.clientId === clientId);
  if (transfer) transfer.syncStatus = syncStatus;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

async function sendTransfer(transfer) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Database configuration is missing.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_stock_transfer`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        p_client_id: transfer.clientId,
        p_reference: transfer.reference,
        p_source_bin: transfer.sourceBin,
        p_destination_bin: transfer.destinationBin,
        p_items: transfer.items.map((item) => ({ sku: item.sku, quantity: item.quantity })),
        p_completed_at: transfer.completedAt,
      }),
    });
    if (!response.ok) throw new Error("Transfer could not be synced.");
    connectionHealthy = true;
  } catch {
    connectionHealthy = false;
    throw new Error("Transfer could not be synced.");
  } finally {
    window.clearTimeout(timeout);
  }
}

async function syncQueue({ announce = false } = {}) {
  if (!navigator.onLine) {
    updateConnectionStatus();
    if (announce) showMessage("Still offline. The transfer remains safely queued.");
    return;
  }
  const queue = getSyncQueue();
  if (!queue.length) {
    updateConnectionStatus();
    return;
  }
  elements.connectionStatus.textContent = `Syncing ${queue.length}...`;
  const remaining = [];
  let synced = 0;
  for (const transfer of queue) {
    try {
      await sendTransfer(transfer);
      updateHistorySyncStatus(transfer.clientId, "synced");
      synced += 1;
    } catch {
      remaining.push(transfer);
      updateHistorySyncStatus(transfer.clientId, "waiting");
    }
  }
  saveSyncQueue(remaining);
  if (synced) void refreshMasterData();
  if (announce || synced) {
    showMessage(remaining.length
      ? `${synced} synced. ${remaining.length} still waiting.`
      : `${synced} pending ${synced === 1 ? "transfer" : "transfers"} synced.`);
  }
}

function confirmTransfer() {
  const completedAt = new Date();
  const reference = `BT-${completedAt.getFullYear()}-${String(Date.now()).slice(-6)}`;
  const transfer = {
    clientId: crypto.randomUUID(),
    reference,
    sourceBin: state.sourceBin,
    destinationBin: state.destinationBin,
    items: state.items,
    totalQuantity: totalQuantity(),
    completedAt: completedAt.toISOString(),
    syncStatus: "waiting",
  };
  const history = getHistory();
  history.unshift(transfer);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
  const queue = getSyncQueue();
  queue.push(transfer);
  saveSyncQueue(queue);
  localStorage.removeItem(STORAGE_KEY);
  $("#success-reference").textContent = `${reference} • Saved safely${navigator.onLine && connectionHealthy ? " and syncing" : " offline"}`;
  renderHistory();
  showStep("success");
  void syncQueue();
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const history = getHistory();
  const list = $("#history-list");
  $("#history-count").textContent = `${history.length} saved`;
  if (!history.length) {
    list.innerHTML = '<p class="history-empty">No transfers have been completed on this device.</p>';
    return;
  }
  list.innerHTML = history.map((transfer) => {
    const date = new Date(transfer.completedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const items = Array.isArray(transfer.items) ? transfer.items : [];
    const itemRows = items.map((item) => `<li>
      <strong>${escapeHtml(item.sku)}</strong>
      <span>Qty ${Number(item.quantity) || 0}</span>
    </li>`).join("");
    const syncStatus = transfer.syncStatus === "synced" ? "Synced" : transfer.syncStatus === "waiting" ? "Waiting to sync" : "Device only";
    return `<details class="history-card">
      <summary>
        <span class="history-transfer"><strong>${escapeHtml(transfer.reference)}</strong><span>${escapeHtml(transfer.sourceBin)} → ${escapeHtml(transfer.destinationBin)} • ${items.length} ${items.length === 1 ? "item" : "items"}</span><span class="sync-state ${syncStatus === "Waiting to sync" ? "is-pending" : ""}">${syncStatus}</span></span>
        <span class="history-date">${escapeHtml(date)}</span>
      </summary>
      <div class="history-details">
        <p>Items moved</p>
        <ul>${itemRows || "<li>No item details saved.</li>"}</ul>
      </div>
    </details>`;
  }).join("");
}

function resetTransfer() {
  Object.assign(state, { sourceBin: "", destinationBin: "", items: [], currentStep: "source" });
  localStorage.removeItem(STORAGE_KEY);
  elements.sourceBin.value = "";
  elements.activeSourceBin.textContent = "Not set";
  elements.sourceBin.readOnly = false;
  elements.destinationBin.value = "";
  elements.sku.value = "";
  elements.quantity.value = "";
  elements.draftStatus.textContent = "Not saved";
  elements.draftStatus.classList.remove("is-saved");
  clearFieldError(elements.itemError);
  clearFieldError(elements.destinationError);
  renderBucket();
  showStep("source");
  elements.sourceBin.focus();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;

  const lifecycle = new AbortController();
  const reportRegistrationError = (error) => console.warn("WebMCP tool registration failed", error);

  try {
    void Promise.resolve(context.registerTool({
      name: "stage_stock_transfer",
      title: "Stage stock transfer",
      description: "Populate the visible RF workflow with a source bin, destination bin, and one or more SKU quantities, then open the review step without completing the transfer.",
      inputSchema: {
        type: "object",
        properties: {
          sourceBin: { type: "string", minLength: 1 },
          destinationBin: { type: "string", minLength: 1 },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                sku: { type: "string", minLength: 1 },
                quantity: { type: "integer", minimum: 1 },
              },
              required: ["sku", "quantity"],
              additionalProperties: false,
            },
          },
        },
        required: ["sourceBin", "destinationBin", "items"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const sourceBin = normalize(input?.sourceBin || "");
        const destinationBin = normalize(input?.destinationBin || "");
        const items = Array.isArray(input?.items) ? input.items : [];
        if (!sourceBin || !destinationBin || sourceBin === destinationBin) {
          throw new Error("Source and destination bins are required and must be different.");
        }
        if (!items.length || items.some((item) => !normalize(item?.sku || "") || !Number.isInteger(item?.quantity) || item.quantity < 1)) {
          throw new Error("At least one valid SKU and whole-number quantity is required.");
        }

        state.sourceBin = sourceBin;
        state.destinationBin = destinationBin;
        state.items = items.map((item) => ({
          id: crypto.randomUUID(),
          sku: normalize(item.sku),
          quantity: item.quantity,
        }));
        elements.sourceBin.value = sourceBin;
        elements.sourceBin.readOnly = true;
        elements.destinationBin.value = destinationBin;
        renderBucket();
        prepareReview();
        return { status: "staged", sourceBin, destinationBin, itemCount: state.items.length, totalQuantity: totalQuantity() };
      },
    }, { signal: lifecycle.signal })).catch(reportRegistrationError);

    void Promise.resolve(context.registerTool({
      name: "complete_staged_transfer",
      title: "Complete staged transfer",
      description: "Confirm the transfer currently shown in the review step and add it to device-local transfer history.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute() {
        if (state.currentStep !== "review" || !state.sourceBin || !state.destinationBin || !state.items.length) {
          throw new Error("No valid transfer is currently staged for confirmation.");
        }
        confirmTransfer();
        return { status: "completed", sourceBin: state.sourceBin, destinationBin: state.destinationBin };
      },
    }, { signal: lifecycle.signal })).catch(reportRegistrationError);
  } catch (error) {
    reportRegistrationError(error);
  }
}

$("#set-source").addEventListener("click", setSourceBin);
elements.sourceBin.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !elements.sourceBin.readOnly) setSourceBin();
});
$("#item-form").addEventListener("submit", addItem);
$("#save-draft").addEventListener("click", saveDraft);
elements.continueButton.addEventListener("click", goToDestination);
$("#review-transfer").addEventListener("click", prepareReview);
elements.destinationBin.addEventListener("keydown", (event) => {
  if (event.key === "Enter") prepareReview();
});
$("#confirm-transfer").addEventListener("click", confirmTransfer);
$("#start-another").addEventListener("click", resetTransfer);
$$('[data-back="source"]').forEach((button) => button.addEventListener("click", goToSource));
$$('[data-back="items"]').forEach((button) => button.addEventListener("click", () => showStep("items")));
$$('[data-back="destination"]').forEach((button) => button.addEventListener("click", () => showStep("destination")));
$("#clear-history").addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  showMessage("Transfer history cleared.");
});
elements.retrySync.addEventListener("click", () => void syncQueue({ announce: true }));
window.addEventListener("online", () => {
  connectionHealthy = true;
  updateConnectionStatus();
  void refreshMasterData();
  void syncQueue({ announce: true });
});
window.addEventListener("offline", () => {
  connectionHealthy = false;
  updateConnectionStatus();
});
window.addEventListener("focus", () => void syncQueue());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void syncQueue();
});

async function initializeOfflineSupport() {
  const dataRefreshed = await refreshMasterData();
  const cached = getMasterData();
  const dataReady = dataRefreshed || (cached.bins.length > 0 && cached.items.length > 0 && cached.inventory.length > 0);
  let workerReady = false;
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("service-worker.js?v=3");
      await navigator.serviceWorker.ready;
      workerReady = true;
    } catch {
      workerReady = false;
    }
  }
  offlineReady = dataReady && workerReady;
  updateConnectionStatus();
}

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
elements.iosInstallTip.hidden = !isIos || isStandalone;

window.setInterval(() => {
  if (getSyncQueue().length) void syncQueue();
}, 15000);

renderBucket();
renderHistory();
loadDraft();
registerWebMcpTools();
updateConnectionStatus();
void initializeOfflineSupport();
void syncQueue();
