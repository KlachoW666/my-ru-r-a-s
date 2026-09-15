'use strict';
function register({app,service,requireUser,limits}){
  const route=work=>async(req,res,next)=>{
    try{await work(req,res,next);}catch(e){
      if(!e.status)console.error('[Skin withdrawal]',e);
      res.status(e.status||503).json({status:'error',code:'SKIN_WITHDRAWAL_ERROR',message:e.status?e.message:'Вывод временно недоступен. Попробуйте ещё раз с тем же запросом.'});
    }
  };
  app.get('/api/v1/wallet/skins/withdraw-inventory',route(async(req,res)=>{
    if(!await requireUser(req,res))return;
    res.json({status:'success',data:await service.catalog()});
  }));
  app.post('/api/v1/wallet/withdraw',route(async(req,res,next)=>{
    if(String(req.body?.channel).toUpperCase()!=='SKINS')return next();
    const user=await requireUser(req,res);if(!user)return;
    res.json({status:'success',data:await service.create(user.id,req.body,await limits())});
  }));
  app.get('/api/v1/wallet/skins/withdrawals',route(async(req,res)=>{
    const user=await requireUser(req,res);if(!user)return;
    res.json({status:'success',data:await service.list(user.id)});
  }));
  app.post('/api/v1/wallet/withdrawals/:uid/cancel',route(async(req,res,next)=>{
    if(!/^skin-\d+$/.test(req.params.uid))return next();
    const user=await requireUser(req,res);if(!user)return;
    res.json({status:'success',data:await service.cancel(user.id,req.params.uid)});
  }));
}
module.exports={register};
