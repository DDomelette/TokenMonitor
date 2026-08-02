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
    var value = Number(n) || 0;
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
    return value.toString();
  }

  function renderCard(id, valueHtml, subHtml) {
    var container = document.getElementById(id);
    if (!container) return;
    container.innerHTML =
      '<div class="fee-card-value-wrap">' + valueHtml + '</div>' +
      (subHtml ? '<div class="fee-card-sub">' + subHtml + '</div>' : '');
  }

  function getYesterdayCost(costDaily) {
    if (!costDaily || !costDaily.length) return 0;
    var todayStr = new Date().toISOString().slice(0, 10);
    var todayIdx = -1;
    for (var i = costDaily.length - 1; i >= 0; i--) {
      if (costDaily[i].date === todayStr) { todayIdx = i; break; }
    }
    if (todayIdx > 0) return costDaily[todayIdx - 1].total;
    if (todayIdx === -1) return costDaily[costDaily.length - 1].total;
    return 0;
  }

  function updateBalanceCard(balanceData) {
    if (balanceData) {
      var cls = getBalanceClass(balanceData.total);
      renderCard(
        'balance-card-content',
        '<div class="fee-card-value ' + cls + '">&yen;' + (balanceData.total || '--') + '</div>',
        '充值 ' + (balanceData.toppedUp || '--') + '<br>赠金 ' + (balanceData.granted || '--')
      );
    } else {
      renderCard('balance-card-content', '<div class="fee-card-value primary">--</div>', '');
    }
  }

  function updateTodayCostCard(statsData) {
    if (statsData && statsData.token && statsData.cost) {
      var yesterdayCost = getYesterdayCost(statsData.costDaily);
      renderCard(
        'today-cost-card-content',
        '<div class="fee-card-value primary">&yen;' + statsData.cost.todayCost.toFixed(2) + '</div>',
        formatTokens(statsData.token.todayTokens) + ' tokens<br>昨日:¥' + yesterdayCost.toFixed(2)
      );
    } else {
      renderCard('today-cost-card-content', '<div class="fee-card-value primary">--</div>', '');
    }
  }

  function updateCacheRateCard(statsData) {
    if (statsData && statsData.token) {
      var rate = statsData.token.todayCacheRate.toFixed(1);
      renderCard(
        'cache-rate-card-content',
        '<div class="fee-card-value primary">' + rate + '%</div>',
        '命中 ' + formatTokens(statsData.token.todayCacheHit) + '<br>未命中 ' + formatTokens(statsData.token.todayCacheMiss)
      );
    } else {
      renderCard('cache-rate-card-content', '<div class="fee-card-value primary">--</div>', '');
    }
  }

  function updateFeeCards(balanceData, statsData) {
    updateBalanceCard(balanceData);
    updateTodayCostCard(statsData);
    updateCacheRateCard(statsData);
  }

  window.App.updateFeeCards = updateFeeCards;
  if (window.ComponentRegistry) {
    ['balance-card', 'today-cost-card', 'cache-rate-card'].forEach(function (id) {
      window.ComponentRegistry.registerRuntime(id, {
        resize: function () {}
      });
    });
  }
})();
