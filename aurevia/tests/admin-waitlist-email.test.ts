import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	entryFindFirst:vi.fn(),
	entryUpdate:vi.fn(),
	auditCreate:vi.fn(),
	transaction:vi.fn(),
	isEmailConfigured:vi.fn(),
	sendEmail:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	waitlistEntry:{findFirst:mocks.entryFindFirst},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/email',()=>({
	emailDeliveryStatus:(delivery:{sent:boolean;reason?:string})=>delivery.sent?'sent':delivery.reason==='not-configured'?'not-configured':'failed',
	isEmailConfigured:mocks.isEmailConfigured,
	sendEmail:mocks.sendEmail,
}));

import {PATCH} from '@/app/api/admin/waitlist/route';

function request(){
	return new Request('https://aurevia.test/api/admin/waitlist',{
		method:'PATCH',
		headers:{'content-type':'application/json'},
		body:JSON.stringify({id:'waitlist-1',status:'INVITED'}),
	});
}

describe('admin waitlist invitation email status',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.entryFindFirst.mockResolvedValue({id:'waitlist-1',email:'person@example.invalid'});
		mocks.entryUpdate=vi.fn().mockResolvedValue({id:'waitlist-1',status:'INVITED'});
		mocks.auditCreate=vi.fn().mockResolvedValue({});
		mocks.transaction.mockImplementation(async(callback)=>callback({
			waitlistEntry:{update:mocks.entryUpdate},
			auditLog:{create:mocks.auditCreate},
		}));
		mocks.isEmailConfigured.mockReturnValue(true);
		mocks.sendEmail.mockResolvedValue({sent:true,provider:'smtp'});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('reports sent only when the email provider accepted delivery',async()=>{
		mocks.sendEmail.mockResolvedValue({sent:true,provider:'smtp'});

		const response=await PATCH(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({delivery:'sent'});
		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
			to:'person@example.invalid',
			subject:'Aurevia waitlist invitation',
		}));
	});

	it('keeps the admin status update and reports delivery failure honestly',async()=>{
		mocks.sendEmail.mockResolvedValue({sent:false,provider:'smtp',reason:'failed'});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await PATCH(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			entry:{status:'INVITED'},
			delivery:'failed',
		});
		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledWith(
			'Waitlist status changed but invitation email delivery failed.',
			expect.objectContaining({reason:'failed',provider:'smtp'}),
		);
		warning.mockRestore();
	});

	it('does not attempt delivery or claim success when email is unconfigured',async()=>{
		mocks.isEmailConfigured.mockReturnValue(false);

		const response=await PATCH(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({delivery:'not-configured'});
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});
