'use client';

import {type ChangeEvent,type FormEvent,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Archive,ExternalLink,Eye,ImagePlus,Plus,RefreshCw,Save,Trash2,Video,X} from 'lucide-react';
import {StoriesViewer,type StoryFeedItem} from '@/components/StoriesExperience';

type Category={id:string;name:string;slug:string;displayOrder:number};
type StoryMedia=StoryFeedItem['media'][number]&{sizeBytes:number};
type ManagedStory=Omit<StoryFeedItem,'media'>&{
	status:'DRAFT'|'SCHEDULED'|'PUBLISHED'|'ARCHIVED';
	visibility:'PUBLIC'|'REGISTERED_USERS';
	publishAt:string|null;
	expiresAt:string|null;
	displayOrder:number;
	createdAt:string;
	createdBy:{id:string;name:string|null;email:string}|null;
	engagement:{views:number;linkClicks:number};
	auditHistory:{id:string;action:string;createdAt:string;actor:{name:string|null;email:string}|null}[];
	media:StoryMedia[];
};
type Draft={title:string;description:string;categoryId:string;externalUrl:string;visibility:'PUBLIC'|'REGISTERED_USERS';publishAt:string;expiresAt:string;displayOrder:number;status:ManagedStory['status']};
const emptyDraft:Draft={title:'',description:'',categoryId:'',externalUrl:'',visibility:'PUBLIC',publishAt:'',expiresAt:'',displayOrder:0,status:'DRAFT'};

function localDate(value:string|null|undefined){
	if(!value)return '';
	const date=new Date(value);
	date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
	return date.toISOString().slice(0,16);
}

function publicStatus(story:ManagedStory){
	if(story.status==='PUBLISHED'&&story.expiresAt&&new Date(story.expiresAt)<=new Date())return 'EXPIRED';
	if(story.status==='SCHEDULED'&&story.publishAt&&new Date(story.publishAt)<=new Date()){
		if(story.expiresAt&&new Date(story.expiresAt)<=new Date())return 'EXPIRED';
		return 'PUBLISHED';
	}
	return story.status;
}

export default function AdminStoriesPanel(){
	const [stories,setStories]=useState<ManagedStory[]>([]);
	const [categories,setCategories]=useState<Category[]>([]);
	const [draft,setDraft]=useState<Draft>(emptyDraft);
	const [files,setFiles]=useState<File[]>([]);
	const [editingId,setEditingId]=useState('');
	const [categoryName,setCategoryName]=useState('');
	const [query,setQuery]=useState('');
	const [statusFilter,setStatusFilter]=useState('ALL');
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [preview,setPreview]=useState<StoryFeedItem|null>(null);
	const previewUrls=useRef<string[]>([]);

	const load=useCallback(async(showLoading=false)=>{
		if(showLoading)setLoading(true);
		try{
			const [storyResponse,categoryResponse]=await Promise.all([fetch('/api/admin/stories',{cache:'no-store'}),fetch('/api/admin/stories/categories',{cache:'no-store'})]);
			const [storyResult,categoryResult]=await Promise.all([storyResponse.json(),categoryResponse.json()]);
			if(!storyResponse.ok)throw new Error(storyResult.error||'Unable to load stories.');
			if(!categoryResponse.ok)throw new Error(categoryResult.error||'Unable to load story categories.');
			setStories(Array.isArray(storyResult.stories)?storyResult.stories:[]);
			setCategories(Array.isArray(categoryResult)?categoryResult:[]);
			setDraft(current=>({...current,categoryId:current.categoryId||categoryResult[0]?.id||''}));
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load stories.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{void load(true)},[load]);
	useEffect(()=>()=>{previewUrls.current.forEach(url=>URL.revokeObjectURL(url))},[]);

	const totals=useMemo(()=>stories.reduce((total,story)=>({views:total.views+story.engagement.views,clicks:total.clicks+story.engagement.linkClicks}),{views:0,clicks:0}),[stories]);
	const filteredStories=useMemo(()=>stories.filter(story=>{
		const matchesQuery=`${story.title} ${story.description} ${story.category.name}`.toLowerCase().includes(query.trim().toLowerCase());
		return matchesQuery&&(statusFilter==='ALL'||publicStatus(story)===statusFilter);
	}),[query,statusFilter,stories]);

	function startEdit(story:ManagedStory){
		setEditingId(story.id);
		setDraft({title:story.title,description:story.description,categoryId:story.category.id,externalUrl:story.externalUrl||'',visibility:story.visibility,publishAt:localDate(story.publishAt),expiresAt:localDate(story.expiresAt),displayOrder:story.displayOrder,status:story.status});
		setFiles([]);
		setNotice('');
		window.scrollTo({top:0,behavior:'smooth'});
	}

	function resetForm(){
		setEditingId('');
		setDraft({...emptyDraft,categoryId:categories[0]?.id||''});
		setFiles([]);
	}

	function chooseFiles(event:ChangeEvent<HTMLInputElement>){
		const selected=Array.from(event.currentTarget.files||[]);
		setFiles(current=>[...current,...selected].slice(0,8));
		event.currentTarget.value='';
	}

	function openPreview(){
		const category=categories.find(item=>item.id===draft.categoryId);
		if(!category){setError('Select a category before previewing.');return}
		previewUrls.current.forEach(url=>URL.revokeObjectURL(url));
		previewUrls.current=files.map(file=>URL.createObjectURL(file));
		const existing=stories.find(item=>item.id===editingId)?.media||[];
		const added=files.map((file,index)=>({id:`preview-${index}`,type:file.type.startsWith('video/')?'VIDEO' as const:'IMAGE' as const,mimeType:file.type,altText:null,displayOrder:existing.length+index,url:previewUrls.current[index]}));
		setPreview({
			id:editingId||'preview',
			title:draft.title||'Story title preview',
			description:draft.description||'Story description preview.',
			category,
			externalUrl:draft.externalUrl||null,
			publishedAt:null,
			media:[...existing,...added],
		});
	}

	async function uploadMedia(storyId:string){
		for(const file of [...files]){
			const form=new FormData();
			form.set('file',file);
			const response=await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}/media`,{method:'POST',body:form});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||`Unable to upload ${file.name}.`);
			setFiles(current=>current.filter(item=>item!==file));
		}
	}

	async function save(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		setBusy('save');setError('');setNotice('');
		const categoryId=draft.categoryId||categories[0]?.id||'';
		const publishAt=draft.publishAt?new Date(draft.publishAt).toISOString():null;
		const expiresAt=draft.expiresAt?new Date(draft.expiresAt).toISOString():null;
		const common={title:draft.title,description:draft.description,categoryId,externalUrl:draft.externalUrl.trim()||null,visibility:draft.visibility,publishAt,expiresAt,displayOrder:draft.displayOrder};
		try{
			let storyId=editingId;
			if(!editingId){
				const response=await fetch('/api/admin/stories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...common,status:'DRAFT'})});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Unable to create the story.');
				storyId=result.id;
				if(!storyId)throw new Error('The saved story response was incomplete.');
				setEditingId(storyId);
				await load();
			}else{
				const current=stories.find(item=>item.id===editingId);
				if(!current)throw new Error('This story is no longer available. Reload the page.');
				const response=await fetch('/api/admin/stories',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({storyId:editingId,action:'save',...common,status:current.status,publishAt:current.publishAt})});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Unable to update the story.');
			}
			if(files.length)await uploadMedia(storyId);
			if(draft.status!=='DRAFT'){
				const statusPayload=draft.status==='PUBLISHED'?{action:'publish'}:{action:'save',status:draft.status,publishAt};
				const response=await fetch('/api/admin/stories',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({storyId,...statusPayload,expiresAt})});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'The story was saved, but its publication status could not be changed.');
			}else if(editingId){
				const response=await fetch('/api/admin/stories',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({storyId,action:'save',status:'DRAFT',publishAt:null,expiresAt})});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'The story was saved, but its draft status could not be changed.');
			}
			setNotice(draft.status==='PUBLISHED'?'Story published.':draft.status==='SCHEDULED'?'Story scheduled.':editingId?'Story updated.':'Draft saved.');
			resetForm();
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save story.')}
		finally{setBusy('')}
	}

	async function addCategory(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		setBusy('category');setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/stories/categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:categoryName})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to create category.');
			setCategoryName('');
			if(!draft.categoryId)setDraft(current=>({...current,categoryId:result.id}));
			setNotice('Story category created.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to create category.')}
		finally{setBusy('')}
	}

	async function transition(story:ManagedStory,action:'publish'|'archive'){
		if(busy)return;
		setBusy(`${story.id}:${action}`);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/stories',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({storyId:story.id,action})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update story status.');
			setNotice(action==='publish'?'Story published.':'Story archived.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update story status.')}
		finally{setBusy('')}
	}

	async function remove(story:ManagedStory){
		if(!window.confirm(`Move “${story.title}” to Deleted Items? It will disappear from public stories immediately.`))return;
		if(busy)return;
		setBusy(`${story.id}:delete`);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/stories',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({storyId:story.id})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to delete story.');
			setNotice('Story moved to Deleted Items.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to delete story.')}
		finally{setBusy('')}
	}

	async function removeMedia(story:ManagedStory,mediaId:string){
		if(busy)return;
		setBusy(`${story.id}:${mediaId}`);setError('');setNotice('');
		try{
			const response=await fetch(`/api/admin/stories/${encodeURIComponent(story.id)}/media/${encodeURIComponent(mediaId)}`,{method:'DELETE'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to remove media.');
			setNotice('Story media removed.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to remove story media.')}
		finally{setBusy('')}
	}

	function closePreview(){
		setPreview(null);
		previewUrls.current.forEach(url=>URL.revokeObjectURL(url));
		previewUrls.current=[];
	}
	const selectedStory=stories.find(story=>story.id===editingId);

	return <div className="admin-stories-workspace">
		<header className="admin-stories-heading"><div><span className="account-kicker">WORKSPACE · PUBLIC CONTENT</span><h1>Stories management</h1><p>Create public updates and manage story scheduling, media, visibility, and engagement.</p></div><button type="button" className="icon-action" aria-label="Refresh stories" onClick={()=>void load(true)}><RefreshCw size={15}/></button></header>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}{notice&&<p className="admin-stories-notice" role="status">{notice}</p>}
		<section className="admin-stories-stats" aria-label="Story engagement summary"><article><small>Active stories</small><b>{stories.filter(story=>['PUBLISHED','SCHEDULED'].includes(publicStatus(story))).length}</b></article><article><small>Total views</small><b>{totals.views.toLocaleString()}</b></article><article><small>External link clicks</small><b>{totals.clicks.toLocaleString()}</b></article><article><small>Categories</small><b>{categories.length}</b></article></section>
		<div className="admin-stories-layout">
			<section className="account-panel admin-story-editor">
				<div className="account-panel-title"><div><h2>{editingId?'Edit story':'Create a story'}</h2><p className="account-panel-subtitle">Drafts stay private. Scheduled and published stories follow their dates and visibility.</p></div></div>
				<form className="admin-story-form" onSubmit={event=>void save(event)}>
					<label className="account-label">Title<input className="input" required minLength={2} maxLength={120} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
					<label className="account-label">Category<select className="input" required value={draft.categoryId} onChange={event=>setDraft({...draft,categoryId:event.target.value})}><option value="">Choose category</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
					<label className="account-label admin-story-description">Description<textarea className="input min-h-24" required maxLength={3000} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
					<label className="account-label">Publication status<select className="input" value={draft.status} onChange={event=>setDraft({...draft,status:event.target.value as Draft['status']})}><option value="DRAFT">Save as draft</option><option value="SCHEDULED">Schedule</option><option value="PUBLISHED">Publish now</option><option value="ARCHIVED">Archive</option></select></label>
					<label className="account-label">Visibility<select className="input" value={draft.visibility} onChange={event=>setDraft({...draft,visibility:event.target.value as Draft['visibility']})}><option value="PUBLIC">Public visitors and members</option><option value="REGISTERED_USERS">Signed-in members only</option></select></label>
					<label className="account-label">Publish date and time<input className="input" type="datetime-local" value={draft.publishAt} onChange={event=>setDraft({...draft,publishAt:event.target.value})} required={draft.status==='SCHEDULED'} disabled={draft.status==='PUBLISHED'}/></label>
					<label className="account-label">Expiration (optional)<input className="input" type="datetime-local" value={draft.expiresAt} onChange={event=>setDraft({...draft,expiresAt:event.target.value})}/></label>
					<label className="account-label">Display order<input className="input" type="number" min={0} max={10000} value={draft.displayOrder} onChange={event=>setDraft({...draft,displayOrder:Number(event.target.value)})}/></label>
					<label className="account-label admin-story-description">External HTTPS link (optional)<input className="input" type="url" inputMode="url" placeholder="https://…" value={draft.externalUrl} onChange={event=>setDraft({...draft,externalUrl:event.target.value})}/></label>
					<div className="admin-story-upload admin-story-description"><label className="account-label">Images and videos<input className="input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple onChange={chooseFiles}/></label><small>JPEG, PNG, WebP up to 5 MB; MP4 or WebM up to 50 MB. Up to 8 new files per save.</small>
						{files.length>0&&<ul className="admin-story-file-list">{files.map((file,index)=><li key={`${file.name}:${index}`}><span>{file.type.startsWith('video/')?<Video size={15}/>:<ImagePlus size={15}/>} {file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={()=>setFiles(current=>current.filter((_,fileIndex)=>fileIndex!==index))}><X size={15}/></button></li>)}</ul>}
						{selectedStory?.media.map(media=><div className="admin-story-file-list" key={media.id}><span>{media.type==='VIDEO'?<Video size={15}/>:<ImagePlus size={15}/>} Stored {media.type.toLowerCase()} · {(media.sizeBytes/1024/1024).toFixed(1)} MB</span><button type="button" onClick={()=>void removeMedia(selectedStory,media.id)} aria-label="Remove stored story media"><Trash2 size={14}/></button></div>)}
					</div>
					<div className="admin-story-form-actions admin-story-description"><button type="button" className="admin-story-secondary" onClick={openPreview}><Eye size={15}/> Preview</button><button type="submit" className="admin-story-primary" disabled={Boolean(busy)}><Save size={15}/>{busy==='save'?'Saving…':editingId?'Save changes':'Save story'}</button>{editingId&&<button type="button" className="admin-story-secondary" onClick={resetForm}>Cancel</button>}</div>
				</form>
			</section>
			<section className="account-panel admin-story-categories">
				<div className="account-panel-title"><div><h2>Categories</h2><p className="account-panel-subtitle">Add categories to organize published stories.</p></div></div>
				<form className="admin-category-form" onSubmit={event=>void addCategory(event)}><label className="account-label">New category<input className="input" required minLength={2} maxLength={80} value={categoryName} onChange={event=>setCategoryName(event.target.value)}/></label><button className="admin-story-primary" disabled={busy==='category'}><Plus size={15}/>{busy==='category'?'Adding…':'Add category'}</button></form>
				<div className="admin-category-list">{categories.map(category=><span key={category.id}>{category.name}<small>Order {category.displayOrder}</small></span>)}</div>
			</section>
		</div>
		<section className="admin-story-list">
			<header className="admin-story-list-heading"><div><h2>Story library</h2><p>Publication history and privacy-deduplicated views.</p></div><div className="admin-story-filters"><input className="input" aria-label="Search stories" placeholder="Search stories" value={query} onChange={event=>setQuery(event.target.value)}/><select className="input" aria-label="Filter stories by status" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="SCHEDULED">Scheduled</option><option value="PUBLISHED">Published</option><option value="EXPIRED">Expired</option><option value="ARCHIVED">Archived</option></select></div></header>
			{loading&&!stories.length?<p className="account-empty" role="status">Loading stories…</p>:filteredStories.length?filteredStories.map(story=><article className="admin-story-row" key={story.id}>
				<div className="admin-story-row-main"><span className={`admin-story-status status-${publicStatus(story).toLowerCase()}`}>{publicStatus(story)}</span><h3>{story.title}</h3><p>{story.description}</p><small>{story.category.name} · {story.visibility==='PUBLIC'?'Public':'Members only'} · {story.createdBy?.name||story.createdBy?.email||'Former administrator'}</small><small>Created: {new Date(story.createdAt).toLocaleString()}</small>{publicStatus(story)==='PUBLISHED'&&<small>Published: {new Date(story.publishedAt||story.publishAt||story.createdAt).toLocaleString()}</small>}{publicStatus(story)==='SCHEDULED'&&story.publishAt&&<small>Scheduled: {new Date(story.publishAt).toLocaleString()}</small>}{story.expiresAt&&<small>Expires: {new Date(story.expiresAt).toLocaleString()}</small>}<details className="admin-story-history"><summary>Audit history ({story.auditHistory.length})</summary>{story.auditHistory.length?<ul>{story.auditHistory.map(event=><li key={event.id}><b>{event.action}</b><span>{new Date(event.createdAt).toLocaleString()} · {event.actor?.name||event.actor?.email||'System'}</span></li>)}</ul>:<p>No audit events recorded.</p>}</details></div>
				<div className="admin-story-row-stats"><span><Eye size={14}/>{story.engagement.views} views</span><span><ExternalLink size={14}/>{story.engagement.linkClicks} clicks</span><span>{story.media.length} media</span></div>
				<div className="admin-story-row-actions"><button type="button" onClick={()=>setPreview(story)} aria-label={`Preview ${story.title}`}><Eye size={15}/></button><button type="button" onClick={()=>startEdit(story)} aria-label={`Edit ${story.title}`}>Edit</button>{!['PUBLISHED','ARCHIVED'].includes(story.status)&&<button type="button" onClick={()=>void transition(story,'publish')} disabled={Boolean(busy)} aria-label={`Publish ${story.title}`}>Publish</button>}{story.status!=='ARCHIVED'&&<button type="button" onClick={()=>void transition(story,'archive')} disabled={Boolean(busy)} aria-label={`Archive ${story.title}`}><Archive size={15}/></button>}<button type="button" onClick={()=>void remove(story)} disabled={Boolean(busy)} aria-label={`Delete ${story.title}`}><Trash2 size={15}/></button></div>
			</article>):<p className="account-empty">{loading?'Loading stories…':'No stories match this filter.'}</p>}
		</section>
		{preview&&<StoriesViewer stories={[preview]} onClose={closePreview} trackEngagement={false}/>}
	</div>;
}
