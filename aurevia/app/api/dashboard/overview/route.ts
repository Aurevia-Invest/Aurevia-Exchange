import {NextResponse} from 'next/server';
import {AccountMode,InvestmentOpportunityStatus,InvestmentStatus,Prisma,UserStatus} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {getUserActivity} from '@/lib/activity';
import {balance,DEMO_STARTING_BALANCE} from '@/lib/ledger';
import {calculateAllocationPercentages,instrumentAssetCategory} from '@/lib/portfolio-metrics';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';
import {jsonSafe} from '@/lib/serializers';
import {MARKET_ASSETS} from '@/lib/live-market';
import {getInternalInstrumentSymbols} from '@/lib/internal-market-data';
import {simulatedInvestmentSettlement} from '@/lib/investment-policy';
import {ALPACA_PAPER_PROVIDER} from '@/lib/bitcoin-funding';
import {getWalletBackedPaperInstrumentIds} from '@/lib/paper-ledger-reconciliation';
import {getMarketAssetForTradingSymbol,isExternalMarketDataSource} from '@/lib/live-market';
import {getMarketQuoteWithFallback,getAlpacaMarketDataOptions} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';

export const dynamic='force-dynamic';

const activeInvestmentStatuses=[
	InvestmentStatus.PENDING_APPROVAL,
	InvestmentStatus.APPROVED,
	InvestmentStatus.ACTIVE,
	InvestmentStatus.PAUSED,
	InvestmentStatus.COMPLETED,
];

// Balances come from owned USD ledger accounts; holdings, orders, opportunities, and activity are scoped to the database-confirmed active mode.
export async function GET(){
	try{
		const sessionUser=await requireUser();
		const profile=await db.$transaction(async tx=>{
			await synchronizeCompletedProfileTier(tx,sessionUser.id);
			return tx.user.findUnique({
				where:{id:sessionUser.id},
				select:{
					id:true,aureviaExchangeId:true,name:true,country:true,phone:true,phoneVerified:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,avatarKey:true,
					kyc:{select:{submittedAt:true}},
				},
			});
		});
		if(!profile||profile.role!=='USER'||profile.status!==UserStatus.ACTIVE){
			return NextResponse.json({error:'This account is unavailable.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
		}

		const mode=profile.accountMode;
		const [accounts,documents,positions,investments,orders,opportunities,activity,instruments]=await Promise.all([
			db.ledgerAccount.findMany({
				where:{userId:profile.id,accountMode:mode,currency:'USD'},
				select:{id:true},
			}),
			mode===AccountMode.REAL?db.kycDocument.count({where:{userId:profile.id,kind:'IDENTITY_DOCUMENT',status:'APPROVED'}}):Promise.resolve(0),
			db.position.findMany({
				where:{userId:profile.id,accountMode:mode,status:'OPEN'},
				include:{instrument:{select:{symbol:true,name:true,baseAsset:true,quoteAsset:true,price:true}}},
				orderBy:{openedAt:'desc'},
			}),
			mode===AccountMode.REAL?db.investmentRequest.findMany({
				where:{userId:profile.id,accountMode:mode,status:{in:activeInvestmentStatuses}},
				include:{opportunity:{select:{title:true,category:true,assetSymbol:true,riskLevel:true,durationDays:true}}},
				orderBy:{requestedAt:'desc'},
			}):Promise.resolve([]),
			db.order.findMany({
				where:{userId:profile.id,accountMode:mode,status:{in:['OPEN','PARTIALLY_FILLED']}},
				select:{id:true,side:true,type:true,status:true,quantity:true,filledQuantity:true,price:true,createdAt:true,instrument:{select:{symbol:true,name:true}}},
				orderBy:{createdAt:'desc'},
				take:8,
			}),
			mode===AccountMode.REAL?db.investmentOpportunity.findMany({
				where:{
					status:InvestmentOpportunityStatus.AVAILABLE,
					realEligible:true,
				},
				select:{id:true,title:true,category:true,description:true,assetSymbol:true,minimumAmount:true,maximumAmount:true,targetReturnPercent:true,durationDays:true,riskLevel:true,requiresApproval:true},
				orderBy:{createdAt:'desc'},
				take:4,
			}):Promise.resolve([]),
			getUserActivity(profile.id,mode,'all',8),
			db.instrument.findMany({where:{enabled:true},select:{id:true,symbol:true}}),
		]);
		const internalMarketInstruments=instruments.flatMap(instrument=>{
			const asset=MARKET_ASSETS.find(item=>getInternalInstrumentSymbols(item.id).includes(instrument.symbol));
			return asset?[{assetId:asset.id,instrumentId:instrument.id}]:[];
		});

		const activeAccount=accounts[0];
		const activeBalance=activeAccount?await balance(db,activeAccount.id):new Prisma.Decimal(0);
		const walletBackedPaperInstrumentIds=mode===AccountMode.REAL&&positions.some(position=>position.providerName===ALPACA_PAPER_PROVIDER)
			?await getWalletBackedPaperInstrumentIds(db,profile.id)
			:new Set<string>();
		const valuationPositions=mode===AccountMode.REAL
			?positions.filter(position=>position.providerName!==ALPACA_PAPER_PROVIDER||walletBackedPaperInstrumentIds.has(position.instrumentId))
			:positions;
		const unreconciledPaperPositionCount=positions.filter(position=>position.providerName===ALPACA_PAPER_PROVIDER&&!walletBackedPaperInstrumentIds.has(position.instrumentId)).length;
		const marketMarks=new Map<string,Prisma.Decimal>();
		if(mode===AccountMode.REAL&&valuationPositions.length){
			const configuration=getServerConfiguration();
			const alpacaData=getAlpacaMarketDataOptions(configuration.execution);
			const instruments=[...new Map(valuationPositions.map(position=>[position.instrumentId,position.instrument])).entries()];
			const quotes=await Promise.all(instruments.map(async([instrumentId,instrument])=>{
				const asset=getMarketAssetForTradingSymbol(instrument.symbol);
				if(!asset)return null;
				try{
					const quote=await getMarketQuoteWithFallback(asset,configuration.marketData.finnhubApiKey,alpacaData);
					if(!isExternalMarketDataSource(quote.source)||quote.isStale)return null;
					return {instrumentId,price:new Prisma.Decimal(quote.price)};
				}catch{return null;}
			}));
			for(const quote of quotes)if(quote)marketMarks.set(quote.instrumentId,quote.price);
		}
		const currentMarksAvailable=mode===AccountMode.DEMO||valuationPositions.every(position=>marketMarks.has(position.instrumentId));
		const positionValue=mode===AccountMode.DEMO
			?positions.reduce((sum,position)=>sum.plus(position.instrument.price.mul(position.quantity)),new Prisma.Decimal(0))
			:currentMarksAvailable?valuationPositions.reduce((sum,position)=>sum.plus(position.quantity.mul(marketMarks.get(position.instrumentId)??0)),new Prisma.Decimal(0)):null;
		const unrealizedPnl=mode===AccountMode.DEMO
			?positions.reduce((sum,position)=>{
				const direction=position.side==='BUY'?1:-1;
				return sum.plus(position.entryPrice.mul(-direction).plus(position.instrument.price.mul(direction)).mul(position.quantity));
			},new Prisma.Decimal(0))
			:currentMarksAvailable?valuationPositions.reduce((sum,position)=>{
				const currentPrice=marketMarks.get(position.instrumentId)??new Prisma.Decimal(0);
				const direction=position.side==='BUY'?1:-1;
				return sum.plus(position.entryPrice.mul(-direction).plus(currentPrice.mul(direction)).mul(position.quantity));
			},new Prisma.Decimal(0)):null;
		const investmentValue=investments.reduce((sum,investment)=>sum.plus(investment.amount),new Prisma.Decimal(0));
		const totalValue=positionValue===null?null:activeBalance.plus(positionValue).plus(investmentValue);
		const allocationValues=new Map<string,Prisma.Decimal>();
		if(activeBalance.gt(0))allocationValues.set('Cash',activeBalance);
		for(const position of valuationPositions){
			const price=mode===AccountMode.DEMO?position.instrument.price:marketMarks.get(position.instrumentId);
			if(!price)continue;
			const category=instrumentAssetCategory(position.instrument);
			allocationValues.set(category,(allocationValues.get(category)??new Prisma.Decimal(0)).plus(price.mul(position.quantity)));
		}
		for(const investment of investments){
			const category=investment.opportunity.category;
			allocationValues.set(category,(allocationValues.get(category)??new Prisma.Decimal(0)).plus(investment.amount));
		}
		const allocations=calculateAllocationPercentages([...allocationValues].map(([category,value])=>({category,value})));
		const tierProfileRequirements=getTierProfileRequirements(profile);
		const tier=getAccountTier({
			accountMode:mode,
			kycStatus:profile.kycStatus,
			verificationDocuments:documents,
			verificationSubmitted:!!profile.kyc?.submittedAt,
			phoneVerified:profile.phoneVerified,
			profileComplete:tierProfileRequirements.profileComplete,
			approvedTier:profile.approvedTier,
		});

		return NextResponse.json(jsonSafe({
			profile:{name:profile.name,aureviaExchangeId:profile.aureviaExchangeId,accountMode:mode,tier:tier.label,progress:tier.progress,profileRequirements:tierProfileRequirements,kycStatus:mode===AccountMode.REAL?profile.kycStatus:'NOT_AVAILABLE',hasAvatar:!!profile.avatarKey},
			accountMode:mode,
			demoStartingBalance:mode===AccountMode.DEMO?DEMO_STARTING_BALANCE:null,
			balances:{[mode]:activeBalance},
			portfolioSummary:{
				accountMode:mode,
				cashBalance:activeBalance,
				positionValue,
				investmentValue,
				totalValue,
				unrealizedPnl,
				allocations,
			},
			unreconciledPaperPositionCount,
			positions:positions.slice(0,8).map(position=>({
				id:position.id,
				side:position.side,
				quantity:position.quantity,
				entryPrice:position.entryPrice,
				currentPrice:mode===AccountMode.DEMO?position.instrument.price:walletBackedPaperInstrumentIds.has(position.instrumentId)||position.providerName!==ALPACA_PAPER_PROVIDER?marketMarks.get(position.instrumentId)??null:null,
				marketValue:mode===AccountMode.DEMO?position.instrument.price.mul(position.quantity):walletBackedPaperInstrumentIds.has(position.instrumentId)||position.providerName!==ALPACA_PAPER_PROVIDER?marketMarks.get(position.instrumentId)?.mul(position.quantity)??null:null,
				openedAt:position.openedAt,
				instrument:{symbol:position.instrument.symbol,name:position.instrument.name},
			})),
			openOrders:orders,
			opportunities,
			activeInvestments:investments.filter(investment=>investment.status===InvestmentStatus.ACTIVE).slice(0,3).map(investment=>({
				id:investment.id,
				title:investment.opportunity.title,
				accountMode:investment.accountMode,
				amount:investment.amount,
				status:investment.status,
				activatedAt:investment.activatedAt,
				maturesAt:investment.maturesAt,
				durationDays:investment.durationDays,
				displayTargetPayout:simulatedInvestmentSettlement(investment.amount,investment.targetReturnPercent,investment.tierBoostPercent??new Prisma.Decimal(0)),
			})),
			recentActivity:activity.items.map(({details,...item})=>item),
			internalMarketInstruments,
			limitations:{
				balances:'Separate USD ledger balances for DEMO and REAL; never combined.',
				portfolio:mode===AccountMode.DEMO?'DEMO cash and practice positions valued at internal reference prices.':'Cash, currently valued positions, and active investment principal.',
				realExecution:'When enabled, REAL account orders route through the Alpaca sandbox. Status reflects provider confirmation; confirmed fills are recorded in the Aurevia ledger.',
			},
		}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const unauthorized=error instanceof Error&&error.message==='UNAUTHORIZED';
		const forbidden=error instanceof Error&&error.message==='FORBIDDEN';
		if(!unauthorized&&!forbidden)console.error('Dashboard overview query failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json(
			{error:unauthorized?'Unauthorized':forbidden?'Forbidden':'Dashboard data is temporarily unavailable.'},
			{status:unauthorized?401:forbidden?403:503,headers:{'Cache-Control':'private, no-store'}},
		);
	}
}
