export type EnvironmentSource = Record<string,string|undefined>;

export type ServerConfiguration = {
  database: {
    url: string;
    directUrl: string;
    target: string;
  };
  auth: {
    secret: string;
    url: string;
    adminUsername: string;
    adminEmail: string;
    adminPassword: string;
  };
  app: {
    url: string;
    port: number;
    marketTickMs: number;
    nodeEnv: string;
  };
  supabase: {
    url: string;
    anonymousKey: string;
    serviceRoleKey: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
    supportEmail: string;
    complaintsEmail: string;
    supportPhone: string;
    configured: boolean;
  };
  verification: {
    codeSecret: string;
    resendApiKey: string;
    emailFrom: string;
    emailApiUrl: string;
    emailApiKey: string;
    termiiApiKey: string;
    termiiSenderId: string;
    smsApiUrl: string;
    smsApiKey: string;
    appUrl: string;
    registrationVerificationEnabled: boolean;
    phoneVerificationRequired: boolean;
    configured: boolean;
  };
  captcha: {
    turnstileSiteKey: string;
    turnstileSecretKey: string;
    turnstileConfigured: boolean;
  };
  execution: {
    realEnabled: boolean;
    alpacaPaperOrdersEnabled: boolean;
    provider: string | null;
    alpacaProvider: string;
    brokerProvider: string;
    brokerApiUrl: string;
    brokerApiKey: string;
    brokerAccountId: string;
    brokerWebhookSecret: string;
    alpacaBaseUrl: string;
    alpacaClientId: string;
    alpacaClientSecret: string;
    alpacaConfigured: boolean;
    alpacaTradingBaseUrl: string;
    alpacaTradingUrlConfigured: boolean;
    alpacaTradingUrlValid: boolean;
    alpacaTradingApiKey: string;
    alpacaTradingApiSecret: string;
    alpacaTradingAccountId: string;
    alpacaTradingConfigured: boolean;
    alpacaBrokerBaseUrl: string;
    alpacaBrokerClientId: string;
    alpacaBrokerClientSecret: string;
    alpacaBrokerAccountId: string;
    alpacaBrokerConfigured: boolean;
  };
  payment: {
    provider: string;
    apiUrl: string;
    apiKey: string;
    webhookSecret: string;
    configured: boolean;
  };
  marketData: {
    apiUrl: string;
    apiKey: string;
    configured: boolean;
    finnhubApiKey: string;
  };
  akedly: {
    enabled: boolean;
    apiKey: string;
    pipelineId: string;
    widgetId: string;
    publicKey: string;
    widgetSecret: string;
    webhookSecret: string;
    configured: boolean;
  };
};

export type PublicConfiguration = {
  appUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

const env = (name: string, source: EnvironmentSource = process.env): string => source[name]?.trim() || '';
const booleanEnv = (name: string, source: EnvironmentSource = process.env): boolean => source[name]?.trim().toLowerCase() === 'true';
const numberEnv = (name: string, fallback: number, source: EnvironmentSource = process.env): number => {
  const value = Number(source[name]?.trim() || fallback);
  return Number.isFinite(value) ? value : fallback;
};

function cleanUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function getDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    if(parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return '';
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export function normalizeAlpacaTradingBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || host !== 'paper-api.alpaca.markets') return null;
    const basePath = parsed.pathname.replace(/\/+$/, '');
    if (parsed.username || parsed.password || parsed.port || !['', '/v2'].includes(basePath) || parsed.search || parsed.hash) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function getServerConfiguration(source: EnvironmentSource = process.env): ServerConfiguration {
  const databaseUrl = cleanUrl(env('DATABASE_URL', source));
  const directUrl = cleanUrl(env('DIRECT_URL', source));
  const appUrl = cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source) || env('RENDER_EXTERNAL_URL', source));
  const supabaseUrl = cleanUrl(env('SUPABASE_URL', source));
  const smtpHost = env('SMTP_HOST', source);
  const smtpUser = env('SMTP_USER', source);
  const smtpPassword = env('SMTP_PASSWORD', source);
  const smtpFrom = env('SMTP_FROM', source);
  const smtpPortValue = env('SMTP_PORT', source);
  const smtpPort = smtpPortValue ? Number(smtpPortValue) : 587;
  const smtpConfigured = Boolean(smtpHost && smtpUser && smtpPassword && smtpFrom)
    && Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535;
  const verificationEmailConfigured = Boolean(env('RESEND_API_KEY', source) || env('VERIFICATION_EMAIL_API_URL', source) && env('VERIFICATION_EMAIL_API_KEY', source));
  const verificationSmsConfigured = Boolean(env('TERMII_API_KEY', source) && env('TERMII_SENDER_ID', source) || env('VERIFICATION_SMS_API_URL', source) && env('VERIFICATION_SMS_API_KEY', source));
  const executionProvider = env('ALPACA_PROVIDER', source) || env('BROKER_PROVIDER', source) || null;
  const alpacaProvider = env('ALPACA_PROVIDER', source) || 'alpaca';
  const brokerProvider = env('BROKER_PROVIDER', source);
  const configuredAlpacaTradingBaseUrl = env('ALPACA_TRADING_BASE_URL', source);
  const alpacaTradingRawBaseUrl = configuredAlpacaTradingBaseUrl || 'https://paper-api.alpaca.markets/v2';
  const alpacaTradingBaseUrl = normalizeAlpacaTradingBaseUrl(alpacaTradingRawBaseUrl) || '';
  const alpacaTradingApiKey = env('ALPACA_API_KEY', source);
  const alpacaTradingApiSecret = env('ALPACA_SECRET_KEY', source) || env('ALPACA_API_SECRET', source);
  const alpacaTradingAccountId = env('ALPACA_ACCOUNT_ID', source);
  const alpacaTradingConfigured = Boolean(alpacaTradingBaseUrl && alpacaTradingApiKey && alpacaTradingApiSecret);
  const alpacaBrokerBaseUrl = env('ALPACA_BROKER_BASE_URL', source) || env('BROKER_API_URL', source);
  const alpacaBrokerClientId = env('ALPACA_BROKER_CLIENT_ID', source) || env('BROKER_API_KEY', source);
  const alpacaBrokerClientSecret = env('ALPACA_BROKER_CLIENT_SECRET', source) || env('BROKER_API_KEY', source);
  const alpacaBrokerAccountId = env('BROKER_ACCOUNT_ID', source) || env('ALPACA_ACCOUNT_ID', source);
  const alpacaBrokerConfigured = Boolean(alpacaBrokerBaseUrl && alpacaBrokerClientId && alpacaBrokerClientSecret && alpacaBrokerAccountId);
  const alpacaBaseUrl = env('ALPACA_TRADING_BASE_URL', source) || env('ALPACA_BROKER_BASE_URL', source);
  const alpacaClientId = env('ALPACA_API_KEY', source) || env('ALPACA_BROKER_CLIENT_ID', source);
  const alpacaClientSecret = env('ALPACA_API_SECRET', source) || env('ALPACA_BROKER_CLIENT_SECRET', source);
  const alpacaConfigured = Boolean(alpacaBaseUrl && alpacaClientId && alpacaClientSecret);
  const paymentConfigured = Boolean(env('PAYMENT_PROVIDER', source) && env('PAYMENT_API_URL', source) && env('PAYMENT_API_KEY', source));
  const finnhubApiKey = env('FINNHUB_API_KEY', source);
  const marketDataConfigured = Boolean(env('MARKET_DATA_API_URL', source) || finnhubApiKey);
  const akedly = {
    enabled: env('AKEDLY_ENABLED', source).toLowerCase() === 'true',
    apiKey: env('AKEDLY_API_KEY', source),
    pipelineId: env('AKEDLY_PIPELINE_ID', source),
    widgetId: env('AKEDLY_WIDGET_ID', source),
    publicKey: env('AKEDLY_PUBLIC_KEY', source),
    widgetSecret: env('AKEDLY_WIDGET_SECRET', source),
    webhookSecret: env('AKEDLY_WEBHOOK_SECRET', source),
  };

  return {
    database: {
      url: databaseUrl,
      directUrl,
      target: getDatabaseTarget(databaseUrl) === getDatabaseTarget(directUrl) && getDatabaseTarget(databaseUrl) ? getDatabaseTarget(databaseUrl) : '',
    },
    auth: {
      secret: env('NEXTAUTH_SECRET', source),
      url: appUrl,
      adminUsername: env('ADMIN_USERNAME', source),
      adminEmail: env('ADMIN_EMAIL', source),
      adminPassword: env('ADMIN_PASSWORD', source),
    },
    app: {
      url: appUrl,
      port: numberEnv('PORT', 3000, source),
      marketTickMs: Math.max(1000, numberEnv('MARKET_TICK_MS', 2500, source)),
      nodeEnv: source.NODE_ENV?.trim() || 'development',
    },
    supabase: {
      url: supabaseUrl,
      anonymousKey: env('NEXT_PUBLIC_SUPABASE_ANON_KEY', source),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY', source),
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      password: smtpPassword,
      from: smtpFrom,
      supportEmail: env('SUPPORT_EMAIL', source) || 'aureviainvest@gmail.com',
      complaintsEmail: env('COMPLAINTS_EMAIL', source) || env('SUPPORT_EMAIL', source) || 'aureviainvest@gmail.com',
      supportPhone: env('SUPPORT_PHONE', source) || '+1 (210) 504-7697',
      configured: smtpConfigured,
    },
    verification: {
      codeSecret: env('VERIFICATION_CODE_SECRET', source) || env('NEXTAUTH_SECRET', source),
      resendApiKey: env('RESEND_API_KEY', source),
      emailFrom: env('VERIFICATION_EMAIL_FROM', source) || 'noreply@aureviaexchanged.dpdns.org',
      emailApiUrl: env('VERIFICATION_EMAIL_API_URL', source),
      emailApiKey: env('VERIFICATION_EMAIL_API_KEY', source),
      termiiApiKey: env('TERMII_API_KEY', source),
      termiiSenderId: env('TERMII_SENDER_ID', source),
      smsApiUrl: env('VERIFICATION_SMS_API_URL', source),
      smsApiKey: env('VERIFICATION_SMS_API_KEY', source),
      appUrl: cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source) || env('RENDER_EXTERNAL_URL', source) || 'https://aurevia-exchange-6hfi.onrender.com'),
      registrationVerificationEnabled: true,
      phoneVerificationRequired: false,
      configured: verificationEmailConfigured || verificationSmsConfigured,
    },
    captcha: {
      turnstileSiteKey: env('NEXT_PUBLIC_TURNSTILE_SITE_KEY', source),
      turnstileSecretKey: env('TURNSTILE_SECRET_KEY', source),
      turnstileConfigured: Boolean(env('NEXT_PUBLIC_TURNSTILE_SITE_KEY', source) && env('TURNSTILE_SECRET_KEY', source)),
    },
    execution: {
      realEnabled: booleanEnv('REAL_EXECUTION_ENABLED', source),
      alpacaPaperOrdersEnabled: booleanEnv('ALPACA_PAPER_ORDERS_ENABLED', source),
      provider: executionProvider || null,
      alpacaProvider,
      brokerProvider,
      brokerApiUrl: env('BROKER_API_URL', source),
      brokerApiKey: env('BROKER_API_KEY', source),
      brokerAccountId: env('BROKER_ACCOUNT_ID', source) || env('ALPACA_ACCOUNT_ID', source),
      brokerWebhookSecret: env('BROKER_WEBHOOK_SECRET', source),
      alpacaBaseUrl,
      alpacaClientId,
      alpacaClientSecret,
      alpacaConfigured,
      alpacaTradingBaseUrl,
      alpacaTradingUrlConfigured: Boolean(configuredAlpacaTradingBaseUrl),
      alpacaTradingUrlValid: Boolean(alpacaTradingBaseUrl),
      alpacaTradingApiKey,
      alpacaTradingApiSecret,
      alpacaTradingAccountId,
      alpacaTradingConfigured,
      alpacaBrokerBaseUrl,
      alpacaBrokerClientId,
      alpacaBrokerClientSecret,
      alpacaBrokerAccountId,
      alpacaBrokerConfigured,
    },
    payment: {
      provider: env('PAYMENT_PROVIDER', source),
      apiUrl: env('PAYMENT_API_URL', source),
      apiKey: env('PAYMENT_API_KEY', source),
      webhookSecret: env('PAYMENT_WEBHOOK_SECRET', source),
      configured: paymentConfigured,
    },
    marketData: {
      apiUrl: env('MARKET_DATA_API_URL', source),
      apiKey: env('MARKET_DATA_API_KEY', source),
      configured: marketDataConfigured,
      finnhubApiKey,
    },
    akedly: {
      ...akedly,
      configured: Boolean(akedly.apiKey&&akedly.pipelineId&&akedly.widgetId&&akedly.publicKey&&akedly.widgetSecret&&akedly.webhookSecret),
    },
  };
}

export function getPublicConfiguration(source: EnvironmentSource = process.env): PublicConfiguration {
  return {
    appUrl: cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source)),
    supabaseUrl: cleanUrl(env('NEXT_PUBLIC_SUPABASE_URL', source)),
    supabaseAnonKey: env('NEXT_PUBLIC_SUPABASE_ANON_KEY', source),
  };
}

export function validateServerConfiguration(config: ServerConfiguration): string[] {
  const issues: string[] = [];
  if(!config.database.url) issues.push('DATABASE_URL is missing');
  else if(!/^postgres(?:ql)?:\/\//i.test(config.database.url)) issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  if(!config.database.directUrl) issues.push('DIRECT_URL is missing');
  else if(!/^postgres(?:ql)?:\/\//i.test(config.database.directUrl)) issues.push('DIRECT_URL must be a valid PostgreSQL URL');
  const databaseTarget = getDatabaseTarget(config.database.url);
  const directTarget = getDatabaseTarget(config.database.directUrl);
  if(databaseTarget && directTarget && databaseTarget !== directTarget) issues.push('DATABASE_URL and DIRECT_URL must target the same database');
  if(!config.auth.secret) issues.push('NEXTAUTH_SECRET is missing');
  if(!config.auth.url) issues.push('NEXTAUTH_URL is missing');
  else try {
    const parsed = new URL(config.auth.url);
    if(parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') issues.push('NEXTAUTH_URL must be a valid absolute HTTPS URL');
  } catch {
    issues.push('NEXTAUTH_URL must be a valid absolute HTTPS URL');
  }
  if(config.execution.realEnabled && (!config.execution.alpacaTradingConfigured || config.execution.alpacaProvider.toLowerCase() !== 'alpaca')) issues.push('REAL_EXECUTION_ENABLED requires a complete Individual Alpaca Trading API configuration selected with ALPACA_PROVIDER=alpaca');
  if(config.execution.realEnabled && config.execution.alpacaTradingUrlConfigured && !config.execution.alpacaTradingUrlValid) issues.push('ALPACA_TRADING_BASE_URL must use an approved HTTPS Alpaca Trading API host');
  return issues;
}

export function configurationSummary(config: ServerConfiguration) {
  return {
    databaseTarget: config.database.target || 'not confirmed',
    databaseConfigured: Boolean(config.database.url && config.database.directUrl),
    authConfigured: Boolean(config.auth.secret && config.auth.url),
    supabaseConfigured: Boolean(config.supabase.url && config.supabase.serviceRoleKey),
    smtpConfigured: config.smtp.configured,
    verificationConfigured: config.verification.configured,
    execution: {
      realEnabled: config.execution.realEnabled,
      provider: config.execution.provider,
      alpacaConfigured: config.execution.alpacaConfigured,
      adapterRegistered: false,
    },
    marketDataConfigured: config.marketData.configured,
    finnhubConfigured: Boolean(config.marketData.finnhubApiKey),
    akedlyConfigured: config.akedly.configured,
    paymentConfigured: config.payment.configured,
  };
}
