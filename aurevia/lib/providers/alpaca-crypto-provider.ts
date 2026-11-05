import 'server-only';
import type {
  ExecutionProvider,
  ProviderBalance,
  ProviderOrder,
  ProviderOrderRequest,
  ProviderOrderState,
  ProviderPosition,
  ProviderReconciliation,
  SignedProviderWebhook,
} from './contracts';
import { getServerConfiguration } from '@/lib/config/env';
import { normalizeAlpacaTradingBaseUrl } from '@/lib/config/env';
import { verifyHmacSha256 } from './registry';

export type AlpacaCryptoClientOptions = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
  fetcher?: typeof fetch;
};

type AlpacaOrderResponse = {
  id?: string;
  client_order_id?: string;
  asset_id?: string;
  symbol?: string;
  status?: string;
  filled_qty?: string;
  filled_at?: string | null;
  created_at?: string;
  updated_at?: string;
  qty?: string;
  filled_quantity?: string;
  order_type?: string;
};

type NormalizedAlpacaOrder = {
  id: string;
  clientOrderId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeState(value: string | undefined): ProviderOrderState {
  const status = value?.toLowerCase();
  if (status === 'accepted' || status === 'pending' || status === 'pending_new' || status === 'new' || status === 'accepted_for_bidding' || status === 'done_for_day' || status === 'pending_replace' || status === 'stopped' || status === 'suspended' || status === 'calculated') return 'ACCEPTED';
  if (status === 'pending_cancel') return 'PENDING_CANCEL';
  if (status === 'partially_filled') return 'PARTIALLY_FILLED';
  if (status === 'filled') return 'FILLED';
  if (status === 'expired') return 'EXPIRED';
  if (status === 'canceled' || status === 'cancelled' || status === 'replaced') return 'CANCELLED';
  if (status === 'rejected' || status === 'invalid') return 'REJECTED';
  return 'FAILED';
}

function assertSandbox(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname;
    if (!host.endsWith('.sandbox.alpaca.markets') && host !== 'broker-api.sandbox.alpaca.markets') {
      throw new Error('SANDBOX_ONLY');
    }
  } catch {
    throw new Error('SANDBOX_ONLY');
  }
}

export function buildAlpacaCryptoClient(options: AlpacaCryptoClientOptions) {
  assertSandbox(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const credentials = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`ALPACA_CRYPTO_API_ERROR:${response.status}`);
    }
    return response.json();
  };

  return {
    async submitOrder(input: {
      clientOrderId: string;
      assetId: string;
      symbol: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop_limit';
      timeInForce: 'gtc' | 'ioc';
      qty: string;
      limitPrice?: string;
      stopPrice?: string;
    }): Promise<NormalizedAlpacaOrder> {
      const body: {
        client_order_id: string;
        symbol: string;
        side: 'buy' | 'sell';
        type: string;
        time_in_force: string;
        qty: string;
        asset_id: string;
        limit_price?: string;
        stop_price?: string;
      } = {
        client_order_id: input.clientOrderId,
        symbol: input.symbol,
        asset_id: input.assetId,
        side: input.side,
        type: input.type,
        time_in_force: input.timeInForce,
        qty: input.qty,
      };
      if (input.limitPrice) body.limit_price = input.limitPrice;
      if (input.stopPrice) body.stop_price = input.stopPrice;
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders`, { method: 'POST', body: JSON.stringify(body) }) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? input.clientOrderId,
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async getOrder(orderId: string): Promise<NormalizedAlpacaOrder> {
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders/${orderId}`) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async cancelOrder(orderId: string): Promise<NormalizedAlpacaOrder> {
      const response = await request(`/v1/trading/accounts/${options.accountId}/orders/${orderId}`, { method: 'DELETE' }) as AlpacaOrderResponse;
      return {
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'cancelled',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      };
    },
    async getOrders(): Promise<NormalizedAlpacaOrder[]> {
      const data = await request(`/v1/trading/accounts/${options.accountId}/orders?status=all`) as { orders?: AlpacaOrderResponse[] };
      return (data.orders ?? []).map((response) => ({
        id: response.id ?? '',
        clientOrderId: response.client_order_id ?? '',
        status: response.status ?? 'accepted',
        createdAt: response.created_at ?? new Date().toISOString(),
        updatedAt: response.updated_at ?? new Date().toISOString(),
      }));
    },
  };
}

function normalizeLegacyOrder(response: NormalizedAlpacaOrder, idempotencyKey: string): ProviderOrder {
  return {
    providerOrderId: response.id,
    clientOrderId: response.clientOrderId || idempotencyKey,
    state: normalizeState(response.status),
    acceptedAt: response.createdAt,
    updatedAt: response.updatedAt,
    executions: [],
  };
}

export class AlpacaCryptoProvider implements ExecutionProvider {
  readonly name = 'alpaca-crypto-sandbox';
  readonly executionMode = 'PAPER' as const;
  private readonly client: ReturnType<typeof buildAlpacaCryptoClient>;
  private readonly webhookSecret: string;

  constructor(options: AlpacaCryptoClientOptions & { webhookSecret: string }) {
    this.client = buildAlpacaCryptoClient(options);
    this.webhookSecret = options.webhookSecret;
  }

  async healthCheck() {
    try {
      await this.client.getOrders();
      return { connected: true, checkedAt: new Date().toISOString() };
    } catch {
      return { connected: false, checkedAt: new Date().toISOString() };
    }
  }

  async submitOrder(request: ProviderOrderRequest, idempotencyKey: string): Promise<ProviderOrder> {
    const response = await this.client.submitOrder({
      clientOrderId: request.clientOrderId,
      assetId: request.assetId ?? '',
      symbol: request.symbol,
      side: request.side === 'BUY' ? 'buy' : 'sell',
      type: request.type === 'MARKET' ? 'market' : request.type === 'LIMIT' ? 'limit' : 'stop_limit',
      timeInForce: request.timeInForce === 'ioc' ? 'ioc' : 'gtc',
      qty: request.quantity,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
    });
    return normalizeLegacyOrder(response, idempotencyKey);
  }

  async cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrder> {
    return normalizeLegacyOrder(await this.client.cancelOrder(providerOrderId), idempotencyKey);
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrder> {
    return normalizeLegacyOrder(await this.client.getOrder(providerOrderId), 'status');
  }

  async getPositions(_accountId: string): Promise<ProviderPosition[]> {
    throw new Error('CRYPTO_POSITION_RECONCILIATION_NOT_IMPLEMENTED');
  }

  async getBalances(_accountId: string): Promise<ProviderBalance[]> {
    throw new Error('CRYPTO_BALANCE_RECONCILIATION_NOT_IMPLEMENTED');
  }

  async reconcile(_accountId: string): Promise<ProviderReconciliation> {
    throw new Error('CRYPTO_RECONCILIATION_NOT_IMPLEMENTED');
  }

  verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
    return Promise.resolve(verifyHmacSha256(rawBody, signature, this.webhookSecret));
  }

  parseWebhook(_rawBody: string): Promise<SignedProviderWebhook> {
    return Promise.resolve({
      eventId: '',
      eventType: '',
      providerOrderId: '',
      occurredAt: new Date().toISOString(),
    });
  }
}

export class IndividualAlpacaTradingProvider implements ExecutionProvider {
  readonly name = 'individual-alpaca-trading';
  readonly executionMode: 'PAPER' | 'LIVE';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly webhookSecret: string;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    accountId?: string;
    webhookSecret?: string;
    fetcher?: typeof fetch;
  }) {
    const baseUrl = normalizeAlpacaTradingBaseUrl(options.baseUrl);
    if (!baseUrl || new URL(baseUrl).hostname !== 'paper-api.alpaca.markets') throw new Error('ALPACA_PAPER_ENDPOINT_REQUIRED');
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.webhookSecret = options.webhookSecret ?? '';
    this.executionMode = 'PAPER';
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method=(init.method??'GET').toUpperCase();
    const maxAttempts=method==='GET'?3:1;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      try{
        const response=await this.fetcher(`${this.baseUrl}${path}`,{
          ...init,
          signal:init.signal??AbortSignal.timeout(10_000),
          headers:{
            'APCA-API-KEY-ID':this.apiKey,
            'APCA-API-SECRET-KEY':this.apiSecret,
            'content-type':'application/json',
            ...(init.headers??{}),
          },
        });
        if(!response.ok){
          const error=new AlpacaTradingApiError(response.status);
          if(method==='GET'&&attempt+1<maxAttempts&&(response.status===408||response.status===429||response.status>=500)){
            await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
            continue;
          }
          throw error;
        }
        if(response.status===204)return undefined as T;
        try{return await response.json() as T}
        catch{throw new Error('ALPACA_TRADING_API_INVALID_RESPONSE')}
      }catch(error){
        if(error instanceof AlpacaTradingApiError){
          if(method==='GET'&&attempt+1<maxAttempts&&(error.status===408||error.status===429||error.status>=500)){
            await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
            continue;
          }
          throw error;
        }
        if(method==='GET'&&attempt+1<maxAttempts){
          await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error('ALPACA_TRADING_API_UNAVAILABLE');
  }

  async getAccount():Promise<AlpacaTradingAccount> {
    const account=await this.request<AlpacaTradingAccount>('/v2/account');
    if(!account||typeof account.id!=='string'||!account.id||typeof account.status!=='string'||typeof account.currency!=='string'||
      typeof account.cash!=='string'||typeof account.buying_power!=='string'||typeof account.equity!=='string'||
      typeof account.portfolio_value!=='string'||(account.pattern_day_trader!==undefined&&typeof account.pattern_day_trader!=='boolean')||
      typeof account.trade_suspended_by_user!=='boolean'||typeof account.trading_blocked!=='boolean'||
      typeof account.account_blocked!=='boolean')throw new Error('ALPACA_TRADING_API_INVALID_ACCOUNT_RESPONSE');
    for(const value of [account.cash,account.buying_power,account.equity,account.portfolio_value]){
      if(!/^-?\d+(\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))throw new Error('ALPACA_TRADING_API_INVALID_ACCOUNT_RESPONSE');
    }
    return account;
  }

  async getAsset(symbol:string):Promise<AlpacaTradingAsset>{
    const asset=await this.request<AlpacaTradingAsset>(`/v2/assets/${encodeURIComponent(symbol)}`);
    if(!asset||typeof asset.id!=='string'||asset.symbol?.toUpperCase()!==symbol.toUpperCase()||
      typeof asset.class!=='string'||typeof asset.status!=='string'||typeof asset.tradable!=='boolean'||
      (asset.class.toLowerCase()==='us_equity'&&typeof asset.fractionable!=='boolean')){
      throw new Error('ALPACA_TRADING_API_INVALID_ASSET_RESPONSE');
    }
    return asset;
  }

  async healthCheck() {
    try {
      const account=await this.getAccount();
      if(account.status!=='ACTIVE'||account.account_blocked||account.trading_blocked||account.trade_suspended_by_user)return {connected:false,checkedAt:new Date().toISOString(),status:'UNAVAILABLE' as const};
      return { connected: true, checkedAt: new Date().toISOString() };
    } catch (error) {
      const status=error instanceof AlpacaTradingApiError&&(error.status===401||error.status===403)?'AUTHENTICATION_FAILED' as const:'UNAVAILABLE' as const;
      return { connected: false, checkedAt: new Date().toISOString(), status };
    }
  }

  async submitOrder(request: ProviderOrderRequest, idempotencyKey: string): Promise<ProviderOrder> {
    const body: {
      symbol: string;
      qty: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop' | 'stop_limit';
      time_in_force: 'day' | 'gtc' | 'ioc';
      client_order_id: string;
      limit_price?: string;
      stop_price?: string;
    } = {
      symbol: request.symbol,
      qty: request.quantity,
      side: request.side === 'BUY' ? 'buy' : 'sell',
      type: request.type === 'MARKET' ? 'market' : request.type === 'LIMIT' ? 'limit' : request.type === 'STOP_LIMIT' ? 'stop_limit' : 'stop',
      time_in_force: request.timeInForce ?? 'day',
      client_order_id: idempotencyKey,
    };
    if (request.limitPrice) body.limit_price = request.limitPrice;
    if (request.stopPrice) body.stop_price = request.stopPrice;
    let response:AlpacaTradingOrderResponse;
    try {
      response = await this.request<AlpacaTradingOrderResponse>('/v2/orders', {method:'POST',body:JSON.stringify(body)});
    } catch(error) {
      if(!(error instanceof AlpacaTradingApiError)||![409,422].includes(error.status))throw error;
      try{return await this.getOrderByClientId(idempotencyKey)}
      catch{throw error}
    }
    return normalizeIndividualOrder(response, idempotencyKey);
  }

  async cancelOrder(providerOrderId: string, idempotencyKey: string): Promise<ProviderOrder> {
    await this.request<void>(`/v2/orders/${encodeURIComponent(providerOrderId)}`, { method: 'DELETE' });
    const response = await this.getOrder(providerOrderId);
    return normalizeIndividualOrder(response, idempotencyKey);
  }

  async getOrder(providerOrderId: string): Promise<AlpacaTradingOrderResponse> {
    return this.request<AlpacaTradingOrderResponse>(`/v2/orders/${encodeURIComponent(providerOrderId)}`);
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrder> {
    return normalizeIndividualOrder(await this.getOrder(providerOrderId));
  }

  async getOrderByClientId(clientOrderId:string):Promise<ProviderOrder>{
    const response=await this.request<AlpacaTradingOrderResponse>(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
    return normalizeIndividualOrder(response,clientOrderId);
  }

  async getOrders():Promise<ProviderOrder[]>{
    const response=await this.request<AlpacaTradingOrderResponse[]>('/v2/orders?status=all&limit=500');
    if(!Array.isArray(response))throw new Error('ALPACA_TRADING_API_INVALID_ORDERS_RESPONSE');
    return response.map(item=>normalizeIndividualOrder(item));
  }

  async getPositions(_accountId: string): Promise<ProviderPosition[]> {
    const items=await this.request<Array<{symbol:string;qty:string;avg_entry_price:string;market_value:string;unrealized_pl:string;asset_class?:string}>>('/v2/positions');
    if(!Array.isArray(items))throw new Error('ALPACA_TRADING_API_INVALID_POSITIONS_RESPONSE');
    const asOf=new Date().toISOString();
    return items.map(item=>{
      if(typeof item.symbol!=='string'||!item.symbol||![item.qty,item.avg_entry_price,item.market_value,item.unrealized_pl].every(value=>typeof value==='string'&&/^-?\d+(\.\d+)?$/.test(value)&&Number.isFinite(Number(value))))throw new Error('ALPACA_TRADING_API_INVALID_POSITIONS_RESPONSE');
      return {symbol:item.symbol,quantity:item.qty,averagePrice:item.avg_entry_price,marketValue:item.market_value,unrealizedPnl:item.unrealized_pl,currency:'USD',asOf};
    });
  }

  async getBalances(_accountId: string): Promise<ProviderBalance[]> {
    const response = await this.getAccount();
    return [{
      currency:response.currency,
      available:response.cash,
      reserved:'0',
      asOf: new Date().toISOString(),
    }];
  }

  async reconcile(_accountId: string): Promise<ProviderReconciliation> {
    throw new Error('PROVIDER_RECONCILIATION_REQUIRES_LOCAL_CONTEXT');
  }

  verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
    return Promise.resolve(!!this.webhookSecret && verifyHmacSha256(rawBody, signature, this.webhookSecret));
  }

  parseWebhook(_rawBody: string): Promise<SignedProviderWebhook> {
    return Promise.resolve({
      eventId: '',
      eventType: '',
      providerOrderId: '',
      occurredAt: new Date().toISOString(),
    });
  }
}

export class AlpacaTradingApiError extends Error {
  constructor(readonly status:number){super(`ALPACA_TRADING_API_ERROR:${status}`);this.name='AlpacaTradingApiError';}
}

type AlpacaTradingOrderResponse={
  id?:string;account_id?:string;status?:string;client_order_id?:string;created_at?:string;updated_at?:string;
  filled_qty?:string;filled_avg_price?:string|null;
};

type AlpacaTradingAccount={
  id:string;status:string;currency:string;cash:string;buying_power:string;equity:string;portfolio_value:string;
  pattern_day_trader?:boolean;trade_suspended_by_user:boolean;trading_blocked:boolean;account_blocked:boolean;
};

type AlpacaTradingAsset={
  id:string;symbol:string;class:string;status:string;tradable:boolean;fractionable?:boolean;
};

function normalizeIndividualOrder(
  response: AlpacaTradingOrderResponse,
  expectedClientOrderId?: string,
): ProviderOrder {
  if(!response.id||!response.status||!response.client_order_id||(expectedClientOrderId!==undefined&&response.client_order_id!==expectedClientOrderId)||!response.created_at||!response.updated_at||normalizeState(response.status)==='FAILED')throw new Error('ALPACA_TRADING_API_INVALID_ORDER_RESPONSE');
  if(typeof response.filled_qty!=='string')throw new Error('ALPACA_TRADING_API_INVALID_ORDER_RESPONSE');
  for(const value of [response.filled_qty,response.filled_avg_price]){
    if(value!==undefined&&value!==null&&(!/^\d+(\.\d+)?$/.test(value)||!Number.isFinite(Number(value))))throw new Error('ALPACA_TRADING_API_INVALID_ORDER_RESPONSE');
  }
  for(const value of [response.created_at,response.updated_at]){
    if(value!==undefined&&(!Number.isFinite(Date.parse(value))))throw new Error('ALPACA_TRADING_API_INVALID_ORDER_RESPONSE');
  }
  return {
    providerOrderId: response.id,
    clientOrderId: response.client_order_id,
    state: normalizeState(response.status),
    providerStatus: response.status,
    acceptedAt: response.created_at,
    updatedAt: response.updated_at,
    executions: [],
    filledQuantity:response.filled_qty,
    ...(response.filled_avg_price===undefined||response.filled_avg_price===null?{}:{averageFillPrice:response.filled_avg_price}),
  };
}

export function createIndividualTradingApiProviderFromEnvironment() {
  const config = getServerConfiguration().execution;
  if (config.alpacaProvider.toLowerCase() !== 'alpaca' || !config.alpacaTradingConfigured || new URL(config.alpacaTradingBaseUrl).hostname !== 'paper-api.alpaca.markets') return null;
  return new IndividualAlpacaTradingProvider({
    baseUrl: config.alpacaTradingBaseUrl,
    apiKey: config.alpacaTradingApiKey,
    apiSecret: config.alpacaTradingApiSecret,
    webhookSecret: config.brokerWebhookSecret,
  });
}

export async function getAlpacaPaperAccountHealth() {
  const config = getServerConfiguration().execution;
  const selected = config.alpacaProvider.toLowerCase() === 'alpaca';
  const paperOrdersEnabled=config.alpacaPaperOrdersEnabled;
  const paperEndpoint = config.alpacaTradingUrlValid && new URL(config.alpacaTradingBaseUrl).hostname === 'paper-api.alpaca.markets';
  const configured = config.alpacaTradingConfigured && paperEndpoint;
  const hasAlpacaConfiguration = Boolean(
    config.alpacaTradingUrlConfigured ||
    config.alpacaTradingApiKey ||
    config.alpacaTradingApiSecret,
  );
  let status: 'AVAILABLE' | 'AUTHENTICATION_FAILED' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'NOT_SELECTED' | 'MISCONFIGURED';
  let diagnosticCode:string|null=null;
  let account:AlpacaTradingAccount|null=null;

  if (!hasAlpacaConfiguration) {
    status = 'NOT_CONFIGURED';
  } else if (!selected) {
    status = 'NOT_SELECTED';
  } else if (!configured) {
    status = 'MISCONFIGURED';
  } else {
    const provider = createIndividualTradingApiProviderFromEnvironment();
    if (!provider) {
      status = 'MISCONFIGURED';
    } else {
      try{
        account=await provider.getAccount();
        status=account.status==='ACTIVE'&&!account.account_blocked&&!account.trading_blocked&&!account.trade_suspended_by_user?'AVAILABLE':'UNAVAILABLE';
      }catch(error){
        status=error instanceof AlpacaTradingApiError&&(error.status===401||error.status===403)?'AUTHENTICATION_FAILED':'UNAVAILABLE';
        diagnosticCode=error instanceof AlpacaTradingApiError?`HTTP_${error.status}`:error instanceof Error&&error.message.startsWith('ALPACA_TRADING_API_')?error.message:'NETWORK_OR_PROVIDER_ERROR';
      }
    }
  }

  return {
    status,
    connected: status === 'AVAILABLE',
    configured,
    selected,
    mode: paperEndpoint ? 'PAPER' as const : null,
    executionEnabled: paperOrdersEnabled && status === 'AVAILABLE',
    paperOrdersEnabled,
    liveTradingEnabled: false as const,
    diagnosticCode,
    account:account?{
      accountId:account.id,
      status:account.status,
      currency:account.currency,
      cash:account.cash,
      buyingPower:account.buying_power,
      equity:account.equity,
      portfolioValue:account.portfolio_value,
      patternDayTrader:account.pattern_day_trader??null,
      tradingBlocked:account.trading_blocked,
      accountBlocked:account.account_blocked,
      tradeSuspendedByUser:account.trade_suspended_by_user,
    }:null,
    checkedAt: new Date().toISOString(),
  };
}

export function createAlpacaCryptoProviderFromEnvironment() {
  const config = getServerConfiguration().execution;
  if (!config.realEnabled || !config.brokerProvider || !config.alpacaBrokerConfigured) return null;
  return new AlpacaCryptoProvider({
    baseUrl: config.alpacaBrokerBaseUrl,
    clientId: config.alpacaBrokerClientId,
    clientSecret: config.alpacaBrokerClientSecret,
    accountId: config.alpacaBrokerAccountId,
    webhookSecret: config.brokerWebhookSecret,
  });
}
