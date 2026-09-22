(function (root, factory) {
  var api = factory();
  root.MiniRowOrder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PROVIDER_IDS = Object.freeze(['deepseek', 'codex', 'kimi', 'dsh']);

  // 接受数组或逗号分隔字符串;忽略重复/未知项,缺失项按默认顺序补齐。
  function parseRowOrder(value) {
    var raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
    var order = [];
    raw.concat(PROVIDER_IDS).forEach(function (pid) {
      var id = String(pid).trim();
      if (PROVIDER_IDS.includes(id) && !order.includes(id)) order.push(id);
    });
    return order;
  }

  return { PROVIDER_IDS: PROVIDER_IDS, parseRowOrder: parseRowOrder };
});
