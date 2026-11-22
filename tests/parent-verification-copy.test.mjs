import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileStore,setStore} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('the parent explanation names a card charge and refund, with a native accessible reason disclosure',()=>{
 const note=source.match(/id="cardCheckNote">([^<]+)<\/p>/)[1];
 assert.match(note,/\$0\.50 card charge/);
 assert.match(note,/full refund through Stripe right away, back to the same card/);
 assert.match(note,/bank may take time to show the credit/);
 assert.match(note,/original charge may disappear/);
 const disclosure=source.match(/<details class="help" id="parentVerificationWhy">([\s\S]*?)<\/details>/)[1];
 assert.match(disclosure,/^<summary>Why do we ask\?<\/summary>/);
 assert.match(disclosure,/helps us confirm that an adult is approving and managing/);
 assert.doesNotMatch(disclosure,/proves|proof of|guarantees/i);
 assert.ok(!source.includes('50¢ refunded check'));
 assert.ok(!source.includes('card check is still processing'));
});

test('parent notices and both invitation email formats explain the same card refund',async()=>{
 const dir=await mkdtemp(tmpdir()+'/hb-parent-copy-');
 setStore(fileStore(dir));
 Object.assign(process.env,{PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:'http://copy.test'});
 const call=(method,path,body)=>handleRequest({method,path,body:body?JSON.stringify(body):'',headers:{origin:'http://copy.test'},origin:'http://copy.test',query:new URL('http://copy.test'+path).searchParams});
 try{
  for(const path of ['/api/site/privacy','/api/site/terms']){
   const page=await call('GET',path);
   assert.equal(page.status,200);
   assert.match(page.body,/Last updated November 22, 2026/);
   assert.match(page.body,/\$0\.50 card payment/);
   assert.match(page.body,/full refund through Stripe right away, back to the same card/);
   assert.match(page.body,/bank may take time to show the credit/);
   assert.match(page.body,/eligible playtester code/);
   assert.doesNotMatch(page.body,/50¢|card check|refunded check|proves you are/i);
  }
  const sent=await call('POST','/api/ask',{email:'copy-parent@example.com',draft:{first:'Taylor',bizName:'Taylor’s Yard Crew',type:'prep'}});
  assert.equal(sent.status,200);
  const out=await call('GET','/api/test/outbox?email=copy-parent%40example.com');
  const mail=JSON.parse(out.body).messages[0];
  for(const message of [mail.text,mail.html]){
   assert.match(message,/\$0\.50 card payment/);
   assert.match(message,/bank may take time to show the credit/);
   assert.match(message,/adult is approving and managing/);
   assert.doesNotMatch(message,/50¢|card check|refunded check|proves you are/i);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
