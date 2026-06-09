const fs = require('fs');
const path = require('path');
const { calcCost } = require('./pricing');

const RING_BUFFER_SIZE = 2880;

class Aggregator {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.resetDay();
    this.ringBuffer = new Array(RING_BUFFER_SIZE).fill(null);
    this.bufferIndex = 0;
    this.bufferCount = 0;
    this.currentBucket = { totalTokens: 0, totalCost: 0, timestamp: Date.now() };
    this.loadHistory();
  }

  resetDay() {
    const today = new Date().toISOString().slice(0, 10);
    this.today = {
      date: today,
      models: {},
      totalCost: 0,
      totalTokens: 0,
      totalCacheHit: 0,
      totalCacheMiss: 0,
      totalPromptTokens: 0
    };
  }

  loadHistory() {
    const historyPath = path.join(this.dataDir, 'history.json');
    this.history = [];
    try {
      if (fs.existsSync(historyPath)) {
        this.history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      }
    } catch (e) {
      this.history = [];
    }
  }

  saveHistory() {
    const historyPath = path.join(this.dataDir, 'history.json');
    try {
      fs.writeFileSync(historyPath, JSON.stringify(this.history, null, 2));
    } catch (e) {}
  }

  update(modelName, usage) {
    const date = new Date().toISOString().slice(0, 10);
    if (this.today.date !== date) {
      this.archiveDay();
      this.resetDay();
    }

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || promptTokens + completionTokens;
    const cacheHit = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss = usage.prompt_cache_miss_tokens || 0;

    if (!this.today.models[modelName]) {
      this.today.models[modelName] = {
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHit: 0,
        cacheMiss: 0
      };
    }

    const m = this.today.models[modelName];
    m.totalTokens += totalTokens;
    m.promptTokens += promptTokens;
    m.completionTokens += completionTokens;
    m.cacheHit += cacheHit;
    m.cacheMiss += cacheMiss;

    const cost = calcCost(modelName, promptTokens, completionTokens, cacheHit);
    this.today.totalCost += cost;
    this.today.totalTokens += totalTokens;
    this.today.totalCacheHit += cacheHit;
    this.today.totalCacheMiss += cacheMiss;
    this.today.totalPromptTokens += promptTokens;

    this.currentBucket.totalTokens += totalTokens;
    this.currentBucket.totalCost += cost;
  }

  getCacheRate() {
    if (this.today.totalPromptTokens === 0) return 0;
    return this.today.totalCacheHit / this.today.totalPromptTokens * 100;
  }

  getModelStats() {
    const entries = Object.entries(this.today.models)
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return entries;
  }

  getTodayStats() {
    return {
      models: this.getModelStats(),
      totalCost: this.today.totalCost,
      totalTokens: this.today.totalTokens,
      cacheRate: this.getCacheRate(),
      cacheHit: this.today.totalCacheHit,
      cacheMiss: this.today.totalCacheMiss
    };
  }

  sampleRingBuffer() {
    const bucket = {
      totalTokens: this.currentBucket.totalTokens,
      totalCost: this.currentBucket.totalCost,
      timestamp: this.currentBucket.timestamp
    };
    this.ringBuffer[this.bufferIndex] = bucket;
    this.bufferIndex = (this.bufferIndex + 1) % RING_BUFFER_SIZE;
    if (this.bufferCount < RING_BUFFER_SIZE) this.bufferCount++;
    this.currentBucket = { totalTokens: 0, totalCost: 0, timestamp: Date.now() };
  }

  getRingBufferPoints(count) {
    const points = [];
    const start = (this.bufferIndex - Math.min(count, this.bufferCount) + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
    let cumulativeTokens = 0;
    let cumulativeCost = 0;
    for (let i = 0; i < Math.min(count, this.bufferCount); i++) {
      const idx = (start + i) % RING_BUFFER_SIZE;
      const b = this.ringBuffer[idx];
      if (b) {
        cumulativeTokens += b.totalTokens;
        cumulativeCost += b.totalCost;
        points.push({
          time: b.timestamp,
          totalTokens: cumulativeTokens,
          totalCost: cumulativeCost,
          deltaTokens: b.totalTokens,
          deltaCost: b.totalCost
        });
      }
    }
    return points;
  }

  getPointsForRange(range) {
    switch (range) {
      case '30s': return this.getRingBufferPoints(30);
      case '1m': return this.getRingBufferPoints(60);
      case '1h': return this.downsample(60);
      case '1d': return this.downsample(24);
      default: return this.getRingBufferPoints(60);
    }
  }

  downsample(targetCount) {
    const rawPoints = this.getRingBufferPoints(RING_BUFFER_SIZE);
    if (rawPoints.length <= targetCount) return rawPoints;
    const step = Math.floor(rawPoints.length / targetCount);
    const result = [];
    for (let i = 0; i < rawPoints.length; i += step) {
      const chunk = rawPoints.slice(i, Math.min(i + step, rawPoints.length));
      if (chunk.length === 0) continue;
      const point = {
        time: chunk[chunk.length - 1].time,
        totalTokens: chunk[chunk.length - 1].totalTokens,
        totalCost: chunk[chunk.length - 1].totalCost,
        deltaTokens: chunk.reduce((s, p) => s + p.deltaTokens, 0),
        deltaCost: chunk.reduce((s, p) => s + p.deltaCost, 0)
      };
      result.push(point);
    }
    return result.slice(-targetCount);
  }

  getDailyHistory(days) {
    const todayDate = new Date().toISOString().slice(0, 10);
    const relevant = this.history.filter(h => h.date !== todayDate);
    return relevant.slice(-days);
  }

  archiveDay() {
    this.history.push({
      date: this.today.date,
      models: this.today.models,
      totalCost: this.today.totalCost,
      totalTokens: this.today.totalTokens,
      cacheRate: this.getCacheRate()
    });
    const maxDays = 365;
    if (this.history.length > maxDays) {
      this.history = this.history.slice(-maxDays);
    }
    this.saveHistory();
  }
}

module.exports = Aggregator;
