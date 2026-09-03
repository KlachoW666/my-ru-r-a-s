// Kept separate from the compiled Vue bundle so the query and math can be tested.
export function buildItemSearch(input) {
  let text=String(input??'').trim();
  const query={page:1,limit:100};
  const numeric=text.replace(/[\s\u00a0]/g,'');
  if(/^\d+(?:[.,]\d+)?$/.test(numeric)) {
    query.priceMin=Number(numeric.replace(',','.'));query.sortDir='asc';
    return query;
  }
  text=text.replace(/(^|\s)(>=|<=|>|<)\s*(\d+(?:[.,]\d+)?)(?=\s|$)/g,(_,space,op,value)=>{
    const field={'>=':'priceMin','<=':'priceMax','>':'priceGt','<':'priceLt'}[op];
    query[field]=Number(value.replace(',','.'));return ' ';
  }).trim().replace(/\s+/g,' ');
  if(text)query.name=text;
  if(query.priceMin!==undefined||query.priceGt!==undefined)query.sortDir='asc';
  else if(query.priceMax!==undefined||query.priceLt!==undefined)query.sortDir='desc';
  return query;
}

export function solveCaseRtp(items, casePrice, targetRtp=.96, ticketCount=1000000) {
  const bad=message=>({feasible:false,message});
  if(!Array.isArray(items)||!items.length)return bad('Добавьте предметы в кейс.');
  const cost=Number(casePrice);
  if(!Number.isFinite(cost)||cost<=0)return bad('Укажите цену кейса больше нуля.');
  if(!Number.isFinite(targetRtp)||targetRtp<=0||!Number.isSafeInteger(ticketCount)||ticketCount<1)return bad('Некорректная цель RTP или число билетов.');
  const prices=items.map(i=>Number(i.price));
  if(prices.some(p=>!Number.isFinite(p)||p<0))return bad('У предмета некорректная цена.');
  const min=Math.min(...prices),max=Math.max(...prices),target=cost*targetRtp;
  if(target<min||target>max)return bad(`RTP ${(targetRtp*100).toFixed(2)}% недостижим: средний приз должен стоить ${target.toFixed(2)} ₽, а предметы стоят от ${min.toFixed(2)} до ${max.toFixed(2)} ₽. Измените состав или цену кейса.`);
  let probabilities;
  if(min===max)probabilities=prices.map(()=>1/prices.length);
  else if(target===min||target===max){
    const count=prices.filter(p=>p===target).length;
    probabilities=prices.map(p=>p===target?1/count:0);
  }else{
    // Exponential tilt in both directions; stable shifted exponentials avoid
    // overflow. Unlike inverse-price powers, it can reach targets above the mean.
    const normalized=prices.map(p=>(p-min)/(max-min));
    const at=beta=>{
      const shift=beta>0?beta:0,raw=normalized.map(x=>Math.exp(beta*x-shift)),sum=raw.reduce((a,b)=>a+b,0);
      const p=raw.map(w=>w/sum);
      return {p,ev:p.reduce((s,w,i)=>s+w*prices[i],0)};
    };
    let low=-1,high=1;
    for(let i=0;i<60&&at(low).ev>target;i++)low*=2;
    for(let i=0;i<60&&at(high).ev<target;i++)high*=2;
    for(let i=0;i<100;i++) {const mid=(low+high)/2;if(at(mid).ev<target)low=mid;else high=mid;}
    probabilities=at((low+high)/2).p;
  }
  const raw=probabilities.map(p=>p*ticketCount),widths=raw.map(Math.floor);
  const remaining=ticketCount-widths.reduce((a,b)=>a+b,0);
  const order=raw.map((n,i)=>({i,fraction:n-widths[i]})).sort((a,b)=>b.fraction-a.fraction||a.i-b.i);
  for(let i=0;i<remaining;i++)widths[order[i%order.length].i]++;
  const actualRtp=widths.reduce((s,w,i)=>s+w*prices[i]/ticketCount,0)/cost;
  if(!Number.isFinite(actualRtp)||Math.abs(actualRtp-targetRtp)>=.0009)return bad('Не удалось получить RTP с точностью формы на миллионе билетов. Уменьшите разброс цен или измените состав. Шансы не изменены.');
  let cursor=1;
  const result=items.map((item,i)=>{
    const row={...item,chance:widths[i]/ticketCount*100,ticketRangeFrom:cursor,ticketRangeTo:cursor+widths[i]-1};
    cursor+=widths[i];return row;
  });
  return {feasible:true,items:result,actualRtp};
}
