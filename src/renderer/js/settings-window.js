(function () {
  var definitions = window.SettingsDefinitions;
  var sessionState = { loggedIn: false, error: null };
  var settingsUpdateQueue = window.SettingsDebounce.createKeyedDebouncer({
    delay: 300,
    onEmit: function (key, value) {
      window.api.send('settings:update', { key: key, value: value });
    }
  });

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
      case 'select': {
        var current = null;
        for (var i = 0; i < def.options.length; i++) {
          if (String(v) === String(def.options[i].value)) { current = def.options[i]; break; }
        }
        return '<div class="custom-select" data-key="' + def.key + '">' +
          '<button type="button" class="custom-select-trigger">' +
            '<span class="custom-select-label">' + (current ? current.label : String(v)) + '</span>' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</button>' +
          '<div class="custom-select-menu">' +
            def.options.map(function (o) {
              return '<div class="custom-select-option' + (String(v) === String(o.value) ? ' selected' : '') + '" data-value="' + o.value + '">' + o.label + '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }
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

    document.querySelectorAll('input[data-key]').forEach(function (el) {
      el.addEventListener('input', function () { handleChange(el); });
      if (el.type === 'checkbox') {
        el.addEventListener('change', function () { handleChange(el); });
      }
    });

    document.querySelectorAll('.custom-select').forEach(function (sel) {
      var trigger = sel.querySelector('.custom-select-trigger');
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = sel.classList.contains('open');
        closeAllSelects();
        if (!wasOpen) {
          // 可视空间不足时向上展开,避免被 settings-body 的滚动边界裁切
          var body = document.querySelector('.settings-body');
          var spaceBelow = body.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom;
          var menuHeight = sel.querySelectorAll('.custom-select-option').length * 34 + 12;
          sel.classList.toggle('drop-up', spaceBelow < menuHeight);
          sel.classList.add('open');
        }
      });
      sel.querySelectorAll('.custom-select-option').forEach(function (opt) {
        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          sel.querySelectorAll('.custom-select-option').forEach(function (o) { o.classList.remove('selected'); });
          opt.classList.add('selected');
          sel.querySelector('.custom-select-label').textContent = opt.textContent;
          sel.classList.remove('open');
          handleSelectChange(sel.dataset.key, opt.dataset.value);
        });
      });
    });
  }

  function closeAllSelects() {
    document.querySelectorAll('.custom-select.open').forEach(function (sel) {
      sel.classList.remove('open');
    });
  }

  function handleSelectChange(key, value) {
    settingsUpdateQueue.schedule(key, value);
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
    settingsUpdateQueue.schedule(key, value);
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

  // 主题与主窗口保持一致:React 主窗口目前只有浅色一套样式(无 body.dark 处理),
  // 设置窗口若跟随系统变暗会与主窗口割裂。在主窗口支持暗色前,设置窗口固定浅色,
  // 忽略系统暗色与 theme:changed。
  function applyInitialTheme() {
    document.body.classList.remove('dark');
  }

  window.api.on('theme:changed', function () {
    document.body.classList.remove('dark');
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

  document.addEventListener('click', closeAllSelects);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllSelects();
  });
})();
