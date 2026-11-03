export type SupportChatSide='left'|'right';
export type SupportChatPosition={left:number;top:number};
export type SupportChatViewport={width:number;height:number};

const edgeGap=12;
const launcherSize=56;
const panelWidth=360;
const panelHeight=560;

export function clampSupportChatPosition(
	position:SupportChatPosition,
	expanded:boolean,
	viewport:SupportChatViewport,
):SupportChatPosition{
	const width=expanded?Math.min(panelWidth,Math.max(0,viewport.width-2*edgeGap)):launcherSize;
	const height=expanded?Math.min(panelHeight,Math.max(0,viewport.height-2*edgeGap)):launcherSize;
	return {
		left:Math.max(edgeGap,Math.min(position.left,Math.max(edgeGap,viewport.width-width-edgeGap))),
		top:Math.max(edgeGap,Math.min(position.top,Math.max(edgeGap,viewport.height-height-edgeGap))),
	};
}

export function nearestSupportChatSide(
	left:number,
	expanded:boolean,
	viewport:SupportChatViewport,
):SupportChatSide{
	const position=clampSupportChatPosition({left,top:edgeGap},expanded,viewport);
	const width=expanded?Math.min(panelWidth,Math.max(0,viewport.width-2*edgeGap)):launcherSize;
	return position.left<=viewport.width-position.left-width?'left':'right';
}

export function dockSupportChatPosition(
	position:SupportChatPosition,
	side:SupportChatSide,
	expanded:boolean,
	viewport:SupportChatViewport,
):SupportChatPosition{
	const clamped=clampSupportChatPosition(position,expanded,viewport);
	const width=expanded?Math.min(panelWidth,Math.max(0,viewport.width-2*edgeGap)):launcherSize;
	return {
		...clamped,
		left:side==='left'?edgeGap:Math.max(edgeGap,viewport.width-width-edgeGap),
	};
}
