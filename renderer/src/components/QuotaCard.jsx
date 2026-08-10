// 订阅制额度卡片:由 windows 数组驱动(不写死两条);subscription 模式不显示任何金额;
// authStatus==='expired' 时替换为重试入口(凭证由本机 CLI 维护,应用只读无法代授权,
// 按钮只做立即重试,提示用户先去终端跑一次对应 CLI)。
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

// Kimi 套餐名是音乐术语(andante/moderato/allegretto/allegro),首字母大写原样展示
function kimiPlanLabel(planName) {
  const p = (planName || '').trim();
  if (!p) return null;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

export default function QuotaCard({ provider, quotaState, authStatus, onRetry }) {
  if (authStatus === 'expired') {
    return (
      <div className="quota-card quota-expired">
        <div className="quota-card-head">
          <span className="quota-card-plan">{provider ? provider.displayName : ''} 登录已过期</span>
        </div>
        <button className="quota-reauth-btn" onClick={onRetry}>立即重试</button>
        <div className="quota-reauth-hint">凭证由本机 {provider ? provider.id : ''} CLI 维护,请先在终端运行一次 {provider ? provider.id : ''},再点此重试</div>
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
  const isKimi = !!(provider && provider.id === 'kimi');
  const badge = !isKimi && quotaState.planName && quotaState.planName !== title
    ? planBadgeLabel(quotaState.planName)
    : null;
  const kimiPlan = isKimi ? kimiPlanLabel(quotaState.planName) : null;
  return (
    <div className="quota-card">
      <div className="quota-card-head">
        <span className="quota-card-plan">{title}</span>
        {badge ? <span className="quota-card-plan-badge">{badge}</span> : null}
        {kimiPlan ? <span className="quota-card-plan-kimi">{kimiPlan}</span> : null}
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
