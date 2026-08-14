// Provider 领域模型定义:纯 JSDoc 类型注释 + 工厂函数,无网络/IO 逻辑。

/**
 * @typedef {Object} UsageRecord
 * @property {string} provider  - provider id ('deepseek'|'codex'|'kimi'|'dsh')
 * @property {string} date      - 'YYYY-MM-DD'(本地时区)
 * @property {string} model     - 模型名
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedTokens
 * @property {number} cost
 * @property {string} currency
 * @property {number} [ts]                - dsh 记录:epoch 毫秒(dsh 用 ts 而非 date)
 * @property {object} [usage]             - dsh 记录:{ input, cached, output, total }
 * @property {string} [eventFingerprint]  - dsh 记录:去重指纹
 */

/**
 * @typedef {Object} ScanBatch
 * @property {UsageRecord[]} records - 本轮新扫描到的记录
 * @property {boolean} complete      - 是否已覆盖扫描开始时的完整文件快照
 * @property {number} bytesRead      - 本轮实际读取的字节数
 */

/**
 * @typedef {Object} QuotaWindow
 * @property {'5h'|'weekly'} kind
 * @property {number} used
 * @property {number} limit
 * @property {number} remaining
 * @property {number} resetsAt  - epoch ms
 */

/**
 * @typedef {Object} QuotaState
 * @property {string} provider
 * @property {'prepaid'|'subscription'} billingMode
 * @property {QuotaWindow[]|null} windows
 * @property {{total:number,granted:number,toppedUp:number,currency:string}|null} balance
 * @property {string|null} planName
 * @property {number|null} billingCycleEnd  - epoch ms
 * @property {number} fetchedAt             - epoch ms
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {string} displayName
 * @property {{balance:boolean,webUsage:boolean,quota:boolean,localLog:boolean,realtimeProxy:boolean}} capabilities
 * @property {(ctx:ProviderContext)=>'ok'|'expired'|'missing'} authStatus
 * @property {((ctx:ProviderContext)=>Promise<object|null>)} [fetchBalance]
 * @property {((ctx:ProviderContext,args:{month:number,year:number})=>Promise<object>)} [fetchUsage]
 * @property {((ctx:ProviderContext)=>Promise<QuotaState|null>)} [fetchQuota]
 * @property {((ctx:ProviderContext,args?:{sinceMs?:number,retainAll?:boolean,mode?:'legacy'|'uuid'})=>Promise<ScanBatch|UsageRecord[]>)} [readLocalLog]
 */

/**
 * @typedef {Object} ProviderContext
 * @property {{get:(k:string)=>any,set:(k:string,v:any)=>void,delete:(k:string)=>void}} store
 * @property {(url:string,headers?:Object,proxyUrl?:string|null)=>Promise<any>} httpGet
 * @property {()=>string|null} getProxyUrl
 * @property {{log:(...a:any[])=>void,error:(...a:any[])=>void}} logger
 */

function makeQuotaWindow(kind, used, limit, remaining, resetsAt) {
  return { kind: kind, used: used, limit: limit, remaining: remaining, resetsAt: resetsAt };
}

function makeQuotaState(provider, billingMode, windows, balance, planName, billingCycleEnd, fetchedAt) {
  return {
    provider: provider,
    billingMode: billingMode,
    windows: windows,
    balance: balance || null,
    planName: planName || null,
    billingCycleEnd: billingCycleEnd || null,
    fetchedAt: fetchedAt || Date.now()
  };
}

module.exports = { makeQuotaWindow, makeQuotaState };
