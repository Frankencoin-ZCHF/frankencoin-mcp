import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.CACHE_ENABLED = 'false';
const { createHttpServer } = await import('../../src/server/http.js');
const { setFetchImpl } = await import('../../src/upstream/client.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { DOC_FILES, KNOWLEDGE_TOPICS } = await import('../../src/lib/constants.js');
const { dispatchTool } = await import('../../src/tools/dispatch.js');
const doc = readFileSync(new URL('../fixtures/live-audit/overview.md', import.meta.url), 'utf8');

test('inherited object keys are unknown topics and never become outbound GitHub paths', async () => {
  const calls=[];
  setFetchImpl(async url => {calls.push(url); return new Response('down',{status:503});});
  for (const topic of ['__proto__','constructor','toString','../README.md']) {
    const result = await dispatchTool('get_knowledge',{topic});
    assert.match(result.error, /Unknown topic/);
    assert.deepEqual(result.availableTopics, KNOWLEDGE_TOPICS);
  }
  assert.deepEqual(calls, []);
});

test('SDK knowledge results preserve document fields in both MCP representations and REST', async () => {
  let fail = false;
  setFetchImpl(async () => fail ? new Response('unavailable',{status:503}) : new Response(JSON.stringify({content:Buffer.from(doc).toString('base64')})));
  const server = createHttpServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({name:'knowledge-contract-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
    const manifest = await client.listTools();
    const tool = manifest.tools.find(t=>t.name==='get_knowledge');
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.inputSchema.properties.topic.default,'overview');
    for(const topic of Object.keys(DOC_FILES)) {
      const mcp=await client.callTool({name:'get_knowledge',arguments:{topic}});
      assert.equal(mcp.structuredContent.content,doc);
      assert.equal(mcp.structuredContent.topic,topic);
      assert.deepEqual(mcp.structuredContent, JSON.parse(mcp.content[0].text));
      const rest=await (await fetch(base+`/api/get_knowledge?topic=${topic}`)).json();
      assert.equal(rest.result.content,mcp.structuredContent.content);
      assert.equal(rest.result.source,mcp.structuredContent.source);
    }
    for(const args of [{topic:42},{topic:'faq',extra:true}]) {
      const result=await client.callTool({name:'get_knowledge',arguments:args});
      assert.equal(result.isError,true);
    }
    assert.equal((await fetch(base+'/api/get_knowledge?topic=faq&extra=true')).status,400);
    fail=true;
    const unavailable=await client.callTool({name:'get_knowledge',arguments:{topic:'faq'}});
    assert.equal(unavailable.structuredContent.content,null);
    assert.equal(unavailable.structuredContent.status,'unavailable');
    assert.equal(unavailable.structuredContent.sources.github.code,'upstream_error');
    assert.notDeepEqual(unavailable.structuredContent,{});
    const upstreamError=await client.callTool({name:'get_compliance',arguments:{}});
    assert.equal(upstreamError.isError,true);
    assert.equal(upstreamError.structuredContent.code,'upstream_error');
  } finally {await client.close();server.closeAllConnections();await new Promise(r=>server.close(r));setFetchImpl(null);}
});
