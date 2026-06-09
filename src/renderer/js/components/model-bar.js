function updateModelBar(models) {
  const container = document.getElementById('model-bar');
  if (!container) return;

  if (!models || models.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:8px;">暂无数据</div>';
    return;
  }

  const maxTokens = models[0]?.totalTokens || 1;

  let html = '';
  models.forEach(m => {
    const pct = Math.max((m.totalTokens / maxTokens) * 100, 2);
    const modelName = m.model.replace('deepseek-', '');
    let tokenDisplay;
    if (m.totalTokens >= 1000000) {
      tokenDisplay = (m.totalTokens / 1000000).toFixed(1) + 'M';
    } else if (m.totalTokens >= 1000) {
      tokenDisplay = (m.totalTokens / 1000).toFixed(1) + 'K';
    } else {
      tokenDisplay = m.totalTokens.toString();
    }
    html += `
      <div class="model-bar-item">
        <span class="model-bar-label">${modelName}</span>
        <div class="model-bar-track">
          <div class="model-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="model-bar-value">${tokenDisplay} tk</span>
      </div>
    `;
  });

  container.innerHTML = html;
}

module.exports = { updateModelBar };
