import {a as defineComponent,s as h,r as ref} from './vendor-vNcy1sFx.js';
export default defineComponent({
  name:'ManualSkinQueue',props:{requests:{type:Array,default:()=>[]},cancel:{type:Function,required:true}},
  setup(props){
    const busy=ref(''),error=ref('');
    async function cancel(row){
      if(busy.value)return;busy.value=row.request_id;error.value='';
      try{await props.cancel(row.request_id);}catch(e){error.value=e.message||'Не удалось отменить заявку';}finally{busy.value='';}
    }
    return()=>h('div',{class:'wl-cart manual-skin-queue'},[
      h('h2',null,'Ваши заявки'),
      error.value?h('p',{role:'alert',class:'wl-note'},error.value):null,
      ...props.requests.map(row=>h('article',{key:row.request_id,class:'manual-skin-request'},[
        h('strong',null,row.status==='processing'?'Администратор готовит обмен':'Ожидает проверки'),
        h('p',null,`${row.skins_count} предметов · ${Number(row.amount_rub).toLocaleString('ru-RU')} ₽`),
        h('p',{class:'wl-note'},row.can_cancel?'Сумма зарезервирована. До начала обработки можно отменить заявку.':'Отправка выполняется вручную. Ожидайте предложения обмена в Steam.'),
        row.can_cancel?h('button',{class:'wl-cta',type:'button',disabled:!!busy.value,onClick:()=>cancel(row)},busy.value===row.request_id?'Отмена…':'Отменить и вернуть баланс'):null
      ]))
    ]);
  }
});
