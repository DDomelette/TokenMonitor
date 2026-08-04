import * as registry from './components.js';

export function getNestedSetting(settings, path) {
  if (!settings || typeof path !== 'string') return undefined;
  return path.split('.').reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, settings);
}

export function isComponentVisible(component, settings) {
  if (!component) return false;
  const configured = getNestedSetting(settings, component.settingsKey);
  return configured === undefined ? component.defaultVisible !== false : configured !== false;
}

export function visibleComponentIds(settings) {
  return registry.list()
    .filter((component) => isComponentVisible(component, settings))
    .map((component) => component.id);
}

// GridStack 只会保存当前渲染的节点。把这些新几何合并回完整布局，
// 保留因设置关闭或 provider 暂不可用而未渲染模块的原位置与尺寸。
export function mergeLayoutItems(existingItems, savedItems) {
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const saved = Array.isArray(savedItems) ? savedItems : [];
  const savedById = new Map(
    saved.filter((item) => item && item.id).map((item) => [item.id, item])
  );
  const knownIds = new Set();
  const merged = existing
    .filter((item) => item && item.id)
    .map((item) => {
      knownIds.add(item.id);
      return Object.assign({}, savedById.get(item.id) || item);
    });

  saved.forEach((item) => {
    if (item && item.id && !knownIds.has(item.id)) {
      merged.push(Object.assign({}, item));
    }
  });
  return merged;
}
