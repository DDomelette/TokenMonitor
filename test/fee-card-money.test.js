const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMoney() {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '../renderer/src/fee-card-money.mjs')
  );
  moduleUrl.searchParams.set('test', String(Date.now()) + Math.random());
  return import(moduleUrl.href);
}

test('known currencies use their common symbols', async () => {
  const { formatCurrencyAmount } = await loadMoney();

  assert.equal(formatCurrencyAmount('CNY', '10.00'), '¥10.00');
  assert.equal(formatCurrencyAmount('USD', '10.00'), '$10.00');
  assert.equal(formatCurrencyAmount('EUR', '10.00'), '€10.00');
  assert.equal(formatCurrencyAmount('sgd', '10.00'), 'S$10.00');
});

test('an unmapped valid ISO currency is shown as an uppercase code', async () => {
  const { formatCurrencyAmount } = await loadMoney();

  assert.equal(formatCurrencyAmount('xyz', '10.00'), 'XYZ 10.00');
});

test('zero amounts are present rather than placeholders', async () => {
  const { formatCurrencyAmount } = await loadMoney();

  assert.equal(formatCurrencyAmount('CNY', 0), '¥0');
  assert.equal(formatCurrencyAmount('USD', '0'), '$0');
  assert.equal(formatCurrencyAmount('XYZ', 0), 'XYZ 0');
});

test('only null, undefined, and empty amounts use the missing placeholder', async () => {
  const { formatCurrencyAmount } = await loadMoney();

  assert.equal(formatCurrencyAmount('CNY', null), '¥--');
  assert.equal(formatCurrencyAmount('USD', undefined), '$--');
  assert.equal(formatCurrencyAmount('XYZ', ''), 'XYZ --');
  assert.equal(formatCurrencyAmount('', '10.00'), '10.00');
  assert.equal(formatCurrencyAmount('not-a-code', '10.00'), '10.00');
});

test('FeeCard formats total, topped-up, and granted balances through one helper', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/FeeCard.jsx'),
    'utf8'
  );

  assert.match(source, /import \{ formatCurrencyAmount \} from '\.\.\/fee-card-money\.mjs';/);
  assert.match(source, /formatCurrencyAmount\(balance\.currency, balance\.total\)/);
  assert.match(source, /formatCurrencyAmount\(balance\.currency, balance\.toppedUp\)/);
  assert.match(source, /formatCurrencyAmount\(balance\.currency, balance\.granted\)/);
  assert.doesNotMatch(source, /balance\.(?:total|toppedUp|granted)\s*\|\|\s*'--'/);
});
