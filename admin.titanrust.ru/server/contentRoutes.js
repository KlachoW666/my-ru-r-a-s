'use strict';
const sqlite = require('sqlite3');
const { ensureColumns } = require('./schemaCompatibility');

function invalid(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function number(value, name, min = 0) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min) invalid(`Некорректное поле ${name}`);
  return n;
}
function boolean(value, name) {
  if (![true,false,1,0,'true','false','1','0'].includes(value)) invalid(`Некорректное поле ${name}`);
  return [true,1,'true','1'].includes(value) ? 1 : 0;
}
function paging(q) {
  const page = Math.max(1, parseInt(q.page,10)||1), limit = Math.min(1000,Math.max(1,parseInt(q.limit,10)||20));
  return {page,limit,offset:(page-1)*limit};
}
const colorByRarity = {REGULAR:'756767',UNUSUAL:'4076ff',RARE:'65dc04',VIOLET:'a33ee2',GOLD:'ffc43b'};

// Each request owns its SQLite connection. A failed multi-row mutation cannot
// roll back another request's wallet changes on the application's shared handle.
function connection(filename) {
  const db = new sqlite.Database(filename);
  db.configure('busyTimeout',5000);
  return {
    all:(sql,args=[])=>new Promise((ok,no)=>db.all(sql,args,(e,r)=>e?no(e):ok(r))),
    get:(sql,args=[])=>new Promise((ok,no)=>db.get(sql,args,(e,r)=>e?no(e):ok(r))),
    run:(sql,args=[])=>new Promise((ok,no)=>db.run(sql,args,function(e){e?no(e):ok({lastID:this.lastID,changes:this.changes})})),
    close:()=>new Promise((ok,no)=>db.close(e=>e?no(e):ok()))
  };
}
function register({app,DB_PATH,requireAdminJWT}) {
  let schemaReady;
  async function schema() {
    if (!schemaReady) schemaReady = (async()=>{
      const db=connection(DB_PATH);
      try {
        await ensureColumns(db, 'series');
        await ensureColumns(db, 'cases');
        await ensureColumns(db, 'case_items');
        await ensureColumns(db, 'items');
        await db.run('CREATE TABLE IF NOT EXISTS content_page_types (type TEXT PRIMARY KEY)');
        await db.run(`CREATE TABLE IF NOT EXISTS content_page_meta (page_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, locale TEXT NOT NULL DEFAULT 'ru', updated_by TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      } finally {await db.close();}
    })().catch(e=>{schemaReady=undefined;throw e;});
    return schemaReady;
  }
  function route(method,path,fn) {
    app[method]('/api/v1/admin'+path,requireAdminJWT,async(req,res)=>{
      let db,transaction=false;
      try {
        await schema(); db=connection(DB_PATH);
        if(method!=='get'){await db.run('BEGIN IMMEDIATE');transaction=true;}
        const result=await fn(req,db);
        if(transaction){await db.run('COMMIT');transaction=false;}
        res.json({success:true,...result});
      } catch(e) {
        if(transaction)await db.run('ROLLBACK').catch(()=>{});
        const status=e.status||(e.code==='SQLITE_CONSTRAINT'?409:500);
        if(status===500)console.error('[Content]',e);
        /*
         * Причина ошибки уходит в ответ, а не только в лог.
         *
         * Раньше на любую непредвиденную ошибку админка получала
         * «Не удалось обработать контент», а настоящий текст оставался в
         * логе сервера. Со стороны оператора это выглядит как «Server error,
         * попробуйте позже» — по такому сообщению нельзя ни понять причину,
         * ни внятно её передать.
         *
         * Показывать текст здесь безопасно: раздел за админской авторизацией,
         * и читает его тот, кто и должен разбираться. Код ошибки SQLite
         * («no such column», «SQLITE_BUSY») сразу называет виновника.
         */
        const detail=status===500&&e&&e.message?`: ${e.message}`:'';
        res.status(status).json({
          success:false,
          message:e.status?e.message:status===409
            ?'Запись с таким идентификатором уже существует'
            :`Не удалось обработать контент${detail}`,
          code:e.code||undefined
        });
      } finally {if(db)await db.close();}
    });
  }
  async function requireRow(db,table,id){
    const row=await db.get(`SELECT * FROM ${table} WHERE id=?`,[id]);
    if(!row)invalid('Запись не найдена',404);return row;
  }
  async function list(db,table,q,where,args,order,map=x=>x) {
    const {page,limit,offset}=paging(q),clause=where.length?' WHERE '+where.join(' AND '):'';
    const {total}=await db.get(`SELECT COUNT(*) total FROM ${table}${clause}`,args);
    const rows=await db.all(`SELECT * FROM ${table}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,[...args,limit,offset]);
    return {data:await Promise.all(rows.map(map)),total,pagination:{page,limit,total}};
  }
  const itemDto=r=>({...r,upgraderEnabled:!!r.upgraderEnabled,typeColor:(r.rarity_color||r.color||'').replace(/^#/,''),externalId:r.classid||r.market_hash_name||String(r.id)});
  for(const endpoint of ['/cases/items','/cases/catalog-items'])route('get',endpoint,async(req,db)=>{
    const q=req.query,where=['COALESCE(delisted,0)=0','COALESCE(admin_disabled,0)=0'],args=[];
    if(q.name||q.search){where.push('name LIKE ?');args.push(`%${q.name||q.search}%`);}
    if(q.ids!==undefined){const ids=Array.isArray(q.ids)?q.ids:String(q.ids).split(',');if(!ids.length)where.push('0');else{where.push(`id IN (${ids.map(()=>'?')})`);args.push(...ids);}}
    if(q.upgraderEnabled!==undefined){where.push('COALESCE(upgraderEnabled,0)=?');args.push(boolean(q.upgraderEnabled,'upgraderEnabled'));}
    if(q.type_color){where.push("REPLACE(COALESCE(rarity_color,color,''),'#','')=?");args.push(q.type_color);}
    for(const [key,op]of [['priceMin','>='],['priceMax','<='],['priceGt','>'],['priceLt','<']])if(q[key]!==undefined){where.push(`price ${op} ?`);args.push(number(q[key],key));}
    const direction=q.sortDir==='asc'?'ASC':'DESC';
    return list(db,'items',q,where,args,`price ${direction},id ${direction}`,itemDto);
  });
  function itemFields(body,old={}) {
    const b={...old,...body};
    if(typeof b.name!=='string'||!b.name.trim())invalid('Название предмета обязательно');
    const rarity=b.rarity||'REGULAR';if(!colorByRarity[rarity])invalid('Некорректная редкость');
    return {name:b.name.trim(),price:number(b.price??0,'price'),image:b.image??'',rarity,color:colorByRarity[rarity],
      chance:number(b.chance??0,'chance'),ticketRangeFrom:number(b.ticketRangeFrom??0,'ticketRangeFrom'),ticketRangeTo:number(b.ticketRangeTo??0,'ticketRangeTo'),upgraderEnabled:boolean(b.upgraderEnabled??false,'upgraderEnabled')};
  }
  async function update(db,table,id,fields){
    const keys=Object.keys(fields);await db.run(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`,[...keys.map(k=>fields[k]),id]);
  }
  async function insert(db,table,fields){
    const keys=Object.keys(fields);return (await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?')})`,keys.map(k=>fields[k]))).lastID;
  }
  route('post','/cases/items',async(req,db)=>{
    const fields=itemFields(req.body);const id=await insert(db,'items',{...fields,market_hash_name:fields.name});
    return {data:itemDto(await requireRow(db,'items',id))};
  });
  route('put','/cases/items/:id',async(req,db)=>{
    const old=await requireRow(db,'items',req.params.id);await update(db,'items',old.id,itemFields(req.body,old));
    return {data:itemDto(await requireRow(db,'items',old.id))};
  });
  route('delete','/cases/items/:id',async(req,db)=>{
    const old=await requireRow(db,'items',req.params.id);
    const used=await db.get('SELECT COUNT(*) n FROM case_items WHERE item_id=?',[old.id]);
    if(used.n)invalid('Предмет используется в кейсах. Сначала уберите его из состава.',409);
    await db.run('UPDATE items SET admin_disabled=1,upgraderEnabled=0 WHERE id=?',[old.id]);return {data:{id:old.id}};
  });
  route('post','/cases/items/import-upgrader',async(req,db)=>{
    const where=['COALESCE(delisted,0)=0','COALESCE(admin_disabled,0)=0'],args=[];
    for(const [key,op]of [['priceMin','>='],['priceMax','<=']])if(req.body[key]!=null){where.push(`price ${op} ?`);args.push(number(req.body[key],key));}
    if(req.body.priceMin!=null&&req.body.priceMax!=null&&Number(req.body.priceMin)>Number(req.body.priceMax))invalid('Минимальная цена больше максимальной');
    const clause=where.join(' AND '),{total}=await db.get(`SELECT COUNT(*) total FROM items WHERE ${clause}`,args);
    const {imported}=await db.get(`SELECT COUNT(*) imported FROM items WHERE ${clause} AND COALESCE(upgraderEnabled,0)=0`,args);
    await db.run(`UPDATE items SET upgraderEnabled=1 WHERE ${clause}`,args);
    return {data:{imported,updated:total-imported,total}};
  });

  const seriesDto=r=>({...r,isActive:r.status==='active',archived:r.status==='archived',isLimited:!!r.isLimited,isSecret:!!r.isSecret});
  route('get','/cases/series/schedule',async(req,db)=>{
    const rows=await db.all('SELECT * FROM series WHERE isLimited=1 ORDER BY sortOrder,id');
    // Only limited series belong in schedule. Standard series are read by /series.
    return {data:rows.map(r=>({series:seriesDto(r)}))};
  });
  route('get','/cases/series',async(req,db)=>{
    const where=[],args=[];if(req.query.status){where.push('status=?');args.push(req.query.status);}
    if(req.query.search){where.push('name LIKE ?');args.push(`%${req.query.search}%`);}
    return list(db,'series',req.query,where,args,'sortOrder DESC,id DESC',seriesDto);
  });
  for(const method of ['post','put'])route(method,'/cases/series'+(method==='put'?'/:id':''),async(req,db)=>{
    const old=method==='put'?await requireRow(db,'series',req.params.id):{};
    const b=req.body.data||req.body,name=b.name??old.name;
    if(typeof name!=='string'||!name.trim())invalid('Название серии обязательно');
    const img=b.title_image??b.titleImage??b.image??old.titleImage??'';
    const fields={name:name.trim(),description:b.description??old.description??'',image:img,titleImage:img,sortOrder:number(b.sort_order??b.sortOrder??old.sortOrder??0,'sortOrder')};
    let id=old.id;if(id)await update(db,'series',id,fields);else id=await insert(db,'series',fields);
    return {data:seriesDto(await requireRow(db,'series',id))};
  });

  async function fullCase(db,row){
    const items=await db.all(`SELECT i.*, ci.chance,ci.ticketRangeFrom,ci.ticketRangeTo FROM case_items ci JOIN items i ON i.id=ci.item_id WHERE ci.case_id=? ORDER BY ci.id`,[row.id]);
    const series=row.seriesId?await db.get('SELECT name FROM series WHERE id=?',[row.seriesId]):null;
    return {...row,isActive:!!row.isActive,archived:!!row.archived,isBlogger:!!row.isBlogger,seriesName:series?.name||null,items:items.map(itemDto),itemIds:items.map(i=>i.id)};
  }
  function caseFilter(q){
    const where=[],args=[];
    if(q.status==='archived')where.push('archived=1');
    else if(q.status){where.push('archived=0 AND isActive=?');args.push(q.status==='active'?1:0);}
    if(q.exclusiveTo){where.push('exclusiveTo=?');args.push(q.exclusiveTo);}
    if(q.seriesId){where.push('seriesId=?');args.push(q.seriesId);}
    if(q.search||q.name){where.push('(name LIKE ? OR slug LIKE ?)');args.push(`%${q.search||q.name}%`,`%${q.search||q.name}%`);}
    return {where,args};
  }
  route('get','/cases',async(req,db)=>{const {where,args}=caseFilter(req.query);return list(db,'cases',req.query,where,args,'sortOrder DESC,id DESC',r=>fullCase(db,r));});
  route('get','/cases/export',async(req,db)=>{
    const {where,args}=caseFilter(req.query);const rows=await db.all('SELECT * FROM cases'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY sortOrder DESC,id DESC',args);
    const data=await Promise.all(rows.map(r=>fullCase(db,r)));
    return {data:data.map(c=>({...c,items:c.items.map(i=>({catalogItemName:i.name,chanceRtp96:i.chance,rarity:i.rarity,itemPrice:i.price}))}))};
  });
  /*
   * Слаг из названия.
   *
   * Форма создания кейса в админке слаг НЕ отправляет: прежний обработчик
   * делал его сам из названия. При переносе маршрутов сюда это потерялось, и
   * создание кейса стало падать с «Некорректный slug» — в интерфейсе это
   * выглядит как «Server Error».
   *
   * Кириллица переводится в латиницу, иначе у русского названия слаг выходил
   * бы пустым.
   */
  const TRANSLIT={'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'};
  function slugify(text) {
    let out='';
    for(const ch of String(text||'').toLowerCase()) out+=TRANSLIT[ch]!==undefined?TRANSLIT[ch]:ch;
    return out.replace(/[^a-z0-9_-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  }

  /*
   * Слаг уникален в схеме (UNIQUE на cases.slug), поэтому два кейса с
   * одинаковым названием иначе дали бы ошибку записи вместо понятного
   * результата. Добавляем числовой суффикс.
   */
  async function uniqueSlug(db,base,ownId) {
    const root=base||`case-${Date.now()}`;
    for(let n=0;n<200;n++){
      const candidate=n?`${root}-${n+1}`:root;
      const row=await db.get('SELECT id FROM cases WHERE slug = ?',[candidate]);
      if(!row||(ownId!=null&&String(row.id)===String(ownId))) return candidate;
    }
    return `${root}-${Date.now()}`;
  }

  async function saveCase(req,db,existing) {
    const b=req.body.data||req.body,old=existing||{};
    const name=b.name??old.name;
    if(typeof name!=='string'||!name.trim())invalid('Название кейса обязательно');

    // Слаг прислали — проверяем строго, как и раньше. Не прислали — делаем
    // из названия сами, как делал прежний обработчик.
    let slug=b.slug??old.slug;
    if(slug===undefined||slug===null||String(slug).trim()===''){
      slug=await uniqueSlug(db,slugify(name),old.id);
    }
    if(typeof slug!=='string'||!/^[a-z0-9][a-z0-9_-]*$/.test(slug))invalid('Некорректный slug');
    const price=number(b.price??old.price,'price');if(price<=0)invalid('Цена должна быть больше нуля');
    const seriesId=b.seriesId===null||b.seriesId===''?null:b.seriesId??old.seriesId??null;
    if(seriesId)await requireRow(db,'series',seriesId);
    const fields={name:name.trim(),slug,price,image:b.image??old.image??'',volatility:b.volatility??old.volatility??'AVERAGE',sortOrder:number(b.sortOrder??old.sortOrder??0,'sortOrder'),seriesId,isBlogger:boolean(b.isBlogger??old.isBlogger??false,'isBlogger'),exclusiveTo:b.exclusiveTo??old.exclusiveTo??null};
    const entries=[];
    if(b.items!==undefined){
      if(!Array.isArray(b.items))invalid('items должен быть массивом');
      const seen=new Set();
      for(const raw of b.items){
        const it=typeof raw==='object'&&raw!==null?raw:{id:raw};const id=it.catalogItemId??it.id;
        const item=await db.get('SELECT * FROM items WHERE id=? AND COALESCE(delisted,0)=0 AND COALESCE(admin_disabled,0)=0',[id]);
        if(!item)invalid('Предмет не найден в каталоге');if(seen.has(item.id))invalid('Повторяющийся предмет');seen.add(item.id);
        if(it.customPrice!==undefined&&Number(it.customPrice)!==Number(item.price))invalid('Индивидуальная цена внутри кейса не поддерживается. Обновите цену предмета в каталоге.');
        if(it.catalogItemId!==undefined&&it.rarity!==undefined&&it.rarity!==item.rarity)invalid('Редкость внутри кейса должна совпадать с каталогом.');
        const previous=old.id?await db.get('SELECT * FROM case_items WHERE case_id=? AND item_id=?',[old.id,item.id]):null;
        entries.push({item_id:item.id,chance:number(it.chance??previous?.chance??item.chance??0,'chance'),ticketRangeFrom:number(it.ticketRangeFrom??previous?.ticketRangeFrom??0,'ticketRangeFrom'),ticketRangeTo:number(it.ticketRangeTo??previous?.ticketRangeTo??0,'ticketRangeTo')});
      }
    }
    let id=old.id;
    if(id)await update(db,'cases',id,fields);else id=await insert(db,'cases',fields);
    if(b.items!==undefined){await db.run('DELETE FROM case_items WHERE case_id=?',[id]);for(const it of entries)await insert(db,'case_items',{case_id:id,...it});}
    return {data:await fullCase(db,await requireRow(db,'cases',id))};
  }
  route('post','/cases/from-catalog',(req,db)=>saveCase(req,db));
  route('post','/cases/bulk',async(req,db)=>{
    const input=req.body.cases;
    if(!Array.isArray(input)||!input.length||input.length>500)invalid('Нужно передать от 1 до 500 кейсов');
    if(req.body.archiveExistingSeries)invalid('Автоматическая замена живой серии ещё не подключена. Существующие кейсы не изменены.',501);
    const result={createdActive:0,createdInactive:0,errors:[],inactiveCases:[],seriesConflicts:[]};
    for(let index=0;index<input.length;index++){
      const c=input[index];await db.run('SAVEPOINT import_case');
      try{
        if(!c||!Array.isArray(c.items)||!c.items.length)invalid('Состав кейса пуст');
        const items=[];
        for(const it of c.items){
          const matches=await db.all('SELECT * FROM items WHERE LOWER(name)=LOWER(?) AND COALESCE(delisted,0)=0 AND COALESCE(admin_disabled,0)=0',[it.catalogItemName]);
          if(matches.length!==1)invalid(`Предмет не найден однозначно: ${it.catalogItemName}`);
          const row=matches[0];
          if(it.itemPrice!==undefined&&Number(it.itemPrice)!==Number(row.price))invalid(`Цена ${row.name} отличается от каталога. Сначала обновите предмет.`);
          if(it.rarity!==undefined&&it.rarity!==row.rarity)invalid(`Редкость ${row.name} отличается от каталога. Сначала обновите предмет.`);
          items.push({id:row.id,chance:number(it.chanceRtp96,'chanceRtp96'),ticketRangeFrom:0,ticketRangeTo:0});
        }
        if(Math.abs(items.reduce((sum,it)=>sum+it.chance,0)-100)>0.001)invalid('Сумма шансов должна быть 100%');
        let seriesId=null;
        if(c.seriesName){
          let series=await db.get('SELECT * FROM series WHERE name=?',[c.seriesName]);
          if(!series)series={id:await insert(db,'series',{name:c.seriesName,status:'active'})};
          seriesId=series.id;
        }
        await saveCase({body:{...c,seriesId,items}},db);
        await db.run('RELEASE import_case');result.createdActive++;
      }catch(e){
        await db.run('ROLLBACK TO import_case');await db.run('RELEASE import_case');
        result.errors.push({index,slug:c?.slug||'',code:'IMPORT_FAILED',message:e.status?e.message:e.code==='SQLITE_CONSTRAINT'?'Slug уже существует':'Не удалось сохранить кейс'});
      }
    }
    return {data:result};
  });
  route('get','/rtp/cases/:caseId/tier/:tierId',async(req,db)=>{
    const row=await requireRow(db,'cases',req.params.caseId);
    if(req.params.tierId!=='rtp_96')invalid('В текущем движке нет независимых RTP-вариантов кейса',501);
    const c=await fullCase(db,row);
    return {data:{caseId:row.id,tierCode:'rtp_96',items:c.items.map(i=>({itemId:i.id,itemName:i.name,itemPrice:String(i.price),chancePercent:i.chance,ticketRangeFrom:i.ticketRangeFrom,ticketRangeTo:i.ticketRangeTo,adminLocked:false}))}};
  });
  route('post','/cases',(req,db)=>saveCase(req,db));
  route('put','/cases/:id',async(req,db)=>saveCase(req,db,await requireRow(db,'cases',req.params.id)));
  route('delete','/cases/:id',async(req,db)=>{
    const row=await requireRow(db,'cases',req.params.id);await db.run("UPDATE cases SET isActive=0,status='inactive' WHERE id=?",[row.id]);return {data:{id:row.id}};
  });
  for(const action of ['reactivate','deactivate'])route('post',`/cases/:id/${action}`,async(req,db)=>{
    const row=await requireRow(db,'cases',req.params.id);if(row.archived&&action==='reactivate')invalid('Архивный кейс нельзя активировать',409);
    await db.run('UPDATE cases SET isActive=?,status=? WHERE id=?',[action==='reactivate'?1:0,action==='reactivate'?'active':'inactive',row.id]);
    return {data:await fullCase(db,await requireRow(db,'cases',row.id))};
  });

  const defaultTypes=['info','terms','privacy','faq','about'];
  const pageType=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value))invalid('Некорректный тип страницы');return value;};
  route('get','/page/types',async(req,db)=>{
    const rows=await db.all("SELECT type FROM content_page_types UNION SELECT type FROM pages WHERE type IS NOT NULL");
    return {data:{types:[...new Set([...defaultTypes,...rows.map(r=>r.type)])].sort()}};
  });
  route('post','/page/types',async(req,db)=>{const type=pageType(req.body.type);await db.run('INSERT OR IGNORE INTO content_page_types(type) VALUES(?)',[type]);return {data:{type}};});
  const pageDto=r=>{let content;try{content=JSON.parse(r.content)}catch{content={text:r.content||''}}return {id:r.id,pageType:r.type||r.slug,locale:r.locale||'ru',version:r.version||1,updatedBy:r.updated_by||null,content};};
  route('get','/pages',async(req,db)=>{
    const where=req.query.type?['p.type=?']:[],args=req.query.type?[req.query.type]:[];
    return list(db,'pages p LEFT JOIN content_page_meta m ON m.page_id=p.id',req.query,where,args,'p.id DESC',pageDto);
  });
  route('post','/pages',async(req,db)=>{
    const type=pageType(req.body.type),content=req.body.content;
    if(!content||typeof content!=='object')invalid('Контент должен быть JSON-объектом или массивом');
    const old=await db.get('SELECT * FROM pages WHERE type=? OR slug=? ORDER BY id LIMIT 1',[type,type]);
    const fields={slug:old?.slug||type,type,title:type,content:JSON.stringify(content)};
    let id=old?.id;if(id)await update(db,'pages',id,fields);else id=await insert(db,'pages',fields);
    await db.run(`INSERT INTO content_page_meta(page_id,version,updated_by) VALUES(?,1,?) ON CONFLICT(page_id) DO UPDATE SET version=version+1,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,[id,req.user?.username||null]);
    await db.run('INSERT OR IGNORE INTO content_page_types(type) VALUES(?)',[type]);
    return {data:pageDto(await db.get('SELECT * FROM pages p LEFT JOIN content_page_meta m ON m.page_id=p.id WHERE p.id=?',[id]))};
  });
  // These controls used to return invented numbers or a successful no-op.
  // Enabling them needs game-side stock reservation and tier-specific payouts.
  for(const [method,url] of [
    ['get','/cases/series/:id/supply'],['put','/cases/series/:id/supply/:caseId'],
    ['put','/cases/series/:id/limited'],['get','/cases/series/:id/monitor'],['get','/cases/series/:id/audit'],
    ['post','/cases/series/:id/activate'],['post','/cases/series/:id/pause'],['post','/cases/series/:id/resume'],['post','/cases/series/:id/close'],
    ['post','/cases/fix-rtp'],['post','/rtp/solve-preview'],['post','/rtp/cases/:caseId/tier/:tierId/auto-derive']
  ])route(method,url,async()=>invalid('Эта операция ещё не подключена к игровому движку. Изменения не выполнены.',501));
}
module.exports={register};
