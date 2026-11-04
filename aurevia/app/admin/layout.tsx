import type {ReactNode} from 'react';

export const viewport={width:1280,initialScale:1};

export default function AdminLayout({children}:{children:ReactNode}){
	return <div className="admin-scope">{children}</div>;
}
