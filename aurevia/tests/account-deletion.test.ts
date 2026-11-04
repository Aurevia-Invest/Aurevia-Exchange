import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({balance:vi.fn()}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance}));

import {deleteAccountData} from '@/lib/account-deletion';

function transaction(overrides:Record<string,unknown>={}){
	return {
		user:{findUnique:vi.fn().mockResolvedValue({
			id:'user-1',
			avatarKey:null,
			kycDocuments:[{storageKey:'user-1/00000000-0000-4000-8000-000000000001.pdf'}],
			funding:[{receiptKey:null}],
			supportConversations:[{attachmentKey:null}],
			clientStories:[],
			taxCases:[],
		}),delete:vi.fn().mockResolvedValue({})},
		fundingRequest:{count:vi.fn().mockResolvedValue(0)},
		ledgerAccount:{findMany:vi.fn().mockResolvedValue([])},
		ledgerTransaction:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		supportMessage:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		auditLog:{updateMany:vi.fn().mockResolvedValue({count:0}),create:vi.fn().mockResolvedValue({})},
		...overrides,
	} as unknown as Prisma.TransactionClient;
}

describe('physical account deletion',()=>{
	beforeEach(()=>{vi.clearAllMocks();mocks.balance.mockResolvedValue(new Prisma.Decimal(0))});

	it('deletes the user in the transaction and returns private-file cleanup work',async()=>{
		const tx=transaction();
		const files=await deleteAccountData(tx,{userId:'user-1',actorId:'admin-1'});

		expect(files).toEqual([{area:'kyc',ownerId:'user-1',key:'user-1/00000000-0000-4000-8000-000000000001.pdf'}]);
		expect(tx.ledgerTransaction.deleteMany).toHaveBeenCalledWith({where:{entries:{some:{account:{userId:'user-1'}}}}});
		expect(tx.supportMessage.deleteMany).toHaveBeenCalledWith({where:{authorId:'user-1'}});
		expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
			where:{OR:[{actorId:'user-1'},{entityId:'user-1'}]},
			data:{actorId:null,entityId:null,metadata:Prisma.DbNull},
		});
		expect(tx.user.delete).toHaveBeenCalledWith({where:{id:'user-1'}});
		expect(tx.auditLog.create).toHaveBeenCalledWith({data:{
			actorId:'admin-1',action:'ADMIN_ACCOUNT_DELETED',entity:'USER',entityId:'user-1',
		}});
	});

	it('blocks deletion with active funding unless an admin explicitly forces it',async()=>{
		const tx=transaction({fundingRequest:{count:vi.fn().mockResolvedValue(1)}});

		await expect(deleteAccountData(tx,{userId:'user-1',actorId:null})).rejects.toThrow('ACCOUNT_HAS_ACTIVE_FUNDING');
		expect(tx.user.delete).not.toHaveBeenCalled();
	});

	it('blocks non-zero balances unless forced',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal('0.01'));
		const tx=transaction({ledgerAccount:{findMany:vi.fn().mockResolvedValue([{id:'ledger-1',startingBalance:new Prisma.Decimal(0)}])}});

		await expect(deleteAccountData(tx,{userId:'user-1',actorId:null})).rejects.toThrow('ACCOUNT_HAS_NONZERO_BALANCE');
		expect(tx.user.delete).not.toHaveBeenCalled();
	});

	it('allows an admin force deletion despite active funding and balances',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(10));
		const tx=transaction({fundingRequest:{count:vi.fn().mockResolvedValue(1)},ledgerAccount:{findMany:vi.fn().mockResolvedValue([{id:'ledger-1',startingBalance:new Prisma.Decimal(0)}])}});

		await expect(deleteAccountData(tx,{userId:'user-1',actorId:'admin-1',force:true})).resolves.toHaveLength(1);
		expect(tx.user.delete).toHaveBeenCalledOnce();
	});
});
