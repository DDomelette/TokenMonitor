(function () {
  var grid = null;
  var settings = null;
  var layoutState = null;
  var activeBreakpoint = null;
  var editing = false;
  var initialized = false;
  var applyingLayout = false;
  var resizeFrame = null;
  var resizeStartNode = null;
  var resizePreviewPreset = null;
  var editButton = null;
  var reflowClearTimer = null;
  var DEFAULT_CELL_HEIGHT = 24;
  var MIN_CELL_HEIGHT = 28;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getPath(source, path) {
    return path.split('.').reduce(function (value, part) {
      return value && value[part] !== undefined ? value[part] : undefined;
    }, source);
  }

  function setPath(target, path, value) {
    var parts = path.split('.');
    var cursor = target;
    parts.slice(0, -1).forEach(function (part) {
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = value;
  }

  function isVisible(id) {
    var component = window.ComponentRegistry.get(id);
    return component && getPath(settings, component.settingsKey) !== false;
  }

  function layoutItem(id, breakpoint) {
    var layout = layoutState && layoutState[breakpoint];
    return layout && layout.items.find(function (item) { return item.id === id; });
  }

  function ensureSnapLabel(element) {
    var surface = element && element.querySelector('.component-surface');
    if (!surface) return null;
    var label = surface.querySelector('.layout-snap-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'layout-snap-label';
      surface.appendChild(label);
    }
    return label;
  }

  function applyPresetToElement(element, preset) {
    if (!element || !preset) return;
    var presetName = preset.name || preset.preset;
    element.dataset.layoutPreset = presetName;
    var label = ensureSnapLabel(element);
    if (label) label.textContent = presetName + ' · ' + preset.w + '×' + preset.h;
  }

  function widgetOptions(id) {
    var component = window.ComponentRegistry.get(id);
    return {
      noResize: component && component.resizable === false
    };
  }

  function applyWidgetOptions(element, component) {
    if (!element || !component) return;
    var noResize = component.resizable === false;
    if (noResize) element.setAttribute('gs-no-resize', 'true');
    else element.removeAttribute('gs-no-resize');
    if (grid && element.gridstackNode) {
      grid.update(element, { noResize: noResize });
    }
  }

  function scheduleChartResize() {
    if (window.App && window.App.scheduleChartResize) {
      window.App.scheduleChartResize();
    }
  }

  function layoutRows(items) {
    return Math.max(1, items.reduce(function (maximum, item) {
      return Math.max(maximum, (item.y || 0) + (item.h || 1));
    }, 0));
  }

  function activeItems() {
    return layoutState[activeBreakpoint].items.filter(function (item) {
      return isVisible(item.id);
    }).map(function (item) {
      return Object.assign(clone(item), widgetOptions(item.id));
    });
  }

  function computeResponsiveCellHeight() {
    var content = document.querySelector('.content');
    var availableHeight = content && content.clientHeight
      ? content.clientHeight - 24
      : window.innerHeight;
    var rows = layoutRows(activeItems());
    var height = Math.round(availableHeight / rows);
    return Math.max(MIN_CELL_HEIGHT, height || DEFAULT_CELL_HEIGHT);
  }

  function parsePixel(value) {
    var number = parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  }

  function updateResponsiveCellHeight() {
    if (!grid) return;
    grid.cellHeight(computeResponsiveCellHeight());
  }

  function syncAspectRatioWidgets() {
    if (!grid) return;
    var cellWidth = grid.cellWidth();
    var cellHeight = grid.getCellHeight ? grid.getCellHeight(true) : computeResponsiveCellHeight();
    if (!cellWidth || !cellHeight) return;

    window.ComponentRegistry.list().forEach(function (component) {
      if (!component.aspectRatio) return;
      var element = document.querySelector('[data-component-id="' + component.id + '"]');
      if (!element || !element.gridstackNode || !isVisible(component.id)) return;
      var node = element.gridstackNode;
      var surface = element.querySelector('.component-surface');
      var surfaceWidth = surface ? surface.getBoundingClientRect().width : node.w * cellWidth;
      var surfaceStyle = surface ? getComputedStyle(surface) : null;
      var verticalInset = surfaceStyle
        ? parsePixel(surfaceStyle.top) + parsePixel(surfaceStyle.bottom)
        : 0;
      var targetRows = Math.max(1, Math.round((surfaceWidth + verticalInset) / (cellHeight * component.aspectRatio)));
      if (targetRows !== node.h) {
        grid.update(element, { h: targetRows });
      }
    });
  }

  function prepareElements() {
    window.ComponentRegistry.list().forEach(function (component) {
      var element = document.querySelector('[data-component-id="' + component.id + '"]');
      var item = layoutItem(component.id, activeBreakpoint);
      if (!element || !item) return;
      element.setAttribute('gs-id', item.id);
      element.setAttribute('gs-x', item.x);
      element.setAttribute('gs-y', item.y);
      element.setAttribute('gs-w', item.w);
      element.setAttribute('gs-h', item.h);
      element.classList.toggle('hidden', !isVisible(component.id));
      applyWidgetOptions(element, component);
      applyPresetToElement(element, item);
    });
  }

  function captureActiveLayout() {
    if (!grid || applyingLayout) return;
    var saved = grid.save(false, false, undefined, grid.getColumn());
    if (!Array.isArray(saved)) return;

    var items = saved.map(function (item) {
      var id = item.id;
      if (!id) return null;
      var preset = window.LayoutPolicy.nearestPreset(
        id,
        activeBreakpoint,
        item.w,
        item.h
      );
      if (!preset) return null;
      return {
        id: id,
        x: item.x || 0,
        y: item.y || 0,
        w: preset.w,
        h: preset.h,
        preset: preset.name
      };
    }).filter(Boolean);

    var savedIds = new Set(items.map(function (item) { return item.id; }));
    layoutState[activeBreakpoint].items.forEach(function (item) {
      if (!savedIds.has(item.id)) items.push(clone(item));
    });

    layoutState[activeBreakpoint] = window.LayoutPolicy.validateLayout(
      activeBreakpoint,
      { columns: grid.getColumn(), items: items }
    );
  }

  function persistActiveLayout() {
    captureActiveLayout();
    window.api.send('settings:update', {
      key: 'layout.' + activeBreakpoint,
      value: clone(layoutState[activeBreakpoint])
    });
  }

  function loadActiveLayout(options) {
    if (!grid) return;
    applyingLayout = true;
    var columns = window.LayoutPolicy.columnsForBreakpoint(activeBreakpoint);
    grid.column(columns, 'none');
    syncAllVisibility();
    updateResponsiveCellHeight();
    grid.load(activeItems(), false);
    syncAspectRatioWidgets();
    window.ComponentRegistry.list().forEach(function (component) {
      var element = document.querySelector('[data-component-id="' + component.id + '"]');
      var item = layoutItem(component.id, activeBreakpoint);
      if (!element || !item) return;
      element.classList.toggle('hidden', !isVisible(component.id));
      applyWidgetOptions(element, component);
      applyPresetToElement(element, item);
    });
    applyingLayout = false;
    updateEmptyState();
    if (!options || !options.deferChartResize) scheduleChartResize();
  }

  function selectElement(element) {
    document.querySelectorAll('.grid-stack-item.is-selected').forEach(function (item) {
      item.classList.remove('is-selected');
    });
    if (element) element.classList.add('is-selected');
  }

  function bindGridEvents() {
    grid.on('dragstart resizestart', function (event, element) {
      selectElement(element);
      window.ReflowAnimator.capture(grid.el, element);
      if (event.type === 'resizestart' && element && element.gridstackNode) {
        resizeStartNode = {
          id: element.dataset.componentId,
          w: element.gridstackNode.w,
          h: element.gridstackNode.h
        };
        resizePreviewPreset = null;
      }
    });
    grid.on('drag resize', function (event, element) {
      window.ReflowAnimator.play(grid.el, element);
      window.ReflowAnimator.capture(grid.el, element);
      if (event.type === 'resize' && element && element.gridstackNode) {
        var node = element.gridstackNode;
        var id = element.dataset.componentId;
        var preset = window.LayoutPolicy.presetAfterResize(
          id,
          activeBreakpoint,
          resizeStartNode,
          node
        ) || window.LayoutPolicy.nearestPreset(
          id,
          activeBreakpoint,
          node.w,
          node.h
        );
        resizePreviewPreset = preset;
        applyPresetToElement(element, preset);
        scheduleChartResize();
      }
    });
    grid.on('dragstop', function () {
      persistActiveLayout();
      finishReflow();
    });
    grid.on('resizestop', function (event, element) {
      if (!element || !element.gridstackNode) return;
      var node = element.gridstackNode;
      var preset = resizePreviewPreset || window.LayoutPolicy.presetAfterResize(
        element.dataset.componentId,
        activeBreakpoint,
        resizeStartNode,
        node
      ) || window.LayoutPolicy.nearestPreset(
        element.dataset.componentId,
        activeBreakpoint,
        node.w,
        node.h
      );
      resizeStartNode = null;
      resizePreviewPreset = null;
      if (preset) {
        grid.update(element, { w: preset.w, h: preset.h });
        applyPresetToElement(element, preset);
      }
      persistActiveLayout();
      scheduleChartResize();
      finishReflow();
    });
  }

  function finishReflow() {
    clearTimeout(reflowClearTimer);
    reflowClearTimer = setTimeout(function () {
      window.ReflowAnimator.clear();
      reflowClearTimer = null;
    }, 180);
  }

  function updateEditButton() {
    if (!editButton) return;
    editButton.setAttribute('aria-pressed', editing ? 'true' : 'false');
    editButton.title = editing ? '完成布局' : '编辑布局';
    editButton.setAttribute('aria-label', editButton.title);
    var icon = editButton.querySelector('.layout-edit-icon');
    if (icon) icon.textContent = editing ? '✓' : '▦';
  }

  function setEditing(value, persistPreference) {
    var next = Boolean(value);
    if (editing === next && initialized) return;
    editing = next;
    document.getElementById('app').classList.toggle('layout-editing', editing);
    if (grid) grid.setStatic(!editing);
    updateEditButton();
    if (initialized) scheduleChartResize();

    if (!editing && initialized) persistActiveLayout();
    if (persistPreference !== false && initialized) {
      window.api.send('settings:update', {
        key: 'window.layoutLocked',
        value: !editing
      });
    }
  }

  function bindEditButton() {
    editButton = document.getElementById('layoutEditBtn');
    if (!editButton || editButton.dataset.layoutBound === 'true') return;
    editButton.dataset.layoutBound = 'true';
    editButton.addEventListener('click', function () {
      setEditing(!editing, true);
    });
  }

  function bindEmptyState() {
    var button = document.getElementById('emptySettingsBtn');
    if (!button || button.dataset.settingsBound === 'true') return;
    button.dataset.settingsBound = 'true';
    button.addEventListener('click', function () {
      window.api.send('open:settings');
    });
  }

  function updateEmptyState() {
    var dashboard = document.getElementById('dashboardGrid');
    var empty = document.getElementById('dashboardEmpty');
    var hasVisibleComponent = window.ComponentRegistry.list().some(function (component) {
      return isVisible(component.id);
    });
    if (dashboard) dashboard.hidden = !hasVisibleComponent;
    if (empty) empty.hidden = hasVisibleComponent;
  }

  function rememberWidgetGeometry(id, element) {
    var item = layoutItem(id, activeBreakpoint);
    var node = element && element.gridstackNode;
    if (!item || !node) return;
    var preset = window.LayoutPolicy.nearestPreset(id, activeBreakpoint, node.w, node.h);
    item.x = node.x || 0;
    item.y = node.y || 0;
    if (preset) {
      item.w = preset.w;
      item.h = preset.h;
      item.preset = preset.name;
    }
  }

  function syncWidgetVisibility(id, visible) {
    var element = document.querySelector('[data-component-id="' + id + '"]');
    var component = window.ComponentRegistry.get(id);
    var item = layoutItem(id, activeBreakpoint);
    if (!grid || !element || !component || !item) return;

    if (visible) {
      var dashboard = document.getElementById('dashboardGrid');
      if (dashboard) dashboard.hidden = false;
      element.classList.remove('hidden');
      if (!element.gridstackNode) {
        grid.makeWidget(element, Object.assign({
          id: item.id,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h
        }, widgetOptions(item.id)));
      }
      applyWidgetOptions(element, component);
      applyPresetToElement(element, item);
    } else {
      rememberWidgetGeometry(id, element);
      if (element.gridstackNode) grid.removeWidget(element, false, false);
      element.classList.add('hidden');
    }
  }

  function syncAllVisibility() {
    window.ComponentRegistry.list().forEach(function (component) {
      syncWidgetVisibility(component.id, isVisible(component.id));
    });
  }

  function init(nextSettings) {
    if (initialized) {
      applySettings(nextSettings);
      return;
    }

    settings = nextSettings || {};
    layoutState = window.LayoutPolicy.validateState(settings.layout, settings);
    activeBreakpoint = window.LayoutPolicy.breakpointForWidth(window.innerWidth);
    prepareElements();

    grid = window.GridStack.init({
      column: window.LayoutPolicy.columnsForBreakpoint(activeBreakpoint),
      cellHeight: 24,
      margin: 12,
      animate: false,
      float: false,
      staticGrid: true,
      draggable: { handle: '.component-title' },
      resizable: { handles: 'e,se,s,sw,w' }
    }, '#dashboardGrid');
    updateResponsiveCellHeight();
    grid.load(activeItems(), false);
    syncAspectRatioWidgets();
    bindGridEvents();
    bindEditButton();
    bindEmptyState();
    initialized = true;
    syncAllVisibility();
    updateEmptyState();
    setEditing(settings.window && settings.window.layoutLocked === false, false);

    if (!settings.layout || Number(settings.layout.version) !== window.LayoutPolicy.VERSION) {
      window.api.send('settings:update', { key: 'layout', value: clone(layoutState) });
    }
    scheduleChartResize();
  }

  function applySettings(nextSettings) {
    if (!nextSettings) return;
    settings = nextSettings;
    if (!initialized) return;
    var shouldPersistLayout = !settings.layout
      || Number(settings.layout.version) !== window.LayoutPolicy.VERSION;
    layoutState = window.LayoutPolicy.validateState(settings.layout, settings);
    setEditing(settings.window && settings.window.layoutLocked === false, false);
    loadActiveLayout();
    if (shouldPersistLayout) {
      window.api.send('settings:update', { key: 'layout', value: clone(layoutState) });
    }
  }

  function setComponentVisible(id, visible) {
    var component = window.ComponentRegistry.get(id);
    if (!component) return;
    settings = settings || {};
    setPath(settings, component.settingsKey, Boolean(visible));
    if (!initialized) return;
    syncWidgetVisibility(id, Boolean(visible));
    updateResponsiveCellHeight();
    syncAspectRatioWidgets();
    updateEmptyState();
    scheduleChartResize();
  }

  function resize() {
    if (!initialized || resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(function () {
      resizeFrame = null;
      if (window._ws && window._ws.resizing) {
        scheduleChartResize();
        return;
      }
      var nextBreakpoint = window.LayoutPolicy.breakpointForWidth(window.innerWidth);
      if (nextBreakpoint !== activeBreakpoint) {
        captureActiveLayout();
        activeBreakpoint = nextBreakpoint;
        loadActiveLayout();
      } else {
        updateResponsiveCellHeight();
        syncAspectRatioWidgets();
      }
      scheduleChartResize();
    });
  }

  function destroy() {
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    clearTimeout(reflowClearTimer);
    resizeFrame = null;
    resizeStartNode = null;
    resizePreviewPreset = null;
    reflowClearTimer = null;
    window.ReflowAnimator.clear();
    if (grid) grid.destroy(false);
    grid = null;
    initialized = false;
    editing = false;
  }

  window.AppLayout = {
    init: init,
    setEditing: setEditing,
    isEditing: function () { return editing; },
    setComponentVisible: setComponentVisible,
    applySettings: applySettings,
    resize: resize,
    destroy: destroy
  };
})();
