type Bucket={count:number;reset:number};

const buckets=new Map<string,Bucket>();

export class RateLimitError extends Error{
	readonly retryAfterSeconds:number;

	constructor(retryAfterSeconds:number){
		super('RATE_LIMITED');
		this.name='RateLimitError';
		this.retryAfterSeconds=retryAfterSeconds;
	}
}

export function rateLimit(key:string,max=30,windowMs=60_000){
	const now=Date.now();
	let bucket=buckets.get(key);
	if(!bucket||now>=bucket.reset){
		bucket={count:0,reset:now+windowMs};
		buckets.set(key,bucket);
	}
	bucket.count++;
	if(bucket.count>max)throw new RateLimitError(Math.max(1,Math.ceil((bucket.reset-now)/1000)));
}

export function clearRateLimit(key:string){
	buckets.delete(key);
}
