'use strict';
const {transaction}=require('./sqliteTransaction');

function toCents(value,label){
 const amount=Number(value);
 const cents=Math.round(amount*100);
 if(!Number.isFinite(amount)||amount<0||Math.abs(amount*100-cents)>0.00001){
  throw Object.assign(new Error(`Некорректная сумма: ${label}`),{status:400});
 }
 return cents;
}

function makeUpgraderSettlement({getDb}){
 async function settle({userId,mockUser,betAmount,winAmount=0,multiplier,itemName=''}){
  const bet=toCents(betAmount,'ставка');
  const win=toCents(winAmount,'выплата');
  if(bet<=0)throw Object.assign(new Error('Ставка должна быть больше нуля'),{status:400});

  // Development-only mock follows the same single-delta formula.
  if(userId==null){
   if(!mockUser||toCents(mockUser.balance,'баланс')<bet)throw Object.assign(new Error('Недостаточно средств'),{status:409,code:'INSUFFICIENT_BALANCE'});
   mockUser.balance=(toCents(mockUser.balance,'баланс')-bet+win)/100;
   return {balance:mockUser.balance};
  }

  return transaction(getDb,async db=>{
   await db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,type TEXT,amount REAL,
    comment TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`);
   await db.run('CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id,created_at)');
   // One UPDATE is the accounting invariant: balance = old - stake + target.
   // A 100000 stake and 130000 target therefore changes the account by +30000.
   const changed=await db.run(
    'UPDATE users SET balance=ROUND(balance+?,2) WHERE id=? AND ROUND(balance*100)>=?',
    [(win-bet)/100,userId,bet]
   );
   if(changed.changes!==1)throw Object.assign(new Error('Недостаточно средств или пользователь не найден'),{status:409,code:'INSUFFICIENT_BALANCE'});
   await db.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',
    [userId,'upgrade',-bet/100,`Апгрейд x${Number(multiplier||0).toFixed(2)}`]);
   if(win>0)await db.run('INSERT INTO transactions(user_id,type,amount,comment) VALUES(?,?,?,?)',
    [userId,'upgrade_win',win/100,String(itemName||'')]);
   const account=await db.get('SELECT balance FROM users WHERE id=?',[userId]);
   return {balance:Number(account.balance)};
  });
 }
 return {settle};
}

module.exports={makeUpgraderSettlement,toCents};
