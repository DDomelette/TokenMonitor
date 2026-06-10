(function () {
  var debounceTimer = null;
  var definitions = window.SettingsDefinitions;

  function getNested(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, obj);
  }

  function render(def, val) {
    var v = val !== undefined ? val : def.default;
    switch (def.type) {
      case 'toggle':
        return '<label class="toggle-switch"><input type="checkbox" data-key="' + def.key + '" ' + (v ? 'checked' : '') + '><span class="toggle-slider"></span></label>';
      case 'slider':
        return '<div style="display:flex;align-items:center;flex:1;"><input type="range" class="slider-input" data-key="' + def.key + '" min="' + def.min + '" max="' + def.max + '" value="' + v + '" style="flex:1;"><span class="slider-value">' + v + (def.unit || '') + '</span></div>';
      case 'select':
        return '<select class="select-input" data-key="' + def.key + '">' + def.options.map(function (o) { return '<option value="' + o.value + '" ' + (String(v) === String(o.value) ? 'selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>';
      case 'password':
        return '<input type="password" class="text-input" data-key="' + def.key + '" value="' + v + '">';
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
        groups[g].map(function (d) { return '<div class="setting-row' + (d.type === 'slider' ? ' vertical' : '') + '"><div><span class="setting-label">' + d.label + '</span></div>' + render(d, getNested(settings, d.key)) + '</div>'; }).join('') + '</div>';
    });
    return html;
  }

  function bindEvents() {
    document.getElementById('settingsCloseBtn').addEventListener('click', function () { window.api.send('window:close-settings'); });
    document.getElementById('settingsDoneBtn').addEventListener('click', function () { window.api.send('window:close-settings'); });
    document.getElementById('resetBtn').addEventListener('click', function () { window.api.send('settings:reset'); });

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

  window.api.on('settings:loaded', function (settings) {
    document.getElementById('settingsBody').innerHTML = buildPanel(settings);
    bindEvents();
    applyInitialTheme(settings);
  });

  window.api.invoke('get:settings').then(function (settings) {
    document.getElementById('settingsBody').innerHTML = buildPanel(settings);
    bindEvents();
    applyInitialTheme(settings);
  });

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
})();
