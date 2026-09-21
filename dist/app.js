const STORAGE_KEY = "rf-stock-move-draft-v1";
const HISTORY_KEY = "rf-stock-move-history-v1";

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
};

function normalize(value) {
  return value.trim().toUpperCase();
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

function setSourceBin() {
  const source = normalize(elements.sourceBin.value);
  if (!source) {
    showMessage("Scan or enter a source bin first.");
    elements.sourceBin.focus();
    return;
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

function addItem(event) {
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

  const existing = state.items.find((item) => item.sku === sku);
  if (existing) {
    existing.quantity += quantity;
    showMessage(`${sku} already existed, so the quantity was combined.`);
  } else {
    state.items.push({ id: crypto.randomUUID(), sku, quantity });
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
    fragment.querySelector(".item-meta").textContent = `Source ${state.sourceBin || "not set"}`;
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
  $("#total-quantity").textContent = totalQuantity();
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

  const stepNumber = { source: 1, items: 2, destination: 3, review: 4, success: 4 }[step];
  $$(".step").forEach((item, index) => {
    item.classList.toggle("is-active", index + 1 === stepNumber && step !== "success");
    item.classList.toggle("is-complete", index + 1 < stepNumber || step === "success");
  });
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

function prepareReview() {
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

  state.destinationBin = destination;
  elements.destinationBin.value = destination;
  $("#review-source").textContent = state.sourceBin;
  $("#review-destination").textContent = state.destinationBin;
  $("#review-total").textContent = totalQuantity();
  $("#review-items").innerHTML = state.items
    .map((item) => `<div class="review-row"><strong>${escapeHtml(item.sku)}</strong><span>Qty ${item.quantity}</span></div>`)
    .join("");
  markDraftChanged();
  showStep("review");
}

function confirmTransfer() {
  const completedAt = new Date();
  const reference = `BT-${completedAt.getFullYear()}-${String(Date.now()).slice(-6)}`;
  const transfer = {
    reference,
    sourceBin: state.sourceBin,
    destinationBin: state.destinationBin,
    items: state.items,
    totalQuantity: totalQuantity(),
    completedAt: completedAt.toISOString(),
  };
  const history = getHistory();
  history.unshift(transfer);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
  localStorage.removeItem(STORAGE_KEY);
  $("#success-reference").textContent = `${reference} • ${transfer.totalQuantity} units • ${transfer.sourceBin} to ${transfer.destinationBin}`;
  renderHistory();
  showStep("success");
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
    return `<article class="history-card">
      <div><strong>${escapeHtml(transfer.reference)}</strong><p>${escapeHtml(transfer.sourceBin)} → ${escapeHtml(transfer.destinationBin)} • ${transfer.items.length} items • ${transfer.totalQuantity} units</p></div>
      <p class="history-date">${escapeHtml(date)}</p>
    </article>`;
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

renderBucket();
renderHistory();
loadDraft();
registerWebMcpTools();
