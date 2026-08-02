(function () {
  var debounceTimer = null;
  var definitions = window.SettingsDefinitions;
  var sessionState = { loggedIn: false, error: null };

  function getNested(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, obj);
  }

  function buildSessionSection() {
    return '<div class="settings-section" id="sessionSection">' +
      '<div class="settings-section-title">平台登录</div>' +
      '<div class="setting-row"><div><span class="setting-label">会话状态</span></div>' +
      '<span class="session-status"><span class="status-dot offline" id="sessionStatusDot"></span><span id="sessionStatusText">未登录或会话已过期</span></span></div>' +
      '<div class="setting-row"><button class="btn btn-primary" id="sessionReloginBtn" style="width:100%;">登录平台获取用量</button></div>' +
      '</div>';
  }

  function updateSessionSection() {
    var dot = document.getElementById('sessionStatusDot');
    var text = document.getElementById('sessionStatusText');
    var btn = document.getElementById('sessionReloginBtn');
    if (!dot || !text || !btn) return;
    var loggedIn = !!(sessionState && sessionState.loggedIn);
    dot.className = 'status-dot ' + (loggedIn ? 'online' : 'offline');
    text.textContent = loggedIn
      ? '已登录平台'
      : ((sessionState && sessionState.error) || '未登录或会话已过期');
    btn.textContent = loggedIn ? '重新登录平台' : '登录平台获取用量';
  }

  function render(def, val, placeholder) {
    var v = val !== undefined ? val : def.default;
    switch (def.type) {
      case 'toggle':
        return '<label class="toggle-switch"><input type="checkbox" data-key="' + def.key + '" ' + (v ? 'checked' : '') + '><span class="toggle-slider"></span></label>';
      case 'slider':
        return '<div style="display:flex;align-items:center;flex:1;"><input type="range" class="slider-input" data-key="' + def.key + '" min="' + def.min + '" max="' + def.max + '" value="' + v + '" style="flex:1;"><span class="slider-value">' + v + (def.unit || '') + '</span></div>';
      case 'select':
        return '<select class="select-input" data-key="' + def.key + '">' + def.options.map(function (o) { return '<option value="' + o.value + '" ' + (String(v) === String(o.value) ? 'selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>';
      case 'password':
        return '<input type="password" class="text-input" data-key="' + def.key + '" value="' + v + '"' + (placeholder ? ' placeholder="' + placeholder + '"' : '') + '>';
      default:
        return '';
    }
  }

  function buildPanel(settings) {
    var groups = {};
    definitions.forEach(function (d) {
      if (!groups[d.group]) groups[d.group] = [];
      groups[d.group].push(d);
    });
    var html = '';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="settings-section"><div class="settings-section-title">' + g + '</div>' +
        groups[g].map(function (d) {
          var placeholder = '';
          if (d.key === 'apiKey' && settings.providers && settings.providers.deepseek && settings.providers.deepseek.apiKeySet) {
            placeholder = '已保存,输入新 Key 以更换';
          }
          return '<div class="setting-row' + (d.type === 'slider' ? ' vertical' : '') + '"><div><span class="setting-label">' + d.label + '</span></div>' + render(d, getNested(settings, d.key), placeholder) + '</div>';
        }).join('') + '</div>';
    });
    return html;
  }

  function bindEvents() {
    document.getElementById('settingsCloseBtn').addEventListener('click', function () { window.api.send('window:close-settings'); });
    document.getElementById('settingsDoneBtn').addEventListener('click', function () { window.api.send('window:close-settings'); });
    document.getElementById('resetBtn').addEventListener('click', function () {
      if (!window.confirm('确定要重置外观与布局设置吗?\nAPI Key、平台登录与用量数据都会保留。')) return;
      window.api.send('settings:reset');
    });

    var reloginBtn = document.getElementById('sessionReloginBtn');
    if (reloginBtn) {
      reloginBtn.addEventListener('click', function () { window.api.send('session:relogin'); });
    }

    document.querySelectorAll('input[data-key], select[data-key]').forEach(function (el) {
      el.addEventListener('input', function () { handleChange(el); });
      if (el.type === 'checkbox') {
        el.addEventListener('change', function () { handleChange(el); });
      }
    });
  }

  function handleChange(el) {
    var key = el.dataset.key;
    var value;
    if (el.type === 'checkbox') {
      value = el.checked;
    } else if (el.type === 'range') {
      value = parseInt(el.value, 10);
      var span = el.parentElement.querySelector('.slider-value');
      if (span) {
        var def = definitions.find(function (d) { return d.key === key; });
        span.textContent = value + (def ? (def.unit || '') : '');
      }
    } else {
      value = el.value;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      window.api.send('settings:update', { key: key, value: value });
    }, 300);
  }

  function renderAll(settings) {
    document.getElementById('settingsBody').innerHTML = buildSessionSection() + buildPanel(settings);
    bindEvents();
    updateSessionSection();
    applyInitialTheme(settings);
  }

  window.api.on('settings:loaded', function (settings) {
    renderAll(settings);
  });

  window.api.invoke('get:settings').then(function (settings) {
    renderAll(settings);
  });

  window.api.on('session:changed', function (state) {
    sessionState = state || { loggedIn: false, error: null };
    updateSessionSection();
  });

  window.api.invoke('get:session-state').then(function (state) {
    if (state) sessionState = state;
    updateSessionSection();
  }).catch(function () {});

  function applyInitialTheme(settings) {
    var isDark = false;
    var dm = settings.window && settings.window.darkMode;
    if (dm === 'dark') {
      isDark = true;
    } else if (dm === 'light') {
      isDark = false;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      isDark = true;
    }
    if (isDark) document.body.classList.add('dark');
  }

  window.api.on('theme:changed', function (mode) {
    document.body.classList.toggle('dark', mode === 'dark');
  });

  var resizeState = null;
  var resizeCursor = '';
  var resizeFrameId = null;
  var lastEvent = null;

  function flushResizeMove() {
    resizeFrameId = null;
    if (!resizeState || !lastEvent) return;
    window.api.send('resize:move', {
      screenX: lastEvent.screenX,
      screenY: lastEvent.screenY
    });
  }

  function onResizeStart(e, edge) {
    e.preventDefault();
    e.stopPropagation();
    resizeState = edge;
    lastEvent = { screenX: e.screenX, screenY: e.screenY };
    resizeCursor = getComputedStyle(document.querySelector('.resize-' + edge)).cursor;
    document.body.style.cursor = resizeCursor;
    document.body.style.userSelect = 'none';
    window.api.send('resize:start', { edge: edge, screenX: e.screenX, screenY: e.screenY });
  }

  function onResizeMove(e) {
    if (!resizeState) return;
    lastEvent = { screenX: e.screenX, screenY: e.screenY };
    if (resizeFrameId !== null) return;
    resizeFrameId = requestAnimationFrame(flushResizeMove);
  }

  function onResizeEnd() {
    if (!resizeState) return;
    if (resizeFrameId !== null) {
      cancelAnimationFrame(resizeFrameId);
      resizeFrameId = null;
    }
    flushResizeMove();
    resizeState = null;
    lastEvent = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.api.send('resize:end');
  }

  var edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  edges.forEach(function (edge) {
    var el = document.querySelector('.resize-' + edge);
    if (el) {
      el.addEventListener('mousedown', function (e) { onResizeStart(e, edge); });
    }
  });
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
})();
