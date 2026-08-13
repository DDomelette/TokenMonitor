const PRICING = {
  'deepseek-v4-pro': {
    input: 0.001,
    output: 0.004,
    cache_hit: 0.0001
  },
  'deepseek-v4-flash': {
    input: 0.0005,
    output: 0.002,
    cache_hit: 0.00005
  },
  'deepseek-reasoner': {
    input: 0.001,
    output: 0.004,
    cache_hit: 0.0001
  }
};

// DSH 遥测四桶计价(¥/1000 tokens,与 PRICING 同单位)。
// cost = input×input + output×output + cacheRead×cacheHit + cacheWrite×input。
const DSH_PRICING = {
  'deepseek-v4-pro': { input: 0.001, output: 0.004, cacheHit: 0.0001 },
  'deepseek-v4-flash': { input: 0.0005, output: 0.002, cacheHit: 0.00005 },
  'deepseek-reasoner': { input: 0.001, output: 0.004, cacheHit: 0.0001 },
  default: { input: 0.001, output: 0.004, cacheHit: 0.0001 }
};

function getDshModelPrice(model) {
  if (!model) return DSH_PRICING.default;
  if (DSH_PRICING[model]) return DSH_PRICING[model];
  const name = String(model);
  if (name.startsWith('deepseek-v4-pro')) return DSH_PRICING['deepseek-v4-pro'];
  if (name.startsWith('deepseek-v4-flash')) return DSH_PRICING['deepseek-v4-flash'];
  if (name.includes('reasoner')) return DSH_PRICING['deepseek-reasoner'];
  return DSH_PRICING.default;
}

function calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  const price = getDshModelPrice(model);
  return (inputTokens / 1000) * price.input
    + (outputTokens / 1000) * price.output
    + (cacheReadTokens / 1000) * price.cacheHit
    + (cacheWriteTokens / 1000) * price.input;
}

function getModelPrice(model) {
  if (PRICING[model]) return PRICING[model];
  if (model.startsWith('deepseek-v4-pro')) return PRICING['deepseek-v4-pro'];
  if (model.startsWith('deepseek-v4-flash')) return PRICING['deepseek-v4-flash'];
  if (model.includes('reasoner')) return PRICING['deepseek-reasoner'];
  return PRICING['deepseek-v4-pro'];
}

function calcCost(model, promptTokens, completionTokens, cacheHitTokens) {
  const price = getModelPrice(model);
  const cost =
    (promptTokens / 1000) * price.input +
    (completionTokens / 1000) * price.output +
    (cacheHitTokens / 1000) * price.cache_hit;
  return cost;
}

module.exports = { PRICING, getModelPrice, calcCost, DSH_PRICING, getDshModelPrice, calcDshCost };
