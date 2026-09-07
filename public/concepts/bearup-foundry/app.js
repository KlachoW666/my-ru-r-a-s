'use strict';
// Local design fixture only. No API, payment or game requests.
const artwork = name => '/assets/cases/satchel/' + name + '.webp';
const cases = [
  {name:'Первый костёр',art:'campfire',price:49,series:'start',label:'С НАЧАЛА ПУТИ'},
  {name:'Медвежья берлога',art:'monument',price:149,series:'start',label:'ВЫБОР МАСТЕРА'},
  {name:'Холодный след',art:'frostbite',price:299,series:'collection',label:'СЕВЕРНАЯ КОЛЛЕКЦИЯ'},
  {name:'Большой рейд',art:'breach',price:599,series:'raid',label:'ДЛЯ БОЛЬШИХ ПЛАНОВ'},
  {name:'Золотая жила',art:'gold-rush',price:999,series:'collection',label:'ОСОБАЯ КОЛЛЕКЦИЯ'},
  {name:'После вайпа',art:'last-wipe',price:199,series:'start',label:'НОВОЕ НАЧАЛО'},
  {name:'Красная зона',art:'redline',price:399,series:'raid',label:'РЕЙДОВЫЙ НАБОР'},
  {name:'Ночной дозор',art:'blackout',price:749,series:'collection',label:'ТЁМНАЯ КОЛЛЕКЦИЯ'}
];
const money = value => new Intl.NumberFormat('ru-RU').format(value);
const favorites = new Set(); let filter = 'all';
const grid=document.querySelector('#cases'), search=document.querySelector('#search'), sort=document.querySelector('#sort');
const dialog=document.querySelector('#detail'), title=document.querySelector('#detail-title'), detail=document.querySelector('#detail-body');
function show(name,html){title.textContent=name;detail.innerHTML=html;dialog.showModal()}
function render(){
  const result=cases.map((item,id)=>({...item,id})).filter(item=>
    (filter==='all'||(filter==='favorites'?favorites.has(item.id):item.series===filter))&&item.name.toLowerCase().includes(search.value.trim().toLowerCase()));
  if(sort.value!=='featured')result.sort((a,b)=>sort.value==='asc'?a.price-b.price:b.price-a.price);
  grid.innerHTML=result.map(item=>'<article class="case-card"><div class="case-top"><span class="case-number">BU—0'+(item.id+1)+'</span><button class="save" data-save="'+item.id+'" aria-label="В избранное: '+item.name+'" aria-pressed="'+favorites.has(item.id)+'">'+(favorites.has(item.id)?'♥':'♡')+'</button></div><button class="case-open" data-case="'+item.id+'"><span class="case-art"><img src="'+artwork(item.art)+'" alt="'+item.name+'"></span><span class="case-series">'+item.label+'</span><span class="case-name">'+item.name+'</span><span class="case-price"><span>'+money(item.price)+' <img src="/image/icon-money.png" alt="монет"></span><span>Смотреть ↗</span></span></button></article>').join('');
  document.querySelector('#empty').hidden=result.length!==0;document.querySelector('.count').textContent=String(result.length).padStart(2,'0');
}
document.querySelector('.filters').addEventListener('click',event=>{
  const button=event.target.closest('[data-filter]');if(!button)return;
  filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',b===button)});render();
});
search.addEventListener('input',render);sort.addEventListener('change',render);
grid.addEventListener('click',event=>{
  const save=event.target.closest('[data-save]');if(save){const id=Number(save.dataset.save);favorites.has(id)?favorites.delete(id):favorites.add(id);render();return}
  const button=event.target.closest('[data-case]');if(!button)return;const item=cases[Number(button.dataset.case)];
  show(item.name,'<img class="dialog-art" src="'+artwork(item.art)+'" alt="'+item.name+'"><p>Стоимость в концепте: <b>'+money(item.price)+' монет</b>.</p><p>Здесь будет состав кейса и переход к открытию. Это демонстрация дизайна: деньги не списываются.</p>');
});
document.querySelectorAll('[data-info]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.info;
  show(name,name.includes('путь')?'<p>Пять ступеней наград собраны в одну шкалу. Можно выбрать ступень и посмотреть следующую награду.</p><p>Числа в макете условные. Боевые пороги и условия при реализации будут загружаться из настроек админки.</p>':'<p>Пример расположения раздела «'+name+'» в новом интерфейсе. В макете нет авторизации, пополнений или доступа к твоему балансу.</p>');
}));
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.mode;
  show(name,name==='Батлы'?'<div class="modal-tabs"><button class="selected" data-battle="Кейсы">На кейсах</button><button data-battle="Апгрейды">На апгрейдах</button></div><p id="battle-copy">Кейсы: два игрока, общий набор кейсов и результаты раундов на одном экране.</p><p>Предпросмотр структуры раздела. Матчи не запускаются.</p>':'<p>Раздел «'+name+'» получит те же строгие панели, крупную типографику и оранжевые акценты.</p><p>Это концепт главной страницы — игровой режим здесь не подключён.</p>');
}));
detail.addEventListener('click',event=>{const b=event.target.closest('[data-battle]');if(!b)return;detail.querySelectorAll('[data-battle]').forEach(x=>x.classList.toggle('selected',x===b));document.querySelector('#battle-copy').textContent=b.dataset.battle==='Кейсы'?'Кейсы: два игрока, общий набор кейсов и результаты раундов на одном экране.':'Апгрейды: игроки по сторонам, цель в центре и история трёх раундов снизу.'});
document.querySelectorAll('.close,.close-action').forEach(b=>b.addEventListener('click',()=>dialog.close()));
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close()}});
document.querySelector('#feed').innerHTML=cases.slice(0,6).map((item,i)=>'<div class="feed-item"><img src="'+artwork(item.art)+'" alt=""><div><small>'+['MISHKA','rust enjoyer','northside','quiet raid','BERLOGA','solo'][i]+'</small><b>'+item.name+'</b><span>'+money([284,1200,874,3420,960,415][i])+' монет</span></div></div>').join('');
document.querySelector('.feed-next').addEventListener('click',()=>document.querySelector('#feed').scrollBy({left:220,behavior:'smooth'}));
document.querySelector('#rewards').innerHTML=['Искра','След','Берлога','Рейд','Хозяин'].map((name,i)=>'<button class="reward-step '+(i===1?'selected':'')+'" data-reward="'+i+'" aria-pressed="'+(i===1)+'"><strong>'+['✓','Ⅱ','Ⅲ','Ⅳ','Ⅴ'][i]+'</strong><small>'+name+'</small><span>'+['Получено','300','600','1 000','2 000'][i]+'</span></button>').join('');
document.querySelector('#rewards').addEventListener('click',event=>{const b=event.target.closest('[data-reward]');if(!b)return;document.querySelectorAll('[data-reward]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',x===b)});const thresholds=[0,300,600,1000,2000],n=thresholds[Number(b.dataset.reward)];document.querySelector('.next-reward strong').innerHTML=money(Math.max(0,n-174))+' <span>монет</span>';document.querySelector('.progress i').style.width=(n?Math.min(100,174/n*100):100)+'%';document.querySelector('.progress-caption').textContent=n?'174 из '+money(n)+' · демопрогресс':'Награда получена · демо'});
render();
