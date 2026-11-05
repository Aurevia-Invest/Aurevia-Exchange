export type ChartTheme={
	label:string;
	grid:string;
	border:string;
	positive:string;
	negative:string;
	accent:string;
	positiveFill:string;
	negativeFill:string;
};

function cssColor(name:string,fallback:string){
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;
}

function withAlpha(color:string,alpha:number){
	const hex=color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
	if(hex){
		const normalized=hex.length===3?hex.split('').map(value=>value+value).join(''):hex;
		const channels=[0,2,4].map(index=>Number.parseInt(normalized.slice(index,index+2),16));
		return `rgba(${channels.join(',')},${alpha})`;
	}
	if(color.startsWith('rgb('))return color.replace(/^rgb\(/,'rgba(').replace(/\)$/ ,`,${alpha})`);
	return color;
}

export function readChartTheme():ChartTheme{
	const positive=cssColor('--theme-positive','#34D399');
	const negative=cssColor('--theme-negative','#F87171');
	return {
		label:cssColor('--theme-chart-label','#A1AFA4'),
		grid:cssColor('--theme-chart-grid','rgba(161,175,164,.12)'),
		border:cssColor('--theme-border','rgba(198,211,198,.16)'),
		positive,
		negative,
		accent:cssColor('--theme-accent','#C5A45F'),
		positiveFill:withAlpha(positive,.32),
		negativeFill:withAlpha(negative,.32),
	};
}
