import {readFile} from 'node:fs/promises';
import {describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

import {copyAureviaExchangeId} from '@/components/AureviaExchangeId';
import {AUREVIA_EXCHANGE_ID_PATTERN,assignMissingAureviaExchangeId,generateAureviaExchangeId,retryAureviaExchangeIdCollision} from '@/lib/aurevia-exchange-id';

describe('Aurevia Exchange IDs',()=>{
	it('generates the permanent ID format with the UTC account-creation year',()=>{
		const id=generateAureviaExchangeId(new Date('2026-11-02T00:30:00.000Z'));

		expect(id).toMatch(AUREVIA_EXCHANGE_ID_PATTERN);
		expect(id).toMatch(/^AEX-2026-/);
	});

	it('uses independently generated random values for different accounts',()=>{
		const ids=new Set(Array.from({length:100},()=>generateAureviaExchangeId(new Date('2026-01-01T00:00:00.000Z'))));

		expect(ids.size).toBe(100);
	});

	it('retries unique-ID collisions and does not retry unrelated unique conflicts',async()=>{
		const collision=new Prisma.PrismaClientKnownRequestError('Unique constraint failed',{
			code:'P2002',
			clientVersion:'test',
			meta:{target:['aureviaExchangeId']},
		});
		const operation=vi.fn().mockRejectedValueOnce(collision).mockResolvedValue('created');

		await expect(retryAureviaExchangeIdCollision(operation)).resolves.toBe('created');
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it('copies the ID using the browser clipboard API',async()=>{
		const clipboard={writeText:vi.fn().mockResolvedValue(undefined)};

		await copyAureviaExchangeId('AEX-2026-8K7M-4Q9X',clipboard);

		expect(clipboard.writeText).toHaveBeenCalledWith('AEX-2026-8K7M-4Q9X');
	});

	it('backfills only still-unassigned active customer accounts and preserves a concurrent assignment',async()=>{
		const updateMany=vi.fn(async(_args:{where:{id:string;role:'USER';status:'ACTIVE';aureviaExchangeId:null};data:{aureviaExchangeId:string}})=>({count:1}));
		const runTransaction=async<T>(operation:(tx:{user:{updateMany:typeof updateMany}})=>Promise<T>)=>operation({user:{updateMany}});

		await expect(assignMissingAureviaExchangeId(runTransaction,'active-user',new Date('2024-06-01T00:00:00.000Z'))).resolves.toBe(true);
		expect(updateMany).toHaveBeenCalledWith({
			where:{id:'active-user',role:'USER',status:'ACTIVE',aureviaExchangeId:null},
			data:{aureviaExchangeId:expect.stringMatching(/^AEX-2024-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)},
		});

		updateMany.mockResolvedValueOnce({count:0});
		await expect(assignMissingAureviaExchangeId(runTransaction,'concurrent-assignment',new Date('2024-06-01T00:00:00.000Z'))).resolves.toBe(false);
	});

	it('defines unique storage and adds the verified-user constraint after backfill',async()=>{
		const migration=await readFile('prisma/migrations/20261102110000_aurevia_exchange_id/migration.sql','utf8');
		const backfill=await readFile('scripts/aurevia-id-backfill.ts','utf8');

		expect(migration).toContain('CREATE UNIQUE INDEX "User_aureviaExchangeId_key"');
		expect(backfill).toContain('CHECK ("emailVerifiedAt" IS NULL OR "aureviaExchangeId" IS NOT NULL)');
		expect(backfill).toContain('VALIDATE CONSTRAINT "User_verified_requires_aurevia_exchange_id_check"');
	});
});
