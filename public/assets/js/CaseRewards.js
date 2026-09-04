import { a as defineComponent, r as ref, s as h } from './vendor-vNcy1sFx.js';
import { c as request } from './mutator-DePLmT3f.js';

// This readable component is attached to the compiled CasePage. Port it to the
// Vue source before rebuilding that bundle.
export default defineComponent({
  name: 'CaseRewards',
  props: { result: { type: Object, required: true } },
  emits: ['sold'],
  setup(props, { emit }) {
    const pending=ref(false), sale=ref(null), error=ref('');
    const money=n=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+' ₽';
    async function sell() {
      if(pending.value||sale.value) return;
      const ids=props.result.inventoryIds;
      if(!Array.isArray(ids)||!ids.length) return;
      pending.value=true;error.value='';
      try {
        const response=await request({url:'/inventory/sell',method:'POST',data:{ids}});
        if(response.status!=='success'||!response.data) throw new Error('Sale failed');
        sale.value=response.data;
        emit('sold',response.data);
      } catch(e) {
        error.value=e?.response?.data?.message || 'Не удалось продать предметы. Обновите инвентарь и попробуйте снова; повторное начисление исключено.';
      } finally { pending.value=false; }
    }
    return ()=>{
      const result=props.result;
      if(!result?.rewardDestination) return null;
      const inventory=result.rewardDestination==='inventory';
      const fee=Number(result.sellFeePercent)||0;
      const payout=Math.round(Math.round(Number(result.winnings)*100)*(1-fee/100))/100;
      return h('section',{class:'case-reward-destination',style:{padding:'16px',display:'flex',flexWrap:'wrap',gap:'12px',alignItems:'center',color:'var(--text-main)'},'aria-live':'polite'},[
        h('p',{style:{flex:'1 1 260px'}},sale.value
          ? `Продано. На баланс зачислено ${money(sale.value.payout)}.`
          : inventory
            ? `Скины на ${money(result.winnings)} добавлены в инвентарь. Баланс уменьшился на стоимость кейсов; стоимость скинов зачисляется только после продажи.`
            : `Выигрыш ${money(result.winnings)} автоматически зачислен на баланс.`),
        inventory&&!sale.value&&result.inventoryIds?.length
          ? h('button',{type:'button',class:'btn btn-primary',style:{padding:'12px 18px',borderRadius:'12px',background:'var(--accent-primary, var(--accent))',color:'var(--text-main)'},disabled:pending.value,onClick:sell},pending.value?'Продаём…':`Продать выигрыш за ${money(payout)}${fee?` (комиссия ${fee}%)`:''}`)
          : null,
        inventory ? h('a',{href:'/wallet/withdraw',style:{color:'var(--text-main)',textDecoration:'underline'}},'Открыть кошелёк') : null,
        error.value?h('p',{role:'alert',style:{flexBasis:'100%'}},error.value):null
      ]);
    };
  }
});
