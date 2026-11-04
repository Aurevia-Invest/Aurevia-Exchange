import {Prisma,PrismaClient} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';

import {getWalletBackedPaperInstrumentIds} from '@/lib/paper-ledger-reconciliation';

function transaction(
	references:string[],
	filledQuantity='2',
	executionQuantity='2',
){
	return {
		order:{findMany:vi.fn().mockResolvedValue([{
			id:'order-1',instrumentId:'instrument-1',side:'BUY',filledQuantity:new Prisma.Decimal(filledQuantity),
			executions:[{quantity:new Prisma.Decimal(executionQuantity),providerExecutionId:'provider-order-1:2.0000000000'}],
		}])},
		ledgerAccount:{findUnique:vi.fn().mockResolvedValue({id:'usd-account'})},
		ledgerTransaction:{findMany:vi.fn().mockResolvedValue(references.map(reference=>({reference})))},
	} as unknown as PrismaClient;
}

describe('wallet-backed Paper position verification',()=>{
	it('recognizes a position only when its every confirmed execution has a wallet posting',async()=>{
		const tx=transaction(['REAL:SIMULATED_TRADE:BUY:order-1:provider-order-1:2.0000000000']);

		await expect(getWalletBackedPaperInstrumentIds(tx,'user-1')).resolves.toEqual(new Set(['instrument-1']));
	});

	it('excludes legacy positions with no matching wallet transaction',async()=>{
		const tx=transaction([]);

		await expect(getWalletBackedPaperInstrumentIds(tx,'user-1')).resolves.toEqual(new Set());
	});

	it('excludes positions whose posted execution quantity does not cover the confirmed fill',async()=>{
		const tx=transaction(['REAL:SIMULATED_TRADE:BUY:order-1:provider-order-1:2.0000000000'],'2','1');

		await expect(getWalletBackedPaperInstrumentIds(tx,'user-1')).resolves.toEqual(new Set());
	});
});
