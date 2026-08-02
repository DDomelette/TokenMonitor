window._constraint = {};

(function () {
  var ws = window._ws;

  var rules = [
    {
      name: 'minWidth',
      enabled: true,
      apply: function () {
        if (ws.targetWidth < ws.minWidth) {
          ws.targetWidth = ws.minWidth;
          return true;
        }
        return false;
      }
    },
    {
      name: 'minHeight',
      enabled: true,
      apply: function () {
        if (ws.targetHeight < ws.minHeight) {
          ws.targetHeight = ws.minHeight;
          return true;
        }
        return false;
      }
    },
    {
      name: 'maxWidth',
      enabled: true,
      apply: function () {
        if (ws.targetWidth > ws.maxWidth) {
          ws.targetWidth = ws.maxWidth;
          return true;
        }
        return false;
      }
    },
    {
      name: 'maxHeight',
      enabled: true,
      apply: function () {
        if (ws.targetHeight > ws.maxHeight) {
          ws.targetHeight = ws.maxHeight;
          return true;
        }
        return false;
      }
    }
  ];

  function apply() {
    var anyHit = false;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule.enabled) continue;
      if (rule.apply()) {
        anyHit = true;
        ws.lastConstraintRule = rule.name;
      }
    }
    ws.constraintHit = anyHit;
    if (anyHit) ws.constraintHits++;
  }

  window._constraint.apply = apply;
  window._constraint.rules = rules;
})();
