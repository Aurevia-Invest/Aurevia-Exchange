export const THEMES=['forest-green','premium-dashboard'] as const;
export type Theme=typeof THEMES[number];

export function isTheme(value:unknown):value is Theme{
	return value==='forest-green'||value==='premium-dashboard';
}
