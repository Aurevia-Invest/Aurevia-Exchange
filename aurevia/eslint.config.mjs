import js from '@eslint/js';
import {fixupPluginRules} from '@eslint/compat';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles=['**/*.{js,mjs,cjs,jsx,ts,tsx}'];
const eslintConfig=tseslint.config(
	{
		ignores:['**/.next/**','**/.next-dev/**','**/.next-e2e/**','**/node_modules/**','**/coverage/**','**/playwright-report/**','**/test-results/**','**/tools/playwright/browsers/**'],
	},
	{...js.configs.recommended,files:['**/*.{js,mjs,cjs,jsx}']},
	...tseslint.configs.recommended,
	{
		files:sourceFiles,
		languageOptions:{globals:{...globals.browser,...globals.node}},
		plugins:{'@next/next':fixupPluginRules(nextPlugin)},
		rules:{...nextPlugin.configs.recommended.rules,...nextPlugin.configs['core-web-vitals'].rules},
	},
	{
		files:sourceFiles,
		plugins:{'react-hooks':reactHooks},
		rules:{
			...reactHooks.configs.flat['recommended-latest'].rules,
			'react-hooks/set-state-in-effect':'off',
			'react-hooks/static-components':'off',
		},
	},
	{
		files:['**/*.{ts,tsx}'],
		rules:{'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',ignoreRestSiblings:true}]},
	},
);

export default eslintConfig;