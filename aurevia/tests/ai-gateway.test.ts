import {afterEach,describe,expect,it,vi} from 'vitest';

const auditCreate=vi.fn();
const approvedCredential=vi.fn();
vi.mock('@/lib/db',()=>({db:{auditLog:{create:auditCreate}}}));
vi.mock('@/lib/ai-credential-vault',()=>({getApprovedAiCredential:approvedCredential}));

afterEach(()=>{
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.resetModules();
	auditCreate.mockReset();
	approvedCredential.mockReset().mockResolvedValue('');
});

describe('central AI gateway',()=>{
	it('uses OpenRouter free routing and records token usage without logging prompts',async()=>{
		vi.stubEnv('OPENROUTER_API_KEY','private-test-key');
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'test/free-model',pricing:{prompt:'0',completion:'0'}},{id:'test/paid-model',pricing:{prompt:'0.01',completion:'0.02'}}]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({model:'test/free-model',choices:[{message:{content:'Generated analysis.'}}],usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17}}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const {aiChat}=await import('@/lib/ai-gateway');
		const result=await aiChat([{role:'user',content:'private prompt content'}],{service:'unit-test'});
		expect(result).toMatchObject({content:'Generated analysis.',provider:'openrouter',model:'test/free-model',usage:{promptTokens:12,completionTokens:5,totalTokens:17}});
		expect(fetcher.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
		expect(fetcher.mock.calls[1][1].headers.authorization).toBe('Bearer private-test-key');
		expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({entity:'AI_USAGE',metadata:expect.objectContaining({service:'unit-test',totalTokens:17})})}));
		expect(JSON.stringify(auditCreate.mock.calls)).not.toContain('private prompt content');
	});

	it('rejects a configured paid OpenRouter model before sending a completion request',async()=>{
		vi.stubEnv('OPENROUTER_API_KEY','private-test-key');
		vi.stubEnv('AI_MODEL','test/paid-model');
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'test/paid-model',pricing:{prompt:'0.01',completion:'0.02'}}]}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const {aiChat}=await import('@/lib/ai-gateway');
		await expect(aiChat([{role:'user',content:'hello'}])).rejects.toMatchObject({code:'NO_FREE_MODEL'});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('validates message input before making provider requests',async()=>{
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);
		const {aiChat}=await import('@/lib/ai-gateway');
		await expect(aiChat([{role:'tool',content:'invalid role'}])).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('caches identical requests briefly without counting cached tokens as new usage',async()=>{
		vi.stubEnv('OPENROUTER_API_KEY','private-test-key');
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'test/free-model',pricing:{prompt:'0',completion:'0'}}]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({model:'test/free-model',choices:[{message:{content:'Generated analysis.'}}],usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17}}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const {aiChat}=await import('@/lib/ai-gateway');
		const first=await aiChat([{role:'user',content:'same request'}],{service:'unit-test',actorId:'user-a'});
		const second=await aiChat([{role:'user',content:'same request'}],{service:'unit-test',actorId:'user-a'});
		expect(second.content).toBe(first.content);
		expect(second.usage).toEqual({promptTokens:null,completionTokens:null,totalTokens:null});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(auditCreate).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({metadata:expect.objectContaining({cacheHit:true,totalTokens:null})})}));
	});

	it('reports an approved encrypted backup credential only after its free model is verified',async()=>{
		vi.stubEnv('AI_PROVIDER','openrouter');
		vi.stubEnv('OPENROUTER_API_KEY','');
		vi.stubEnv('GEMINI_API_KEY','');
		vi.stubEnv('GROQ_API_KEY','');
		vi.stubEnv('AI_BACKUP_PROVIDERS','gemini');
		vi.stubEnv('GEMINI_FREE_MODEL','gemini-2.0-flash');
		vi.stubEnv('AI_FREE_MODEL_ALLOWLIST','gemini:gemini-2.0-flash');
		approvedCredential.mockImplementation(async(provider:string)=>provider==='gemini'?'approved-db-key':'');
		const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({models:[{name:'models/gemini-2.0-flash'}]}),{status:200})));
		vi.stubGlobal('fetch',fetcher);
		const {getAiEngineStatus}=await import('@/lib/ai-gateway');
		const status=await getAiEngineStatus();
		expect(status.backupProviders).toEqual(['gemini']);
		expect(status.providers.find(provider=>provider.provider==='gemini')).toMatchObject({status:'CONNECTED',model:'gemini-2.0-flash'});
		expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/models?key=approved-db-key'),expect.objectContaining({cache:'no-store'}));
	});
});