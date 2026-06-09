let longPressTimer = null;
let draggedEl = null;

function initDragSort(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  container.addEventListener('mousedown', (e) => {
    const title = e.target.closest('.component-title');
    if (!title) return;
    if (isLayoutLocked) return;

    const wrapper = title.closest('.component-wrapper');
    if (!wrapper) return;

    longPressTimer = setTimeout(() => {
      wrapper.classList.add('dragging');
      wrapper.draggable = true;
      wrapper.setAttribute('draggable', 'true');
      draggedEl = wrapper;
      wrapper.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    }, 200);
  });

  container.addEventListener('mouseup', () => {
    clearTimeout(longPressTimer);
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.setAttribute('draggable', 'false');
      draggedEl = null;
    }
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(longPressTimer);
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.setAttribute('draggable', 'false');
      draggedEl = null;
    }
  });

  container.addEventListener('dragstart', (e) => {
    if (!isLayoutLocked && draggedEl) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedEl.id);
      setTimeout(() => { draggedEl.classList.add('dragging'); }, 0);
    } else {
      e.preventDefault();
    }
  });

  container.addEventListener('dragend', (e) => {
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl = null;
    }
    container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.component-wrapper');
    if (target && target !== draggedEl) {
      container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
  });

  container.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.component-wrapper');
    if (target) target.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));

    const target = e.target.closest('.component-wrapper');
    if (!target || target === draggedEl || !draggedEl) return;

    const wrappers = [...container.querySelectorAll('.component-wrapper')];
    const fromIndex = wrappers.indexOf(draggedEl);
    const toIndex = wrappers.indexOf(target);

    if (fromIndex < toIndex) {
      container.insertBefore(draggedEl, target.nextSibling);
    } else {
      container.insertBefore(draggedEl, target);
    }

    saveComponentOrder(container);
  });
}

function saveComponentOrder(container) {
  const wrappers = container.querySelectorAll('.component-wrapper');
  const order = [...wrappers].map(w => w.id);
  window.api.send('settings:update', { key: 'componentOrder', value: order });
}

module.exports = { initDragSort };
