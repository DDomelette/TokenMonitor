(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DiagnosticsView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STATUS_PRESENTATION = {
    pending: { statusClass: 'status-pending', statusLabel: '等待诊断' },
    running: { statusClass: 'status-running', statusLabel: '正在诊断' },
    pass: { statusClass: 'status-pass', statusLabel: '正常' },
    fail: { statusClass: 'status-fail', statusLabel: '异常' },
    skipped: { statusClass: 'status-skipped', statusLabel: '已跳过' }
  };

  function rowForCheck(check) {
    var status = check && STATUS_PRESENTATION[check.status] ? check.status : 'pending';
    var presentation = STATUS_PRESENTATION[status];
    var showGuide = status === 'fail';
    return {
      id: check.id,
      group: check.group,
      title: check.title,
      summary: check.summary || '',
      status: status,
      statusClass: presentation.statusClass,
      statusLabel: presentation.statusLabel,
      showGuide: showGuide,
      guideId: showGuide ? check.guideId : null
    };
  }

  function groupChecks(checks, definitions) {
    var source = Array.isArray(checks) ? checks : [];
    var definitionSource = Array.isArray(definitions) ? definitions : [];
    var order = [];
    var seen = Object.create(null);

    definitionSource.concat(source).forEach(function (item) {
      if (!item || typeof item.group !== 'string' || seen[item.group]) return;
      seen[item.group] = true;
      order.push(item.group);
    });

    return order.map(function (name) {
      return {
        name: name,
        checks: source.filter(function (check) { return check.group === name; })
      };
    }).filter(function (group) { return group.checks.length > 0; });
  }

  return {
    rowForCheck: rowForCheck,
    groupChecks: groupChecks
  };
});
