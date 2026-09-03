'use strict';

// A transaction must own its connection: sharing the admin's long-lived handle
// would allow unrelated HTTP requests to join or roll back its transaction.
async function transaction(getDb, work) {
  const db = getDb();
  if (!db) throw new Error('Database unavailable');
  db.configure('busyTimeout', 5000);
  const run = (sql, params=[]) => new Promise((resolve,reject) => db.run(sql,params,function(error) {
    error ? reject(error) : resolve({changes:this.changes,lastID:this.lastID});
  }));
  const all = (sql, params=[]) => new Promise((resolve,reject) => db.all(sql,params,(error,rows)=>error?reject(error):resolve(rows)));
  let begun = false;
  try {
    await run('BEGIN IMMEDIATE'); begun = true;
    const value = await work({run,all,get:async(sql,p)=>(await all(sql,p))[0]});
    await run('COMMIT'); begun = false;
    return value;
  } catch(error) {
    if (begun) await run('ROLLBACK').catch(()=>{});
    throw error;
  } finally { await new Promise(resolve=>db.close(resolve)); }
}
module.exports = { transaction };
