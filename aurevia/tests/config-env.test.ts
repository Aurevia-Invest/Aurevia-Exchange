import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  getPublicConfiguration,
  getServerConfiguration,
  normalizeAlpacaTradingBaseUrl,
  configurationSummary,
  validateServerConfiguration,
} from '../lib/config/env';
import {resolveRenderApplicationUrls} from '../lib/config/render-urls';

afterEach(()=>vi.unstubAllEnvs());

describe('canonical environment configuration',()=>{
  const source: Record<string,string|undefined> = {
    DATABASE_URL:'postgresql://user:test@example.invalid/db',
    DIRECT_URL:'postgresql://user:test@example.invalid/db',
    NEXTAUTH_SECRET:'test-secret-that-is-long-enough-for-auth',
    NEXTAUTH_URL:'https://app.example.invalid',
    NEXT_PUBLIC_APP_URL:'https://app.example.invalid',
    NEXT_PUBLIC_SUPABASE_URL:'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'public-anon-key',
    SUPABASE_SERVICE_ROLE_KEY:'private-service-key',
  };

  it('validates required server configuration without exposing secret values',()=>{
    const config=getServerConfiguration(source);
    const validation=validateServerConfiguration(config);

    expect(config.database.url).toContain('example.invalid');
    expect(config.auth.secret).toBe('test-secret-that-is-long-enough-for-auth');
    expect(config.database.directUrl).toContain('example.invalid');
    expect(validation).toEqual([]);
    expect(JSON.stringify(getPublicConfiguration(source))).not.toContain('private-service-key');
  });

  it('reports missing required values and malformed URLs with variable names only',()=>{
    const issues=validateServerConfiguration(getServerConfiguration({
      DATABASE_URL:'',
      DIRECT_URL:'not-a-url',
      NEXTAUTH_SECRET:'',
      NEXTAUTH_URL:'relative-url',
    }));

    expect(issues).toEqual(expect.arrayContaining([
      'DATABASE_URL is missing',
      'DIRECT_URL must be a valid PostgreSQL URL',
      'NEXTAUTH_SECRET is missing',
      'NEXTAUTH_URL must be a valid absolute HTTPS URL',
    ]));
  });

  it('rejects database URLs that target different databases',()=>{
    const config=getServerConfiguration({
      ...source,
      DIRECT_URL:'postgresql://user:test@example.invalid/other-db',
    });

    expect(validateServerConfiguration(config)).toContain('DATABASE_URL and DIRECT_URL must target the same database');
  });

  it('keeps public configuration limited to browser-safe values',()=>{
    vi.stubEnv('NEXT_PUBLIC_APP_URL','https://app.example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','public-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','private-service-key');

    const publicConfig=getPublicConfiguration();

    expect(publicConfig.appUrl).toBe('https://app.example.invalid');
    expect(publicConfig.supabaseUrl).toBe('https://project.supabase.co');
    expect(publicConfig.supabaseAnonKey).toBe('public-anon-key');
    expect(JSON.stringify(publicConfig)).not.toContain('private-service-key');
  });

  it('keeps Akedly credentials server-side and reports only whether the set is complete',()=>{
    const akedlySource={
      AKEDLY_API_KEY:'test-api-key',
      AKEDLY_PIPELINE_ID:'test-pipeline',
      AKEDLY_WIDGET_ID:'test-widget',
      AKEDLY_PUBLIC_KEY:'test-public-key',
      AKEDLY_WIDGET_SECRET:'test-widget-secret',
      AKEDLY_WEBHOOK_SECRET:'test-webhook-secret',
    };
    const config=getServerConfiguration(akedlySource);

    expect(config.akedly).toMatchObject({
      enabled:false,
      apiKey:'test-api-key',
      pipelineId:'test-pipeline',
      widgetId:'test-widget',
      publicKey:'test-public-key',
      configured:true,
    });

    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:'true'}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:'"true"'}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:"'TRUE'"}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_WIDGET_SECRET:'"test-widget-secret"'}).akedly.configured).toBe(false);
    expect(config.akedly.widgetSecret).toBe('test-widget-secret');
    expect(config.akedly.webhookSecret).toBe('test-webhook-secret');
    expect(getServerConfiguration({AKEDLY_API_KEY:'test-api-key'}).akedly.configured).toBe(false);
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-api-key');
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-widget-secret');
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-webhook-secret');
  });

  it('rejects whitespace and control characters in Akedly server credentials without echoing values',()=>{
    const config=getServerConfiguration({
      AKEDLY_API_KEY:' test-api-key ',
      AKEDLY_PIPELINE_ID:'test-pipeline',
      AKEDLY_WIDGET_ID:'test-widget',
      AKEDLY_PUBLIC_KEY:'test-public-key',
      AKEDLY_WIDGET_SECRET:'test-widget\n-secret',
      AKEDLY_WEBHOOK_SECRET:'test-webhook-secret',
    });

    expect(config.akedly.configured).toBe(false);
    expect(config.akedly.formattingIssues).toEqual([
      'AKEDLY_API_KEY (remove surrounding whitespace)',
      'AKEDLY_WIDGET_SECRET (remove control characters)',
    ]);
    expect(validateServerConfiguration(config)).toContain(
      'Invalid Akedly environment formatting: AKEDLY_WIDGET_SECRET (remove control characters)',
    );
    expect(JSON.stringify(config.akedly.formattingIssues)).not.toContain('test-api-key');
    expect(JSON.stringify(config.akedly.formattingIssues)).not.toContain('test-widget-secret');
  });

  it('detects optional integrations without requiring credentials',()=>{
    const config=getServerConfiguration({
      REAL_EXECUTION_ENABLED:'false',
      BROKER_PROVIDER:'',
      ALPACA_BROKER_BASE_URL:'https://broker-api.sandbox.alpaca.markets',
      ALPACA_BROKER_CLIENT_ID:'',
      ALPACA_BROKER_CLIENT_SECRET:'',
    });

    expect(config.execution.realEnabled).toBe(false);
    expect(config.execution.alpacaConfigured).toBe(false);
    expect(config.execution.provider).toBeNull();
    expect(config.smtp.configured).toBe(false);
    expect(config.marketData.configured).toBe(false);
  });

  it('uses the published support phone when no override is configured',()=>{
    expect(getServerConfiguration({}).smtp.supportPhone).toBe('+1 (210) 504-7697');
    expect(getServerConfiguration({SUPPORT_PHONE:'+1 555 010 1234'}).smtp.supportPhone).toBe('+1 555 010 1234');
  });

  it('requires every SMTP credential and a valid port before enabling mail delivery',()=>{
    const complete={
      SMTP_HOST:'smtp-relay.brevo.com',
      SMTP_PORT:'587',
      SMTP_USER:'smtp-user',
      SMTP_PASSWORD:'smtp-password',
      SMTP_FROM:'Aurevia Exchange <mail@example.invalid>',
    };

    expect(getServerConfiguration(complete).smtp.configured).toBe(true);
    expect(getServerConfiguration({...complete,SMTP_FROM:''}).smtp.configured).toBe(false);
    expect(getServerConfiguration({...complete,SMTP_PASSWORD:'   '}).smtp.configured).toBe(false);
    expect(getServerConfiguration({...complete,SMTP_PORT:'invalid'}).smtp.configured).toBe(false);
    expect(getServerConfiguration({...complete,SMTP_PORT:'587'}).smtp.port).toBe(587);
    expect(getServerConfiguration({...complete,SMTP_PORT:''}).smtp.port).toBe(587);
  });

  it('never exposes SMTP credentials in public configuration',()=>{
    const config={
      SMTP_HOST:'smtp-relay.brevo.com',
      SMTP_PORT:'587',
      SMTP_USER:'private-smtp-user',
      SMTP_PASSWORD:'private-smtp-password',
      SMTP_FROM:'Aurevia Exchange <mail@example.invalid>',
    };

    expect(JSON.stringify(getPublicConfiguration(config))).not.toContain('private-smtp-user');
    expect(JSON.stringify(getPublicConfiguration(config))).not.toContain('private-smtp-password');
  });

  it('reports only configured phone OTP delivery and never treats email as verification',()=>{
    expect(getServerConfiguration({}).verification.configured).toBe(false);
    expect(getServerConfiguration({RESEND_API_KEY:'email-notifications-key'}).verification.configured).toBe(false);
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA'}).verification.configured).toBe(true);
    expect(getServerConfiguration({TWILIO_ACCOUNT_SID:`AC${'1'.repeat(32)}`,TWILIO_AUTH_TOKEN:'test-token',TWILIO_VERIFY_SERVICE_SID:`VA${'2'.repeat(32)}`}).verification).toMatchObject({
      configured:true,
      twilioConfigured:true,
      termiiConfigured:false,
    });
    expect(getServerConfiguration({TWILIO_ACCOUNT_SID:'invalid',TWILIO_AUTH_TOKEN:'test-token',TWILIO_VERIFY_SERVICE_SID:'invalid'}).verification.configured).toBe(false);
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA'}).verification.termiiBaseUrl).toBe('https://api.ng.termii.com');
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA',TERMII_BASE_URL:'https://api.eu.termii.com'}).verification.termiiBaseUrl).toBe('https://api.eu.termii.com');
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA',TERMII_BASE_URL:'https://example.invalid'}).verification).toMatchObject({configured:false,termiiBaseUrlValid:false});
  });

  it('uses the Render HTTPS origin until a custom domain is explicitly verified',()=>{
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia.onrender.com',
      NEXTAUTH_URL:'http://localhost:3000',
      NEXT_PUBLIC_APP_URL:'http://localhost:3000',
    })).toEqual({
      nextAuthUrl:'https://aurevia.onrender.com',
      publicAppUrl:'https://aurevia.onrender.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia.onrender.com',
      NEXTAUTH_URL:'https://auth.example.com',
      NEXT_PUBLIC_APP_URL:'https://app.example.com',
    })).toEqual({
      nextAuthUrl:'https://aurevia.onrender.com',
      publicAppUrl:'https://aurevia.onrender.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia.onrender.com',
      NEXTAUTH_URL:'https://auth.example.com',
      NEXT_PUBLIC_APP_URL:'https://app.example.com',
      AUREVIA_CUSTOM_DOMAIN_VERIFIED:'true',
    })).toEqual({
      nextAuthUrl:'https://app.example.com',
      publicAppUrl:'https://app.example.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'development',
      RENDER_EXTERNAL_URL:'https://aurevia.onrender.com',
      NEXTAUTH_URL:'http://localhost:3000',
    })).toBeNull();
  });

  it('accepts the deployed Alpaca paper variable names without requiring an account ID or enabling REAL execution',()=>{
    const config=getServerConfiguration({
      REAL_EXECUTION_ENABLED:'false',
      ALPACA_PROVIDER:'alpaca',
      ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',
      ALPACA_API_KEY:'paper-key',
      ALPACA_SECRET_KEY:'paper-secret',
      ALPACA_PAPER_ORDERS_ENABLED:'true',
    });

    expect(config.execution.provider).toBe('alpaca');
    expect(config.execution.alpacaTradingConfigured).toBe(true);
    expect(config.execution.alpacaTradingBaseUrl).toBe('https://paper-api.alpaca.markets');
    expect(config.execution.alpacaTradingApiKey).toBe('paper-key');
    expect(config.execution.alpacaTradingApiSecret).toBe('paper-secret');
    expect(config.execution.alpacaTradingAccountId).toBe('');
    expect(config.execution.realEnabled).toBe(false);
    expect(config.execution.alpacaPaperOrdersEnabled).toBe(true);
  });

  it('supports the legacy Alpaca API secret alias without exposing it publicly',()=>{
    const config=getServerConfiguration({ALPACA_API_SECRET:'legacy-paper-secret'});
    expect(config.execution.alpacaTradingApiSecret).toBe('legacy-paper-secret');
    expect(config.execution.alpacaClientSecret).toBe('legacy-paper-secret');
    expect(JSON.stringify(getPublicConfiguration({ALPACA_API_SECRET:'legacy-paper-secret'}))).not.toContain('legacy-paper-secret');
  });

  it('accepts ALPACA_BASE_URL as an alias for the paper trading endpoint',()=>{
    const config=getServerConfiguration({
      ALPACA_PROVIDER:'alpaca',
      ALPACA_BASE_URL:'https://paper-api.alpaca.markets/v2',
      ALPACA_API_KEY:'test-paper-key',
      ALPACA_API_SECRET:'test-paper-secret',
    });

    expect(config.execution).toMatchObject({
      provider:'alpaca',
      alpacaTradingBaseUrl:'https://paper-api.alpaca.markets',
      alpacaTradingUrlConfigured:true,
      alpacaTradingUrlValid:true,
      alpacaTradingConfigured:true,
      alpacaBaseUrl:'https://paper-api.alpaca.markets/v2',
      alpacaClientSecret:'test-paper-secret',
      realEnabled:false,
      alpacaPaperOrdersEnabled:false,
    });
  });

  it('prefers the established ALPACA_TRADING_BASE_URL and ALPACA_SECRET_KEY names',()=>{
    const config=getServerConfiguration({
      ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',
      ALPACA_BASE_URL:'https://api.alpaca.markets',
      ALPACA_SECRET_KEY:'primary-secret',
      ALPACA_API_SECRET:'legacy-secret',
    });

    expect(config.execution.alpacaTradingBaseUrl).toBe('https://paper-api.alpaca.markets');
    expect(config.execution.alpacaTradingApiSecret).toBe('primary-secret');
  });

  it('does not silently replace an explicitly configured non-paper endpoint with the alias',()=>{
    const config=getServerConfiguration({
      ALPACA_TRADING_BASE_URL:'https://api.alpaca.markets',
      ALPACA_BASE_URL:'https://paper-api.alpaca.markets',
      ALPACA_API_KEY:'test-paper-key',
      ALPACA_SECRET_KEY:'test-paper-secret',
    });

    expect(config.execution.alpacaTradingUrlConfigured).toBe(true);
    expect(config.execution.alpacaTradingUrlValid).toBe(false);
    expect(config.execution.alpacaTradingConfigured).toBe(false);
  });

  it('keeps paper order submission disabled unless explicitly enabled',()=>{
    expect(getServerConfiguration({ALPACA_PROVIDER:'alpaca',ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',ALPACA_API_KEY:'paper-key',ALPACA_SECRET_KEY:'paper-secret'}).execution.alpacaPaperOrdersEnabled).toBe(false);
    expect(getServerConfiguration({ALPACA_PAPER_ORDERS_ENABLED:'true'}).execution.alpacaPaperOrdersEnabled).toBe(true);
  });

  it('normalizes only approved HTTPS Alpaca Trading API hosts',()=>{
    expect(normalizeAlpacaTradingBaseUrl(' https://PAPER-API.ALPACA.MARKETS/ ')).toBe('https://paper-api.alpaca.markets');
    expect(normalizeAlpacaTradingBaseUrl('https://paper-api.alpaca.markets/v2')).toBe('https://paper-api.alpaca.markets');
    expect(normalizeAlpacaTradingBaseUrl('https://api.alpaca.markets')).toBeNull();
    for(const url of ['http://paper-api.alpaca.markets','https://example.com','https://paper-api.alpaca.markets/path','https://paper-api.alpaca.markets/v2/account','https://user:pass@paper-api.alpaca.markets']){
      expect(normalizeAlpacaTradingBaseUrl(url)).toBeNull();
    }
  });

  it('consumes Finnhub credentials only in server configuration',()=>{
    const privateSource={FINNHUB_API_KEY:'server-only-finnhub-test-key',ALPACA_API_KEY:'server-only-alpaca-test-key',ALPACA_API_SECRET:'server-only-alpaca-secret',ALPACA_ACCOUNT_ID:'private-account-id'};
    const config=getServerConfiguration(privateSource);
    expect(config.marketData.finnhubApiKey).toBe('server-only-finnhub-test-key');
    const publicConfig=JSON.stringify(getPublicConfiguration(privateSource));
    for(const value of Object.values(privateSource))expect(publicConfig).not.toContain(value);
  });

  it('detects market-data providers without exposing their credentials',()=>{
    const privateSource={
      FINNHUB_API_KEY:'finnhub-secret',TWELVE_DATA_API_KEY:'twelve-secret',
      ALPHA_VANTAGE_API_KEY:'alpha-secret',FMP_API_KEY:'fmp-secret',
      MARKET_DATA_DISPLAY_LICENSES_CONFIRMED:'true',
    };
    const config=getServerConfiguration(privateSource);
    expect(config.marketData).toMatchObject({
      configured:true,finnhubApiKey:'finnhub-secret',twelveDataApiKey:'twelve-secret',
      alphaVantageApiKey:'alpha-secret',fmpApiKey:'fmp-secret',productionLicenseConfirmed:true,
    });
    const summary=JSON.stringify(configurationSummary(config));
    for(const value of Object.values(privateSource).slice(0,4))expect(summary).not.toContain(value);
    expect(summary).toContain('"fmpConfigured":true');
  });
});
