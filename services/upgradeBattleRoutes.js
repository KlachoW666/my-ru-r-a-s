'use strict';

function register({app,service}) {
  function route(method,path,work,authenticated=false) {
    app[method]('/api/v1/upgrade-battles'+path,async(req,res)=>{
      if(authenticated&&(!req.auth||req.auth.mock))return res.status(401).json({status:'error',message:'Нужно войти в аккаунт'});
      try {res.json({status:'success',data:await work(req)});}
      catch(error) {
        const status=error.status||503;
        if(status>=500)console.error('[UpgradeBattles]',error.message);
        res.status(status).json({status:'error',message:status>=500?'Не удалось обработать батл. Повторите запрос — повторного списания не будет.':error.message});
      }
    });
  }
  route('get','/config',()=>service.config());
  route('get','/items',req=>service.items(req.query));
  route('get','',req=>service.list(req.auth?.sub,req.query.history==='true'));
  route('post','/create',async req=>({battle:await service.create(req.auth.sub,req.body||{})}),true);
  route('get','/:uid',async req=>({battle:await service.get(req.params.uid,req.auth?.sub)}));
  route('post','/:uid/join',async req=>({battle:await service.join(req.auth.sub,req.params.uid,req.body||{})}),true);
  route('post','/:uid/cancel',async req=>({battle:await service.cancel(req.auth.sub,req.params.uid)}),true);
}

// A saved hold is refunded even when every browser has disconnected. On restart
// the first sweep also catches rooms whose deadline elapsed while offline.
function startRefundWorker(service,server) {
  let running=false;
  async function sweep(){if(running)return;running=true;try{await service.expire();}catch(e){console.error('[UpgradeBattles refund]',e.message);}finally{running=false;}}
  const timer=setInterval(sweep,30000);timer.unref();
  server.once('listening',sweep);server.once('close',()=>clearInterval(timer));
}
module.exports={register,startRefundWorker};
