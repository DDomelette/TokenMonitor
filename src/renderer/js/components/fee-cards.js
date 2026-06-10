window.App = window.App || {};

(function () {
  function getBalanceClass(totalBalance) {
    var val = parseFloat(totalBalance);
    if (isNaN(val)) return 'primary';
    if (val < 5) return 'error';
    if (val < 20) return 'warning';
    return 'primary';
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  }

  function updateFeeCards(balanceData, statsData) {
    var container = document.getElementById('fee-cards');
    if (!container) return;

    var balanceHTML = '<div class="card-label">余额</div>';
    var costHTML = '<div class="card-label">今日消耗</div>';
    var cacheHTML = '<div class="card-label">缓存命中率</div>';

    if (balanceData) {
      var cls = getBalanceClass(balanceData.total);
      balanceHTML += '<div class="card-value ' + cls + '">&yen;' + (balanceData.total || '--') + '</div>';
      balanceHTML += '<div class="card-sub">充值 ' + (balanceData.toppedUp || '--') + ' | 赠金 ' + (balanceData.granted || '--') + '</div>';
    } else {
      balanceHTML += '<div class="card-value primary">--</div>';
    }

    if (statsData && statsData.token && statsData.cost) {
      costHTML += '<div class="card-value primary">&yen;' + statsData.cost.totalCost.toFixed(2) + '</div>';
      costHTML += '<div class="card-sub">' + formatTokens(statsData.token.totalTokens) + ' tokens</div>';

      var rate = statsData.token.cacheRate.toFixed(1);
      cacheHTML += '<div class="card-value primary">' + rate + '%</div>';
      cacheHTML += '<div class="card-sub">命中 ' + formatTokens(statsData.token.cacheHit) + ' | 未命中 ' + formatTokens(statsData.token.cacheMiss) + '</div>';
    } else {
      costHTML += '<div class="card-value primary">--</div>';
      cacheHTML += '<div class="card-value primary">--</div>';
    }

    container.innerHTML =
      '<div class="cards-row">' +
        '<div class="card">' + balanceHTML + '</div>' +
        '<div class="card">' + costHTML + '</div>' +
        '<div class="card">' + cacheHTML + '</div>' +
      '</div>';
  }

  window.App.updateFeeCards = updateFeeCards;
})();
