'use strict';
const {transaction}=require('./sqliteTransaction');
function makeDepositLadder({getAdminDb,queryAdminDb}) {
  let ready;
  function ensureSchema() {
    if (!ready) ready=transaction(getAdminDb,async({run})=>{
      await run(`CREATE TABLE IF NOT EXISTS deposit_chain_claims (
        user_id INTEGER NOT NULL,tier_index INTEGER NOT NULL,status TEXT NOT NULL,
        item_json TEXT,amount REAL,case_name TEXT,opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
        admin_user_id TEXT,void_reason TEXT,PRIMARY KEY(user_id,tier_index))`);
      await run('CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    }).catch(error=>{ready=undefined;throw error;});
    return ready;
  }
  async function claimed(userId) {
    await ensureSchema();
    const rows=await queryAdminDb('SELECT * FROM deposit_chain_claims WHERE user_id=? ORDER BY tier_index',[userId]);
    if(rows.failed)throw new Error('Cannot read ladder claims');
    return rows;
  }
  async function claim({userId,tierIndex,threshold,caseName,item}) {
    const amount=Number(item?.price);
    if(!Number.isInteger(tierIndex)||tierIndex<0||!Number.isFinite(threshold)||threshold<0||!Number.isFinite(amount)||amount<0)
      return {ok:false,error:'CHAIN_UNAVAILABLE',message:'Некорректный тир или приз'};
    await ensureSchema();
    return transaction(getAdminDb,async({get,run})=>{
      const user=await get('SELECT id FROM users WHERE id=?',[userId]);
      if(!user)return {ok:false,error:'UNAUTHORIZED',message:'Пользователь не найден'};
      const existing=await get('SELECT status FROM deposit_chain_claims WHERE user_id=? AND tier_index=?',[userId,tierIndex]);
      if(existing)return {ok:false,error:'CHAIN_OUT_OF_ORDER',message:'Этот тир уже обработан'};
      const deposited=await get("SELECT COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=? AND type='deposit'",[userId]);
      if(Number(deposited.amount)<threshold)return {ok:false,error:'CHAIN_INSUFFICIENT_DEPOSIT',message:'Недостаточная сумма пополнений'};
      await run("INSERT INTO deposit_chain_claims(user_id,tier_index,status,item_json,amount,case_name) VALUES(?,?,'CONSUMED',?,?,?)",
        [userId,tierIndex,JSON.stringify(item),amount,caseName]);
      await run('UPDATE users SET balance=ROUND(COALESCE(balance,0)+?,2) WHERE id=?',[amount,userId]);
      await run("INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,'deposit_chain',?,?)",[userId,amount,'Бесплатный кейс: '+caseName]);
      return {ok:true,balance:(await get('SELECT balance FROM users WHERE id=?',[userId])).balance};
    });
  }
  return {ensureSchema,claimed,claim};
}
module.exports={makeDepositLadder};
