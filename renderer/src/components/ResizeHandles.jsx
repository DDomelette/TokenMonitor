// 8 个缩放手柄 + 完整移植旧 app.js 的缩放逻辑(行为逐行等价)。
// 拖动期间通过 window:set-bounds 即时提交。窗口为非透明 + DWM 圆角,
// 尺寸与圆角由合成器同帧绘制,无需拖动期间切直角的兼容逻辑。
import React, { useEffect, useRef } from 'react';
import { send, getBounds, onBoundsChanged } from '../api.js';

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const MIN_W = 380;
const MIN_H = 200;
const MAX_W = 2400;
const MAX_H = 1600;

export default function ResizeHandles() {
  const wsRef = useRef({
    x: 0, y: 0, width: 420, height: 680,
    resizing: false, resizeEdge: null,
    minWidth: MIN_W, minHeight: MIN_H, maxWidth: MAX_W, maxHeight: MAX_H
  });
  const startRef = useRef({ screenX: 0, screenY: 0, x: 0, y: 0, w: 0, h: 0 });
  const targetBoundsRef = useRef(null);
  const boundsRafRef = useRef(null);

  // 每帧最多提交一次 setBounds, 高频 mousemove 只保留最新目标, 避免 IPC 洪峰
  function requestBounds(bounds) {
    targetBoundsRef.current = bounds;
    if (boundsRafRef.current !== null) return;
    boundsRafRef.current = requestAnimationFrame(function () {
      boundsRafRef.current = null;
      if (targetBoundsRef.current) send('window:set-bounds', targetBoundsRef.current);
    });
  }

  function flushPendingBounds() {
    if (boundsRafRef.current === null) return;
    cancelAnimationFrame(boundsRafRef.current);
    boundsRafRef.current = null;
    if (targetBoundsRef.current) send('window:set-bounds', targetBoundsRef.current);
  }

  function handleBoundsChanged(bounds) {
    if (!bounds || wsRef.current.resizing) return;
    wsRef.current.x = bounds.x;
    wsRef.current.y = bounds.y;
    wsRef.current.width = bounds.width;
    wsRef.current.height = bounds.height;
  }

  useEffect(() => {
    const ws = wsRef.current;

    const onMouseMove = (e) => {
      if (!ws.resizing) return;
      const start = startRef.current;
      const dx = e.screenX - start.screenX;
      const dy = e.screenY - start.screenY;
      const edge = ws.resizeEdge;
      let newW = start.w;
      let newH = start.h;
      let newX = start.x;
      let newY = start.y;

      if (edge.indexOf('e') !== -1) newW = Math.min(ws.maxWidth, Math.max(ws.minWidth, start.w + dx));
      if (edge.indexOf('w') !== -1) {
        newW = Math.min(ws.maxWidth, Math.max(ws.minWidth, start.w - dx));
        newX = start.x + start.w - newW;
      }
      if (edge.indexOf('s') !== -1) newH = Math.min(ws.maxHeight, Math.max(ws.minHeight, start.h + dy));
      if (edge.indexOf('n') !== -1) {
        newH = Math.min(ws.maxHeight, Math.max(ws.minHeight, start.h - dy));
        newY = start.y + start.h - newH;
      }

      const target = { x: newX, y: newY, width: newW, height: newH };
      ws.targetX = newX; ws.targetY = newY;
      ws.targetWidth = newW; ws.targetHeight = newH;
      requestBounds(target);
    };

    const onMouseUp = () => {
      if (!ws.resizing) return;
      ws.resizing = false;
      ws.resizeEdge = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (targetBoundsRef.current) {
        flushPendingBounds();
      }
      targetBoundsRef.current = null;
      send('resize:end');
      window.dispatchEvent(new Event('resize'));
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    onBoundsChanged(handleBoundsChanged);

    getBounds().then((bounds) => {
      if (bounds) {
        ws.x = bounds.x; ws.y = bounds.y;
        ws.width = bounds.width; ws.height = bounds.height;
      }
    }).catch(() => {});

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (boundsRafRef.current !== null) {
        cancelAnimationFrame(boundsRafRef.current);
        boundsRafRef.current = null;
      }
    };
  }, []);

  function onResizeStart(e, edge) {
    e.preventDefault();
    e.stopPropagation();
    const ws = wsRef.current;
    ws.resizing = true;
    ws.resizeEdge = edge;
    startRef.current.screenX = e.screenX;
    startRef.current.screenY = e.screenY;
    startRef.current.x = ws.x;
    startRef.current.y = ws.y;
    startRef.current.w = ws.width;
    startRef.current.h = ws.height;
    ws.targetX = ws.x; ws.targetY = ws.y;
    ws.targetWidth = ws.width; ws.targetHeight = ws.height;
    targetBoundsRef.current = null;
    const cursor = getComputedStyle(document.querySelector('.resize-' + edge)).cursor;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';
  }

  return (
    <div className="resize-layer">
      {EDGES.map((edge) => (
        <div key={edge} className={`resize-handle resize-${edge}`} onMouseDown={(e) => onResizeStart(e, edge)} />
      ))}
    </div>
  );
}
