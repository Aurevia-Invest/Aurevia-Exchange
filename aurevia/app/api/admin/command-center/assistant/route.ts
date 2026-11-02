import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {runAiService} from '@/lib/ai-services';
import {rateLimit} from '@/lib/rate-limit';
import {getIntegrationInventory} from '@/lib/integration-manager';

const schema=z.object({question:z.string().trim().min(3).max(1000)});

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-api-assistant:${admin.id}`,10,60_000);
		const {question}=schema.parse(await request.json());
		const inventory=await getIntegrationInventory();
		const context=inventory.map(item=>({name:item.name,status:item.status,detail:item.detail,feature:item.feature,documentation:item.documentation}));
		const result=await runAiService('api_configuration_assistance',[
			{role:'system',content:'You are the Aurevia administrator API configuration assistant. Explain only the supplied integration status and the official documentation URLs supplied below. Provide exact environment variable names only when present in the context or in the known Aurevia configuration set: OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, AI_PROVIDER, AI_MODEL, AI_BACKUP_PROVIDERS, AI_FREE_MODEL_ALLOWLIST, GEMINI_FREE_MODEL, GROQ_FREE_MODEL, AI_SECRETS_ENCRYPTION_KEY, ALPACA_API_KEY, ALPACA_SECRET_KEY, FINNHUB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, RESEND_API_KEY, TERMII_API_KEY, TERMII_SENDER_ID, AKEDLY_API_KEY, AKEDLY_PIPELINE_ID, AKEDLY_WIDGET_ID, AKEDLY_PUBLIC_KEY, AKEDLY_WIDGET_SECRET, AKEDLY_WEBHOOK_SECRET, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SUBSCRIPTION_ENCRYPTION_KEY, GNEWS_API_KEY. Never ask the administrator to paste a secret into chat, never generate credentials, never claim a connection succeeded, and never describe generated text as verified provider information. Say credentials must be created with the official provider and added through Render environment settings or the encrypted approval workflow. Do not recommend disabling security, using paid models, or changing financial settings. Keep the answer concise and state that it is generated assistance.'},
			{role:'user',content:JSON.stringify({question,integrations:context})},
		],{actorId:admin.id,temperature:0.2,maxTokens:500});
		return NextResponse.json({answer:result.content,provider:result.provider,model:result.model,generatedAnalysis:true},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a question between 3 and 1,000 characters.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many configuration questions. Try again shortly.'},{status:429});
		console.error('Admin API configuration assistant failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Configuration assistance is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}