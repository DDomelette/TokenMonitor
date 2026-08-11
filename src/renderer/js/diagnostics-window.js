(function () {
  var state = DiagnosticsState.createState();
  var groupDefinitions = [];
  var guideFeedbackById = Object.create(null);
  var pendingGuideById = Object.create(null);
  var runGeneration = 0;
  var acceptedRunId = null;
  var themeSettings = null;
  var systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

  var summaryElement = document.getElementById('diagnosticsSummary');
  var groupsElement = document.getElementById('diagnosticsGroups');
  var actionStatusElement = document.getElementById('diagnosticsActionStatus');
  var rerunButton = document.getElementById('rerunDiagnosticsBtn');
  var copyButton = document.getElementById('copyDiagnosticsBtn');
  var closeButton = document.getElementById('diagnosticsCloseBtn');

  function createTextElement(tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text || '';
    return element;
  }

  function guideFailureMessage(result) {
    if (result && (result.errorCode === 'INVALID_GUIDE_ID' || result.errorCode === 'GUIDE_NOT_FOUND')) {
      return '解决手册不可用';
    }
    return '无法打开解决手册';
  }

  function openGuide(checkId, guideId, button) {
    var activeGeneration = runGeneration;
    var activeRunId = acceptedRunId;
    pendingGuideById[checkId] = true;
    button.disabled = true;
    window.diagnosticsApi.openGuide(guideId).then(function (result) {
      if (runGeneration !== activeGeneration || acceptedRunId !== activeRunId) return;
      if (result && result.ok === true) {
        delete guideFeedbackById[checkId];
      } else {
        guideFeedbackById[checkId] = guideFailureMessage(result);
      }
    }).catch(function () {
      if (runGeneration === activeGeneration && acceptedRunId === activeRunId) {
        guideFeedbackById[checkId] = '无法打开解决手册';
      }
    }).then(function () {
      if (runGeneration !== activeGeneration || acceptedRunId !== activeRunId) return;
      delete pendingGuideById[checkId];
      render();
    });
  }

  function createCheckRow(check) {
    var model = DiagnosticsView.rowForCheck(check);
    var row = document.createElement('div');
    row.className = 'diagnostic-row ' + model.statusClass;
    row.dataset.checkId = model.id;
    row.appendChild(createTextElement('div', 'diagnostic-title', model.title));
    var statusElement = createTextElement('span', 'diagnostic-status', model.statusLabel);
    if (model.statusClass === 'status-running') {
      var spinner = createTextElement('span', 'diagnostic-spinner', '');
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-label', 'Diagnostic check running');
      statusElement.appendChild(spinner);
    }
    row.appendChild(statusElement);

    if (model.summary) {
      row.appendChild(createTextElement('div', 'diagnostic-detail', model.summary));
    }

    if (model.showGuide) {
      var actions = document.createElement('div');
      actions.className = 'diagnostic-guide-actions';
      var guideButton = createTextElement('button', 'guide-link', '查看解决手册');
      guideButton.type = 'button';
      guideButton.dataset.guideId = model.guideId;
      guideButton.disabled = pendingGuideById[model.id] === true;
      var feedback = createTextElement('span', 'guide-feedback', guideFeedbackById[model.id] || '');
      feedback.setAttribute('role', 'status');
      guideButton.addEventListener('click', function () {
        openGuide(model.id, model.guideId, guideButton);
      });
      actions.appendChild(guideButton);
      actions.appendChild(feedback);
      row.appendChild(actions);
    }
    return row;
  }

  function render() {
    var checks = DiagnosticsState.orderedChecks(state);
    var counts = DiagnosticsState.summary(state);
    summaryElement.textContent = counts.total === 0
      ? '准备诊断…'
      : '共 ' + counts.total + ' 项 · 正常 ' + counts.pass + ' · 异常 ' + counts.fail +
        ' · 跳过 ' + counts.skipped + ' · 进行中 ' + (counts.pending + counts.running);
    copyButton.disabled = !state.runId || !counts.complete;

    var sections = DiagnosticsView.groupChecks(checks, groupDefinitions).map(function (group) {
      var section = document.createElement('section');
      section.className = 'diagnostics-group';
      section.appendChild(createTextElement('h2', 'diagnostics-group-title', group.name));
      var list = document.createElement('div');
      list.className = 'diagnostics-group-list';
      group.checks.forEach(function (check) { list.appendChild(createCheckRow(check)); });
      section.appendChild(list);
      return section;
    });
    groupsElement.replaceChildren.apply(groupsElement, sections);
  }

  function startDiagnostics() {
    var generation = runGeneration + 1;
    runGeneration = generation;
    acceptedRunId = null;
    state = DiagnosticsState.createState();
    groupDefinitions = [];
    guideFeedbackById = Object.create(null);
    pendingGuideById = Object.create(null);
    rerunButton.disabled = true;
    copyButton.disabled = true;
    actionStatusElement.textContent = '正在启动诊断…';
    render();
    return window.diagnosticsApi.run().then(function (snapshot) {
      if (generation !== runGeneration) return;
      if (!snapshot || typeof snapshot.runId !== 'string' || !Array.isArray(snapshot.checks)) {
        throw new Error('Invalid diagnostics snapshot');
      }
      groupDefinitions = snapshot.checks.slice();
      state = DiagnosticsState.startRun(state, snapshot);
      acceptedRunId = state.runId;
      actionStatusElement.textContent = '';
      render();
    }).catch(function () {
      if (generation !== runGeneration) return;
      actionStatusElement.textContent = '诊断启动失败，请重试';
    }).then(function () {
      if (generation !== runGeneration) return;
      rerunButton.disabled = false;
    });
  }

  function copyReport() {
    if (!acceptedRunId || state.runId !== acceptedRunId) return;
    var activeGeneration = runGeneration;
    var activeRunId = acceptedRunId;
    copyButton.disabled = true;
    actionStatusElement.textContent = '';
    window.diagnosticsApi.copyReport(activeRunId).then(function (result) {
      if (runGeneration !== activeGeneration || acceptedRunId !== activeRunId) return;
      actionStatusElement.textContent = result && result.ok === true
        ? '已复制诊断结果'
        : '复制诊断结果失败';
    }).catch(function () {
      if (runGeneration === activeGeneration && acceptedRunId === activeRunId) {
        actionStatusElement.textContent = '复制诊断结果失败';
      }
    }).then(function () {
      if (runGeneration !== activeGeneration || acceptedRunId !== activeRunId) return;
      copyButton.disabled = !DiagnosticsState.summary(state).complete;
    });
  }

  function applyTheme() {
    var windowValues = (themeSettings && themeSettings.window) || {};
    var theme = ThemeModeLink.resolveTheme(windowValues, systemThemeMedia.matches);
    document.body.classList.toggle('dark', theme === 'dark' || theme === 'acrylic-dark');
    document.body.dataset.theme = theme;
  }

  function refreshTheme() {
    return window.diagnosticsApi.getTheme().then(function (projection) {
      themeSettings = projection;
      applyTheme();
    }).catch(function () {
      themeSettings = null;
      applyTheme();
    });
  }

  window.diagnosticsApi.onProgress(function (event) {
    if (!acceptedRunId || !event || event.runId !== acceptedRunId) return;
    var nextState = DiagnosticsState.applyProgress(state, event);
    if (nextState === state) return;
    state = nextState;
    render();
  });

  window.diagnosticsApi.onThemeChanged(refreshTheme);

  window.diagnosticsApi.onFocusState(function (focused) {
    document.body.dataset.windowActive = String(focused !== false);
  });

  systemThemeMedia.addEventListener('change', applyTheme);
  closeButton.addEventListener('click', function () {
    window.diagnosticsApi.close();
  });
  rerunButton.addEventListener('click', startDiagnostics);
  copyButton.addEventListener('click', copyReport);

  applyTheme();
  refreshTheme();
  startDiagnostics();
})();
