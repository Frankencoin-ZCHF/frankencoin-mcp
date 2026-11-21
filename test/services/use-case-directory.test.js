import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchTool } from "../../src/tools/dispatch.js";
import { setFetchImpl } from "../../src/upstream/client.js";

test("website edits, removals and failed refreshes propagate to both guide and directory", async t => {
  t.mock.timers.enable({apis:["Date"], now:Date.now()});
  let file = {
    gettingStarted:{buy:["entry"],pay:[],save:[],borrow:[],invest:[]},
    cases:[{id:"entry",title:"Buy from a wallet",partner:"First name",description:"First route.",link:"https://example.org/old"}]
  };
  let reads=0;
  setFetchImpl(async url=>{
    let body="# Protocol";
    if(url.includes("use-cases.json")){
      reads++;
      body=JSON.stringify(file);
    } else if(!url.includes("gitbook/")) body="{}";
    return Response.json({content:Buffer.from(body).toString("base64")});
  });
  t.after(()=>setFetchImpl(null));
  const overview=()=>dispatchTool("get_knowledge",{});
  const links=()=>dispatchTool("get_knowledge",{topic:"links"});
  const first=await Promise.all([overview(),links()]);
  assert.match(first[0].gettingStarted,/First name/);
  assert.equal(reads,1);
  file.cases[0]={...file.cases[0],partner:"Second name",description:"New route.",link:"https://example.org/new"};
  t.mock.timers.tick(300001);
  const changed=await overview();
  assert.match(changed.gettingStarted,/Second name.*example.org\/new.*New route/);
  assert.equal((await links()).useCaseHighlights[0].url,file.cases[0].link);
  const valid=file;
  file={cases:"bad"};
  t.mock.timers.tick(300001);
  const stale=await overview();
  assert.equal(stale.sources.useCases.status,"stale");
  assert.equal(stale.sources.useCases.lastSuccessAt,changed.sources.useCases.lastSuccessAt);
  assert.equal(stale.gettingStarted,changed.gettingStarted);
  assert.equal((await links()).useCaseSource.status,"stale");
  file={...valid,cases:[]};
  t.mock.timers.tick(30001);
  const removed=await overview();
  assert.equal(removed.sources.useCases.status,"available");
  assert.doesNotMatch(removed.gettingStarted,/Second name|example.org/);
  assert.match(removed.gettingStarted,/Buy ZCHF/);
  assert.deepEqual((await links()).useCaseHighlights,[]);
});
