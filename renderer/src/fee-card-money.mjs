const CURRENCY_SYMBOLS = Object.freeze({
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  SGD: 'S$',
  KRW: '₩'
});

function normalizeCurrency(currency) {
  const code = typeof currency === 'string'
    ? currency.trim().toUpperCase()
    : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function amountText(amount) {
  return amount === null || amount === undefined || amount === ''
    ? '--'
    : String(amount);
}

export function formatCurrencyAmount(currency, amount) {
  const code = normalizeCurrency(currency);
  const value = amountText(amount);
  if (!code) return value;

  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${value}` : `${code} ${value}`;
}
