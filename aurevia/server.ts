import next from 'next';
import {createServer} from 'http';
import {Server as IOServer} from 'socket.io';
import {loadEnvConfig} from '@next/env';
import {randomBytes} from 'node:crypto';
import {tickMarkets} from './lib/market';
import {MARKET_ASSETS} from './lib/live-market';
import {getMarketQuoteWithFallback,getAlpacaMarketDataOptions} from './lib/market-data-service';
import {getServerConfiguration} from './lib/config/env';
import {logAkedlyReadiness} from './lib/akedly';
import {settleMaturedSimulatedInvestments} from './lib/demo-investment-settlement';
import {resolveRenderApplicationUrls} from './lib/config/render-urls';

loadEnvConfig(process.cwd());
if(process.env.NODE_ENV==='production')logAkedlyReadiness();
const renderApplicationUrls=resolveRenderApplicationUrls(process.env);
if(renderApplicationUrls){
	process.env.NEXTAUTH_URL=renderApplicationUrls.nextAuthUrl;
	process.env.NEXT_PUBLIC_APP_URL=renderApplicationUrls.publicAppUrl;
}
const dev=process.env.NODE_ENV!=='production';
const port=Number(process.env.PORT||3000);
if(dev){
	const localAppUrl=`http://localhost:${port}`;
	if((process.env.NEXTAUTH_URL&&process.env.NEXTAUTH_URL!==localAppUrl)||(process.env.NEXT_PUBLIC_APP_URL&&process.env.NEXT_PUBLIC_APP_URL!==localAppUrl)){
		console.warn('Using local application URLs in development; ignoring configured URLs.');
	}
	process.env.NEXTAUTH_URL=localAppUrl;
	process.env.NEXT_PUBLIC_APP_URL=localAppUrl;
}
if(!process.env.NEXTAUTH_SECRET){
	if(!dev){
		console.error('Missing required production configuration: NEXTAUTH_SECRET.');
		process.exit(1);
	}
	process.env.NEXTAUTH_SECRET=randomBytes(32).toString('hex');
}
if(!process.env.NEXTAUTH_URL){
	if(!dev){
		console.error('Missing required production configuration: NEXTAUTH_URL.');
		process.exit(1);
	}
	process.env.NEXTAUTH_URL=`http://localhost:${port}`;
}
if(!process.env.NEXT_PUBLIC_APP_URL){
	process.env.NEXT_PUBLIC_APP_URL=process.env.NEXTAUTH_URL;
}
const app=next({dev});
const handle=app.getRequestHandler();
const configuredPublicUrl=process.env.NEXT_PUBLIC_APP_URL||process.env.NEXTAUTH_URL;
const publicUrl=configuredPublicUrl||`http://localhost:${port}`;

function safeErrorCode(error:unknown){
 const value=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 return /^[A-Z0-9_]{2,32}$/.test(value)?value:error instanceof Error?error.name:'UnknownError';
}

async function startServer(){
  if(!dev){
    for(const [name,value] of [['NEXTAUTH_URL',process.env.NEXTAUTH_URL],['NEXT_PUBLIC_APP_URL',configuredPublicUrl]] as const){
      if(!value)continue;
      try{
        const parsed=new URL(value);
        const isLocalTestHttp=parsed.protocol==='http:'&&['localhost','127.0.0.1','::1'].includes(parsed.hostname)&&process.env.AUREVIA_E2E_ALLOW_HTTP_PROVIDER==='1';
        if(parsed.protocol!=='https:'&&!isLocalTestHttp)throw new Error('HTTPS_REQUIRED');
      }catch{
        console.error(`${name} must be a valid absolute HTTPS URL in production.`);
        process.exit(1);
      }
    }
  }

  let appReady=false;
  const http=createServer((req,res)=>{
    if(!appReady){
      res.writeHead(503,{'Retry-After':'1'}).end('Service starting');
      return;
    }
    handle(req,res);
  });
  const io=new IOServer(http,{cors:{origin:publicUrl,credentials:true}});
  io.on('connection',socket=>{socket.emit('connected',{ok:true});});
  const intervalMs=Math.max(1000,Number(process.env.MARKET_TICK_MS||1000));
  const liveMarketRefreshMs=30_000;
  let running=false;
  let liveMarketRunning=false;
  let consecutiveFailures=0;

  function scheduleNextTick(delay:number){setTimeout(()=>{void runMarketTick()},delay)}
  function scheduleNextLiveMarketTick(delay=liveMarketRefreshMs){setTimeout(()=>{void runLiveMarketTick()},delay)}
  const runMarketTick=async()=>{
    if(running)return scheduleNextTick(intervalMs);
    running=true;
    let nextDelay=intervalMs;
    try{
      const updates=await tickMarkets();
      if(updates.length)io.emit('market:update',updates.map(update=>({...update,changePercent:update.change*100})));
      consecutiveFailures=0;
      try{
        const maturedInvestmentsSettled=await settleMaturedSimulatedInvestments();
        if(maturedInvestmentsSettled)console.log(`Auto-settled ${maturedInvestmentsSettled} matured simulated investment(s).`);
      }catch(settlementError){
        console.error(`Scheduled simulated investment settlement failed (${safeErrorCode(settlementError)}).`);
      }
    }catch(error){
      consecutiveFailures++;
      nextDelay=Math.min(intervalMs*2**Math.min(consecutiveFailures,6),60_000);
      console.error(`Market tick failed; retrying in ${nextDelay}ms (attempt ${consecutiveFailures}, ${safeErrorCode(error)}).`);
    }finally{
      running=false;
      scheduleNextTick(nextDelay);
    }
  };
  const runLiveMarketTick=async()=>{
    if(liveMarketRunning)return scheduleNextLiveMarketTick();
    liveMarketRunning=true;
    try{
      const configuration=getServerConfiguration();
      if(!configuration.marketData.finnhubApiKey&&!configuration.execution.alpacaTradingConfigured){
        return;
      }
      const alpacaData=getAlpacaMarketDataOptions(configuration.execution);
      let unavailableCount=0;
      const updates=await Promise.all(MARKET_ASSETS.map(async asset=>{
        try{
          const quote=await getMarketQuoteWithFallback(asset,configuration.marketData.finnhubApiKey,alpacaData);
          if(quote.isStale||!(quote.source==='Finnhub'||quote.source.startsWith('Alpaca')))return null;
          return {
            symbol:asset.id,
            price:quote.price,
            change:quote.change,
            changePercent:quote.changePercent,
            source:quote.source,
            dataMode:'LIVE' as const,
            lastUpdatedAt:quote.updatedAt,
          };
        }catch{
          unavailableCount++;
          return null;
        }
      }));
      const available=updates.filter((update):update is NonNullable<typeof update>=>update!==null);
      if(available.length)io.emit('market:update',available);
      if(unavailableCount)console.warn(`Live market update unavailable for ${unavailableCount} asset(s).`);
    }catch(error){
      console.error(`Live market update failed (${safeErrorCode(error)}).`);
    }finally{
      liveMarketRunning=false;
      scheduleNextLiveMarketTick();
    }
  };
  async function prepareApplication(){
    try{
      await app.prepare();
      appReady=true;
      console.log('Next.js application ready');
      scheduleNextTick(0);
      scheduleNextLiveMarketTick(0);
    }catch(error){
      console.error('Next.js preparation failed; startup aborted',error);
      process.exit(1);
    }
  }

  http.once('error',(error:NodeJS.ErrnoException)=>{
    console.error(error.code==='EADDRINUSE'?'Configured HTTP port is already in use':'HTTP server failed to start');
    process.exit(1);
  });

  http.listen(port,'0.0.0.0',()=>{
    console.log(`Aurevia Exchange HTTP server listening on 0.0.0.0:${port}`);
    void prepareApplication();
  });
}

void startServer();
