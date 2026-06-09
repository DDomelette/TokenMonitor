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

module.exports = { PRICING, getModelPrice, calcCost };
