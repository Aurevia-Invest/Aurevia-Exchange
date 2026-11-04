import {redirect} from 'next/navigation';
import AdminNav from '@/components/AdminNav';
import AdminSessionsPanel from '@/components/AdminSessionsPanel';
import {requireAdmin} from '@/lib/auth';

export default async function AdminSessionsPage(){
	try{await requireAdmin()}catch{redirect('/admin/login')}
	return <><AdminNav/><main><AdminSessionsPanel/></main></>;
}
