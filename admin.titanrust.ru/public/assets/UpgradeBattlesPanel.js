import {d as defineComponent,j as ref,e as h,k as onMounted,G as onUnmounted,a5 as request} from "./index-D4siiPNB.js";

// Readable extension to the compiled admin page. Keep this wrapper when rebuilding.
const ROOT = '/upgrade-battles';
const STATUS = {waiting:'Ожидает соперника',finished:'Завершён',cancelled:'Отменён'};
const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';
const percent = v => v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v)*100).toLocaleString('ru-RU',{maximumFractionDigits:4})+'%';
const date = v => !v || Number.isNaN(new Date(v).getTime()) ? '—' : new Date(v).toLocaleString('ru-RU');
function numeric(v,min,max,label){
 if(!['string','number'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max)throw Error(label+': значение от '+min+' до '+max);
 return Number(v);
}
export function configPayload(form){
 if(typeof form.enabled!=='boolean')throw Error('Укажите состояние режима');
 const rtp=numeric(form.rtpPercent,1,100,'RTP (%)')/100;
 const minRoundBet=numeric(form.minRoundBet,.01,10000,'Минимум за раунд');
 const maxRoundBet=numeric(form.maxRoundBet,.01,10000,'Максимум за раунд');
 for(const value of [minRoundBet,maxRoundBet])if(Math.abs(value*100-Math.round(value*100))>.00001)throw Error('Суммы: не более двух знаков после запятой');
 const waitSeconds=numeric(form.waitSeconds,30,86400,'Время ожидания');
 if(!Number.isInteger(waitSeconds))throw Error('Время ожидания должно быть целым числом секунд');
 if(minRoundBet>maxRoundBet)throw Error('Минимальная ставка выше максимальной');
 return {enabled:form.enabled,rtp,minRoundBet,maxRoundBet,waitSeconds};
}
function formFrom(config){
 const form={enabled:config?.enabled,rtpPercent:config?.rtp==null?'':Number(config.rtp)*100,minRoundBet:config?.minRoundBet,maxRoundBet:config?.maxRoundBet,waitSeconds:config?.waitSeconds};
 configPayload(form);return form;
}
function payload(response){
 if(!response||response.catchAll||response.success===false||response.data==null)throw Error(response?.message||'API апгрейд-батлов недоступен: проверьте обновление сервера');
 return response.data;
}
function errorText(error){
 const body=error?.response?.data;
 return body?.message||body?.error?.message||(typeof body?.error==='string'?body.error:null)||
  (error?.response?.status===403?'Недостаточно прав для этого действия':error?.message)||'Не удалось выполнить запрос. Повторите попытку.';
}
export function createAdminBattleModel(send=request){
 const state=ref({form:null,configLoading:false,saving:false,configError:'',notice:'',history:false,battles:null,listLoading:false,listError:'',search:'',selectedUid:null,battle:null,detailLoading:false,detailError:''});
 let listVersion=0,detailVersion=0,disposed=false;
 async function loadConfig(){
  if(state.value.configLoading||state.value.saving)return;
  state.value.configLoading=true;state.value.configError='';
  try{const form=formFrom(payload(await send({url:ROOT+'/config',method:'GET'})));if(!disposed)state.value.form=form;}
  catch(e){if(!disposed)state.value.configError=errorText(e);}
  finally{if(!disposed)state.value.configLoading=false;}
 }
 async function saveConfig(){
  const s=state.value;if(s.saving||s.configLoading||!s.form)return;
  s.configError='';s.notice='';
  try{
   const data=configPayload(s.form);s.saving=true;
   const form=formFrom(payload(await send({url:ROOT+'/config',method:'PUT',data})));
   if(!disposed){s.form=form;s.notice='Настройки сохранены. Уже созданные батлы сохраняют свои цены и RTP.';}
  }catch(e){if(!disposed)s.configError=errorText(e);}
  finally{if(!disposed)s.saving=false;}
 }
 async function loadList(history=state.value.history){
  const version=++listVersion,s=state.value;s.history=!!history;s.listLoading=true;s.listError='';s.battles=null;
  try{
   const data=payload(await send({url:ROOT,method:'GET',params:{history:!!history}}));
   if(!Array.isArray(data.battles))throw Error('Некорректный ответ списка батлов');
   if(!disposed&&version===listVersion)s.battles=data.battles;
  }catch(e){if(!disposed&&version===listVersion)s.listError=errorText(e);}
  finally{if(!disposed&&version===listVersion)s.listLoading=false;}
 }
 async function openBattle(uid){
  const version=++detailVersion,s=state.value;s.selectedUid=uid;s.battle=null;s.detailError='';s.detailLoading=true;
  try{
   const b=payload(await send({url:ROOT+'/'+encodeURIComponent(uid),method:'GET'})).battle;
   if(!b||!Array.isArray(b.players)||!Array.isArray(b.targets)||!Array.isArray(b.rounds))throw Error('Некорректный ответ деталей батла');
   if(!disposed&&version===detailVersion)s.battle=b;
  }catch(e){if(!disposed&&version===detailVersion)s.detailError=errorText(e);}
  finally{if(!disposed&&version===detailVersion)s.detailLoading=false;}
 }
 function closeBattle(){detailVersion++;Object.assign(state.value,{selectedUid:null,battle:null,detailError:'',detailLoading:false});}
 function dispose(){disposed=true;listVersion++;detailVersion++;}
 return {state,loadConfig,saveConfig,loadList,openBattle,closeBattle,dispose};
}
const button=(label,fn,props={})=>h('button',{type:'button',onClick:fn,...props},label);
const alert=text=>text?h('p',{class:'aub-error',role:'alert'},text):null;
const pair=(label,value)=>h('div',{class:'aub-pair'},[h('dt',null,label),h('dd',null,value)]);
function proof(label,value){return h('label',{class:'aub-proof'},[h('span',null,label),h('textarea',{readonly:true,rows:2,value:value||'Будет раскрыт после завершения или отмены батла','aria-label':label})]);}
function battleDetails(b){
 return h('div',{class:'aub-detail'},[
  h('h3',null,'Матч '+b.uid),
  h('dl',{class:'aub-summary'},[
   pair('Статус',STATUS[b.status]||b.status),pair('Вход с игрока',money(b.entryPrice)),pair('Ставка за раунд',money(b.roundBet)),
   pair('Зафиксированный RTP',percent(b.rtp)),pair('Сумма успешных апгрейдов',money(b.pot)),
   pair('Создан',date(b.createdAt)),pair('Ожидание до',date(b.expiresAt)),pair('Завершён / отменён',date(b.finishedAt))
  ]),
  b.cancelReason?h('p',null,'Причина отмены: '+b.cancelReason):null,
  h('div',{class:'aub-players'},[0,1].map(slot=>{
   const p=b.players.find(p=>p.slot===slot);
   return h('section',{class:'aub-player'},p?[
    h('h4',null,p.name+' · ID '+p.userId),h('p',null,'Результат: '+money(p.score)),h('p',null,'Выплата: '+money(p.payout)),
    b.winnerUserIds?.includes(p.userId)?h('strong',null,'Победитель'):null,proof('Client seed · игрок '+(slot+1),p.clientSeed)
   ]:[h('h4',null,'Игрок '+(slot+1)),h('p',null,'Соперник ещё не присоединился')]);
  })),
  h('h3',null,'Три раунда · цены и шансы на момент создания'),
  h('div',{class:'aub-rounds'},[0,1,2].map(index=>{
   const target=b.targets[index];
   return h('section',{class:'aub-round','data-round':index},[
    h('h4',null,'Раунд '+(index+1)),h('p',null,target?.name||'Цель не получена'),
    h('p',null,'Цена: '+money(target?.price)+' · шанс: '+percent(target?.chance)),
    ...[0,1].map(slot=>{const r=b.rounds.find(r=>r.roundIndex===index&&r.slot===slot);const player=b.players.find(p=>p.slot===slot);
     return h('p',null,(player?.name||'Игрок '+(slot+1))+': '+(r?(r.won?'Успех · ':'Неудача · ')+money(r.value)+' · roll '+r.roll:'Нет результата'));
    })
   ]);
  })),
  h('h3',null,'Данные проверки результата'),
  proof('SHA-256 серверного сида (фиксация до игры)',b.serverHash),proof('Server seed',b.status==='waiting'?null:b.serverSeed),
  h('p',{class:'aub-muted'},'Показаны сохранённые значения сервера. Автоматическая криптографическая проверка на этой странице не выполняется. Выплата не прибавляется к стоимости предметов повторно.')
 ]);
}
export const UpgradeBattlesPanel=defineComponent({
 name:'UpgradeBattlesPanel',props:{model:{type:Object,default:null}},
 setup(props){
  const model=props.model||createAdminBattleModel();
  onMounted(()=>{model.loadConfig();model.loadList();});onUnmounted(()=>model.dispose());
  function input(field,label,min,max,step){const s=model.state.value;return h('label',{class:'aub-field'},[
   h('span',null,label),h('input',{type:'number',required:true,min,max,step,value:s.form[field],onInput:e=>{s.form[field]=e.target.value;s.notice='';}})
  ]);}
  return()=>{
   const s=model.state.value,search=s.search.trim().toLocaleLowerCase('ru');
   const rows=(s.battles||[]).filter(b=>!search||[b.uid,...b.players.flatMap(p=>[p.name,p.userId])].join(' ').toLocaleLowerCase('ru').includes(search));
   return h('div',{class:'aub-panel'},[
    h('section',{class:'aub-card'},[
     h('h2',null,'Настройки апгрейд-батлов'),h('p',{class:'aub-muted'},'Дуэль 1×1, три раунда. Одинаковые цели и RTP для обоих игроков. Лимиты ниже — за один раунд; вход равен трём ставкам.'),
     alert(s.configError),s.configLoading?h('p',{role:'status'},'Загрузка настроек…'):null,
     !s.form&&!s.configLoading?button('Повторить загрузку настроек',model.loadConfig):null,
     s.form?h('form',{onSubmit:e=>{e.preventDefault();model.saveConfig();}},[
      h('fieldset',{disabled:s.saving||s.configLoading},[
       h('legend',{class:'aub-muted'},'Изменения применяются только к новым батлам'),
       h('label',{class:'aub-toggle'},[h('input',{type:'checkbox',checked:s.form.enabled,onChange:e=>{s.form.enabled=e.target.checked;s.notice='';}}),h('span',null,'Режим включён')]),
       h('div',{class:'aub-fields'},[input('rtpPercent','RTP, %',1,100,.01),input('minRoundBet','Минимум за раунд, ₽',.01,10000,.01),input('maxRoundBet','Максимум за раунд, ₽',.01,10000,.01),input('waitSeconds','Ожидание соперника, секунд',30,86400,1)]),
       h('p',{class:'aub-muted'},'Право изменения проверяет сервер. При отказе настройки не считаются сохранёнными.'),
       h('button',{type:'submit',class:'aub-primary',disabled:s.saving||s.configLoading},s.saving?'Сохранение…':'Сохранить настройки')
      ])
     ]):null,
     s.notice?h('p',{role:'status'},s.notice):null
    ]),
    h('section',{class:'aub-card'},[
     h('div',{class:'aub-toolbar'},[h('h2',null,'История и ожидающие матчи'),button('Обновить',()=>model.loadList(),{disabled:s.listLoading})]),
     h('div',{class:'aub-toolbar'},[
      h('div',{class:'aub-switch','aria-label':'Период списка'},[button('Ожидающие',()=>model.loadList(false),{'aria-pressed':!s.history}),button('История',()=>model.loadList(true),{'aria-pressed':s.history})]),
      h('label',{class:'aub-field'},[h('span',null,'Поиск в загруженных матчах'),h('input',{type:'search',placeholder:'ID матча, имя или ID игрока',value:s.search,onInput:e=>s.search=e.target.value})])
     ]),
     alert(s.listError),s.listLoading?h('p',{role:'status'},'Загрузка матчей…'):null,
     s.battles!==null&&!s.listLoading?h('div',{class:'aub-table-scroll'},[h('table',null,[
      h('caption',null,'Показано '+rows.length+' из '+s.battles.length+' загруженных. API возвращает до 100 последних матчей выбранного типа.'),
      h('thead',null,[h('tr',null,['Матч','Статус','Игроки','Вход с игрока','Итоговая сумма','Создан','Ожидание до','Завершён','Действия'].map(t=>h('th',{scope:'col'},t)))]),
      h('tbody',null,rows.length?rows.map(b=>h('tr',{key:b.uid},[
       h('td',{class:'aub-id'},b.uid),h('td',null,STATUS[b.status]||b.status),h('td',null,b.players.map(p=>p.name+' (#'+p.userId+')').join(' / ')),
       h('td',null,money(b.entryPrice)),h('td',null,money(b.pot)),h('td',null,date(b.createdAt)),h('td',null,date(b.expiresAt)),h('td',null,date(b.finishedAt)),
       h('td',null,button('Подробнее',()=>model.openBattle(b.uid),{'aria-label':'Подробнее о матче '+b.uid}))
      ])):[h('tr',null,[h('td',{colspan:9},search?'Поиск не дал результатов':s.history?'Завершённых или отменённых матчей нет':'Ожидающих матчей нет')])])
     ])]):null
    ]),
    s.selectedUid?h('section',{class:'aub-card','aria-label':'Детали матча','aria-busy':s.detailLoading},[
     h('div',{class:'aub-toolbar'},[h('h2',null,'Детали матча'),button('Обновить матч',()=>model.openBattle(s.selectedUid),{disabled:s.detailLoading}),button('Закрыть детали',model.closeBattle)]),
     alert(s.detailError),s.detailLoading?h('p',{role:'status'},'Загрузка результатов…'):null,s.battle?battleDetails(s.battle):null
    ]):null
   ]);
  };
 }
});
export function withUpgradeBattles(CasePage){
 return defineComponent({name:'BattlesModesAdmin',setup(){
  const mode=ref('cases');
  return()=>h('div',{class:'aub-page'},[
   h('link',{rel:'stylesheet',href:'/assets/UpgradeBattlesPanel.css'}),
   h('nav',{class:'aub-switch','aria-label':'Режим батлов'},[
    button('На кейсах',()=>mode.value='cases',{'aria-pressed':mode.value==='cases'}),
    button('На апгрейдах',()=>mode.value='upgrade',{'aria-pressed':mode.value==='upgrade'})
   ]),
   mode.value==='cases'?h(CasePage):h(UpgradeBattlesPanel)
  ]);
 }});
}
