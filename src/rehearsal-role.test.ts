import test from 'node:test';
import assert from 'node:assert/strict';
import {RehearsalRole} from './rehearsal-role.ts';
import {Controller} from './controller.ts';
import {handleResponderProgress} from './responder.ts';
import type {ProviderInbound} from './contracts.ts';
const wearer='+12025550100',maya='+12025550101';
const event:ProviderInbound={messageId:'incoming',sender:wearer,kind:'text',text:'on it',chatId:'chat',lineId:'line'};
test('role switch is explicit, incident-bound, and expires automatically',()=>{
 let now=0;const roles=new RehearsalRole(()=>now);
 assert.equal(roles.map(event,'LF-ABC',wearer,maya),null);
 roles.set('LF-ABC','maya');assert.equal(roles.map(event,'LF-ABC',wearer,maya)?.sender,maya);
 assert.equal(roles.map({...event,sender:'+12025550102'},'LF-ABC',wearer,maya),null);
 assert.equal(roles.map(event,'LF-OTHER',wearer,maya),null);
 roles.set('LF-ABC','maya');now=30*60_000;assert.equal(roles.view('LF-ABC'),null);
});
test('role switch preserves clinical questions and binds simple progress to the current incident',()=>{
 const roles=new RehearsalRole();roles.set('LF-ABC','maya');
 assert.equal(roles.map(event,'LF-ABC',wearer,maya)?.text,'on it LF-ABC');
 assert.equal(roles.map({...event,text:'What meds are recorded?'},'LF-ABC',wearer,maya)?.text,'What meds are recorded?');
 assert.equal(roles.map({...event,text:'resolved: Stayed with Morgan.'},'LF-ABC',wearer,maya)?.text,'RESOLVED LF-ABC Stayed with Morgan.');
 assert.equal(roles.map({...event,targetMessageId:'original-alert'},'LF-ABC',wearer,maya)?.text,'on it');
 roles.clear();assert.equal(roles.map(event,'LF-ABC',wearer,maya),null);
});
test('rehearsal acceptance still requires actual accepted alert chat provenance',()=>{
 const c=new Controller(':memory:',[{id:'maya',name:'Maya',phone:maya}]);
 try {
  const i=c.trigger({kind:'manual',summary:'Isolated rehearsal fixture'});
  const originalAlerts=c.actions(i.id).filter(a=>a.type==='alert').length;
  c.queueRehearsalAlert(i.id,'maya');
  assert.equal(c.actions(i.id).filter(a=>a.type==='alert').length,originalAlerts+1);
  const role=new RehearsalRole();role.set(i.id,'maya');
  const mapped=role.map(event,i.id,wearer,maya)!;
  assert.equal(handleResponderProgress(mapped,c),false);
  const action=c.claimAction('responders')!;
  c.finishAction(action.id,'provider_accepted','Synthetic fixture acceptance','alert-id',{chatId:'chat',lineId:'line'});
  assert.equal(handleResponderProgress({...mapped,chatId:'wrong'},c),false);
  assert.equal(handleResponderProgress(mapped,c),true);assert.equal(c.active()?.ownerId,'maya');
  assert.ok(c.events(i.id).some(e=>e.type==='REHEARSAL_ROLE_SWITCH'));
 }finally{c.close();}
});
