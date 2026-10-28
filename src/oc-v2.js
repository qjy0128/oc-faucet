export function providersPayload(providers, models, defaultModel) {
  const grouped = new Map();
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (provider && typeof provider.id === 'string') grouped.set(provider.id, { ...provider, models: {} });
  }

  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model.providerID !== 'string') continue;
    if (!grouped.has(model.providerID)) {
      grouped.set(model.providerID, { id: model.providerID, name: model.providerID, models: {} });
    }
    const id = typeof model.modelID === 'string' && model.modelID ? model.modelID : model.id;
    if (typeof id !== 'string' || !id) continue;
    const variants = Object.fromEntries(
      (Array.isArray(model.variants) ? model.variants : [])
        .filter((variant) => variant && typeof variant.id === 'string' && variant.id)
        .map((variant) => [variant.id, { ...(variant.settings ?? {}), ...(variant.body ?? {}) }]),
    );
    grouped.get(model.providerID).models[id] = {
      ...model,
      id,
      cost: Array.isArray(model.cost) ? (model.cost[0] ?? {}) : model.cost,
      reasoning: Object.keys(variants).length > 0,
      variants,
    };
  }

  const defaults = {};
  if (defaultModel && typeof defaultModel.providerID === 'string') {
    const id = defaultModel.modelID ?? defaultModel.id;
    if (typeof id === 'string' && id) defaults[defaultModel.providerID] = id;
  }
  return { providers: [...grouped.values()], default: defaults };
}

export function promptPayload(message) {
  if (!message || typeof message !== 'object') return { info: {}, parts: [] };
  const parts = Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : [];
  if (message.tokens) parts.push({ type: 'step-finish', tokens: message.tokens });
  return {
    info: { id: message.id, role: 'assistant', error: message.error },
    parts,
  };
}

export function permissionPayload(request) {
  const callID = request?.metadata?.callID ?? request?.metadata?.callId ?? request?.metadata?.toolCallID;
  return {
    ...request,
    permission: request?.action,
    patterns: request?.resources ?? [],
    ...(typeof callID === 'string' && callID ? { tool: { callID } } : {}),
  };
}
