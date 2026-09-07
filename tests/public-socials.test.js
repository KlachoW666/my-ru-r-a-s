'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {publicSocials}=require('../services/publicSocials');
test('BEARZ defaults use the final user-provided accounts',()=>{
  assert.deepEqual(publicSocials([]).map(x=>x.url),['https://t.me/bearztop','https://vk.com/bearztop']);
});
test('legacy social rows get keys for the actual footer icons',()=>{
  const links=publicSocials([{id:'telegram',name:'Telegram',url:'https://t.me/kabangg'},{id:'vk',name:'VK',url:'https://vk.com/kabangg'},{id:'discord',name:'Discord',url:'https://discord.gg/kaban'}]);
  assert.deepEqual(links.map(x=>[x.key,x.url]),[['telegram','https://t.me/bearztop'],['vk','https://vk.com/bearztop']]);
});
test('admin replacement accounts are not overwritten',()=>{
  const links=publicSocials([{id:'telegram',name:'Telegram',url:'https://t.me/new_owned_channel'}]);
  assert.equal(links[0].url,'https://t.me/new_owned_channel');
});
test('previous intermediate telegram name migrates to the final name',()=>{
  assert.equal(publicSocials([{id:'telegram',url:'https://t.me/satchel_top'}])[0].url,'https://t.me/bearztop');
});
