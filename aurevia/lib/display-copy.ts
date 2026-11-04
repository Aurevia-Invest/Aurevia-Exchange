export function removeSimulatedLabels(value:string){
	if(/\bREAL\b/i.test(value))return value;
	return value
		.replace(/(^|[^a-z])simulating(?=$|[^a-z])/gi,'$1running in DEMO mode')
		.replace(/(^|[^a-z])simulations(?=$|[^a-z])/gi,'$1practice sessions')
		.replace(/(^|[^a-z])simulation(?=$|[^a-z])/gi,'$1practice')
		.replace(/(^|[^a-z])simulated(?=$|[^a-z])/gi,'$1DEMO');
}
