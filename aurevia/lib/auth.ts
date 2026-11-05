import {getServerSession} from 'next-auth';
import {authOptions} from '@/lib/auth-options';

export async function requireUser(){
	const session=await getServerSession(authOptions);
	if(!session?.user?.id)throw new Error('UNAUTHORIZED');
	if(!/^[a-f0-9]{64}$/.test(session.user.sessionHash))throw new Error('UNAUTHORIZED');
	if(session.user.role!=='USER')throw new Error('FORBIDDEN');
	return session.user;
}

export async function requireAdmin(){
	const session=await getServerSession(authOptions);
	if(!session?.user?.id)throw new Error('UNAUTHORIZED');
	if(session.user.role!=='ADMIN')throw new Error('FORBIDDEN');
	return session.user;
}
