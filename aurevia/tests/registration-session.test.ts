import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	userUpdateMany:vi.fn(),
	encode:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany}}}));
vi.mock('next-auth/jwt',()=>({encode:mocks.encode}));

import {NextResponse} from 'next/server';
import {establishRegistrationSession} from '@/lib/registration-session';

describe('registration-created authentication session',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		vi.stubEnv('NEXTAUTH_SECRET','test-session-secret');
		vi.stubEnv('NEXTAUTH_URL','https://aurevia.test');
		vi.stubEnv('NODE_ENV','production');
		mocks.userFindUnique.mockResolvedValue({
			id:'new-user',
			email:'person@example.invalid',
			name:'Person Example',
			role:'USER',
			status:'ACTIVE',
			accountMode:'DEMO',
			activeSessionId:null,
			requiresRegistrationVerification:false,
			emailVerifiedAt:null,
			phoneVerified:true,
			phoneVerifiedAt:new Date(),
			verifiedChannel:'SMS',
		});
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.encode.mockResolvedValue('encrypted-next-auth-session');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('sets the normal secure NextAuth cookie only for a server-verified account',async()=>{
		const response=NextResponse.json({verified:true});
		await establishRegistrationSession(response,'person@example.invalid');

		expect(mocks.encode).toHaveBeenCalledWith(expect.objectContaining({
			token:expect.objectContaining({id:'new-user',email:'person@example.invalid',sessionId:expect.any(String)}),
			secret:'test-session-secret',
		}));
		expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'new-user',activeSessionId:null,status:'ACTIVE',requiresRegistrationVerification:false},
		}));
		expect(response.headers.get('set-cookie')).toContain('__Secure-next-auth.session-token=encrypted-next-auth-session');
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(response.headers.get('set-cookie')).toContain('Secure');
	});

	it('does not issue a session before a verified phone or email exists',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'pending-user',
			email:'person@example.invalid',
			role:'USER',
			status:'ACTIVE',
			requiresRegistrationVerification:true,
			emailVerifiedAt:null,
			phoneVerified:false,
			phoneVerifiedAt:null,
			verifiedChannel:null,
		});

		await expect(establishRegistrationSession(NextResponse.json({verified:true}),'person@example.invalid'))
			.rejects.toThrow('REGISTRATION_SESSION_NOT_AUTHORIZED');
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.encode).not.toHaveBeenCalled();
	});
});
