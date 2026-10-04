import test from 'node:test';
import assert from 'node:assert/strict';
import {careTeamPreviews} from './preview-care-team.ts';
import type {Action} from '../src/contracts.ts';
const a={id:'a',incidentId:'i',type:'alert',recipientId:'maya',text:'Actual incident alert',status:'provider_accepted',createdAt:2000} as Action;
test('preview copies only new care-team outbound messages, never wearer messages or queued drafts',()=>{
 const drafts=[a,{...a,id:'old',createdAt:500},{...a,id:'wearer',recipientId:null}, {...a,id:'queued',status:'queued'}] as Action[];
 assert.deepEqual(careTeamPreviews(drafts,1000,new Set()),[a]);
 assert.deepEqual(careTeamPreviews(drafts,1000,new Set(['a'])),[]);
});
test('preview selection cannot change original routing or delivery status',()=>{
 const before=JSON.stringify(a);careTeamPreviews([a],1000,new Set());assert.equal(JSON.stringify(a),before);
});
