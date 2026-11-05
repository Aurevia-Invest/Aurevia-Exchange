export const publicRoutes=[
	'/',
	'/about',
	'/auth/akedly/callback',
	'/client-stories',
	'/education',
	'/forgot-password',
	'/login',
	'/markets',
	'/privacy',
	'/register',
	'/reset-password',
	'/risk-disclosure',
	'/stories',
	'/support',
	'/terms',
	'/waitlist',
	'/admin/login',
] as const;

export const authenticatedRoutes=[
	'/about-me',
	'/activity',
	'/broadcasts',
	'/cards',
	'/cards/[id]',
	'/cards/apply',
	'/community',
	'/dashboard',
	'/investments',
	'/kyc',
	'/markets',
	'/news',
	'/notifications',
	'/orders',
	'/portfolio',
	'/settings',
	'/stories',
	'/tax-services',
	'/tax-services/request/[id]',
	'/tier',
	'/trade',
	'/wallet',
	'/wallet/convert',
	'/wallet/transactions',
	'/wallet/transactions/[id]',
	'/client-stories',
	'/education',
	'/support',
] as const;

export const adminRoutes=[
	'/admin',
	'/admin/activity',
	'/admin/approved-deposits',
	'/admin/approved-withdrawals',
	'/admin/audit-logs',
	'/admin/broadcasts',
	'/admin/cards',
	'/admin/command-center',
	'/admin/community',
	'/admin/content',
	'/admin/deleted-items',
	'/admin/investments',
	'/admin/kyc',
	'/admin/markets',
	'/admin/news-feed',
	'/admin/nova',
	'/admin/operations',
	'/admin/payments',
	'/admin/positions',
	'/admin/providers',
	'/admin/receipts',
	'/admin/sessions',
	'/admin/settings',
	'/admin/settlements',
	'/admin/stories',
	'/admin/support',
	'/admin/tax-services',
	'/admin/tiers',
	'/admin/users',
	'/admin/verified-accounts',
	'/admin/waitlist',
] as const;

export const themeRouteGroups={public:publicRoutes,authenticated:authenticatedRoutes,admin:adminRoutes} as const;
export const themeRoutePaths=[...new Set(Object.values(themeRouteGroups).flat())];
export const fallbackRoutes=['/theme-route-not-found'] as const;
export const themes=['forest-green','premium-dashboard'] as const;

// Dynamic IDs intentionally select each nested route's loading/error state without changing account data.
export function concreteRoutePath(route:string){
	return route.replace(/\[\.\.\.(\w+)\]/g,'theme-$1').replace(/\[([^\]]+)\]/g,'theme-$1');
}
