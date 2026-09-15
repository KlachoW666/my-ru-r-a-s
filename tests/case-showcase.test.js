'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
// Static CSS contract; appearance and responsive layout are checked in Browser.
test('home showcase uses open cards without changing item rarity styles',()=>{
 const css=fs.readFileSync(require('node:path').join(__dirname,'../public/assets/css/bearz-workshop.css'),'utf8');
 assert.match(css,/\.bz-home \.case-card\{[^}]*text-align:center[^}]*border:0/);
 assert.match(css,/\.bz-home \.case-card \.cc-price\{[^}]*width:fit-content/);
 assert.match(css,/prefers-reduced-motion:reduce/);
});
