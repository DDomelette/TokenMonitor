(function () {
  var definitions = window.SettingsDefinitions;
  var sessionState = { loggedIn: false, error: null };
  var lastCustomProxyUrl = '';
  var closingSettingsWindow = false;
  var failedSaveKeys = Object.create(null);
  var settingsUpdateQueue = window.SettingsDebounce.createKeyedDebouncer({
    delay: 300,
    onEmit: function (key, value) {
      return window.api.invoke('settings:save', { key: key, value: value });
    },
    onSuccess: function (key) {
      delete failedSaveKeys[key];
      if (Object.keys(failedSaveKeys).length === 0) {
        showSaveError('');
      }
    },
    onError: function (error, key) {
      failedSaveKeys[key] = true;
      showSaveError('设置保存失败，请重试。');
    }
  });

  function getNested(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o && o[k] !== undefined) ? o[k] : undefined; }, obj);
  }

  function escapeAttr(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function showSaveError(message) {
    var errorEl = document.getElementById('settingsSaveError');
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function setClosePending(pending) {
    var closeBtn = document.getElementById('settingsCloseBtn');
    var doneBtn = document.getElementById('settingsDoneBtn');
    if (closeBtn) closeBtn.disabled = pending;
    if (doneBtn) doneBtn.disabled = pending;
    var app = document.getElementById('app');
    if (app) app.setAttribute('aria-busy', pending ? 'true' : 'false');
  }

  function requestSettingsClose() {
    if (closingSettingsWindow) return;
    closingSettingsWindow = true;
    setClosePending(true);
    showSaveError('');

    settingsUpdateQueue.flush().then(function () {
      window.api.send('window:close-settings');
    }).catch(function () {
      closingSettingsWindow = false;
      setClosePending(false);
      showSaveError('设置保存失败，请重试。');
    });
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

  function showDeepseekApiKeyFeedback(message, isError) {
    var feedback = document.getElementById('deepseekApiKeyFeedback');
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.style.color = isError ? '#c43b3b' : 'var(--text-secondary)';
    feedback.hidden = !message;
  }

  function setDeepseekApiKeyPending(pending) {
    var input = document.getElementById('deepseekApiKeyInput');
    var button = document.getElementById('deepseekApiKeySaveBtn');
    if (input) input.disabled = pending;
    if (button) {
      button.disabled = pending;
      button.textContent = pending ? '验证中…' : '验证并保存';
    }
  }

  function submitDeepseekApiKey() {
    var input = document.getElementById('deepseekApiKeyInput');
    var candidate = input ? input.value.trim() : '';
    if (!candidate) {
      showDeepseekApiKeyFeedback('请输入新的 API Key。', true);
      return;
    }

    setDeepseekApiKeyPending(true);
    showDeepseekApiKeyFeedback('', false);
    window.api.invoke('settings:replace-api-key', { apiKey: candidate }).then(function () {
      var currentInput = document.getElementById('deepseekApiKeyInput');
      if (currentInput) {
        currentInput.value = '';
        currentInput.placeholder = '已保存,输入新 Key 以更换';
      }
      showDeepseekApiKeyFeedback('API Key 已验证并保存。', false);
    }).catch(function () {
      showDeepseekApiKeyFeedback('API Key 验证失败，已保留原值。', true);
    }).then(function () {
      setDeepseekApiKeyPending(false);
    });
  }

  function proxyModeFromValue(value) {
    if (value === 'system') return 'system';
    return value ? 'custom' : 'direct';
  }

  function showProxyFeedback(message, isError) {
    var feedback = document.getElementById('proxyFeedback');
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.style.color = isError ? '#c43b3b' : 'var(--text-secondary)';
    feedback.hidden = !message;
  }

  function syncProxyControls() {
    var mode = document.getElementById('proxyModeSelect');
    var input = document.getElementById('proxyUrlInput');
    if (!mode || !input) return;
    var custom = mode.value === 'custom';
    input.disabled = !custom;
    input.placeholder = custom ? 'http://127.0.0.1:7890' : '仅自定义模式需要地址';
    showProxyFeedback('', false);
    if (custom && !input.value.trim()) prefillProxyUrl();
  }

  // 自定义模式且输入为空时预填默认值:优先探测本机正在监听的代理端口,
  // 探测不到再回填上次使用过的地址(忘记 IP/端口 是常态)
  function prefillProxyUrl() {
    var input = document.getElementById('proxyUrlInput');
    if (!input || input.value.trim()) return;
    function fillLastCustom() {
      if (lastCustomProxyUrl && !input.value.trim()) {
        input.value = lastCustomProxyUrl;
        showProxyFeedback('已填入上次使用的代理地址,可按需修改。', false);
      }
    }
    window.api.invoke('detect:proxy-port').then(function (result) {
      var port = result && result.port;
      if (port && !input.value.trim()) {
        input.value = 'http://127.0.0.1:' + port;
        showProxyFeedback('已填入检测到的本机代理端口 ' + port + ',可按需修改。', false);
        return;
      }
      if (!port) fillLastCustom();
    }).catch(fillLastCustom);
  }

  function setProxyPending(pending) {
    var mode = document.getElementById('proxyModeSelect');
    var input = document.getElementById('proxyUrlInput');
    var button = document.getElementById('proxySaveBtn');
    if (mode) mode.disabled = pending;
    if (input) input.disabled = pending || !mode || mode.value !== 'custom';
    if (button) {
      button.disabled = pending;
      button.textContent = pending ? '保存中…' : '应用';
    }
  }

  function submitProxySetting() {
    var mode = document.getElementById('proxyModeSelect');
    var input = document.getElementById('proxyUrlInput');
    if (!mode || !input) return;

    var candidate = '';
    if (mode.value === 'system') candidate = 'system';
    if (mode.value === 'custom') candidate = input.value.trim();
    if (mode.value === 'custom' && !candidate) {
      showProxyFeedback('请输入 HTTP 代理地址。', true);
      return;
    }

    setProxyPending(true);
    showProxyFeedback('', false);
    window.api.invoke('settings:save', {
      key: 'providers.proxyUrl',
      value: candidate
    }).then(function () {
      showProxyFeedback('代理设置已保存，将在下一次请求生效。', false);
    }).catch(function () {
      showProxyFeedback('代理设置无效，已保留原值。', true);
    }).then(function () {
      setProxyPending(false);
    });
  }

  function showHistorySyncProgress(message) {
    var el = document.getElementById('historySyncProgress');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function setHistorySyncPending(pending) {
    var btn = document.getElementById('historySyncBtn');
    if (btn) {
      btn.disabled = pending;
      btn.textContent = pending ? '同步中…' : '同步历史数据';
    }
  }

  function formatHistorySyncSummary(summary) {
    var lines = [];
    if (summary.deepseek && summary.deepseek.skipped) {
      lines.push('DeepSeek:未登录平台,仅同步了本机数据');
    } else if (summary.deepseek) {
      var ds = summary.deepseek;
      lines.push('DeepSeek:同步 ' + ds.monthsFetched + ' 个月' +
        (ds.monthsFailed && ds.monthsFailed.length ? ',' + ds.monthsFailed.length + ' 个月失败(' + ds.monthsFailed.join('、') + ')' : '') +
        (ds.earliestDate ? ',最早 ' + ds.earliestDate : ''));
    }
    ['codex', 'kimi'].forEach(function (pid) {
      var r = summary[pid];
      if (!r) return;
      var label = pid === 'codex' ? 'Codex' : 'Kimi';
      lines.push(label + ':重建 ' + r.daysRebuilt + ' 天' + (r.earliestDate ? ',最早 ' + r.earliestDate : ''));
    });
    return lines.join('\n');
  }

  function showHistorySyncResult(summary) {
    var el = document.getElementById('historySyncResult');
    var hint = summary.retentionHint || null;
    if (el) {
      var text = formatHistorySyncSummary(summary);
      if (hint) {
        text += '\n当前历史保留 ' + hint.historyDays + ' 天,早于 ' + hint.earliestDate +
          ' 的数据会被自动清理,建议调到 ≥ ' + hint.suggestedDays + ' 天';
      }
      el.textContent = text;
      el.hidden = !text;
    }
    var btn = document.getElementById('historySyncRetentionBtn');
    if (btn) {
      if (hint) {
        btn.hidden = false;
        btn.textContent = '调整为 ' + hint.suggestedDays + ' 天';
        btn.onclick = function () {
          window.api.invoke('settings:save', { key: 'data.historyDays', value: hint.suggestedDays }).then(function () {
            btn.hidden = true;
            showHistorySyncProgress('历史保留天数已调整为 ' + hint.suggestedDays + ' 天,可再次同步补齐被清理的数据。');
          });
        };
      } else {
        btn.hidden = true;
      }
    }
  }

  function submitHistorySync() {
    setHistorySyncPending(true);
    showHistorySyncProgress('正在同步…');
    window.api.invoke('sync:history').then(function (summary) {
      showHistorySyncResult(summary || {});
      showHistorySyncProgress('');
    }).catch(function () {
      showHistorySyncProgress('同步失败,请稍后重试。');
    }).then(function () {
      setHistorySyncPending(false);
    });
  }

  function renderMcpConnectionInfo(info) {
    var urlInput = document.getElementById('mcpServerUrl');
    var tokenInput = document.getElementById('mcpServerToken');
    var copyBtn = document.getElementById('mcpCopyBtn');
    var rotateBtn = document.getElementById('mcpRotateBtn');
    if (!urlInput || !tokenInput) return;
    urlInput.value = info.running ? info.url : (info.enabled ? '启动中/未运行' : '已关闭');
    tokenInput.value = info.token || '';
    if (copyBtn) copyBtn.disabled = !info.running;
    if (rotateBtn) rotateBtn.disabled = !info.enabled;
  }

  function loadMcpConnectionInfo() {
    if (!document.getElementById('mcpServerUrl')) return;
    window.api.invoke('mcp:getConnectionInfo').then(renderMcpConnectionInfo).catch(function () {
      var urlInput = document.getElementById('mcpServerUrl');
      if (urlInput) urlInput.value = '不可用';
    });
  }

  function copyMcpConnectionInfo() {
    var urlInput = document.getElementById('mcpServerUrl');
    var tokenInput = document.getElementById('mcpServerToken');
    var copyBtn = document.getElementById('mcpCopyBtn');
    if (!urlInput || !tokenInput) return;
    navigator.clipboard.writeText(urlInput.value + '\nAuthorization: Bearer ' + tokenInput.value);
    if (copyBtn) {
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制连接信息'; }, 1200);
    }
  }

  function rotateMcpToken() {
    var rotateBtn = document.getElementById('mcpRotateBtn');
    if (rotateBtn) rotateBtn.disabled = true;
    window.api.invoke('mcp:rotateToken').then(renderMcpConnectionInfo).catch(function () {}).then(function () {
      if (rotateBtn) rotateBtn.disabled = false;
    });
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
      case 'proxy': {
        var proxyMode = proxyModeFromValue(v);
        var proxyUrl = proxyMode === 'custom' ? v : '';
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<select class="text-input" id="proxyModeSelect">' +
            '<option value="direct"' + (proxyMode === 'direct' ? ' selected' : '') + '>直连</option>' +
            '<option value="system"' + (proxyMode === 'system' ? ' selected' : '') + '>系统代理</option>' +
            '<option value="custom"' + (proxyMode === 'custom' ? ' selected' : '') + '>自定义 HTTP 代理</option>' +
          '</select>' +
          '<input type="text" class="text-input" id="proxyUrlInput" value="' + escapeAttr(proxyUrl) + '" autocomplete="off" spellcheck="false">' +
          '<button type="button" class="btn btn-primary" id="proxySaveBtn">应用</button>' +
          '<span id="proxyFeedback" role="status" hidden style="font-size:12px;line-height:1.3;"></span>' +
        '</div>';
      }
      case 'credential':
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<input type="password" class="text-input" id="deepseekApiKeyInput" value=""' + (placeholder ? ' placeholder="' + placeholder + '"' : ' placeholder="输入新的 API Key"') + '>' +
          '<button type="button" class="btn btn-primary" id="deepseekApiKeySaveBtn">验证并保存</button>' +
          '<span id="deepseekApiKeyFeedback" role="status" hidden style="font-size:12px;line-height:1.3;"></span>' +
        '</div>';
      case 'historySync':
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<button type="button" class="btn btn-primary" id="historySyncBtn">同步历史数据</button>' +
          '<span id="historySyncProgress" role="status" hidden style="font-size:12px;line-height:1.3;"></span>' +
          '<span id="historySyncResult" role="status" hidden style="font-size:12px;line-height:1.5;white-space:pre-line;"></span>' +
          '<button type="button" class="btn" id="historySyncRetentionBtn" hidden></button>' +
        '</div>';
      case 'mcpServer':
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<input type="text" class="text-input" id="mcpServerUrl" readonly value="加载中…" autocomplete="off" spellcheck="false">' +
          '<input type="text" class="text-input" id="mcpServerToken" readonly value="" autocomplete="off" spellcheck="false">' +
          '<div style="display:flex;gap:6px;">' +
            '<button type="button" class="btn btn-primary" id="mcpCopyBtn" disabled>复制连接信息</button>' +
            '<button type="button" class="btn" id="mcpRotateBtn">重新生成 token</button>' +
          '</div>' +
        '</div>';
      case 'password':
        return '<input type="password" class="text-input" data-key="' + def.key + '" value="' + v + '"' + (placeholder ? ' placeholder="' + placeholder + '"' : '') + '>';
      default:
        return '';
    }
  }

  function buildPanel(settings) {
    var groups = {};
    var visibleDefinitions = definitions.filter(function (d) {
      if (!d.visibleWhen) return true;
      return getNested(settings, d.visibleWhen.key) === d.visibleWhen.equals;
    });
    visibleDefinitions.forEach(function (d) {
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
          var vertical = d.type === 'slider' || d.type === 'credential' || d.type === 'proxy' || d.type === 'historySync' || d.type === 'mcpServer';
          return '<div class="setting-row' + (vertical ? ' vertical' : '') + '"><div><span class="setting-label">' + d.label + '</span></div>' + render(d, getNested(settings, d.key), placeholder) + '</div>';
        }).join('') + '</div>';
    });
    return html;
  }

  function bindEvents() {
    document.getElementById('settingsCloseBtn').addEventListener('click', requestSettingsClose);
    document.getElementById('settingsDoneBtn').addEventListener('click', requestSettingsClose);
    document.getElementById('resetBtn').addEventListener('click', function () {
      if (!window.confirm('确定要重置外观与布局设置吗?\nAPI Key、平台登录与用量数据都会保留。')) return;
      window.api.send('settings:reset');
    });

    var reloginBtn = document.getElementById('sessionReloginBtn');
    if (reloginBtn) {
      reloginBtn.addEventListener('click', function () { window.api.send('session:relogin'); });
    }

    var deepseekApiKeySaveBtn = document.getElementById('deepseekApiKeySaveBtn');
    if (deepseekApiKeySaveBtn) {
      deepseekApiKeySaveBtn.addEventListener('click', submitDeepseekApiKey);
    }

    var proxyModeSelect = document.getElementById('proxyModeSelect');
    if (proxyModeSelect) {
      proxyModeSelect.addEventListener('change', syncProxyControls);
    }
    var proxySaveBtn = document.getElementById('proxySaveBtn');
    if (proxySaveBtn) {
      proxySaveBtn.addEventListener('click', submitProxySetting);
    }

    var historySyncBtn = document.getElementById('historySyncBtn');
    if (historySyncBtn) {
      historySyncBtn.addEventListener('click', submitHistorySync);
    }

    var mcpCopyBtn = document.getElementById('mcpCopyBtn');
    if (mcpCopyBtn) {
      mcpCopyBtn.addEventListener('click', copyMcpConnectionInfo);
    }
    var mcpRotateBtn = document.getElementById('mcpRotateBtn');
    if (mcpRotateBtn) {
      mcpRotateBtn.addEventListener('click', rotateMcpToken);
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
    // 主题模式与跟随系统开关联动,避免手动选择被 followSystemTheme 主开关覆盖
    ThemeModeLink.linkedWrites(key, value).forEach(function (linked) {
      settingsUpdateQueue.schedule(linked.key, linked.value);
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
    settingsUpdateQueue.schedule(key, value);
  }

  function renderAll(settings) {
    lastCustomProxyUrl = getNested(settings, 'providers.proxyUrlLastCustom') || '';
    document.getElementById('settingsBody').innerHTML = buildSessionSection() + buildPanel(settings);
    bindEvents();
    syncProxyControls();
    loadMcpConnectionInfo();
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

  window.api.on('sync:progress', function (p) {
    if (!p) return;
    var stageLabel = { deepseek: 'DeepSeek', codex: 'Codex', kimi: 'Kimi' }[p.stage] || p.stage;
    showHistorySyncProgress('正在同步 ' + stageLabel + ' ' + (p.detail || '') + ' …');
  });

  window.api.invoke('get:session-state').then(function (state) {
    if (state) sessionState = state;
    updateSessionSection();
  }).catch(function () {});

  // 主题与主窗口一致:followSystemTheme 为主开关(语义同 renderer/src/theme-sync.js),
  // 依据持久化设置 + 系统暗色媒体查询解析;theme:changed 仅作唤醒信号,负载不作权威。
  var themeSettings = null;
  var systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    var windowValues = (themeSettings && themeSettings.window) || {};
    var theme = ThemeModeLink.resolveTheme(windowValues, systemThemeMedia.matches);
    document.body.classList.toggle('dark', theme === 'dark' || theme === 'acrylic-dark');
    document.body.dataset.theme = theme;
  }

  // 失焦实心化(Accent 未生效时主进程才下发)
  window.api.on('window:focus-state', function (focused) {
    document.body.dataset.windowActive = String(focused !== false);
  });

  function applyInitialTheme(settings) {
    themeSettings = settings || themeSettings;
    applyTheme();
  }

  window.api.on('theme:changed', function () {
    applyTheme();
  });

  systemThemeMedia.addEventListener('change', function () {
    applyTheme();
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
