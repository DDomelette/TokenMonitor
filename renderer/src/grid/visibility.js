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
