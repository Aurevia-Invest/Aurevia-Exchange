import {AccountMode} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	tierRequestFindFirst:vi.fn(),
	auditCreate:vi.fn(),
	runAiService:vi.fn(),
	rateLimit:vi.fn(),
	getRequirements:vi.fn(),
	getAccountTier:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	tierUpgradeRequest:{findFirst:mocks.tierRequestFindFirst},
	auditLog:{create:mocks.auditCreate},
}}));
vi.mock('@/lib/ai-services',()=>({runAiService:mocks.runAiService}));
vi.mock('@/lib/ai-gateway',()=>({AiGatewayError:class AiGatewayError extends Error{constructor(message:string,readonly code:string,readonly status=503){super(message)}}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/production-policy',()=>({
	getTierProfileRequirements:mocks.getRequirements,
	getAccountTier:mocks.getAccountTier,
}));

import {POST} from '@/app/api/onboarding/assistant/route';

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'user-1'});
	mocks.userFindUnique.mockResolvedValue({
		role:'USER',status:'ACTIVE',accountMode:AccountMode.DEMO,approvedTier:1,kycStatus:'PENDING',
		email:'member@example.test',name:'Member Name',country:'US',phone:'+12025550123',phoneVerified:false,
		kyc:null,kycDocuments:[],
	});
	mocks.tierRequestFindFirst.mockResolvedValue(null);
	mocks.auditCreate.mockResolvedValue({});
	mocks.getRequirements.mockReturnValue({nameComplete:false,countryComplete:false,phoneComplete:false,profileComplete:false});
	mocks.getAccountTier.mockReturnValue({label:'TIER 1',progress:33});
	mocks.runAiService.mockResolvedValue({
		content:JSON.stringify({summary:'Complete your profile details to progress through the account checklist.',caveat:'KYC and tier changes follow the normal administrator-reviewed workflow.'}),
		provider:'openrouter',model:'test/free-model',
	});
});

describe('smart onboarding assistant',()=>{
	it('uses local profile checks and sends no personal values to AI',async()=>{
		const response=await POST();
		const body=await response.json();
		const messages=mocks.runAiService.mock.calls[0][1] as Array<{role:string;content:string}>;

		expect(response.status).toBe(200);
		expect(body.steps.map((step:{id:string})=>step.id)).toEqual(['complete_name','select_country','add_phone']);
		expect(body.guidance.summary).toContain('Complete your profile');
		expect(messages[1].content).not.toContain('member@example.test');
		expect(messages[1].content).not.toContain('Member Name');
		expect(messages[1].content).not.toContain('+12025550123');
		expect(mocks.runAiService).toHaveBeenCalledWith('smart_onboarding',expect.any(Array),expect.objectContaining({actorId:'user-1'}));
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:expect.objectContaining({actorId:'user-1',action:'AI_ONBOARDING_GUIDANCE',metadata:expect.objectContaining({accountMode:'DEMO',externalAction:false})})});
	});

	it('keeps REAL identity workflow guidance review-only',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,approvedTier:2,kycStatus:'PENDING',
			email:'member@example.test',name:'Member Name',country:'US',phone:'+12025550123',phoneVerified:true,
			kyc:{submittedAt:new Date()},kycDocuments:[{status:'SUBMITTED'}],
		});
		mocks.getRequirements.mockReturnValue({nameComplete:true,countryComplete:true,phoneComplete:true,profileComplete:true});
		mocks.getAccountTier.mockReturnValue({label:'TIER 2',progress:67});

		const response=await POST();
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body.steps).toEqual([{id:'await_identity_review',title:'Check your identity-review status',href:'/kyc'}]);
		expect(body.steps[0].title).not.toContain('approved');
	});

	it('rejects unauthorized users and malformed model output',async()=>{
		mocks.requireUser.mockRejectedValue(new Error('FORBIDDEN'));
		expect((await POST()).status).toBe(403);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();

		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.runAiService.mockResolvedValue({content:'not-json',provider:'openrouter',model:'test/free-model'});
		expect((await POST()).status).toBe(502);
		expect(mocks.auditCreate).not.toHaveBeenCalled();
	});
});
