'use strict';
function register({app,deposits}) {
  app.post(['/api/v1/wallet/withdraw','/api/v1/wallet/skins/withdraw','/api/v1/inventory/withdraw'],async(req,res,next)=>{
    if (!req.auth || req.auth.mock) return res.status(401).json({status:'error',code:'UNAUTHORIZED',message:'Нужна авторизация'});
    try {
      const state=await deposits.wager(req.auth.sub);
      if (state.hasActiveWager) return res.status(403).json({status:'error',code:'WAGER_REQUIRED',
        message:`Перед выводом нужно отыграть ещё ${state.remaining} ₽`,data:state});
      next();
    } catch(error) {
      console.error('[Wager]',error);
      res.status(503).json({status:'error',code:'WAGER_UNAVAILABLE',message:'Не удалось проверить отыгрыш. Вывод не выполнен.'});
    }
  });
}
module.exports={register};
