import test from 'node:test';import assert from 'node:assert/strict';
import {normalizePhoton,createPhotonAdapter} from './photon.ts';import {choiceText} from '../patient-followup.ts';
const event={id:'vote-1',platform:'imessage',direction:'inbound',sender:{id:'+12025550100'},space:{id:'any;-;+12025550100',phone:'shared'},content:{type:'poll_option',selected:true,poll:{title:'How are you feeling today?'},option:{title:'A little lonely'}}};
test('selected native poll choices normalize as attributed patient input; deselections do not',()=>{
 assert.equal(normalizePhoton(event)?.pollQuestion,'How are you feeling today?');assert.equal(normalizePhoton(event)?.text,'A little lonely');
 assert.equal(normalizePhoton({...event,content:{...event.content,selected:false}}),null);
});
test('generated patient choices use native poll transport, while plain fallback stays available',async()=>{
 let native=0,texts=0;
 const space={id:'any;-;+12025550100',phone:'shared',send:async()=>{texts++;return{id:'text'}},sendPoll:async(title:string,options:string[])=>{native++;assert.equal(title,'Question?');assert.deepEqual(options,['Yes','No']);return{id:'poll'}}};
 const adapter=createPhotonAdapter({projectId:'x',projectSecret:'y',factory:async()=>({messages:async function*(){}(),openDm:async()=>space,stop:async()=>{}})});
 assert.equal((await adapter.sendMessage('+12025550100',choiceText('Question?',['Yes','No']))).status,'provider_accepted');assert.equal(native,1);assert.equal(texts,0);
});
