// Presentational components only. Games, wallet, catalog and rewards use existing stores.
import {e as element, s as component, ag as RouterLink, r as ref, N as onMounted} from './vendor-vNcy1sFx.js';
import {u as useDepositChain} from './useDepositChain-CTOMFCQw.js';

const link = (to, label, className) => component(RouterLink, {to, class: className}, {default: () => label});
const number = value => Number(value || 0).toLocaleString('ru-RU', {maximumFractionDigits: 0});
export const WorkshopLadder = {
  name: 'BearzWorkshopLadder',
  setup() {
    const chain = useDepositChain();
    const collapsed = ref(false);
    onMounted(() => chain.stateQuery.refetch());
    return () => {
      if (!chain.showLadder.value) return null;
      const tiers = chain.tierViews.value;
      const ready = chain.activeTier.value?.status === 'ready';
      const complete = chain.completed.value;
      return element('section', {class: 'bz-ladder', 'aria-label': 'Бесплатные кейсы за депозит', 'data-testid': 'deposit-chain'}, [
        element('header', {class: 'bz-ladder-head'}, [
          element('div', null, [element('p', {class: 'bz-eyebrow'}, 'ПУТЬ МЕДВЕДЯ'), element('h2', null, 'Бесплатные кейсы за депозит')]),
          element('button', {type: 'button', class: 'bz-ladder-toggle', 'aria-expanded': !collapsed.value, 'aria-controls': 'bz-ladder-body', onClick: () => {collapsed.value = !collapsed.value;}}, collapsed.value ? 'Развернуть ↓' : 'Свернуть ↑')
        ]),
        collapsed.value ? null : element('div', {id: 'bz-ladder-body', class: 'bz-ladder-body'}, [
          element('ol', {class: 'bz-steps'}, tiers.map((tier, index) => {
            const status = tier.status;
            const caption = status === 'opened' ? 'Получен ✓' : status === 'ready' ? 'Открыть →' : `Депозит ${number(tier.thresholdNum)}`;
            const content = [
              element('span', {class: 'bz-step-number'}, String(index + 1).padStart(2, '0')),
              element('img', {src: tier.caseImage, alt: '', class: 'bz-step-art', loading: 'lazy'}),
              element('strong', null, tier.caseName),
              element('span', {class: 'bz-step-status'}, caption)
            ];
            return element('li', {key: tier.tierIndex, class: `bz-step is-${status}`}, [
              tier.caseSlug ? component(RouterLink, {to: `/cases/${tier.caseSlug}`, 'aria-label': `${tier.caseName}: ${caption}`}, {default: () => content}) : element('div', {class: 'bz-step-unavailable'}, content)
            ]);
          })),
          element('aside', {class: 'bz-ladder-progress'}, [
            element('span', null, complete ? 'Путь пройден' : ready ? 'Кейс готов к открытию' : 'До следующего кейса'),
            element('strong', null, complete ? `${tiers.length} / ${tiers.length}` : ready ? 'Можно забирать' : `${number(chain.activeCollected.value)} / ${number(chain.activeThreshold.value)}`),
            element('div', {class: 'bz-progress-track', role: 'progressbar', 'aria-label': 'Прогресс депозита', 'aria-valuenow': complete || ready ? 100 : Math.round(chain.activeProgress.value * 100), 'aria-valuemin': 0, 'aria-valuemax': 100}, [element('i', {style: {width: `${complete || ready ? 100 : chain.activeProgress.value * 100}%`}})]),
            link('/wallet', 'Пополнить →', 'bz-primary')
          ])
        ])
      ]);
    };
  }
};
export const WorkshopHero = {
  name: 'BearzWorkshopHero',
  setup() {
    return () => element('section', {class: 'bz-hero', 'aria-labelledby': 'bz-title'}, [
      element('img', {class: 'bz-hero-art', src: '/image/bear-gunsmith-banner-1470x630.png', alt: '', fetchpriority: 'high'}),
      element('div', {class: 'bz-hero-copy'}, [
        element('p', {class: 'bz-eyebrow'}, 'BEARZ / МАСТЕРСКАЯ RUST'),
        element('h1', {id: 'bz-title'}, ['ХОРОШИЙ ЛУТ.', element('br'), element('span', null, 'МЕДВЕЖИЙ ХАРАКТЕР.')]),
        element('p', {class: 'bz-intro'}, 'От первого костра до большого рейда. Выбирай кейс, собирай свою коллекцию и встречай соперников на арене.'),
        element('a', {href: '#bearz-catalog', class: 'bz-primary'}, 'В мастерскую ↗'),
        element('span', {class: 'bz-hero-note'}, 'КЕЙСЫ / БАТЛЫ / АПГРЕЙД')
      ])
    ]);
  }
};
export const WorkshopModes = {
  name: 'BearzWorkshopModes',
  setup() {
    return () => element('section', {class: 'bz-modes', 'aria-label': 'Игровые режимы'}, [
      element('article', null, [
        element('p', {class: 'bz-eyebrow'}, '01 / АРЕНА'),
        element('h2', null, 'Один на один. Медведь на медведя.'),
        element('p', null, 'Батлы на кейсах и апгрейдах — выбирай свой формат.'),
        element('div', {class: 'bz-mode-links'}, [link('/crate-pvp', 'Батлы на кейсах ↗'), link('/crate-pvp?mode=upgrade', 'Батлы на апгрейдах ↗')])
      ]),
      element('article', null, [
        element('p', {class: 'bz-eyebrow'}, '02 / ВЕРСТАК'),
        element('h2', null, 'Твой следующий уровень.'),
        element('p', null, 'Выбирай цель и проверяй условия перед запуском апгрейда.'),
        element('div', {class: 'bz-mode-links'}, [link('/upgrader', 'Открыть апгрейдер ↗')])
      ])
    ]);
  }
};
