import Image from 'next/image';
import Link from 'next/link';
import Nav from '@/components/Nav';
import {getPublishedClientStories} from '@/lib/client-stories';
import {resolveClientStoryImage} from '@/lib/client-story-media';

export const dynamic='force-dynamic';

export default async function ClientStoriesPage(){
	const stories=await getPublishedClientStories();
	return <><Nav/><main className="account-page mx-auto max-w-6xl">
		<header className="account-heading"><div><span className="account-kicker">CLIENT STORIES</span><h1>Client stories</h1><p>Administrator-published testimonials and consented, verified client stories.</p></div></header>
		{stories.length?<div className="grid gap-4 md:grid-cols-2">{stories.map(story=>{
			const image=story.imageUrl||resolveClientStoryImage(story.imageReference);
			return <article key={story.id} className="card p-4 sm:p-5">{image&&<span className="client-story-avatar client-story-avatar-md mb-4"><Image src={image} alt={`Portrait for ${story.displayName}`} width={320} height={320} className="client-story-portrait"/></span>}{story.title&&<h3 className="mb-2 text-sm gold">{story.title}</h3>}{story.rating&&<p className="client-story-rating mb-2" aria-label={`Rated ${story.rating} out of 5`}>{'★'.repeat(story.rating)}<span className="sr-only">Rated {story.rating} out of 5</span></p>}<p className="whitespace-pre-line leading-7">{story.quote}</p><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"><div><h2 className="font-semibold">{story.displayName}</h2><p className="muted text-sm">{[story.cityOrRegion,story.country].filter(Boolean).join(', ')}</p></div><span className={`status-pill ${story.verifiedClientStory?'mode-demo':''}`}>{story.verifiedClientStory?'Verified client story':'Published testimonial'}</span></div>{story.withdrawalAmount&&<p className="mt-3 text-sm">Verified withdrawal · {Number(story.withdrawalAmount).toLocaleString()} {story.currency}</p>}</article>;
		})}</div>:<section className="account-panel card p-6"><h2 className="font-semibold">No stories approved for publication</h2><p className="mt-2 muted">Client stories are shown only after the required verification and consent checks.</p><Link className="mt-4 inline-flex min-h-11 items-center text-sm gold" href="/">Return to Aurevia Exchange</Link></section>}
	</main></>;
}