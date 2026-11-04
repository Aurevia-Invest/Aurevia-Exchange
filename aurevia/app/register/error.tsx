'use client';

import {useEffect} from 'react';
import Link from 'next/link';

export default function RegisterError({error}:{error:Error&{digest?:string}}){
	useEffect(()=>{
		console.error('[register] Registration page rendering failed.',{
			errorName:error.name,
			...(error.digest?{digest:error.digest}:{}),
		});
	},[error]);

	return <main className="flex min-h-screen items-center justify-center bg-black px-6">
		<section className="card max-w-md p-7 text-center" aria-labelledby="register-error-title">
			<div className="gold text-sm font-bold tracking-[.25em]">AUREVIA EXCHANGE</div>
			<h1 id="register-error-title" className="mt-3 text-2xl font-black">Registration page unavailable</h1>
			<p className="mt-2 muted">The registration page could not load. If this happened after you submitted the form, try signing in before submitting again.</p>
			<div className="mt-6 flex flex-wrap justify-center gap-3">
				<button onClick={()=>window.location.reload()} className="btn bg-gold px-5 text-black">Reload</button>
				<Link href="/login" className="btn border border-white/20 px-5">Sign in</Link>
			</div>
		</section>
	</main>;
}
