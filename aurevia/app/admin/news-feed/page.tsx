import {redirect} from 'next/navigation';
import AdminNav from '@/components/AdminNav';
import AdminEditorialNewsPanel from '@/components/AdminEditorialNewsPanel';
import {requireAdmin} from '@/lib/auth';

export default async function AdminNewsFeedPage(){
	try{await requireAdmin()}catch{redirect('/admin/login')}
	return <><AdminNav/><main className="account-page"><AdminEditorialNewsPanel/></main></>;
}
