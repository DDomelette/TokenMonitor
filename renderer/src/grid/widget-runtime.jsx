// 注册表的运行时半边：同类组件共享数据订阅和渲染入口，Dashboard 不再按 id 拼结构。
import React, { useEffect } from 'react';
import { list, get, registerRuntime, getRuntime } from './components.js';
import { send } from '../api.js';
import { useDashboard, useProviders } from '../store.js';
import FeeCard from '../components/FeeCard.jsx';
import ChartWidget from '../components/ChartWidget.jsx';
import QuotaCard from '../components/QuotaCard.jsx';
import TokenHeatmap from '../components/TokenHeatmap.jsx';
import ProviderBar from '../components/ProviderBar.jsx';
import TokenSpeedCard from '../components/TokenSpeedCard.jsx';

function useDeepSeekDashboard(onContentChange) {
  const dashboard = useDashboard('deepseek');
  useEffect(() => {
    if (onContentChange) onContentChange();
  }, [dashboard, onContentChange]);
  return dashboard;
}

function FeeWidget({ id, onContentChange }) {
  const dashboard = useDeepSeekDashboard(onContentChange);
  return (
    <FeeCard
      id={id}
      balance={dashboard ? dashboard.balance : null}
      stats={dashboard ? dashboard.stats : null}
    />
  );
}

function UsageChartWidget({ id, onContentChange }) {
  const dashboard = useDeepSeekDashboard(onContentChange);
  // Token 与费用曲线统一使用 DeepSeek 官网数据，Harness 不能再次累加。
  return <ChartWidget id={id} dashboard={dashboard} />;
}

function QuotaWidget({ definition, onContentChange }) {
  const providers = useProviders();
  useEffect(() => {
    if (onContentChange) onContentChange();
  }, [providers, onContentChange]);
  const provider = providers.find((candidate) => candidate.id === definition.providerId);
  if (!provider) return <div className="embed-empty">未检测到 {definition.providerId} 数据源</div>;
  return (
    <QuotaCard
      provider={provider}
      quotaState={provider.quota}
      authStatus={provider.authStatus}
      quotaFetchedAt={provider.quotaFetchedAt}
      onRetry={() => send('refresh:dashboard')}
    />
  );
}

const runtimeComponents = {
  fee: FeeWidget,
  quota: QuotaWidget,
  'usage-chart': UsageChartWidget,
  'provider-bar': ProviderBar,
  'token-speed': TokenSpeedCard,
  heatmap: TokenHeatmap
};

list().forEach((definition) => {
  const Component = runtimeComponents[definition.renderer];
  if (!Component) throw new Error('Unknown component renderer: ' + definition.renderer);
  registerRuntime(definition.id, { Component });
});

export default function RegisteredWidgetBody({ id, onContentChange }) {
  const definition = get(id);
  const runtime = getRuntime(id);
  const Component = runtime && runtime.Component;
  if (!definition || !Component) return <div className="embed-empty">组件未注册：{id}</div>;
  return <Component id={id} definition={definition} onContentChange={onContentChange} />;
}
