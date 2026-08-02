window._debug = {};

(function () {
  var ws = window._ws;
  var overlay = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = '_physics_debug';
    overlay.style.cssText = [
      'position:fixed;bottom:8px;right:8px;z-index:999999;',
      'background:rgba(0,0,0,0.82);color:#0f0;',
      'font-family:monospace;font-size:10px;line-height:1.5;',
      'padding:6px 8px;border-radius:6px;',
      'pointer-events:none;user-select:none;',
      'min-width:210px;'
    ].join('');
    document.body.appendChild(overlay);
  }

  function render() {
    if (!overlay) createOverlay();
    var c = window._commit;
    overlay.innerHTML = [
      'Cur: X=' + ws.x.toFixed(0) + ' Y=' + ws.y.toFixed(0) + ' W=' + ws.width.toFixed(0) + ' H=' + ws.height.toFixed(0),
      'Tgt: X=' + ws.targetX.toFixed(0) + ' Y=' + ws.targetY.toFixed(0) + ' W=' + ws.targetWidth.toFixed(0) + ' H=' + ws.targetHeight.toFixed(0),
      'Vel: VX=' + ws.vx.toFixed(1) + ' VY=' + ws.vy.toFixed(1),
      'St: drag=' + (ws.dragging ? 1 : 0) + ' resize=' + (ws.resizing ? 1 : 0) + ' edge=' + (ws.resizeEdge || '-'),
      'Constraint:' + (ws.constraintHit ? ' ACTIVE' : ' idle') + '  Rule:' + (ws.lastConstraintRule || '-') + '  Hits:' + ws.constraintHits,
      'Commit: ' + (c && c.isPending() ? 'pending' : 'idle')
    ].join('<br>');
  }

  window._runtime && window._runtime.onTick(render);
})();
