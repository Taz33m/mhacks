import {readFileSync,writeFileSync} from 'node:fs';
const file=new URL('../node_modules/@spectrum-ts/imessage/dist/index.js',import.meta.url);
let source=readFileSync(file,'utf8');
if(!source.includes('lifelinePollTitles')){
 const old='const outboundPoll = (spaceId, poll, content) => outboundRecord(spaceId, poll.pollMessageGuid, content, /* @__PURE__ */ new Date());';
 const replacement='const lifelinePollTitles = new Map();\nconst outboundPoll = (spaceId, poll, content) => { lifelinePollTitles.set(poll.pollMessageGuid, content.title); return outboundRecord(spaceId, poll.pollMessageGuid, content, new Date()); };';
 if(!source.includes(old)||!source.includes('title: input.title,')||!source.includes('title: event.delta.title,'))throw Error('Spectrum poll patch needs review for this SDK version');
 source=source.replace(old,replacement).replace('title: input.title,','title: input.title || lifelinePollTitles.get(input.pollMessageGuid) || "Unknown patient poll",').replace('title: event.delta.title,','title: event.delta.title || lifelinePollTitles.get(event.pollMessageGuid),\n            pollMessageGuid: event.pollMessageGuid,');
 writeFileSync(file,source);
}
console.log('Spectrum empty poll title compatibility fix applied.');
