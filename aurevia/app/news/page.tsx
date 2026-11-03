'use client';

import Nav from '@/components/Nav';
import NewsFeedPanel from '@/components/NewsFeedPanel';
import PublicResourceLinks from '@/components/PublicResourceLinks';

export default function NewsPage(){
	return <>
		<Nav/>
		<main className="account-page">
			<header className="account-heading">
				<div>
					<span className="account-kicker">UPDATES</span>
					<h1>News & updates</h1>
					<p>Headlines from configured publishers and links shared by Aurevia administrators.</p>
				</div>
			</header>
			<NewsFeedPanel/>
			<PublicResourceLinks placement="NEWS_UPDATES"/>
		</main>
	</>;
}
