import {getServerSession} from 'next-auth';
import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin,requireUser} from '@/lib/auth';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {preferenceFromTheme,themeFromPreference} from '@/lib/theme';

const themeSchema=z.object({theme:z.enum(['forest-green','premium-dashboard'])}).strict();

async function getAccount(){
	const session=await getServerSession(authOptions);
	if(!session?.user?.id)return {user:null,response:NextResponse.json({error:'Unauthorized'},{status:401})};
	if(session.user.role==='ADMIN')return {user:await requireAdmin(),response:null};
	if(session.user.role==='USER')return {user:await requireUser(),response:null};
	return {user:null,response:NextResponse.json({error:'Forbidden'},{status:403})};
}

function isAuthError(error:unknown){
	return error instanceof Error&&(error.message==='UNAUTHORIZED'||error.message==='FORBIDDEN');
}

function authErrorResponse(error:unknown){
	return NextResponse.json({error:error instanceof Error&&error.message==='FORBIDDEN'?'Forbidden':'Unauthorized'},{status:error instanceof Error&&error.message==='FORBIDDEN'?403:401});
}

function logFailure(operation:string,error:unknown){
	console.error(`Theme preference ${operation} failed (${error instanceof Error?error.name:'UnknownError'}).`);
}

function unavailableResponse(error:unknown,operation:'read'|'save'){
	if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2022'){
		console.error(`Theme preference ${operation} failed (account theme migration is not applied).`);
		return NextResponse.json({
			code:'THEME_MIGRATION_REQUIRED',
			error:'Account theme saving is not enabled yet. The account-theme database migration must be applied first.',
		},{status:503});
	}
	logFailure(operation,error);
	return NextResponse.json({error:operation==='read'?'Theme preference is unavailable.':'Unable to save the theme preference.'},{status:503});
}

export async function GET(){
	try{
		const {user,response}=await getAccount();
		if(response)return response;
		if(!user)return NextResponse.json({error:'Unauthorized'},{status:401});
		const preference=await db.user.findUnique({where:{id:user.id},select:{preferredTheme:true}});
		if(!preference)return NextResponse.json({error:'Account preference is unavailable.'},{status:404});
		return NextResponse.json({theme:themeFromPreference(preference.preferredTheme)},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(isAuthError(error))return authErrorResponse(error);
		return unavailableResponse(error,'read');
	}
}

export async function PATCH(request:Request){
	try{
		const {user,response}=await getAccount();
		if(response)return response;
		if(!user)return NextResponse.json({error:'Unauthorized'},{status:401});
		let body:unknown;
		try{
			body=await request.json();
		}catch{
			return NextResponse.json({error:'Provide a valid theme preference.'},{status:400});
		}
		const input=themeSchema.parse(body);
		const preferredTheme=preferenceFromTheme(input.theme);
		const result=await db.user.updateMany({
			where:{id:user.id,preferredTheme:{not:preferredTheme}},
			data:{preferredTheme},
		});
		if(result.count===0){
			const account=await db.user.findUnique({where:{id:user.id},select:{id:true}});
			if(!account)return NextResponse.json({error:'Account preference is unavailable.'},{status:404});
		}
		return NextResponse.json({theme:input.theme},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose Forest Green or Premium Dashboard.'},{status:400});
		if(isAuthError(error))return authErrorResponse(error);
		return unavailableResponse(error,'save');
	}
}
