import {ApplicationTheme} from '@prisma/client';
import type {Theme} from '@/lib/theme-shared';
export {isTheme,THEMES,type Theme} from '@/lib/theme-shared';

const themeToPreference:Record<Theme,ApplicationTheme>={
	'forest-green':ApplicationTheme.FOREST_GREEN,
	'premium-dashboard':ApplicationTheme.PREMIUM_DASHBOARD,
};

export function themeFromPreference(value:ApplicationTheme|undefined|null):Theme{
	return value===ApplicationTheme.PREMIUM_DASHBOARD?'premium-dashboard':'forest-green';
}

export function preferenceFromTheme(theme:Theme):ApplicationTheme{
	return themeToPreference[theme];
}
