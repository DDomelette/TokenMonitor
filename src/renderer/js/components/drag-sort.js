window.App = window.App || {};

(function () {
  var longPressTimer = null;
  var draggedEl = null;

  function initDragSort(containerSelector) {
    var container = document.querySelector(containerSelector);
    if (!container) return;

    container.addEventListener('mousedown', function (e) {
      var title = e.target.closest('.component-title');
      if (!title) return;
      if (window._isLayoutLocked) return;

      var wrapper = title.closest('.component-wrapper');
      if (!wrapper) return;

      longPressTimer = setTimeout(function () {
        wrapper.classList.add('dragging');
        wrapper.draggable = true;
        wrapper.setAttribute('draggable', 'true');
        draggedEl = wrapper;
        wrapper.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      }, 200);
    });

    container.addEventListener('mouseup', cleanupDrag);
    container.addEventListener('mouseleave', cleanupDrag);

    function cleanupDrag() {
      clearTimeout(longPressTimer);
      if (draggedEl) {
        draggedEl.classList.remove('dragging');
        draggedEl.setAttribute('draggable', 'false');
        draggedEl = null;
      }
    }

    container.addEventListener('dragstart', function (e) {
      if (!window._isLayoutLocked && draggedEl) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedEl.id);
        setTimeout(function () { if (draggedEl) draggedEl.classList.add('dragging'); }, 0);
      } else {
        e.preventDefault();
      }
    });

    container.addEventListener('dragend', function () {
      if (draggedEl) {
        draggedEl.classList.remove('dragging');
        draggedEl = null;
      }
      container.querySelectorAll('.component-wrapper').forEach(function (w) { w.classList.remove('drag-over'); });
    });

    container.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var target = e.target.closest('.component-wrapper');
      if (target && target !== draggedEl) {
        container.querySelectorAll('.component-wrapper').forEach(function (w) { w.classList.remove('drag-over'); });
        target.classList.add('drag-over');
      }
    });

    container.addEventListener('dragleave', function (e) {
      var target = e.target.closest('.component-wrapper');
      if (target) target.classList.remove('drag-over');
    });

    container.addEventListener('drop', function (e) {
      e.preventDefault();
      container.querySelectorAll('.component-wrapper').forEach(function (w) { w.classList.remove('drag-over'); });

      var target = e.target.closest('.component-wrapper');
      if (!target || target === draggedEl || !draggedEl) return;

      var wrappers = Array.from(container.querySelectorAll('.component-wrapper'));
      var fromIndex = wrappers.indexOf(draggedEl);
      var toIndex = wrappers.indexOf(target);

      if (fromIndex < toIndex) {
        container.insertBefore(draggedEl, target.nextSibling);
      } else {
        container.insertBefore(draggedEl, target);
      }

      saveComponentOrder(container);
    });
  }

  function saveComponentOrder(container) {
    var wrappers = container.querySelectorAll('.component-wrapper');
    var order = Array.from(wrappers).map(function (w) { return w.id; });
    window.api.send('settings:update', { key: 'componentOrder', value: order });
  }

  window.App.initDragSort = initDragSort;
})();
