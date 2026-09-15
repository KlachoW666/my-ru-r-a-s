'use strict';

const {transaction}=require('./sqliteTransaction');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const cents=value=>Math.round(Number(value)*100);

// These are balance-funded requests for MANUAL delivery, not bot stock or trade offers.
function makeSkinWithdrawals({getDb,queryAdminDb,fixImageUrl=x=>x}) {
  let ready;
  function schema(){
    if(!ready)ready=transaction(getDb,async tx=>{
      await tx.run(`CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,amount REAL,currency TEXT,status TEXT DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      const columns=new Set((await tx.all('PRAGMA table_info(withdrawals)')).map(r=>r.name));
      for(const name of ['channel','skin_items','request_key','selection_key','trade_link','delivery_ref'])
        if(!columns.has(name))await tx.run(`ALTER TABLE withdrawals ADD COLUMN ${name} TEXT`);
      await tx.run('CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_request_key ON withdrawals(user_id,request_key) WHERE request_key IS NOT NULL');
    }).catch(e=>{ready=null;throw e;});
    return ready;
  }
  async function query(sql,args=[]){
    const rows=await queryAdminDb(sql,args);
    if(!Array.isArray(rows)||rows.failed)throw new Error('База данных недоступна');
    return rows;
  }
  async function available(read){
    const columns=new Set((await read('PRAGMA table_info(items)')).map(r=>r.name));
    const filters=['price > 0'];
    for(const name of ['delisted','admin_disabled'])if(columns.has(name))filters.push(`COALESCE(${name},0)=0`);
    const rows=await read(`SELECT id,name,price,image,rarity FROM items WHERE ${filters.join(' AND ')} ORDER BY id`);
    const seen=new Set();
    return rows.filter(r=>r.name&&Number.isFinite(Number(r.price))&&!seen.has(r.name)&&seen.add(r.name));
  }
  async function catalog(){
    const items=(await available(query)).map(r=>({id:r.id,name:r.name,img:fixImageUrl(r.image),priceRub:cents(r.price)/100,rarity:r.rarity,count:10}));
    return {items,currency:'RUB',manual:true,message:'Заявку обрабатывает администратор. Наличие и отправка подтверждаются вручную; при отмене деньги возвращаются.'};
  }
  const spentSql="SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE user_id=? AND status NOT IN ('cancelled','rejected') AND datetime(created_at)>=datetime('now','-1 day')";
  async function spentToday(userId){await schema();return Number((await query(spentSql,[userId]))[0].total);}
  function dto(row){
    const items=JSON.parse(row.skin_items||'[]');
    return {request_id:`skin-${row.id}`,id:row.id,amount_rub:row.amount,amount:row.amount,items,
      skins_count:items.reduce((n,i)=>n+i.count,0),created_at:row.created_at,status:row.status,
      ui_status:'PROCESSING',manual:true,can_cancel:row.status==='pending',needs_confirmation:false};
  }
  function selection(body){
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>10)fail('Выберите от 1 до 10 предметов');
    const merged=new Map();
    for(const i of body.items){
      if(typeof i.name!=='string'||!i.name.trim()||i.name.length>200||!Number.isInteger(i.count)||i.count<1||i.count>10)fail('Некорректное количество предметов');
      merged.set(i.name,(merged.get(i.name)||0)+i.count);
    }
    if([...merged.values()].reduce((a,b)=>a+b,0)>10)fail('Можно выбрать не более 10 предметов');
    return [...merged].sort(([a],[b])=>a.localeCompare(b)).map(([name,count])=>({name,count}));
  }
  async function create(userId,body,limits={}){
    const selected=selection(body),key=body.requestId||body.request_id;
    if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(key))fail('Обновите страницу и повторите запрос');
    const selectionKey=JSON.stringify(selected);
    await schema();
    return transaction(getDb,async tx=>{
      const previous=await tx.get('SELECT * FROM withdrawals WHERE user_id=? AND request_key=?',[userId,key]);
      if(previous){
        if(previous.selection_key!==selectionKey)fail('Ключ повторного запроса уже использован для другого набора',409);
        const user=await tx.get('SELECT balance FROM users WHERE id=?',[userId]);
        return {...dto(previous),balance:user.balance,newBalance:user.balance};
      }
      const user=await tx.get('SELECT * FROM users WHERE id=?',[userId]);
      if(!user||['banned','blocked','disabled'].includes(String(user.status).toLowerCase()))fail('Вывод недоступен для этого аккаунта',403);
      if(user.withdrawBlocked||user.withdraw_blocked)fail('Вывод для аккаунта заблокирован',403);
      if(await tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet_wagers'")){
        const wager=await tx.get('SELECT remaining_cents FROM wallet_wagers WHERE user_id=?',[userId]);
        if(Number(wager?.remaining_cents)>0)fail('Завершите отыгрыш пополнения перед выводом',403);
      }
      let link;try{link=new URL(user.trade_link);}catch{fail('Добавьте корректную ссылку обмена Steam в профиле');}
      if(link.protocol!=='https:'||link.hostname!=='steamcommunity.com'||link.pathname!=='/tradeoffer/new/'||!/^\d+$/.test(link.searchParams.get('partner')||'')||!link.searchParams.get('token'))fail('Проверьте ссылку обмена Steam в профиле');
      const byName=new Map((await available(tx.all)).map(i=>[i.name,i]));
      const items=selected.map(i=>{
        const item=byName.get(i.name);if(!item)fail(`Предмет недоступен: ${i.name}`);
        return {...i,itemId:item.id,img:fixImageUrl(item.image),priceRub:cents(item.price)/100};
      });
      const amountCents=items.reduce((n,i)=>n+cents(i.priceRub)*i.count,0),amount=amountCents/100;
      if(!Number.isSafeInteger(amountCents)||amountCents<=0)fail('Некорректная стоимость предметов');
      const min=Number(limits.minWithdraw??500),cap=Number(limits.dailyWithdrawCap??27000);
      if(!Number.isFinite(min)||min<0||!Number.isFinite(cap)||cap<0)fail('Лимиты вывода временно недоступны',503);
      if(amountCents<cents(min))fail(`Минимальная сумма вывода — ${min} ₽`);
      const spent=await tx.get(spentSql,[userId]);
      if(cents(spent.total)+amountCents>cents(cap))fail('Превышен суточный лимит вывода');
      if(!Number.isFinite(Number(user.balance))||cents(user.balance)<amountCents)fail('Недостаточно средств на балансе');
      const balance=(cents(user.balance)-amountCents)/100;
      await tx.run('UPDATE users SET balance=? WHERE id=?',[balance,userId]);
      const r=await tx.run(`INSERT INTO withdrawals(user_id,amount,currency,status,channel,skin_items,request_key,selection_key,trade_link)
        VALUES(?,?,'RUB','pending','SKINS',?,?,?,?)`,[userId,amount,JSON.stringify(items),key,selectionKey,user.trade_link]);
      await tx.run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,'withdraw',?,?)",[userId,-amount,`Вывод скинов: заявка ${r.lastID}`]);
      return {...dto(await tx.get('SELECT * FROM withdrawals WHERE id=?',[r.lastID])),balance,newBalance:balance};
    });
  }
  const numericId=id=>/^skin-\d+$/.test(String(id))?Number(String(id).slice(5)):Number(id);
  async function finish(id,status,userId,deliveryRef=''){
    await schema();
    return transaction(getDb,async tx=>{
      const row=await tx.get("SELECT * FROM withdrawals WHERE id=? AND channel='SKINS'",[numericId(id)]);
      if(!row||(userId!==undefined&&String(row.user_id)!==String(userId)))fail('Заявка не найдена',404);
      const allowed=status==='approved'?['processing']:status==='rejected'?['pending','processing']:['pending'];
      if(!allowed.includes(row.status))fail('Заявка уже обработана или передана в обработку',409);
      await tx.run('UPDATE withdrawals SET status=?,delivery_ref=? WHERE id=?',[status,deliveryRef,row.id]);
      if(status!=='approved'){
        const changed=await tx.run('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?',[row.amount,row.user_id]);
        if(changed.changes!==1)throw new Error('Не удалось вернуть средства');
        await tx.run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,'withdraw_refund',?,?)",[row.user_id,row.amount,`Возврат по заявке скинов ${row.id}`]);
      }
      return dto({...row,status});
    });
  }
  async function decide(id,decision,deliveryRef=''){
    if(!['approve','reject'].includes(decision))fail('Неизвестное решение');
    if(decision==='approve'&&!/^https:\/\/steamcommunity\.com\/tradeoffer\/\d+\/?$/.test(deliveryRef))fail('Укажите ссылку на завершённый обмен Steam');
    return finish(id,decision==='approve'?'approved':'rejected',undefined,deliveryRef);
  }
  async function claim(id){
    await schema();
    return transaction(getDb,async tx=>{
      const r=await tx.run("UPDATE withdrawals SET status='processing' WHERE id=? AND channel='SKINS' AND status='pending'",[numericId(id)]);
      if(r.changes!==1)fail('Заявка уже обработана или передана в обработку',409);
      return dto(await tx.get('SELECT * FROM withdrawals WHERE id=?',[numericId(id)]));
    });
  }
  async function list(userId){await schema();return {withdrawals:(await query("SELECT * FROM withdrawals WHERE user_id=? AND channel='SKINS' AND status IN ('pending','processing') ORDER BY id DESC",[userId])).map(dto)};}
  return {catalog,create,list,cancel:(userId,id)=>finish(id,'cancelled',userId),decide,claim,schema,spentToday};
}
module.exports={makeSkinWithdrawals};
