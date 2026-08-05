// 统计卡片(余额/今日消耗/缓存命中率),逻辑从 fee-cards.js 逐行迁移。
import React from 'react';
import { getYesterdayCost } from '../fee-card-date.mjs';
import { formatCurrencyAmount } from '../fee-card-money.mjs';

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return value.toString();
}

function getBalanceClass(totalBalance) {
  const val = parseFloat(totalBalance);
  if (isNaN(val)) return 'primary';
  if (val < 5) return 'error';
  if (val < 20) return 'warning';
  return 'primary';
}

function placeholders(id) {
  return (
    <div className="fee-card-content">
      <div className="fee-card-value-wrap"><div className="fee-card-value primary">--</div></div>
      {id === 'balance-card' ? '' : ''}
    </div>
  );
}

export default function FeeCard({ id, balance, stats }) {
  if (id === 'balance-card') {
    if (balance) {
      const cls = getBalanceClass(balance.total);
      return (
        <div className="fee-card-content">
          <div className="fee-card-value-wrap">
            <div className={`fee-card-value ${cls}`}>
              {formatCurrencyAmount(balance.currency, balance.total)}
            </div>
          </div>
          <div className="fee-card-sub">
            充值 {formatCurrencyAmount(balance.currency, balance.toppedUp)}<br />
            赠金 {formatCurrencyAmount(balance.currency, balance.granted)}
          </div>
        </div>
      );
    }
    return placeholders(id);
  }

  if (id === 'today-cost-card') {
    if (stats && stats.token && stats.cost) {
      const yesterdayCost = getYesterdayCost(stats.costDaily);
      return (
        <div className="fee-card-content">
          <div className="fee-card-value-wrap">
            <div className="fee-card-value primary">¥{stats.cost.todayCost.toFixed(2)}</div>
          </div>
          <div className="fee-card-sub">
            {formatTokens(stats.token.todayTokens)} tokens<br />昨日:¥{yesterdayCost.toFixed(2)}
          </div>
        </div>
      );
    }
    return placeholders(id);
  }

  if (id === 'cache-rate-card') {
    if (stats && stats.token) {
      const rate = stats.token.todayCacheRate.toFixed(1);
      return (
        <div className="fee-card-content">
          <div className="fee-card-value-wrap">
            <div className="fee-card-value primary">{rate}%</div>
          </div>
          <div className="fee-card-sub">
            命中 {formatTokens(stats.token.todayCacheHit)}<br />未命中 {formatTokens(stats.token.todayCacheMiss)}
          </div>
        </div>
      );
    }
    return placeholders(id);
  }

  return null;
}
