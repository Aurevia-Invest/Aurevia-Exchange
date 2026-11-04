type AureviaEmailTemplate={
	preheader?:string;
	title:string;
	paragraphs:string[];
	action?:{label:string;href:string};
};

function escapeHtml(value:string){
	return value.replace(/[&<>"']/g,character=>({
		'&':'&amp;',
		'<':'&lt;',
		'>':'&gt;',
		'"':'&quot;',
		"'":'&#39;',
	})[character]||character);
}

function safeActionUrl(value:string){
	try{
		const url=new URL(value);
		return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;
	}catch{
		return null;
	}
}

export function renderAureviaEmail({preheader,title,paragraphs,action}:AureviaEmailTemplate){
	const preheaderHtml=preheader
		?`<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>`
		:'';
	const paragraphsHtml=paragraphs.map(paragraph=>
		`<p style="margin:0 0 16px;color:#e8eee8;font-size:15px;line-height:1.65;white-space:pre-line">${escapeHtml(paragraph)}</p>`,
	).join('');
	const actionUrl=action?safeActionUrl(action.href):null;
	const actionHtml=action&&actionUrl
		?`<p style="margin:24px 0;text-align:center"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:13px 22px;border-radius:6px;background:#d2b45c;color:#101610;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(action.label)}</a></p>`
		:'';
	const brand='Aurevia Exchange';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:24px 12px;background:#080d0a;color:#e8eee8;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;border:1px solid #26362b;border-radius:12px;background:#142019"><tr><td style="padding:24px 28px 8px"><p style="margin:0;color:#d2b45c;font-size:12px;font-weight:700;letter-spacing:2px">AUREVIA EXCHANGE</p></td></tr><tr><td style="padding:12px 28px 28px">${preheaderHtml}<h1 style="margin:0 0 18px;color:#f4f3eb;font-size:22px;line-height:1.3">${escapeHtml(title)}</h1>${paragraphsHtml}${actionHtml}<hr style="margin:24px 0;border:0;border-top:1px solid #304136"><p style="margin:0;color:#aab8ad;font-size:12px;line-height:1.6">For your security, never share password reset links. If you did not request this message, you can safely ignore it.</p><p style="margin:18px 0 0;color:#849188;font-size:11px;line-height:1.5">This is an automated account message from ${brand}. Please do not reply.</p></td></tr></table></body></html>`;
}
