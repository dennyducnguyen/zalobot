const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'zalo-mcp-test-'));
process.env.DB_PATH = path.join(dir,'test.db');
const store = require('../src/db');
const {installMcp} = require('../src/mcp');
const {hash, createMcpStore} = require('../src/mcp/store');
const testPassword = crypto.randomBytes(18).toString('hex');
const userId = Number(store.users.create('mcp-test',bcrypt.hashSync(testPassword,4),'Test').lastInsertRowid);
let sent = [], connected=true, sendHook=null;
const channel = {
    status:()=>({connected,listening:connected,zalo_id:'123',display_name:'Test channel',proxy:'DO_NOT_EXPOSE'}),
    async findUserByPhone(phone) {return phone==='0900000000'?{success:true,data:{uid:'12345678901234567890',display_name:'Người thử',avatar:''}}:{success:false};},
    async sendText(to,message,source,type) {if(sendHook) await sendHook();sent.push({to,message,source,type});return {message_row:{msg_id:'msg-'+sent.length,sent_at:Date.now()}};},
};
let requestCounter=0;

test('MCP/OAuth server and send controls (no real Zalo calls)', async t=>{
    const app=express();
    app.use(cookieParser());
    const http=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>http.once('listening',resolve));
    const origin=`http://127.0.0.1:${http.address().port}`;
    const {provider,timer}=installMcp(app,{store,channel,config:{MCP_PUBLIC_URL:origin,MCP_SEND_INTERVAL_MS:0,APP_NAME:'Test'},webAuth:require('../src/middleware/webAuth')});
    app.use(express.json());
    app.use('/app',require('../src/routes/web'));
    app.use('/api/v1',require('../src/middleware/apiAuth'),require('../src/routes/api'));
    app.use(express.static(path.join(__dirname,'../public')));
    app.use((err,req,res,next)=>res.status(err.status || 500).json({error:'request_failed'}));
    async function post(url,body,headers={}) {return fetch(origin+url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
    async function form(url,body,headers={}) {return fetch(origin+url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body)});}
    async function register(secret=false) {
        const response=await post('/register',{client_name:'Integration test',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:secret?'client_secret_post':'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
        assert.equal(response.status,201);return response.json();
    }
    async function startAuthorization(client,scope='zalo:read zalo:send',extra={}) {
        const verifier=crypto.randomBytes(32).toString('base64url');
        const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
        const query=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,scope,state:'test-state',resource:origin+'/mcp',...extra});
        const response=await fetch(origin+'/authorize?'+query,{redirect:'manual'});
        return {response,verifier,cookie:response.headers.get('set-cookie')?.split(';')[0],url:response.headers.get('location')};
    }
    async function consent(start,scopes=['zalo:read','zalo:send']) {
        const page=await fetch(origin+start.url,{headers:{Cookie:start.cookie}});
        assert.equal(page.status,200);
        assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
        assert.equal(page.headers.get('referrer-policy'),'same-origin');
        assert.match(page.headers.get('content-security-policy'),/form-action 'self' https:\/\/client\.example;/);
        const html=await page.text();
        assert.match(html,/Đăng nhập và cấp quyền/);
        const id=new URL(start.url,origin).searchParams.get('id');
        const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
        const body=new URLSearchParams({id,csrf,username:'mcp-test',password:testPassword,decision:'allow'});
        scopes.forEach(s=>body.append('scopes',s));
        const response=await fetch(origin+'/oauth/consent',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:start.cookie,Origin:origin},body});
        assert.equal(response.status,303);
        const callback=new URL(response.headers.get('location'));
        assert.equal(callback.searchParams.get('iss'),origin);
        assert.equal(callback.searchParams.get('state'),'test-state');
        return {code:callback.searchParams.get('code'),id,csrf};
    }
    async function token(client,start,code,extra={}) {
        return form('/token',{grant_type:'authorization_code',client_id:client.client_id,...(client.client_secret?{client_secret:client.client_secret}:{}),code,code_verifier:start.verifier,redirect_uri:'https://client.example/callback',resource:origin+'/mcp',...extra});
    }
    async function connectClient(client,scopes=['zalo:read','zalo:send']) {
        const start=await startAuthorization(client,scopes.join(' '));
        assert.equal(start.response.status,303);
        const approved=await consent(start,scopes);
        const response=await token(client,start,approved.code);
        assert.equal(response.status,200);
        return response.json();
    }
    async function rpc(access,method,params={},headers={}) {
        const response=await post('/mcp',{jsonrpc:'2.0',id:++requestCounter,method,params},{Authorization:`Bearer ${access}`,Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...headers});
        return {response,body:await response.json()};
    }
    async function call(access,name,args={}) {const {response,body}=await rpc(access,'tools/call',{name,arguments:args});assert.equal(response.status,200);return body.result;}
    const payload=(r)=>r.structuredContent;
    let client, tokens, readTokens;
    try {
        await t.test('discovery and unauthenticated challenge',async()=>{
            const response=await fetch(origin+'/.well-known/oauth-authorization-server');const metadata=await response.json();
            assert.equal(metadata.issuer,origin);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.equal(metadata.registration_endpoint,origin+'/register');
            const protectedMetadata=await (await fetch(origin+'/.well-known/oauth-protected-resource/mcp')).json();assert.equal(protectedMetadata.resource,origin+'/mcp');
            assert.deepEqual(protectedMetadata.authorization_servers,[metadata.issuer]);
            const rootMetadata=await(await fetch(origin+'/.well-known/oauth-protected-resource')).json();
            assert.deepEqual(rootMetadata,protectedMetadata);
            assert.equal(response.headers.get('cache-control'),'no-store');
            const denied=await post('/mcp',{});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/);
            assert.equal((await post('/mcp',{}, {Origin:'https://untrusted.example'})).status,403);
        });
        await t.test('DCR, redirect validation, CSRF and wrong PKCE',async()=>{
            assert.equal((await post('/register',{redirect_uris:['http://evil.example/callback']})).status,400);
            client=await register();
            const invalid=await startAuthorization(client,undefined,{redirect_uri:'https://evil.example/callback'});assert.equal(invalid.response.status,400);assert.equal(invalid.response.headers.get('location'),null);
            const badResource=await startAuthorization(client,undefined,{resource:'https://other.example/mcp'});assert.equal(new URL(badResource.url).searchParams.get('error'),'invalid_target');
            const start=await startAuthorization(client);
            assert.equal((await form('/oauth/consent',{id:new URL(start.url,origin).searchParams.get('id'),csrf:'bad'},{Origin:origin,Cookie:start.cookie})).status,403);
            const page=await fetch(origin+start.url,{headers:{Cookie:start.cookie}});
            const csrf=(await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
            const body={id:new URL(start.url,origin).searchParams.get('id'),csrf,username:'mcp-test',password:testPassword,decision:'allow',scopes:'zalo:read'};
            for (const suppliedOrigin of ['null','https://untrusted.example',undefined]) {
                assert.equal((await form('/oauth/consent',body,{Cookie:start.cookie,...(suppliedOrigin?{Origin:suppliedOrigin}:{})})).status,403);
            }
            assert.equal((await form('/oauth/consent',body,{Origin:origin})).status,403);
            assert.equal((await form('/oauth/consent',body,{Origin:origin,Cookie:'mcp_consent=incorrect'})).status,403);
            const approved=await consent(start);
            assert.equal((await token(client,start,approved.code,{code_verifier:'wrong'})).status,400);
            assert.equal((await token(client,start,approved.code,{resource:'https://other.example/mcp'})).status,400);
            const response=await token(client,start,approved.code);assert.equal(response.status,200);tokens=await response.json();
            assert.equal((await token(client,start,approved.code)).status,400);
            assert.equal(store.db.prepare('SELECT 1 FROM mcp_tokens WHERE hash=?').get(tokens.access_token),undefined);
        });
        await t.test('confidential client secret is hashed; OAuth works',async()=>{
            const c=await register(true);
            assert.notEqual(JSON.parse(store.db.prepare('SELECT metadata FROM mcp_clients WHERE id=?').get(c.client_id).metadata).client_secret,c.client_secret);
            assert.ok((await connectClient(c)).access_token);
        });
        await t.test('automatic discovery, DCR and PKCE without preconfigured endpoints',async()=>{
            const {auth:oauth}=require('@modelcontextprotocol/sdk/client/auth.js');
            const memory={};
            const auto={
                redirectUrl:'https://client.example/callback',
                clientMetadata:{client_name:'Automatic discovery test',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'zalo:read'},
                state:()=> 'test-state',
                clientInformation:()=>memory.client,
                saveClientInformation:value=>{memory.client=value;},
                tokens:()=>memory.tokens,
                saveTokens:value=>{memory.tokens=value;},
                saveCodeVerifier:value=>{memory.verifier=value;},
                codeVerifier:()=>memory.verifier,
                redirectToAuthorization:url=>{memory.url=url.href;},
                saveDiscoveryState:value=>{memory.discovery=value;},
                discoveryState:()=>memory.discovery,
            };
            const first=await oauth(auto,{serverUrl:new URL(origin+'/mcp')});
            assert.equal(first,'REDIRECT');assert.ok(memory.client.client_id);
            assert.equal(memory.discovery.authorizationServerMetadata.issuer,origin);
            const response=await fetch(memory.url,{redirect:'manual'});
            assert.equal(response.status,303);
            const approved=await consent({url:response.headers.get('location'),cookie:response.headers.get('set-cookie').split(';')[0]},['zalo:read']);
            const second=await oauth(auto,{serverUrl:new URL(origin+'/mcp'),authorizationCode:approved.code});
            assert.equal(second,'AUTHORIZED');
            assert.equal((await rpc(memory.tokens.access_token,'tools/list')).response.status,200);
        });
        await t.test('real SDK client discovers tools over stateless Streamable HTTP',async()=>{
            const sdk=new Client({name:'automated-test',version:'1.0.0'});
            await sdk.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
            const tools=await sdk.listTools();assert.equal(tools.tools.length,7);
            const state=await sdk.callTool({name:'zalo_get_status',arguments:{}});assert.equal(state.structuredContent.data.connected,true);assert.ok(!JSON.stringify(state).includes('DO_NOT_EXPOSE'));
            await sdk.close();
        });
        await t.test('list pagination, contact/chat distinction and literal search',async()=>{
            for(let n=0;n<7;n++)store.threads.upsertContact({threadId:String(800+n),type:'group',name:'Nhóm '+n});
            store.threads.upsertContact({threadId:'900',type:'user',name:'Chưa chat'});
            store.threads.upsertContact({threadId:'901',type:'user',name:'Đã chat 100%'});
            store.messages.insert({msgId:'test-history',threadId:'901',direction:'in',source:'zalo',content:'private history',contentType:'text',sentAt:Date.now()});
            const first=payload(await call(tokens.access_token,'zalo_list_groups',{limit:3})).data;
            const second=payload(await call(tokens.access_token,'zalo_list_groups',{limit:3,cursor:first.next_cursor})).data;
            assert.equal(first.total,7);assert.equal(first.results.length,3);assert.equal(new Set([...first.results,...second.results].map(r=>r.thread_id)).size,6);
            const chats=payload(await call(tokens.access_token,'zalo_list_conversations',{type:'user'})).data;assert.deepEqual(chats.results.map(r=>r.thread_id),['901']);assert.ok(!JSON.stringify(chats).includes('private history'));
            const literal=payload(await call(tokens.access_token,'zalo_list_contacts',{query:'%'})).data;assert.equal(literal.total,1);
        });
        await t.test('read-only scope cannot send',async()=>{
            readTokens=await connectClient(client,['zalo:read']);
            const denied=await call(readTokens.access_token,'zalo_send_message',{to:'901',thread_type:'user',message:'Test',request_id:'scope-test-1'});
            assert.equal(payload(denied).error.code,'INSUFFICIENT_SCOPE');assert.equal(sent.length,0);
        });
        await t.test('send by ID/phone, preserve large IDs and deduplicate',async()=>{
            const args={to:'901',thread_type:'user',message:'Xin chào có dấu',request_id:'idempotent-test-1'};
            const first=await call(tokens.access_token,'zalo_send_message',args);assert.equal(payload(first).success,true);assert.equal(sent.length,1);assert.equal(sent[0].source,'mcp');
            assert.deepEqual(await call(tokens.access_token,'zalo_send_message',args),first);assert.equal(sent.length,1);
            const conflict=await call(tokens.access_token,'zalo_send_message',{...args,message:'Changed'});assert.equal(payload(conflict).error.code,'IDEMPOTENCY_CONFLICT');
            const byPhone=payload(await call(tokens.access_token,'zalo_send_message_by_phone',{phone:'0900000000',message:'Test phone',request_id:'phone-test-1'}));assert.equal(byPhone.data.to,'12345678901234567890');assert.equal(sent.length,2);
            const missing=payload(await call(tokens.access_token,'zalo_send_message_by_phone',{phone:'0911111111',message:'Test',request_id:'missing-test-1'}));assert.equal(missing.error.code,'USER_NOT_FOUND');assert.equal(sent.length,2);
            const mismatch=payload(await call(tokens.access_token,'zalo_send_message',{...args,thread_type:'group',request_id:'mismatch-test-1'}));assert.equal(mismatch.error.code,'RECIPIENT_TYPE_MISMATCH');
        });
        await t.test('concurrency and uncertain send must not replay',async()=>{
            let release, started;
            const began=new Promise(r=>started=r);
            sendHook=()=>{started();return new Promise(r=>release=r);};
            const args={to:'901',thread_type:'user',message:'One',request_id:'concurrency-test-1'};
            const one=call(tokens.access_token,'zalo_send_message',args);await began;
            assert.equal(payload(await call(tokens.access_token,'zalo_send_message',args)).error.code,'SEND_IN_PROGRESS');
            assert.equal(payload(await call(tokens.access_token,'zalo_send_message',{...args,request_id:'concurrency-test-2'})).error.code,'RATE_LIMITED');
            release();await one;
            sendHook=async()=>{throw new Error('Network timeout');};
            const unknown={...args,request_id:'unknown-test-1'};
            assert.equal(payload(await call(tokens.access_token,'zalo_send_message',unknown)).error.code,'SEND_OUTCOME_UNKNOWN');
            sendHook=null;
            assert.equal(payload(await call(tokens.access_token,'zalo_send_message',unknown)).error.code,'SEND_OUTCOME_UNKNOWN');
        });
        await t.test('restart recovery and disconnected channel',async()=>{
            store.db.prepare("INSERT INTO mcp_sends VALUES (?,?,?,?,?,'pending',NULL,?,?)").run('1:x','restart-test-1','unused','send','901',Date.now(),Date.now());
            createMcpStore(store.db);assert.equal(store.db.prepare('SELECT status FROM mcp_sends WHERE request_id=?').get('restart-test-1').status,'unknown');
            connected=false;
            assert.equal(payload(await call(tokens.access_token,'zalo_send_message',{to:'901',thread_type:'user',message:'Test',request_id:'offline-test-1'})).error.code,'NOT_CONNECTED');
            connected=true;
        });
        await t.test('refresh rotation, replay revocation, expiry and audience',async()=>{
            const refresh=await form('/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:origin+'/mcp'});assert.equal(refresh.status,200);const rotated=await refresh.json();
            assert.notEqual(rotated.refresh_token,tokens.refresh_token);
            assert.equal((await form('/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token})).status,400);
            assert.equal((await rpc(rotated.access_token,'tools/list')).response.status,401);
            tokens=await connectClient(client);
            store.db.prepare('UPDATE mcp_tokens SET resource=? WHERE hash=?').run('https://wrong.example/mcp',hash(tokens.access_token));assert.equal((await rpc(tokens.access_token,'tools/list')).response.status,401);
            store.db.prepare('UPDATE mcp_tokens SET resource=?,expires_at=? WHERE hash=?').run(origin+'/mcp',Date.now()-1,hash(tokens.access_token));assert.equal((await rpc(tokens.access_token,'tools/list')).response.status,401);
            tokens=await connectClient(client);
        });
        await t.test('web login, management/revoke and REST authentication regression',async()=>{
            assert.equal((await fetch(origin+'/app/mcp/connections')).status,401);
            assert.equal((await fetch(origin+'/api/v1/status')).status,401);
            const login=await post('/app/login',{username:'mcp-test',password:testPassword});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
            const response=await fetch(origin+'/app/mcp/connections',{headers:{Cookie:cookie}});assert.equal(response.status,200);const connections=(await response.json()).data.connections;assert.ok(connections.length>=3);assert.ok(!JSON.stringify(connections).includes(tokens.access_token));
            const grantId=(await provider.verifyAccessToken(tokens.access_token)).extra.grantId;
            const revokeUrl=origin+'/app/mcp/connections/'+grantId;
            assert.equal((await fetch(revokeUrl,{method:'DELETE',headers:{Cookie:cookie}})).status,403);
            assert.equal((await fetch(revokeUrl,{method:'DELETE',headers:{Cookie:cookie,Origin:origin,'X-MCP-Settings':'1'}})).status,200);
            assert.equal((await rpc(tokens.access_token,'tools/list')).response.status,401);
            assert.equal((await fetch(origin+'/settings.html')).status,200);
            store.apiKeys.create('test','zik_test_only');
            assert.equal((await fetch(origin+'/api/v1/status',{headers:{'X-API-Key':'zik_test_only'}})).status,200);
        });
        await t.test('password changes invalidate existing OAuth grants',async()=>{
            const before=await connectClient(client);
            store.users.updatePassword(userId,bcrypt.hashSync('changed-'+testPassword,4));
            assert.equal((await rpc(before.access_token,'tools/list')).response.status,401);
        });
        await t.test('send interval rejects another request without sending',async()=>{
            const service=require('../src/mcp/tools').createToolService(store.db,channel,{minIntervalMs:10000,verifyAccessToken:async()=>({})});
            const count=sent.length;
            const blocked=await service.send('zalo_send_message',{to:'901',thread_type:'user',message:'Throttled',request_id:'interval-test-1'},{extra:{userId},clientId:client.client_id,token:'test'});
            assert.equal(blocked.structuredContent.error.code,'RATE_LIMITED');assert.equal(sent.length,count);
        });
        await t.test('image metadata remains compatible after dependency updates',async()=>{
            const sharp=require('sharp');
            const buffer=await sharp({create:{width:12,height:8,channels:3,background:'#ffffff'}}).png().toBuffer();
            const metadata=await sharp(buffer).metadata();
            assert.equal(metadata.width,12);assert.equal(metadata.height,8);assert.ok(buffer.length>0);
        });
    } finally {
        clearInterval(timer);http.closeAllConnections();await new Promise(resolve=>http.close(resolve));
        store.db.close();fs.rmSync(dir,{recursive:true,force:true});
    }
});
