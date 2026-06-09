let debounceTimer = null;

let settingsDefinitions = [
  { group: '窗口', key: 'window.opacity', type: 'slider', label: '透明度', min: 20, max: 100, default: 92, unit: '%' },
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true },
  { group: '组件', key: 'components.feeCards', type: 'toggle', label: '费用概览卡片', default: true },
  { group: '组件', key: 'components.modelBar', type: 'toggle', label: '模型消耗柱状图', default: true },
  { group: '组件', key: 'components.tokenLine', type: 'toggle', label: 'Token 增长趋势', default: true },
  { group: '组件', key: 'components.costLine', type: 'toggle', label: '费用增长趋势', default: true },
  { group: '数据', key: 'data.sampleInterval', type: 'select', label: '曲线采样频率', options: [
    { value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' }
  ], default: 30 },
  { group: '数据', key: 'data.defaultTimeRange', type: 'select', label: '默认时间维度', options: [
    { value: '30s', label: '30 秒' }, { value: '1m', label: '分钟' }, { value: '1h', label: '小时' }, { value: '1d', label: '天' }
  ], default: '1m' },
  { group: '数据', key: 'data.proxyPort', type: 'text', label: '代理端口', default: 7890 },
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'password', label: 'API Key', default: '' }
];

function getValue(key) {
  return window._settingsData ? getNested(window._settingsData, key) : undefined;
}

function getNested(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function renderSetting(def, currentValue) {
  const val = currentValue !== undefined ? currentValue : def.default;
  let input;

  switch (def.type) {
    case 'toggle':
      input = `<label class="toggle-switch"><input type="checkbox" data-key="${def.key}" ${val ? 'checked' : ''}><span class="toggle-slider"></span></label>`;
      break;
    case 'slider':
      input = `<div style="display:flex;align-items:center;flex:1;"><input type="range" class="slider-input" data-key="${def.key}" min="${def.min}" max="${def.max}" value="${val}" style="flex:1;"><span class="slider-value">${val}${def.unit || ''}</span></div>`;
      break;
    case 'select':
      input = `<select class="select-input" data-key="${def.key}">${def.options.map(o => `<option value="${o.value}" ${String(val) === String(o.value) ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
      break;
    case 'text':
      input = `<input type="text" class="text-input" data-key="${def.key}" value="${val}">`;
      break;
    case 'password':
      input = `<input type="password" class="text-input" data-key="${def.key}" value="${val}">`;
      break;
    default:
      input = '';
  }

  return `<div class="setting-row${def.type === 'slider' ? ' vertical' : ''}"><div><span class="setting-label">${def.label}</span></div>${input}</div>`;
}

function renderSettingsPanel() {
  const groups = {};
  settingsDefinitions.forEach(def => {
    if (!groups[def.group]) groups[def.group] = [];
    groups[def.group].push(def);
  });

  let bodyHTML = '';
  Object.entries(groups).forEach(([group, defs]) => {
    bodyHTML += `<div class="settings-section"><div class="settings-section-title">${group}</div>${defs.map(d => renderSetting(d, getValue(d.key))).join('')}</div>`;
  });

  return `<div class="settings-overlay" id="settingsOverlay"><div class="settings-panel"><div class="settings-header"><span class="settings-title">设置</span><button class="settings-close" id="settingsCloseBtn">&times;</button></div><div class="settings-body">${bodyHTML}</div><div class="settings-footer"><button class="btn btn-secondary" id="resetBtn">恢复默认</button><button class="btn btn-primary" id="settingsDoneBtn">关闭</button></div></div></div>`;
}

function initSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  window.api.invoke('get:settings').then(settings => {
    window._settingsData = settings;
    injectSettingsPanel();
  });
}

function injectSettingsPanel() {
  const existing = document.getElementById('settingsOverlay');
  if (existing) existing.remove();
  const html = renderSettingsPanel();
  document.body.insertAdjacentHTML('beforeend', html);
  bindSettingsEvents();
}

function bindSettingsEvents() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;

  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsDoneBtn').addEventListener('click', closeSettings);
  document.getElementById('resetBtn').addEventListener('click', () => { window.api.send('settings:reset'); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });

  overlay.querySelectorAll('input[data-key], select[data-key]').forEach(el => {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      let value;
      if (el.type === 'checkbox') { value = el.checked; }
      else if (el.type === 'range') {
        value = parseInt(el.value, 10);
        const valSpan = el.parentElement.querySelector('.slider-value');
        if (valSpan) { const def = settingsDefinitions.find(d => d.key === key); valSpan.textContent = value + (def ? (def.unit || '') : ''); }
      } else if (el.value && !isNaN(el.value) && key === 'data.proxyPort') { value = parseInt(el.value, 10); }
      else { value = el.value; }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { window.api.send('settings:update', { key, value }); applyUISetting(key, value); }, 300);
    });

    if (el.type === 'checkbox') {
      el.addEventListener('change', () => {
        const key = el.dataset.key;
        const value = el.checked;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { window.api.send('settings:update', { key, value }); applyUISetting(key, value); }, 300);
      });
    }
  });
}

function applyUISetting(key, value) {
  switch (key) {
    case 'components.feeCards': document.getElementById('fee-cards')?.classList.toggle('hidden', !value); break;
    case 'components.modelBar': document.getElementById('model-bar')?.classList.toggle('hidden', !value); break;
    case 'components.tokenLine': document.getElementById('token-line')?.classList.toggle('hidden', !value); break;
    case 'components.costLine': document.getElementById('cost-line')?.classList.toggle('hidden', !value); break;
    case 'window.layoutLocked': setLayoutLocked(value); break;
  }
}

let isLayoutLocked = true;

function setLayoutLocked(locked) {
  isLayoutLocked = locked;
  document.querySelectorAll('.component-title').forEach(el => { el.draggable = !locked; el.style.cursor = locked ? 'default' : 'grab'; });
}

function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) { overlay.classList.add('open'); }
  else { injectSettingsPanel(); setTimeout(() => document.getElementById('settingsOverlay')?.classList.add('open'), 10); }
}

function closeSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.classList.remove('open');
}

module.exports = { initSettings, openSettings, closeSettings };
