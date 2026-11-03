import {AccountMode,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	ledgerEntries:vi.fn(),
	orders:vi.fn(),
	positions:vi.fn(),
	investments:vi.fn(),
	funding:vi.fn(),
	audits:vi.fn(),
	visibilityPreferences:vi.fn(),
	notifications:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	ledgerEntry:{findMany:mocks.ledgerEntries},
	order:{findMany:mocks.orders},
	position:{findMany:mocks.positions},
	investmentRequest:{findMany:mocks.investments},
	fundingRequest:{findMany:mocks.funding},
	auditLog:{findMany:mocks.audits},
	activityVisibilityPreference:{findMany:mocks.visibilityPreferences},
	notification:{findMany:mocks.notifications},
}}));

import {getUserActivity} from '@/lib/activity';

describe('DEMO activity separation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.ledgerEntries.mockResolvedValue([]);
		mocks.orders.mockResolvedValue([{
			id:'demo-order',side:'BUY',type:'MARKET',status:'OPEN',createdAt:new Date('2026-01-02T00:00:00Z'),
			instrument:{symbol:'AURE'},executions:[],averageFillPrice:null,price:null,
			quantity:new Prisma.Decimal(1),filledQuantity:new Prisma.Decimal(0),fee:new Prisma.Decimal(0),
		}]);
		mocks.positions.mockResolvedValue([]);
		mocks.investments.mockResolvedValue([{
			id:'legacy-demo-investment',status:'SETTLED',requestedAt:new Date('2026-01-03T00:00:00Z'),
			opportunity:{title:'Legacy investment',assetSymbol:null,category:'Legacy',targetReturnPercent:null,durationDays:1},
			amount:new Prisma.Decimal(50),simulatedPayout:new Prisma.Decimal(50),
		}]);
		mocks.funding.mockResolvedValue([{
			id:'legacy-demo-funding',type:'DEPOSIT',createdAt:new Date('2026-01-04T00:00:00Z'),
			method:'Legacy',amount:new Prisma.Decimal(50),status:'COMPLETED',transactionReference:null,
		}]);
		mocks.audits.mockResolvedValue([]);
		mocks.visibilityPreferences.mockResolvedValue([]);
		mocks.notifications.mockResolvedValue([]);
	});

	it('shows only trading activity in DEMO, including when legacy records exist',async()=>{
		const result=await getUserActivity('user-1',AccountMode.DEMO,'all');

		expect(result.items.map(item=>item.id)).toEqual(['demo-order']);
		expect(result.items.every(item=>['trade','personal-trade','order','position'].includes(item.category))).toBe(true);
		expect(mocks.orders).toHaveBeenCalledWith(expect.objectContaining({where:{userId:'user-1',accountMode:AccountMode.DEMO}}));
	});

	it('does not expose DEMO investment activity through category filters',async()=>{
		const result=await getUserActivity('user-1',AccountMode.DEMO,'investment');

		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('shows only mode-tagged notifications for the active DEMO mode',async()=>{
		mocks.orders.mockResolvedValue([]);
		mocks.notifications.mockResolvedValue([{
			id:'demo-notice',type:'TRADE',title:'DEMO order completed',message:'Simulated order completed.',
			isRead:true,archivedAt:null,createdAt:new Date('2026-01-05T00:00:00Z'),accountMode:AccountMode.DEMO,
			relatedEntity:'ORDER',relatedId:'demo-order',actionUrl:'/orders',pushOutbox:null,
		}]);
		const result=await getUserActivity('user-1',AccountMode.DEMO,'all');
		expect(result.items.map(item=>item.id)).toEqual(['demo-notice']);
		expect(result.items[0]?.permanentDeletionAllowed).toBe(true);
		expect(mocks.notifications).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({userId:'user-1',AND:expect.arrayContaining([{OR:[{accountMode:AccountMode.DEMO},{accountMode:null}]}])})}));
	});

	it('does not include archived notifications in the default visible feed',async()=>{
		mocks.orders.mockResolvedValue([]);
		mocks.notifications.mockResolvedValue([]);
		mocks.visibilityPreferences.mockResolvedValue([]);
		await getUserActivity('user-1',AccountMode.DEMO,'all');
		expect(mocks.notifications).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({archivedAt:null})}));
	});

	it('keeps security and verification notices protected from permanent deletion',async()=>{
		mocks.orders.mockResolvedValue([]);
		mocks.notifications.mockResolvedValue([{
			id:'security-notice',type:'SECURITY',title:'New sign-in',message:'Security event.',
			isRead:true,archivedAt:null,createdAt:new Date('2026-01-05T00:00:00Z'),accountMode:null,
			relatedEntity:null,relatedId:null,actionUrl:'/settings',pushOutbox:null,
		}]);
		mocks.audits.mockResolvedValue([{
			id:'login-event',actorId:'user-1',action:'LOGIN_FAILED',entity:'LOGIN',entityId:'user-1',
			metadata:{clientIp:'203.0.113.10',userAgent:'private browser details'},createdAt:new Date('2026-01-06T00:00:00Z'),
		}]);
		const result=await getUserActivity('user-1',AccountMode.DEMO,'security');
		expect(result.items).toMatchObject([
			{id:'login-event',category:'security',action:'Failed sign-in',status:'FAILED',source:'audit',details:{eventType:'LOGIN_FAILED'},permanentDeletionAllowed:false},
			{id:'security-notice',source:'notification',permanentDeletionAllowed:false,protectionReason:'Security and verification notifications must be retained.'},
		]);
		expect(JSON.stringify(result.items)).not.toContain('203.0.113.10');
		expect(JSON.stringify(result.items)).not.toContain('private browser details');
	});

	it('excludes login records from admin default activity unless login history is selected',async()=>{
		mocks.orders.mockResolvedValue([]);
		mocks.investments.mockResolvedValue([]);
		mocks.funding.mockResolvedValue([]);
		const loginEvent={
			id:'login-event',actorId:'user-1',action:'LOGIN_FAILED',entity:'LOGIN',entityId:'user-1',
			metadata:{},createdAt:new Date('2026-01-06T00:00:00Z'),
		};
		mocks.audits.mockImplementation(async({where}:{where:{entity:{in:string[]}}})=>
			where.entity.in.includes('LOGIN')?[loginEvent]:[],
		);
		const defaultActivity=await getUserActivity('user-1',AccountMode.REAL,'all',20,{excludeLoginHistory:true});
		expect(defaultActivity.items.some(item=>item.source==='audit')).toBe(false);
		expect(mocks.audits).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({entity:{in:['ORDER','POSITION','INVESTMENT']}})}));

		const loginHistory=await getUserActivity('user-1',AccountMode.REAL,'login-history',20,{includeLoginHistory:true});
		expect(loginHistory.items).toMatchObject([{id:'login-event',source:'audit',category:'security',action:'Failed sign-in'}]);
		expect(mocks.audits).toHaveBeenLastCalledWith(expect.objectContaining({where:expect.objectContaining({entity:{in:['LOGIN']}})}));
	});
});
