// React/GridStack 侧只包装 canonical browser registry；组件元数据不得在此重复定义。
import '../../../src/renderer/js/layout/component-registry.js';

const registry = globalThis.ComponentRegistry;
if (!registry) {
  throw new Error('ComponentRegistry failed to load');
}

const list = registry.list;
const get = registry.get;

export { list, get };
