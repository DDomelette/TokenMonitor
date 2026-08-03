// 订阅制额度卡片:由 windows 数组驱动(不写死两条);subscription 模式不显示任何金额;
// authStatus==='expired' 时替换为重新授权按钮。
// 套餐徽标:prolite→5x Pro / pro→20x Pro / plus→Plus 套餐;未检测到(API 用户)不显示。
import React from 'react';
import WindowBar from './WindowBar.jsx';

function planBadgeLabel(planName) {
  const p = (planName || '').trim().toLowerCase();
  if (!p) return null;
  if (p === 'prolite') return '5x Pro';
  if (p === 'pro') return '20x Pro';
  if (p === 'plus') return 'Plus 套餐';
  return planName;
}

export default function QuotaCard({ provider, quotaState, authStatus, onReauthorize }) {
  if (authStatus === 'expired') {
    return (
      <div className="quota-card quota-expired">
        <div className="quota-card-head">
          <span className="quota-card-plan">{provider ? provider.displayName : ''} 登录已过期</span>
        </div>
        <button className="quota-reauth-btn" onClick={onReauthorize}>点击重新授权</button>
        <div className="quota-reauth-hint">请先在终端运行一次 {provider ? provider.id : ''} 登录命令</div>
      </div>
    );
  }

  if (!quotaState) {
    return (
      <div className="quota-card quota-empty">
        <div className="quota-card-head"><span className="quota-card-plan">{provider ? provider.displayName : ''}</span></div>
        <div className="quota-empty-text">暂无额度数据</div>
      </div>
    );
  }

  const windows = quotaState.windows || [];
  const title = (provider && provider.displayName) || quotaState.planName || '';
  const badge = quotaState.planName && quotaState.planName !== title
    ? planBadgeLabel(quotaState.planName)
    : null;
  return (
    <div className="quota-card">
      <div className="quota-card-head">
        <span className="quota-card-plan">{title}</span>
        {badge ? <span className="quota-card-plan-badge">{badge}</span> : null}
      </div>
      {windows.map((w) => (
        <WindowBar key={(w.name || '') + w.kind} kind={w.kind} name={w.name} used={w.used} limit={w.limit} remaining={w.remaining} resetsAt={w.resetsAt} />
      ))}
      {quotaState.billingMode === 'subscription' && quotaState.billingCycleEnd ? (
        <div className="quota-card-cycle">订阅续费日:{quotaState.billingCycleEnd}</div>
      ) : null}
    </div>
  );
}
