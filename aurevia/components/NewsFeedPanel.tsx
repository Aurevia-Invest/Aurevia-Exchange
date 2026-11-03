'use client';

import {useCallback,useEffect,useState} from 'react';
import {ExternalLink,LoaderCircle,Newspaper,RefreshCw,Sparkles} from 'lucide-react';

type FeedItem={
	id:string;
	title:string;
	summary:string|null;
	canonicalUrl:string;
	publisher:string;
	category:string;
	publishedAt:string|null;
	thumbnailUrl:string|null;
	contentType:string;
	mediaSource:{kind:'video'|'embed';url:string}|null;
	source:{key:string;displayName:string;providerType:string};
};

type FeedResponse={
	items:FeedItem[];
	page:number;
	pageSize:number;
	total:number;
	hasMore:boolean;
	stale:boolean;
	lastSuccessAt:string|null;
	sources:Array<{key:string;displayName:string;category:string}>;
	error?:string;
};
type NewsAnalysis={
	overallSentiment:'positive'|'neutral'|'negative'|'mixed';
	summary:string;
	articles:Array<{id:string;sentiment:'positive'|'neutral'|'negative'|'mixed';observation:string}>;
	caveat:string;
};
type NewsArticleSource={id:string;title:string;canonicalUrl:string;publisher:string;publishedAt:string|null};

function formatWhen(value:string|null){
	if(!value)return '';
	try{
		return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
	}catch{return ''}
}

export default function NewsFeedPanel({compact=false}:{compact?:boolean}){
	const [data,setData]=useState<FeedResponse|null>(null);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [category,setCategory]=useState('');
	const [page,setPage]=useState(1);
	const [analysis,setAnalysis]=useState<NewsAnalysis|null>(null);
	const [analysisSources,setAnalysisSources]=useState<NewsArticleSource[]>([]);
	const [analysisIsStale,setAnalysisIsStale]=useState(false);
	const [analysisError,setAnalysisError]=useState('');
	const [analysisBusy,setAnalysisBusy]=useState(false);

	const load=useCallback(async(nextPage=1,append=false)=>{
		setLoading(true);
		if(!append)setError('');
		try{
			const params=new URLSearchParams({page:String(nextPage),pageSize:compact?'6':'12'});
			if(category)params.set('category',category);
			const response=await fetch(`/api/news-feed?${params}`,{cache:'no-store'});
			const result=await response.json() as FeedResponse;
			if(!response.ok)throw new Error(result.error||'Unable to load news feed.');
			setData(current=>{
				if(append&&current){
					return {...result,items:[...current.items,...result.items]};
				}
				return result;
			});
			setPage(nextPage);
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load news feed.');
		}finally{
			setLoading(false);
		}
	},[category,compact]);

	async function analyzeNews(){
		setAnalysisBusy(true);setAnalysisError('');setAnalysis(null);setAnalysisSources([]);setAnalysisIsStale(false);
		try{
			const response=await fetch('/api/news-feed/analysis',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'News analysis is unavailable.');
			setAnalysis(result.analysis as NewsAnalysis);
			setAnalysisSources(Array.isArray(result.articleSources)?result.articleSources as NewsArticleSource[]:[]);
			setAnalysisIsStale(result.sourceDataStale===true);
		}catch(exception){
			setAnalysisError(exception instanceof Error?exception.message:'News analysis is unavailable.');
		}finally{setAnalysisBusy(false)}
	}

	useEffect(()=>{void load(1,false)},[load]);

	useEffect(()=>{
		const timer=window.setInterval(()=>void load(1,false),60_000);
		return ()=>window.clearInterval(timer);
	},[load]);

	return (
		<section className={`news-feed-panel ${compact?'is-compact':''}`} aria-label="External news and updates">
			<header className="news-feed-header">
				<div>
					<p className="eyebrow">NEWS & UPDATES</p>
					<h2 className="news-feed-title"><Newspaper size={20} aria-hidden="true"/> News & updates</h2>
				</div>
				<div className="news-feed-tools">
					{!compact&&<button type="button" className="btn bg-white/5" onClick={()=>void analyzeNews()} disabled={analysisBusy}><Sparkles size={14}/>{analysisBusy?'Analyzing…':'Analyze sentiment'}</button>}
					<label className="sr-only" htmlFor="news-category">Category</label>
					<select id="news-category" className="input news-feed-select" value={category} onChange={event=>{setCategory(event.target.value);}}>
						<option value="">All categories</option>
						<option value="ECONOMIC_NEWS">Economic news</option>
						<option value="MARKET_NEWS">Market news</option>
						<option value="GENERAL">General</option>
						<option value="VIDEO">Video</option>
					</select>
					<button type="button" className="btn bg-white/5" onClick={()=>void load(1,false)} disabled={loading} aria-label="Refresh news">
						{loading?<LoaderCircle size={14} className="animate-spin"/>:<RefreshCw size={14}/>}
					</button>
				</div>
			</header>

			{analysisError&&<p className="news-feed-state is-error" role="alert">{analysisError}</p>}
			{analysis&&<section className="account-callout mb-4" aria-label="AI news sentiment analysis" aria-live="polite">
				<strong>Generated news sentiment · {analysis.overallSentiment}</strong>
				<p>{analysis.summary}</p>
				{analysis.articles.length>0&&<ul>{analysis.articles.map(article=>{
					const source=analysisSources.find(item=>item.id===article.id);
					return <li key={article.id}>{source?<a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer">{source.publisher}: {source.title}</a>:null} · {article.sentiment}: {article.observation}</li>;
				})}</ul>}
				<p>{analysis.caveat} Sentiment is article framing, not a market signal or recommendation.</p>
				{analysisIsStale&&<p role="status">One or more analyzed news sources may be stale; check the original publisher links.</p>}
			</section>}

			{data?.stale&&<p className="news-feed-banner" role="status">Source data may be outdated. Last successful sync: {formatWhen(data.lastSuccessAt)||'unknown'}.</p>}
			{loading&&!data&&<p className="news-feed-state" role="status">Loading external headlines…</p>}
			{error&&<p className="news-feed-state is-error" role="alert">{error} <button type="button" className="text-link" onClick={()=>void load(1,false)}>Retry</button></p>}
			{!loading&&!error&&data&&data.items.length===0&&(
				<p className="news-feed-state" role="status">No external articles are available yet. Sources sync on a schedule after configuration.</p>
			)}

			{data&&data.items.length>0&&(
				<ul className="news-feed-list">
					{data.items.map(item=>(
						<li key={item.id} className="news-feed-item card">
							<div className="news-feed-item-body">
								<div className="news-feed-meta">
									<span className="news-feed-source">{item.source.displayName}</span>
									{item.publishedAt&&<time dateTime={item.publishedAt}>{formatWhen(item.publishedAt)}</time>}
								</div>
								<a className="news-feed-item-title" href={item.canonicalUrl} target="_blank" rel="noopener noreferrer">
									{item.title} <ExternalLink size={14} aria-hidden="true"/>
								</a>
								{item.mediaSource?.kind==='video'&&<video className="mt-3 aspect-video w-full rounded-md bg-black" controls playsInline preload="metadata"><source src={item.mediaSource.url}/></video>}
								{item.mediaSource?.kind==='embed'&&<div className="mt-3 aspect-video overflow-hidden rounded-md bg-black"><iframe className="h-full w-full" src={item.mediaSource.url} title={item.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"/></div>}
								{item.summary&&<p className="news-feed-summary">{item.summary}</p>}
								<span className="news-feed-publisher muted text-xs">{item.publisher} · {item.category.replaceAll('_',' ').toLowerCase()}</span>
							</div>
						</li>
					))}
				</ul>
			)}

			{data?.hasMore&&(
				<div className="news-feed-more">
					<button type="button" className="btn bg-white/10" disabled={loading} onClick={()=>void load(page+1,true)}>
						{loading?'Loading…':'Load more'}
					</button>
				</div>
			)}
		</section>
	);
}
