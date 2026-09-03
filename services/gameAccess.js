'use strict';

// Check the saved switch on every action, before a handler can debit a wallet.
// Listing old battles/history remains available during maintenance.
function register({app,queryAdminDb}) {
  const guards=[
    ['cases',['/api/v1/cases/open','/api/v1/cases/:slug/open']],
    ['upgrader',['/api/v1/upgrader/place','/api/v1/upgrader/offer/accept']],
    ['battles',['/api/v1/battles/create','/api/v1/battles/:uid/join','/api/v1/battles/:uid/add-bot','/api/v1/battles/:uid/recreate']],
    ['deposit_chain',['/api/v1/deposit-chain/open']]
  ];
  for(const [id,paths] of guards)app.post(paths,async(req,res,next)=>{
    try {
      const rows=await queryAdminDb('SELECT enabled FROM game_configs WHERE id=?',[id]);
      if(rows.failed||!rows.length)return res.status(503).json({status:'error',code:'GAME_CONFIG_UNAVAILABLE',message:'Настройки игры недоступны. Повторите позже.'});
      if(Number(rows[0].enabled)!==1)return res.status(409).json({status:'error',code:'GAME_DISABLED',message:'Режим временно выключен администратором.'});
      next();
    }catch(e){res.status(503).json({status:'error',code:'GAME_CONFIG_UNAVAILABLE',message:'Не удалось проверить доступность игры.'});}
  });
}
module.exports={register};
