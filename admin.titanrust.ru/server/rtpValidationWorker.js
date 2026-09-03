'use strict';
const {parentPort,workerData:d}=require('node:worker_threads');
const crypto=require('node:crypto');
const {fairFloat,pickByRoll}=require('../../services/drops');
const started=Date.now();
let mean=0,m2=0,lastReport=started;
for(let i=0;i<d.iterations;i++){
  const item=pickByRoll(d.entries,fairFloat(d.seedServer,d.seedClient,d.nonceStart+i));
  const value=Number(item.price)/d.casePrice,delta=value-mean;
  mean+=delta/(i+1);m2+=delta*(value-mean);
  if((i+1)%10000===0&&Date.now()-lastReport>=200){
    parentPort.postMessage({type:'progress',iterationsDone:i+1,currentEmpRtp:mean,currentCi95:1.96*Math.sqrt(m2/i/(i+1))});lastReport=Date.now();
  }
}
parentPort.postMessage({type:'done',result:{iterations:d.iterations,durationMs:Date.now()-started,
  arithmeticRtp:d.entries.reduce((s,e)=>s+e.p*e.item.price/d.casePrice,0),empiricalRtp:mean,
  targetRtp:d.targetRtp,delta:mean-d.targetRtp,ci95HalfWidth:1.96*Math.sqrt(m2/(d.iterations-1)/d.iterations),
  seedUsed:{serverHash:crypto.createHash('sha256').update(d.seedServer).digest('hex'),server:d.seedServer,client:d.seedClient,nonceStart:d.nonceStart}
}});
