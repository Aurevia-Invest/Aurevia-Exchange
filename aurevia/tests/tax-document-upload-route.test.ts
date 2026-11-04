import {TaxCaseStatus,TaxDocumentCategory} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userHasTaxAccess:vi.fn(),
	canUserEditCase:vi.fn(),
	rateLimit:vi.fn(),
	taxCaseFindFirst:vi.fn(),
	documentCount:vi.fn(),
	documentCreate:vi.fn(),
	auditCreate:vi.fn(),
	transaction:vi.fn(),
	createPrivateObjectKey:vi.fn(),
	hasMatchingFileExtension:vi.fn(),
	uploadPrivateObject:vi.fn(),
	deletePrivateObject:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/tax-services',()=>({userHasTaxAccess:mocks.userHasTaxAccess,canUserEditCase:mocks.canUserEditCase}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/db',()=>({db:{
	taxCase:{findFirst:mocks.taxCaseFindFirst},
	taxCaseDocument:{count:mocks.documentCount},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/private-storage',()=>({
	createPrivateObjectKey:mocks.createPrivateObjectKey,
	hasMatchingFileExtension:mocks.hasMatchingFileExtension,
	uploadPrivateObject:mocks.uploadPrivateObject,
	deletePrivateObject:mocks.deletePrivateObject,
	PrivateStorageError:class extends Error{},
}));

import {POST} from '@/app/api/tax-services/cases/[id]/documents/route';

function request(fields:{category?:string;description?:string;taxYear?:string}={}){
	const form=new FormData();
	form.append('file',new File([new Uint8Array([37,80,68,70,45])],'document.pdf',{type:'application/pdf'}));
	for(const [key,value] of Object.entries(fields))form.append(key,value);
	return new Request('https://aurevia.test/api/tax-services/cases/case-1/documents',{method:'POST',body:form});
}

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'user-1'});
	mocks.userHasTaxAccess.mockResolvedValue(true);
	mocks.canUserEditCase.mockReturnValue(true);
	mocks.taxCaseFindFirst.mockResolvedValue({id:'case-1',status:TaxCaseStatus.DRAFT,taxYear:2024});
	mocks.documentCount.mockResolvedValue(0);
	mocks.documentCreate.mockResolvedValue({id:'document-1'});
	mocks.auditCreate.mockResolvedValue({});
	mocks.transaction.mockImplementation((callback:(tx:unknown)=>unknown)=>callback({
		taxCaseDocument:{create:mocks.documentCreate},
		auditLog:{create:mocks.auditCreate},
	}));
	mocks.createPrivateObjectKey.mockReturnValue('user-1/00000000-0000-4000-8000-000000000001.pdf');
	mocks.hasMatchingFileExtension.mockReturnValue(true);
	mocks.uploadPrivateObject.mockResolvedValue(undefined);
	mocks.deletePrivateObject.mockResolvedValue(true);
});

describe('tax document upload',()=>{
	it('validates multipart metadata before storing the document',async()=>{
		const response=await POST(request({taxYear:'not-a-year'}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(400);
		expect(mocks.uploadPrivateObject).not.toHaveBeenCalled();
		expect(mocks.documentCreate).not.toHaveBeenCalled();
	});

	it('deletes the uploaded object if the database transaction fails',async()=>{
		mocks.transaction.mockRejectedValue(new Error('database unavailable'));
		const errorLog=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		const response=await POST(request({category:TaxDocumentCategory.PRIOR_YEAR_RETURN,description:' Tax return ',taxYear:'2025'}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(500);
		expect(mocks.deletePrivateObject).toHaveBeenCalledWith('tax','user-1','user-1/00000000-0000-4000-8000-000000000001.pdf');
		expect(mocks.documentCreate).not.toHaveBeenCalled();
		errorLog.mockRestore();
	});
});
