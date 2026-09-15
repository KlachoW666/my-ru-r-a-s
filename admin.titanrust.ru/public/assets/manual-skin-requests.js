import {d as defineComponent,e as h,j as ref,a5 as request,k as onMounted} from './index-D4siiPNB.js';

export default defineComponent({
  name:'ManualSkinRequests',
  setup(){
    const rows=ref([]),error=ref(''),busy=ref(false),refs=ref({});
    async function load(){
      try{const result=await request({url:'/wallet/skin-requests',method:'GET'});rows.value=result.data||[];}
      catch(e){error.value=e.response?.data?.message||'Не удалось загрузить заявки';}
    }
    async function act(row,decision){
      if(busy.value)return;
      busy.value=true;error.value='';
      try{await request({url:`/wallet/skin-requests/${row.id}/${decision}`,method:'POST',data:{deliveryRef:refs.value[row.id]||''}});await load();}
      catch(e){error.value=e.response?.data?.message||'Не удалось обработать заявку';await load();}
      finally{busy.value=false;}
    }
    onMounted(load);
    const button=(label,click)=>h('button',{class:'rounded-md border px-3 py-2 text-sm disabled:opacity-50',disabled:busy.value,onClick:click},label);
    const states={pending:'Ждёт проверки',processing:'В обработке',approved:'Отправлено',rejected:'Отклонено',cancelled:'Отменено игроком'};
    return()=>h('section',{class:'space-y-4 rounded-xl border bg-card p-6 mb-6'},[
      h('div',{class:'flex items-center justify-between gap-4'},[h('h2',{class:'text-xl font-semibold'},'Заявки на скины за баланс'),button('Обновить',load)]),
      h('p',{class:'text-sm text-muted-foreground'},'Ручная отправка. Сначала возьмите заявку в работу — отмена игроком заблокируется. Подтверждайте отправку только после завершения обмена Steam. Отклонение возвращает деньги.'),
      error.value?h('p',{role:'alert',class:'text-destructive'},error.value):null,
      !rows.value.length?h('p',{class:'text-muted-foreground'},'Заявок пока нет'):null,
      ...rows.value.map(row=>h('article',{key:row.id,class:'space-y-3 rounded-lg border p-4'},[
        h('div',{class:'flex flex-wrap justify-between gap-2'},[h('strong',null,`№${row.id} · ${row.username||row.user_id}`),h('span',null,`${row.amount.toLocaleString('ru-RU')} ₽ · ${states[row.status]||row.status}`)]),
        h('ul',{class:'text-sm space-y-1'},row.items.map(i=>h('li',{key:i.name},`${i.name} × ${i.count} — ${i.priceRub} ₽ / шт.`))),
        ['pending','processing'].includes(row.status)?h('div',{class:'flex flex-wrap gap-2 items-center'},[
          row.status==='pending'?button('Взять в работу',()=>act(row,'claim')):null,
          row.status==='processing'?h('a',{href:row.trade_link,target:'_blank',rel:'noopener noreferrer',class:'underline'},'Открыть обмен Steam'):null,
          row.status==='processing'?h('input',{type:'url',class:'rounded-md border bg-background px-3 py-2 text-sm',placeholder:'Ссылка завершённого обмена',value:refs.value[row.id]||'',onInput:e=>refs.value[row.id]=e.target.value}):null,
          row.status==='processing'?button('Подтвердить отправку',()=>act(row,'approve')):null,
          button('Отклонить и вернуть деньги',()=>act(row,'reject'))
        ]):null,
        row.delivery_ref?h('p',{class:'text-sm break-all'},`Обмен: ${row.delivery_ref}`):null
      ]))
    ]);
  }
});
