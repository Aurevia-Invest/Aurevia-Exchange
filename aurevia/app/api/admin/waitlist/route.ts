import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {emailDeliveryStatus,isEmailConfigured,sendEmail} from '@/lib/email';
import {waitlistStatusSchema} from '@/lib/waitlist';

export const dynamic='force-dynamic';

export async function GET(){
  try{
    await requireAdmin();
    const entries=await db.waitlistEntry.findMany({where:{deletedAt:null},include:{user:{select:{id:true,email:true,name:true}}},orderBy:{createdAt:'desc'},take:1000});
    return NextResponse.json(jsonSafe(entries),{headers:{'Cache-Control':'private, no-store'}});
  }catch{return NextResponse.json({error:'Forbidden'},{status:403})}
}

export async function PATCH(request:Request){
  try{
    const admin=await requireAdmin();
    const input=waitlistStatusSchema.parse(await request.json());
    const current=await db.waitlistEntry.findFirst({where:{id:input.id,deletedAt:null}});
    if(!current)return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    const updated=await db.$transaction(async tx=>{
      const entry=await tx.waitlistEntry.update({where:{id:input.id},data:{status:input.status,notes:input.notes??null,updatedAt:new Date()}});
      await tx.auditLog.create({data:{actorId:admin.id,action:`WAITLIST_STATUS_${input.status}`,entity:'WAITLIST_ENTRY',entityId:input.id,metadata:{status:input.status,notes:input.notes||null}}});
      return entry;
    });
    let delivery:'sent'|'failed'|'not-configured'='not-configured';
    if(input.status==='INVITED'&&current.email){
      if(isEmailConfigured()){
        const result=await sendEmail({
          to:current.email,
          subject:'Aurevia waitlist invitation',
          text:'Your Aurevia waitlist status was updated to INVITED. This message confirms the administrative status update and does not grant account access, trading privileges, KYC approval, or broker authorization.',
        });
        delivery=emailDeliveryStatus(result);
        if(!result.sent)console.warn('Waitlist status changed but invitation email delivery failed.',{reason:result.reason||'failed',provider:result.provider||'none'});
      }
    }
    return NextResponse.json({entry:jsonSafe(updated),delivery});
  }catch(error){
    if(error instanceof ZodError)return NextResponse.json({error:'Invalid waitlist update.'},{status:400});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    return NextResponse.json({error:'Unable to update the waitlist entry.'},{status:400});
  }
}

export async function DELETE(request:Request){
  try{
    const admin=await requireAdmin();
    const input=z.object({id:z.string().min(1)}).parse(await request.json());
    const entry=await db.waitlistEntry.findFirst({where:{id:input.id,deletedAt:null}});
    if(!entry)return NextResponse.json({error:'Waitlist entry not found.'},{status:404});
    await db.$transaction(async tx=>{
      const removed=await tx.waitlistEntry.updateMany({where:{id:input.id,deletedAt:null},data:{deletedAt:new Date(),deletedById:admin.id}});
      if(removed.count!==1)throw new Error('WAITLIST_ENTRY_CHANGED');
      await tx.auditLog.create({data:{actorId:admin.id,action:'WAITLIST_ENTRY_SOFT_DELETED',entity:'WAITLIST_ENTRY',entityId:input.id,metadata:{email:entry.email,originalLocation:'/admin/waitlist'}}});
    });
    return NextResponse.json({removed:true,restorable:true});
  }catch(error){
    if(error instanceof ZodError)return NextResponse.json({error:'Waitlist entry ID is required.'},{status:400});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    if(error instanceof Error&&error.message==='WAITLIST_ENTRY_CHANGED')return NextResponse.json({error:'Waitlist entry was changed by another administrator.'},{status:409});
    return NextResponse.json({error:'Unable to remove the waitlist entry.'},{status:400});
  }
}
