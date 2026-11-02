import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import ReceiptGenerator,{type ReceiptData} from '../components/ReceiptGenerator';

const baseReceipt:ReceiptData={
	id:'withdrawal-1',
	reference:'AUR-WITHDRAWAL-1',
	status:'APPROVED',
	type:'WITHDRAWAL',
	accountMode:'REAL',
	createdAt:'2026-10-20T12:00:00.000Z',
	name:'Test User',
	email:'user@example.test',
	amount:'25.00',
	currency:'USD',
	method:'REAL withdrawal',
};

describe('transaction receipt',()=>{
	it('shows the permanent Aurevia Exchange ID and a dedicated copy action',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'COMPLETED',aureviaExchangeId:'AEX-2026-8K7M-4Q9X'}}/>);

		expect(markup).toContain('AUREVIA EXCHANGE ID');
		expect(markup).toContain('AEX-2026-8K7M-4Q9X');
		expect(markup).toContain('Copy Aurevia ID');
	});

	it('does not label an approved REAL withdrawal as completed or successful',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={baseReceipt}/>);
		expect(markup).toContain('Approved · payout not confirmed');
		expect(markup).not.toContain('Transaction Successful');
		expect(markup).not.toContain('>Completed · admin-recorded payout</h2>');
		expect(markup).toContain('Internal Aurevia ledger');
	});

	it('shows completion only when the persisted status is completed',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'COMPLETED',completedAt:'2026-10-20T13:00:00.000Z'}}/>);
		expect(markup).toContain('Completed · admin-recorded payout');
		expect(markup).toContain('Transaction Successful');
	});

	it('renders as a constrained receipt card with transaction details',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'PENDING_REVIEW',type:'DEPOSIT',simulated:true,externalReference:'user-reference'}}/>);
		expect(markup).toContain('aurevia-receipt');
		expect(markup).toContain('Transaction Details');
		expect(markup).toContain('Pending review');
		expect(markup).toContain('INTERNAL LEDGER RECORD');
		expect(markup).toContain('user-reference');
		expect(markup).toContain('OFFICIAL RECEIPT');
		expect(markup).toContain('REFERENCE ID');
		expect(markup).toContain('TOTAL');
	});

	it('does not represent an approved internal deposit as completed',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'APPROVED',type:'DEPOSIT',simulated:true}}/>);
		expect(markup).toContain('>Approved<');
		expect(markup).not.toContain('Transaction Successful');
		expect(markup).not.toContain('LEDGER CREDIT');
	});

	it('displays fee and total only when fee data is present',()=>{
		const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'COMPLETED',fee:'2.50'}}/>);
		expect(markup).toContain('$2.50');
		expect(markup).toContain('$27.50');
		const withoutFee=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status:'PENDING'}}/>);
		expect(withoutFee).toContain('Not recorded');
		expect(withoutFee).toContain('Not available');
	});

	it('renders failed and pending states without success messaging',()=>{
		for(const status of ['PENDING','PENDING_REVIEW','PROCESSING','REJECTED','FAILED','CANCELLED','REVERSED'] as const){
			const markup=renderToStaticMarkup(<ReceiptGenerator receipt={{...baseReceipt,status}}/>);
			expect(markup).not.toContain('Transaction Successful');
			if(status==='REVERSED')expect(markup).toContain('Transaction Reversed');
		}
	});
});
