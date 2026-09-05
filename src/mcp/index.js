const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { mcpAuthRouter, createOAuthMetadata } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createProvider, SCOPES } = require('./auth');
const { hash } = require('./store');
const { createToolService, createMcpServer } = require('./tools');

function installMcp(app, {store,channel,config,webAuth}) {
    const origin = new URL(config.MCP_PUBLIC_URL).origin;
    if (process.env.NODE_ENV === 'production' && !origin.startsWith('https:')) throw new Error('MCP_PUBLIC_URL phải là HTTPS trong production');
    const {db} = store;
    const provider = createProvider(db,origin);
    const metadataUrl = origin+'/.well-known/oauth-protected-resource/mcp';
    const options = {provider,issuerUrl:new URL(origin),resourceServerUrl:new URL(provider.resource),scopesSupported:SCOPES,resourceName:config.APP_NAME+' MCP',clientRegistrationOptions:{rateLimit:{max:20}},tokenOptions:{rateLimit:{max:200}}};
    const metadata = {...createOAuthMetadata(options),issuer:provider.issuer,authorization_response_iss_parameter_supported:true,token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],revocation_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic']};
    const oauthPaths = ['/authorize','/token','/register','/revoke','/oauth'];
    app.use(oauthPaths, express.json({limit:'16kb'}),express.urlencoded({extended:false,limit:'16kb'}));
    // SDK clients use stored secret hashes; normalize either supported secret transport before validation.
    app.use(['/token','/revoke'], (req,res,next) => {
        if (req.headers.authorization?.startsWith('Basic ')) {
            try {
                const decoded=Buffer.from(req.headers.authorization.slice(6),'base64').toString('utf8');
                const colon=decoded.indexOf(':');
                if(colon<0 || req.body?.client_id || req.body?.client_secret) return res.status(400).json({error:'invalid_request'});
                req.body={...req.body,client_id:decodeURIComponent(decoded.slice(0,colon)),client_secret:decodeURIComponent(decoded.slice(colon+1))};
            } catch { return res.status(400).json({error:'invalid_request'}); }
        }
        if(typeof req.body?.client_secret==='string') req.body.client_secret=hash(req.body.client_secret);
        next();
    });
    app.use('/authorize',(req,res,next)=>{
        const redirect=res.redirect.bind(res);
        res.redirect=(status,url)=>{
            if(typeof status==='string'){url=status;status=302;}
            const target=new URL(url,origin);
            if(target.origin!==origin || target.searchParams.has('error') || target.searchParams.has('code')){target.searchParams.set('iss',provider.issuer);url=target.href;}
            return redirect(status,url);
        };
        next();
    });
    const discoveryHeaders={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
    app.get('/.well-known/oauth-authorization-server',(req,res)=>res.set(discoveryHeaders).json(metadata));
    // Override both PRM URLs before the SDK router to avoid it reintroducing a
    // different issuer serialization at the path-specific discovery URL.
    app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(req,res)=>res.set(discoveryHeaders).json({resource:provider.resource,authorization_servers:[provider.issuer],scopes_supported:SCOPES,resource_name:config.APP_NAME+' MCP',bearer_methods_supported:['header']}));
    app.use(mcpAuthRouter(options));
    const consentLimit=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:true,legacyHeaders:false,message:'Thử đăng nhập quá nhiều lần. Vui lòng chờ 15 phút.'});
    app.get('/oauth/consent',provider.consentPage);
    app.post('/oauth/consent',consentLimit,(req,res,next)=>provider.consentSubmit(req,res).catch(next));
    const service=createToolService(db,channel,{minIntervalMs:config.MCP_SEND_INTERVAL_MS,verifyAccessToken:provider.verifyAccessToken});
    const allowedOrigins=new Set([origin,'https://chatgpt.com','https://claude.ai',...(config.MCP_ALLOWED_ORIGINS || [])]);
    app.use('/mcp',(req,res,next)=>{
        if(req.headers.host!==new URL(origin).host) return res.status(403).json({error:'invalid_host'});
        if(req.headers.origin && !allowedOrigins.has(req.headers.origin)) return res.status(403).json({error:'invalid_origin'});
        if(req.headers.origin){res.set('Access-Control-Allow-Origin',req.headers.origin);res.vary('Origin');}
        res.set({'Access-Control-Allow-Headers':'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id','Access-Control-Allow-Methods':'POST, GET, DELETE, OPTIONS','Access-Control-Expose-Headers':'WWW-Authenticate, Retry-After, MCP-Protocol-Version','Cache-Control':'no-store','X-Accel-Buffering':'no'});
        if(req.method==='OPTIONS') return res.sendStatus(204);
        next();
    },express.json({limit:'64kb'}),requireBearerAuth({verifier:provider,resourceMetadataUrl:metadataUrl}),rateLimit({windowMs:60000,limit:120,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>req.auth.extra.grantId}));
    app.post('/mcp',async(req,res)=>{
        const server=createMcpServer(channel,service,req.auth,metadataUrl);
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
        try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
        catch {if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32603,message:'MCP request failed'}});}
    });
    app.all('/mcp',(req,res)=>res.set('Allow','POST, OPTIONS').status(405).json({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Use Streamable HTTP POST /mcp'}}));
    app.get('/app/mcp/connections',webAuth,(req,res)=>{
        const connections=db.prepare('SELECT g.id,g.scopes,g.created_at,g.last_used_at,g.revoked_at,c.metadata FROM mcp_grants g JOIN mcp_clients c ON c.id=g.client_id WHERE g.user_id=? ORDER BY g.created_at DESC LIMIT 100').all(req.user.id).map(({metadata,...g})=>({...g,scopes:JSON.parse(g.scopes),client_name:JSON.parse(metadata).client_name,redirect_origins:[...new Set(JSON.parse(metadata).redirect_uris.map(u=>new URL(u).origin))]}));
        res.set('Cache-Control','no-store').json({success:true,data:{url:provider.resource,connections}});
    });
    app.delete('/app/mcp/connections/:id',webAuth,(req,res)=>{
        if(req.headers.origin!==origin || req.headers['x-mcp-settings']!=='1') return res.status(403).json({success:false,error:{message:'Yêu cầu không hợp lệ'}});
        const deleted=db.prepare('UPDATE mcp_grants SET revoked_at=? WHERE id=? AND user_id=?').run(Date.now(),req.params.id,req.user.id);
        res.status(deleted.changes?200:404).json({success:!!deleted.changes});
    });
    app.get('/app/mcp/activity',webAuth,(req,res)=>{
        const rows=db.prepare("SELECT s.request_id,s.tool,s.recipient,s.status,s.created_at,s.updated_at,json_extract(c.metadata,'$.client_name') AS client_name FROM mcp_sends s LEFT JOIN mcp_clients c ON c.id=substr(s.principal,instr(s.principal,':')+1) WHERE s.principal LIKE ? ORDER BY s.created_at DESC LIMIT 50").all(`${req.user.id}:%`);
        res.set('Cache-Control','no-store').json({success:true,data:{activity:rows}});
    });
    provider.cleanup();
    const timer=setInterval(()=>{try{provider.cleanup();}catch{}},3600000);
    timer.unref();
    return {provider,service,timer};
}
module.exports={installMcp};
