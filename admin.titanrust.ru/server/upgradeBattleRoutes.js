'use strict';
const sqlite=require('sqlite3');
const {makeUpgradeBattles}=require('../../services/upgradeBattles');
function register({app,DB_PATH,requireAdminJWT}){
  const service=makeUpgradeBattles({getDb:()=>new sqlite.Database(DB_PATH)});
  function route(method,path,work){
    app[method]('/api/v1/admin/upgrade-battles'+path,requireAdminJWT,async(req,res)=>{
      try{res.json({success:true,data:await work(req)});}
      catch(e){const status=e.status||503;if(status>=500)console.error('[Admin upgrade battles]',e.message);res.status(status).json({success:false,message:status>=500?'Не удалось загрузить или сохранить батлы. Проверьте миграцию базы.':e.message});}
    });
  }
  route('get','/config',()=>service.config());
  route('put','/config',req=>service.configure(req.body||{},`admin:${req.user.userId}`));
  route('get','',req=>service.list(undefined,req.query.history==='true'));
  route('get','/:uid',async req=>({battle:await service.get(req.params.uid)}));
}
module.exports={register};
