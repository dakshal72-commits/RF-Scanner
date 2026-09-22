const STORAGE_KEY = "rf-stock-move-draft-v1";
const HISTORY_KEY = "rf-stock-move-history-v1";
const SYNC_QUEUE_KEY = "rf-stock-move-sync-queue-v1";
const CONFLICT_KEY = "rf-stock-move-conflicts-v1";
const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
const SNAPSHOT_PAGE_SIZE = 500;
const SNAPSHOT_DB_NAME = "rf-stock-move-snapshot-v2";
const SUPABASE_URL = window.RF_CONFIG?.supabaseUrl;
const SUPABASE_KEY = window.RF_CONFIG?.supabasePublishableKey;
let connectionHealthy = navigator.onLine;
let offlineReady = false;
let syncInProgress = false;
let snapshotRefresh = null;
let snapshotMeta = { cursor: 0, cachedAt: null, ready: false };
const lookup = new Map();

const state = {
  sourceBin: "",
  items: [],
  selectedItemId: "",
  lastTransferClientId: "",
  currentStep: "source",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  stockWorkspace: $("#stock-workspace"),
  sourceStep: $("#source-step"),
  itemsStep: $("#items-step"),
  scanStep: $("#scan-step"),
  destinationStep: $("#destination-step"),
  successStep: $("#success-step"),
  sourceBin: $("#source-bin"),
  scanSku: $("#scan-bucket-sku"),
  destinationBin: $("#destination-bin"),
  moveQuantity: $("#move-quantity"),
  sku: $("#sku"),
  quantity: $("#quantity"),
  bucketList: $("#bucket-list"),
  emptyBucket: $("#empty-bucket"),
  itemError: $("#item-error"),
  scanError: $("#scan-error"),
  destinationError: $("#destination-error"),
  continueButton: $("#continue-destination"),
  draftStatus: $("#draft-status"),
  notice: $("#notice"),
  activeSourceBin: $("#active-source-bin"),
  iosInstallTip: $("#ios-install-tip"),
  connectionStatus: $("#connection-status"),
  retrySync: $("#retry-sync"),
  snapshotStatus: $("#snapshot-status"),
};

function normalize(value) {
  return value.trim().toUpperCase();
}

async function readSupabase(table, query, timeoutMs = 4000) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Database configuration is missing.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
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

function openSnapshotDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("records");
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const snapshotDb = openSnapshotDb().catch(() => null);

async function readSnapshotMeta() {
  const db = await snapshotDb;
  if (!db) return snapshotMeta;
  return new Promise((resolve, reject) => {
    const request = db.transaction("meta", "readonly").objectStore("meta").get("snapshot");
    request.onsuccess = () => resolve(request.result || snapshotMeta);
    request.onerror = () => reject(request.error);
  });
}

async function readSnapshot(kind, key) {
  const cacheKey = `${kind}:${key}`;
  if (lookup.has(cacheKey)) return lookup.get(cacheKey);
  const db = await snapshotDb;
  if (!db) return null;
  const row = await new Promise((resolve, reject) => {
    const request = db.transaction("records", "readonly").objectStore("records").get(cacheKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  if (lookup.size >= 500) lookup.delete(lookup.keys().next().value);
  lookup.set(cacheKey, row);
  return row;
}

async function applySnapshotPage(rows) {
  const db = await snapshotDb;
  if (!db) throw new Error("Offline storage is unavailable on this device.");
  const cursor = rows.at(-1)?.version ?? snapshotMeta.cursor;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(["records", "meta"], "readwrite");
    const records = transaction.objectStore("records");
    for (const row of rows) {
      const key = `${row.kind}:${row.record_key}`;
      if (row.payload === null) records.delete(key);
      else records.put(row.payload, key);
    }
    transaction.objectStore("meta").put({ ...snapshotMeta, cursor }, "snapshot");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  snapshotMeta.cursor = cursor;
  for (const row of rows) lookup.delete(`${row.kind}:${row.record_key}`);
}

async function markSnapshotReady() {
  const db = await snapshotDb;
  if (!db) throw new Error("Offline storage is unavailable on this device.");
  const next = { ...snapshotMeta, ready: true, cachedAt: new Date().toISOString() };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("meta", "readwrite");
    transaction.objectStore("meta").put(next, "snapshot");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  snapshotMeta = next;
}

function updateSnapshotStatus() {
  const cachedAt = snapshotMeta.cachedAt;
  if (!cachedAt) {
    elements.snapshotStatus.hidden = false;
    elements.snapshotStatus.textContent = "Preparing offline inventory snapshot. Keep this page open and connected before using it offline.";
    return;
  }
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(cachedAt).getTime()) / 60000));
  elements.snapshotStatus.hidden = false;
  elements.snapshotStatus.classList.toggle("is-stale", !navigator.onLine || ageMinutes >= 30);
  elements.snapshotStatus.textContent = `${navigator.onLine ? "Inventory snapshot" : "Offline inventory snapshot"}: ${ageMinutes < 1 ? "just updated" : `${ageMinutes} min old`}. Transfers are checked against current stock when synced.`;
}

async function refreshMasterData() {
  if (snapshotRefresh) return snapshotRefresh;
  snapshotRefresh = (async () => {
    try {
      if (!await snapshotDb) return false;
      do {
        const rows = await readSupabase("inventory_changes", `version=gt.${snapshotMeta.cursor}&order=version.asc&select=version,kind,record_key,payload&limit=${SNAPSHOT_PAGE_SIZE}`, 20000);
        if (rows.length) await applySnapshotPage(rows);
        if (rows.length < SNAPSHOT_PAGE_SIZE) break;
      } while (true);
      await markSnapshotReady();
      localStorage.removeItem("rf-stock-move-master-data-v1");
      offlineReady = Boolean(navigator.serviceWorker?.controller || offlineReady);
      updateSnapshotStatus();
      updateConnectionStatus();
      return true;
    } catch {
      return false;
    }
  })();
  try { return await snapshotRefresh; }
  finally { snapshotRefresh = null; }
}

async function findBin(binId) {
  try {
    const rows = await readSupabase("bins", `id=eq.${encodeURIComponent(binId)}&active=eq.true&select=id&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = await readSnapshot("bin", binId);
    if (cached) return cached;
    throw error;
  }
}

async function findItem(sku) {
  try {
    const rows = await readSupabase("items", `sku=eq.${encodeURIComponent(sku)}&active=eq.true&select=sku,description,unit&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = await readSnapshot("item", sku);
    if (cached) return cached;
    throw error;
  }
}

async function findInventory(binId, sku) {
  try {
    const rows = await readSupabase("inventory", `bin_id=eq.${encodeURIComponent(binId)}&sku=eq.${encodeURIComponent(sku)}&select=quantity&limit=1`);
    return rows[0] || null;
  } catch (error) {
    const cached = await readSnapshot("inventory", `${binId}|${sku}`);
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
  if (state.items.length && state.sourceBin && source !== state.sourceBin) {
    showMessage("Move or remove bucket items before changing the source bin.");
    elements.sourceBin.value = state.sourceBin;
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
  const pendingUnits = getSyncQueue().reduce((total, transfer) => total + (transfer.sourceBin === state.sourceBin
    ? (transfer.items || []).filter((entry) => entry.sku === sku).reduce((sum, entry) => sum + Number(entry.quantity || 0), 0)
    : 0), 0);
  const available = Math.max(0, inventoryRecord.quantity - pendingUnits);
  if (requestedTotal > available) {
    showFieldError(elements.itemError, `Only ${available} units of ${sku} are available in ${state.sourceBin}.`);
    elements.quantity.focus();
    elements.quantity.select();
    return;
  }

  if (existing) {
    existing.quantity += quantity;
    existing.available = available;
    showMessage(`${sku} already existed, so the quantity was combined.`);
  } else {
    state.items.push({
      id: crypto.randomUUID(),
      sku,
      quantity,
      available,
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

function persistDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    sourceBin: state.sourceBin,
    items: state.items,
  }));
  elements.draftStatus.textContent = "Draft saved";
  elements.draftStatus.classList.add("is-saved");
}

function saveDraft() {
  persistDraft();
  showMessage("Draft saved on this device.");
}

function loadDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    state.sourceBin = draft.sourceBin || "";
    state.items = Array.isArray(draft.items) ? draft.items : [];
    elements.sourceBin.value = state.sourceBin;
    elements.activeSourceBin.textContent = state.sourceBin || "Not set";
    elements.sourceBin.readOnly = Boolean(state.sourceBin);
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
  elements.scanStep.hidden = step !== "scan";
  elements.destinationStep.hidden = step !== "destination";
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

function goToScan() {
  if (!state.sourceBin || state.items.length === 0) return;
  renderScanBucket();
  clearFieldError(elements.scanError);
  showStep("scan");
  window.setTimeout(() => elements.scanSku.focus(), 150);
}

function renderScanBucket() {
  $("#scan-bucket-list").innerHTML = state.items
    .filter((item) => item.quantity > 0)
    .map((item) => `<div class="scan-bucket-row"><strong>${escapeHtml(item.sku)}</strong><span>${item.quantity} units remaining</span></div>`)
    .join("");
}

function selectBucketItem() {
  clearFieldError(elements.scanError);
  const sku = normalize(elements.scanSku.value);
  const item = state.items.find((entry) => entry.sku === sku && entry.quantity > 0);
  if (!item) {
    showFieldError(elements.scanError, "Scan a SKU with quantity remaining in the transfer bucket.");
    elements.scanSku.focus();
    return;
  }
  state.selectedItemId = item.id;
  $("#selected-item-summary").textContent = `${item.sku} • ${item.quantity} units remaining in ${state.sourceBin}`;
  elements.moveQuantity.value = item.quantity;
  elements.moveQuantity.max = item.quantity;
  elements.destinationBin.value = "";
  clearFieldError(elements.destinationError);
  showStep("destination");
  window.setTimeout(() => elements.destinationBin.focus(), 150);
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

function getConflicts() {
  try {
    return JSON.parse(localStorage.getItem(CONFLICT_KEY)) || [];
  } catch {
    return [];
  }
}

function saveConflicts(conflicts) {
  localStorage.setItem(CONFLICT_KEY, JSON.stringify(conflicts));
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const pending = getSyncQueue().length;
  const conflicts = getConflicts().length;
  const online = navigator.onLine && connectionHealthy;
  elements.connectionStatus.classList.toggle("is-offline", !online);
  elements.connectionStatus.classList.toggle("has-pending", pending > 0);
  elements.connectionStatus.classList.toggle("has-conflict", conflicts > 0);
  elements.connectionStatus.textContent = conflicts
    ? `${online ? "Online" : "Offline"} • ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} • ${pending} waiting`
    : !online
    ? `Offline${pending ? ` • ${pending} waiting` : ""}`
    : pending
      ? `Online • ${pending} waiting`
      : offlineReady
        ? "Online • Offline ready"
        : "Online • Preparing offline";
  elements.retrySync.hidden = pending === 0;
}

function updateHistorySyncStatus(clientId, syncStatus, reason = "") {
  const history = getHistory();
  const transfer = history.find((entry) => entry.clientId === clientId);
  if (transfer) {
    transfer.syncStatus = syncStatus;
    transfer.conflictReason = reason;
  }
  if (state.lastTransferClientId === clientId && state.currentStep === "success") {
    $("#success-title").textContent = syncStatus === "synced" ? "Stock moved successfully" : syncStatus === "conflict" ? "Transfer needs attention" : "Transfer saved for sync";
    if (syncStatus === "conflict") $("#success-reference").textContent = `${transfer?.reference || "Transfer"} • Not applied to inventory. Check Recent transfers.`;
    else if (syncStatus === "synced") $("#success-reference").textContent = `${transfer?.reference || "Transfer"} • Synced with warehouse inventory.`;
  }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

async function sendTransfer(transfer) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Database configuration is missing.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_stock_transfer_v2`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
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
    if (!response.ok) {
      let details = {};
      try { details = await response.json(); } catch { /* Keep the HTTP status below. */ }
      const error = new Error(details.message || `Warehouse rejected the transfer (HTTP ${response.status}).`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403;
      throw error;
    }
    const result = await response.json();
    if (result?.status === "conflict") {
      const error = new Error(result.reason || "Warehouse inventory conflict.");
      error.retryable = false;
      throw error;
    }
    if (result?.status !== "synced") throw new Error("Unexpected warehouse response.");
    connectionHealthy = true;
  } catch (error) {
    if (error.retryable === undefined) {
      error.retryable = true;
      connectionHealthy = false;
    } else {
      connectionHealthy = true;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function syncQueue({ announce = false } = {}) {
  if (syncInProgress) return;
  if (!navigator.onLine) {
    updateConnectionStatus();
    updateSnapshotStatus();
    if (announce) showMessage("Still offline. Pending transfers remain on this device.");
    return;
  }
  syncInProgress = true;
  let synced = 0;
  let foundConflicts = 0;
  try {
    for (const transfer of getSyncQueue()) {
      elements.connectionStatus.textContent = "Syncing pending transfers...";
      try {
        await sendTransfer(transfer);
        saveSyncQueue(getSyncQueue().filter((entry) => entry.clientId !== transfer.clientId));
        updateHistorySyncStatus(transfer.clientId, "synced");
        synced += 1;
      } catch (error) {
        if (error.retryable) {
          updateHistorySyncStatus(transfer.clientId, "waiting");
          continue;
        }
        const conflicts = getConflicts();
        if (!conflicts.some((entry) => entry.transfer.clientId === transfer.clientId)) {
          conflicts.unshift({ transfer, reason: error.message, detectedAt: new Date().toISOString() });
          saveConflicts(conflicts);
        }
        saveSyncQueue(getSyncQueue().filter((entry) => entry.clientId !== transfer.clientId));
        updateHistorySyncStatus(transfer.clientId, "conflict", error.message);
        foundConflicts += 1;
      }
    }
    if (synced) void refreshMasterData();
    if (announce || synced || foundConflicts) {
      showMessage(foundConflicts
        ? `${foundConflicts} transfer ${foundConflicts === 1 ? "needs" : "need"} attention. Check Recent transfers.`
        : getSyncQueue().length
          ? `${synced} synced. ${getSyncQueue().length} still waiting.`
          : synced ? `${synced} ${synced === 1 ? "transfer" : "transfers"} synced.` : "No pending transfers.");
    }
  } finally {
    syncInProgress = false;
    updateConnectionStatus();
  }
}

async function completeTransfer() {
  clearFieldError(elements.destinationError);
  const item = state.items.find((entry) => entry.id === state.selectedItemId);
  const destination = normalize(elements.destinationBin.value);
  const quantity = Number(elements.moveQuantity.value);
  if (!item || !state.sourceBin) {
    showStep("scan");
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity) {
    showFieldError(elements.destinationError, `Move 1 to ${item.quantity} units of ${item.sku}.`);
    elements.moveQuantity.focus();
    return;
  }
  if (!destination || destination === state.sourceBin) {
    showFieldError(elements.destinationError, "Scan a destination bin different from the source bin.");
    elements.destinationBin.focus();
    return;
  }
  const button = $("#complete-transfer");
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
    button.textContent = "Complete bin transfer";
  }

  const completedAt = new Date();
  const reference = `BT-${completedAt.getFullYear()}-${String(Date.now()).slice(-6)}`;
  const transfer = {
    clientId: crypto.randomUUID(),
    reference,
    sourceBin: state.sourceBin,
    destinationBin: destination,
    items: [{ sku: item.sku, quantity }],
    totalQuantity: quantity,
    completedAt: completedAt.toISOString(),
    syncStatus: "waiting",
  };
  const history = getHistory();
  history.unshift(transfer);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  const queue = getSyncQueue();
  queue.push(transfer);
  saveSyncQueue(queue);
  item.quantity -= quantity;
  if (Number.isInteger(item.available)) item.available = Math.max(0, item.available - quantity);
  if (item.quantity === 0) state.items = state.items.filter((entry) => entry.id !== item.id);
  state.selectedItemId = "";
  state.lastTransferClientId = transfer.clientId;
  persistDraft();
  renderBucket();
  $("#start-another").textContent = state.items.length ? "Move another item" : "Add more items";
  $("#success-title").textContent = "Transfer saved for sync";
  $("#success-reference").textContent = `${reference} • ${item.sku} • ${quantity} units • ${state.sourceBin} → ${destination} • Waiting to sync`;
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
    const syncStatus = transfer.syncStatus === "synced" ? "Synced" : transfer.syncStatus === "conflict" ? "Needs attention" : transfer.syncStatus === "waiting" ? "Waiting to sync" : "Device only";
    return `<details class="history-card">
      <summary>
        <span class="history-transfer"><strong>${escapeHtml(transfer.reference)}</strong><span>${escapeHtml(transfer.sourceBin)} → ${escapeHtml(transfer.destinationBin)} • ${items.length} ${items.length === 1 ? "item" : "items"}</span><span class="sync-state ${syncStatus === "Waiting to sync" ? "is-pending" : syncStatus === "Needs attention" ? "is-conflict" : ""}">${syncStatus}</span></span>
        <span class="history-date">${escapeHtml(date)}</span>
      </summary>
      <div class="history-details">
        <p>Items moved</p>
        <ul>${itemRows || "<li>No item details saved.</li>"}</ul>
        ${syncStatus === "Needs attention" ? `<p class="conflict-reason">Not applied to inventory: ${escapeHtml(transfer.conflictReason || "The warehouse rejected this transfer.")}</p><button class="text-button retry-conflict" type="button" data-client-id="${escapeHtml(transfer.clientId)}">Retry this transfer</button>` : ""}
      </div>
    </details>`;
  }).join("");
  list.querySelectorAll(".retry-conflict").forEach((button) => button.addEventListener("click", () => retryConflict(button.dataset.clientId)));
}

function retryConflict(clientId) {
  const conflict = getConflicts().find((entry) => entry.transfer.clientId === clientId);
  if (!conflict) return;
  if (!getSyncQueue().some((entry) => entry.clientId === clientId)) {
    saveSyncQueue([...getSyncQueue(), conflict.transfer]);
  }
  saveConflicts(getConflicts().filter((entry) => entry.transfer.clientId !== clientId));
  updateHistorySyncStatus(clientId, "waiting");
  showMessage("Transfer queued for another attempt.");
  void syncQueue({ announce: true });
}

function continueAfterTransfer() {
  elements.scanSku.value = "";
  if (state.items.length) goToScan();
  else {
    showStep("items");
    elements.sku.focus();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("#set-source").addEventListener("click", setSourceBin);
elements.sourceBin.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !elements.sourceBin.readOnly) setSourceBin();
});
$("#item-form").addEventListener("submit", addItem);
$("#save-draft").addEventListener("click", saveDraft);
elements.continueButton.addEventListener("click", goToScan);
$("#select-bucket-item").addEventListener("click", selectBucketItem);
elements.scanSku.addEventListener("keydown", (event) => {
  if (event.key === "Enter") selectBucketItem();
});
$("#complete-transfer").addEventListener("click", completeTransfer);
elements.destinationBin.addEventListener("keydown", (event) => {
  if (event.key === "Enter") completeTransfer();
});
$("#start-another").addEventListener("click", continueAfterTransfer);
$$('[data-back="source"]').forEach((button) => button.addEventListener("click", goToSource));
$$('[data-back="items"]').forEach((button) => button.addEventListener("click", () => showStep("items")));
$$('[data-back="scan"]').forEach((button) => button.addEventListener("click", goToScan));
$("#clear-history").addEventListener("click", () => {
  const unresolved = new Set(getConflicts().map((entry) => entry.transfer.clientId));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(getHistory().filter((entry) => unresolved.has(entry.clientId))));
  renderHistory();
  showMessage(unresolved.size ? "Completed history cleared. Conflicts were kept." : "Transfer history cleared.");
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
  updateSnapshotStatus();
});
function refreshSnapshotIfDue() {
  const cachedAt = snapshotMeta.cachedAt;
  if (navigator.onLine && (!cachedAt || Date.now() - new Date(cachedAt).getTime() >= SNAPSHOT_REFRESH_MS)) {
    void refreshMasterData();
  }
  updateSnapshotStatus();
}
window.addEventListener("focus", () => {
  refreshSnapshotIfDue();
  void syncQueue();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshSnapshotIfDue();
    void syncQueue();
  }
});

async function initializeOfflineSupport() {
  snapshotMeta = await readSnapshotMeta();
  updateSnapshotStatus();
  const dataRefreshed = await refreshMasterData();
  const dataReady = dataRefreshed || snapshotMeta.ready;
  let workerReady = false;
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("service-worker.js?v=7");
      await navigator.serviceWorker.ready;
      workerReady = true;
    } catch {
      workerReady = false;
    }
  }
  offlineReady = dataReady && workerReady;
  updateSnapshotStatus();
  updateConnectionStatus();
}

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
elements.iosInstallTip.hidden = !isIos || isStandalone;

window.setInterval(() => {
  if (getSyncQueue().length) void syncQueue();
}, 15000);
window.setInterval(refreshSnapshotIfDue, 60000);

renderBucket();
renderHistory();
loadDraft();
updateSnapshotStatus();
updateConnectionStatus();
void initializeOfflineSupport();
void syncQueue();
