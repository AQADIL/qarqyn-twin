const pending = new Map();

export function openWorkflow(page, context) {
  pending.set(page, { ...context, createdAt: Date.now() });
  window.dispatchEvent(new CustomEvent('qarqyn:navigate', { detail: { page, context } }));
}

export function takeWorkflow(page, datasetId) {
  const context = pending.get(page);
  if (!context || context.datasetId !== datasetId) return null;
  return context;
}

export function clearWorkflow() {
  pending.clear();
}

export function consumeWorkflow(page, context) {
  if (pending.get(page) === context) pending.delete(page);
}
