import {describe,expect,it} from 'vitest';
import {utcTimestamp} from '@/components/AdminAuditLogPanel';

describe('admin audit timestamp formatting',()=>{
	it('formats UTC timestamps without throwing for audit rows',()=>{
		expect(()=>utcTimestamp('2026-11-05T17:00:00.000Z')).not.toThrow();
		expect(utcTimestamp('2026-11-05T17:00:00.000Z')).toContain('Nov 5, 2026');
	});
});
