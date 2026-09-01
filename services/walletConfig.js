'use strict';

/**
 * Конфигурация кошелька для фронта.
 *
 * Было: сервер отдавал свою форму — `{balance, paymentMethods, withdrawMethods,
 * depositPresets, minDeposit}`. Фронт её не понимает вовсе, поэтому список
 * стран выходил пустым, а под ним висело «Для выбранной страны нет доступных
 * способов пополнения». Вкладка вывода не рисовалась совсем.
 *
 * Контракт снят с бандла (index-BTskI3-A.js, стор кошелька), а не придуман:
 *
 *   walletConfig.countries              -> configCountries
 *   walletConfig.deposit.methods        -> configDepositMethods
 *   walletConfig.deposit.presets        -> configDepositPresets
 *   walletConfig.deposit.bonus.percent  -> depositBonusPercent
 *   walletConfig.deposit.personalization
 *   walletConfig.withdraw.methods       -> configWithdrawMethods
 *   walletConfig.commission.deposit     -> depositRate()
 *   walletConfig.commission.withdraw    -> withdrawRate()
 *   walletConfig.rates, .usdRubRate, .bynRubRate*
 *
 * Осторожно: `deposit.bonus.percent` и `withdraw.methods` читаются БЕЗ
 * опциональной цепочки. Если `deposit` или `withdraw` не окажется объектом,
 * стор упадёт с TypeError, и страница останется пустой. Поэтому обе ветки
 * присутствуют всегда, даже когда способов ноль.
 *
 * Как фронт разбирает способ оплаты (WalletPage-xHnuX8Qj.js):
 *   category === 'cards'          -> плитка «Фиат», внутри подвкладки
 *   providers.includes('erip')    -> подвкладка ERIP, показывается только для BY
 *   providers.includes('sbp')     -> подвкладка СБП
 *   иначе                         -> подвкладка «Карта»
 *   category 'crypto' | 'skins' | 'giftcards' -> отдельные плитки
 */

/** Категория плитки по коду метода из wallet_methods. */
function categoryOf(code) {
  const c = String(code || '').toLowerCase();
  if (c.includes('crypto')) return 'crypto';
  if (c.includes('skin')) return 'skins';
  if (c.includes('gift')) return 'giftcards';
  return 'cards';
}

/**
 * Платёжные системы метода. Из них фронт выводит подвкладку и рисует значки:
 * значок показывается только у известных ему провайдеров.
 */
function providersOf(code) {
  const c = String(code || '').toLowerCase();
  if (c.startsWith('sbp')) return ['sbp'];
  if (c.startsWith('erip')) return ['erip'];
  if (c.includes('crypto')) return ['usdt', 'eth', 'ltc'];
  if (c.includes('skin')) return ['steam'];
  return ['visa', 'mastercard', 'mir'];
}

function makeWalletConfig({ queryAdminDb, adminSetting }) {

  /** Строка wallet_methods -> способ в форме, понятной бандлу. */
  function toMethod(row, kind) {
    const category = categoryOf(row.code);
    return {
      id: `${kind}_${row.code}`,
      code: row.code,
      category,
      enabled: row.enabled !== 0,
      label: row.name || row.code,
      icon: row.icon || null,
      providers: providersOf(row.code),
      // groupKey пустой — фронт выведет его сам из провайдеров.
      groupKey: '',
      variant: null,
      // Процессор важен: 'BETATRANSFER' включает во фронте отдельную ветку
      // с украинскими и казахскими подметодами. Нам она не нужна.
      processor: 'ROLLYPAY',
      amountCurrency: 'RUB',
      providerToRubRate: '1',
      minAmount: Number(row.min_amount) || 0,
      maxAmount: Number(row.max_amount) || 0,
      feePercent: Number(row.fee_percent) || 0
    };
  }

  async function build({ country } = {}) {
    const [countries, methods, presets, rates] = await Promise.all([
      queryAdminDb(`SELECT code, name, currency FROM wallet_countries WHERE enabled = 1 ORDER BY id ASC`),
      queryAdminDb(`SELECT * FROM wallet_methods WHERE enabled = 1 ORDER BY kind ASC, position ASC`),
      queryAdminDb(`SELECT amount, bonus_percent FROM deposit_presets WHERE enabled = 1 ORDER BY position ASC`),
      queryAdminDb(`SELECT currency, rate, updated_at FROM wallet_rates`)
    ]);

    const limits = await adminSetting('wallet_config', {});

    const depositRows = methods.filter(m => m.kind === 'deposit');
    const withdrawRows = methods.filter(m => m.kind === 'withdraw');

    const depositMethods = depositRows.map(r => toMethod(r, 'deposit'));
    const withdrawMethods = withdrawRows.map(r => toMethod(r, 'withdraw'));

    // Вывод скинов идёт не через wallet_methods, а через инвентарь, но вкладка
    // «Rust скины» на фронте ищет способ с category 'skins'. Без него вкладка
    // висит пустой, хотя инвентарь работает.
    if (!withdrawMethods.some(m => m.category === 'skins')) {
      withdrawMethods.push({
        id: 'withdraw_skins', code: 'skins', category: 'skins', enabled: true,
        label: 'Rust скины', icon: '/assets/wallet/pm-skins.svg',
        providers: ['steam'], groupKey: '', variant: null, processor: 'INTERNAL',
        amountCurrency: 'RUB', providerToRubRate: '1',
        minAmount: Number(limits.minWithdraw ?? 0), maxAmount: 0, feePercent: 0
      });
    }

    const rateMap = {};
    for (const r of rates) rateMap[String(r.currency).toUpperCase()] = Number(r.rate) || 0;
    const usdRub = rateMap.USD || Number(process.env.USD_RUB_RATE) || 0;
    const bynRub = rateMap.BYN || 0;

    // Курс пересчёта суммы в зачисление. Единица — «сколько заказал, столько и
    // получил». Комиссию площадка платит сама, у RollyPay она удерживается из
    // платежа.
    const depositRates = {};
    for (const m of depositMethods) depositRates[m.category] = '1';
    const withdrawRates = {};
    for (const m of withdrawMethods) withdrawRates[m.category] = '1';

    const bonusPercent = Number(limits.depositBonusPercent ?? 0);

    return {
      countries: countries.map(c => ({
        code: String(c.code).toUpperCase(),
        label: c.name,
        currency: c.currency || 'RUB'
      })),
      // deposit и withdraw обязаны быть объектами: стор читает
      // deposit.bonus.percent и withdraw.methods без опциональной цепочки.
      deposit: {
        methods: depositMethods,
        presets: presets.map(p => ({
          amount: Number(p.amount) || 0,
          bonus: Number(p.bonus_percent) || 0,
          bonusPercent: Number(p.bonus_percent) || 0
        })),
        bonus: { percent: bonusPercent },
        personalization: null,
        min: Number(limits.minDeposit ?? 100),
        max: Number(limits.maxDeposit ?? 150000)
      },
      withdraw: {
        methods: withdrawMethods,
        min: Number(limits.minWithdraw ?? 500)
      },
      commission: { deposit: depositRates, withdraw: withdrawRates },
      rates: rateMap,
      usdRubRate: usdRub,
      // Беларусь: фронт показывает курс, только если он объявлен доступным.
      bynRubRate: bynRub ? String(bynRub) : '',
      bynRubRateAvailable: bynRub > 0,
      bynRubQuotedAt: bynRub ? (rates.find(r => String(r.currency).toUpperCase() === 'BYN')?.updated_at || '') : '',
      selectedCountry: country ? String(country).toUpperCase() : null,
      currency: 'RUB'
    };
  }

  return { build, categoryOf, providersOf };
}

module.exports = { makeWalletConfig };
