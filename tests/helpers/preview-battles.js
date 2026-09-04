'use strict';
// Local browser fixture, never loaded by either production server. Only a new
// temporary SQLite file is used. No Steam, real accounts or live money.
const express=require('express'),sqlite=require('sqlite3');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makeUpgradeBattles}=require('../../services/upgradeBattles');
async function start(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'satchel-battle-preview-'));
 const file=path.join(dir,'fixture.sqlite');
 const getDb=()=>new sqlite.Database(file);
 const query=(s,p=[])=>new Promise((ok,no)=>{const db=getDb();db.all(s,p,(e,r)=>db.close(()=>e?no(e):ok(r)));});
 await query('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,balance REAL,status TEXT,avatar TEXT)');
 await query("INSERT INTO users VALUES(1,'Тестовый игрок',10000,'active','/brand/logo-mark.svg'),(2,'Тестовый соперник',10000,'active','/brand/logo-mark.svg')");
 await query('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,price REAL,image TEXT,rarity TEXT,upgraderEnabled INTEGER)');
 await query("INSERT INTO items VALUES(1,'Тестовый MP5',200,'/brand/logo-mark.svg','RARE',1),(2,'Тестовый AK',300,'/brand/logo-mark.svg','RARE',1),(3,'Тестовый Bolt',400,'/brand/logo-mark.svg','RARE',1),(4,'Дорогой тестовый AK',10000,'/brand/logo-mark.svg','RARE',1)");
 await query('CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,amount REAL,comment TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 await require('../../admin.titanrust.ru/server/adminSchema').ensureAdminSchema({dbRun:query,dbGet:async(s,p)=>(await query(s,p))[0]});
 const service=makeUpgradeBattles({getDb});await service.configure({enabled:true,rtp:.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900},'preview');
 const room=await service.create(2,{requestId:'preview-initial-room',clientSeed:'preview-creator',roundBet:100,targetIds:[1,2,3]});
 const finished=await service.create(2,{requestId:'preview-finished-room',clientSeed:'preview-creator-finished',roundBet:100,targetIds:[1,2,3]});
 await service.join(1,finished.uid,{clientSeed:'preview-opponent'});
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth={sub:1};next();});
 const ok=(res,data)=>res.json({status:'success',data});
 require('../../services/upgradeBattleRoutes').register({app,service});
 app.get('/api/v1/config/games',(_,res)=>ok(res,{config:{modes:['case_opening','battle','upgrade','online_badge'].map(name=>({name,enabled:true})),topDropsVisible:false}}));
 app.get('/api/v1/auth/refresh',(_,res)=>ok(res,{accessToken:'local-preview-only'}));
 app.get('/api/v1/user',async(_,res)=>ok(res,{...(await query('SELECT * FROM users WHERE id=1'))[0],userId:'1',name:'Тестовый игрок',currency:'RUB',role:'user',createdAt:'2026-09-01T00:00:00Z'}));
 app.get('/api/v1/stats/global',(_,res)=>ok(res,{stats:{totalCases:0,totalUpgrades:0,totalUsers:2,online:2}}));
 app.get('/api/v1/battles',(_,res)=>ok(res,[]));
 require('../../admin.titanrust.ru/server/upgradeBattleRoutes').register({app,DB_PATH:file,requireAdminJWT:(req,res,next)=>{req.user={userId:1,role:'SUPER_ADMIN'};next();}});
 app.use('/api/v1',(req,res)=>{console.log('Fixture ancillary API:',req.method,req.path);ok(res,{items:[],history:[],links:[],notifications:[],unreadCount:0});});
 app.use(express.static(path.resolve(__dirname,'../../public')));
 app.get('*',(_,res)=>res.sendFile(path.resolve(__dirname,'../../public/index.html')));
 const server=app.listen(3197,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:3197/crate-pvp?mode=upgrade',room:room.uid,finished:finished.uid,fixture:file})));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
start().catch(e=>{console.error(e);process.exitCode=1;});
