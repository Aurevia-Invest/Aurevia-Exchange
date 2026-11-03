import Image from 'next/image';

type AureviaLoadingProps={
	variant?:'screen'|'inline';
	label?:string;
	detail?:string;
	className?:string;
};

export default function AureviaLoading({
	variant='screen',
	label='Loading Aurevia Exchange',
	detail='Preparing your workspace',
	className='',
}:AureviaLoadingProps){
	return <div
		className={`aurevia-loading aurevia-loading-${variant} ${className}`.trim()}
		role="status"
		aria-live="polite"
		aria-atomic="true"
		aria-label={label}
	>
		<div className="aurevia-loading-emblem" aria-hidden="true">
			<span className="aurevia-loading-orbit aurevia-loading-orbit-one"/>
			<span className="aurevia-loading-orbit aurevia-loading-orbit-two"/>
			<span className="aurevia-loading-orbit aurevia-loading-orbit-three"/>
			<span className="aurevia-loading-particle aurevia-loading-particle-one"/>
			<span className="aurevia-loading-particle aurevia-loading-particle-two"/>
			<span className="aurevia-loading-particle aurevia-loading-particle-three"/>
			<Image src="/aurevia-logo.png" alt="" width={96} height={96} priority={variant==='screen'}/>
		</div>
		<div className="aurevia-loading-copy">
			<p className="aurevia-loading-wordmark">AUREVIA <span>EXCHANGE</span></p>
			<p className="aurevia-loading-label">{label}</p>
			{variant==='screen'&&<p className="aurevia-loading-detail">{detail}</p>}
			{variant==='screen'&&<div className="aurevia-loading-track" aria-hidden="true"><span/></div>}
		</div>
	</div>;
}
