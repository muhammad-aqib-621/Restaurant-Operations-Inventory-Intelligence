import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, ClipboardList, PackageCheck, Plus, Trash2, Truck } from 'lucide-react';
import { type AuthData, dateTime, useCommand, useData, useList } from '../lib/client';
import { DataTable, Field, FormMessage, Money, PageTitle, Panel, QueryState, Status } from '../components/operations';
import { convertQuotedCost } from '../lib/unit-cost';

type Unit = 'G' | 'KG' | 'ML' | 'L' | 'PIECE';
interface Ingredient { id: string; name: string; sku: string; unit: Unit; unitCost: string; active: boolean }
interface Supplier { id: string; name: string; contactName?: string | null; email?: string | null; phone?: string | null; address?: string | null; active: boolean }
interface PurchaseItem { id: string; ingredientId: string; quantity: string; receivedQuantity: string; unitCost: string; ingredient: Ingredient }
interface Receipt { id: string; createdAt: string; invoiceReference?: string | null; receivedBy?: { name: string }; items: { id: string; quantity: string; unitCost: string; purchaseOrderItemId: string; expiresAt?: string | null }[] }
interface Purchase { id: string; number: number; supplierId: string; supplier: Supplier; status: string; expectedAt?: string | null; notes?: string | null; createdAt: string; items: PurchaseItem[]; receipts?: Receipt[] }
interface Waste { id: string; quantity: string; reason: string; estimatedCost: string; status: string; createdAt: string; ingredient: Ingredient; createdBy?: { name: string }; approvedBy?: { name: string } | null }
const units = ['G', 'KG', 'ML', 'L', 'PIECE'] as const;
const positiveDecimal = z.string().regex(/^\d+(?:\.\d{1,6})?$/, 'Enter a positive amount with up to 6 decimal places.').refine(value => Number(value) > 0, 'Must be greater than zero.');
const costDecimal = z.string().regex(/^\d+(?:\.\d{1,6})?$/, 'Enter a nonnegative unit cost with up to 6 decimal places.');
const supplierSchema = z.object({ name: z.string().trim().min(1, 'Supplier name is required.').max(160), contactName: z.string().trim().max(160), email: z.union([z.string().email('Enter a valid email.'), z.literal('')]), phone: z.string().trim().max(60), address: z.string().trim().max(500), active: z.boolean() });
const purchaseSchema = z.object({ supplierId: z.string().min(1, 'Select a supplier.'), expectedAt: z.string(), notes: z.string().trim().max(1000), items: z.array(z.object({ ingredientId: z.string().min(1, 'Select an ingredient.'), quantity: positiveDecimal, unit: z.enum(units), unitCost: costDecimal })).min(1, 'Add at least one ingredient.') }).refine(value => new Set(value.items.map(item => item.ingredientId)).size === value.items.length, { message: 'Use each ingredient once per purchase order.', path: ['items'] });
const receiptSchema = z.object({ invoiceReference: z.string().trim().max(160), items: z.array(z.object({ purchaseOrderItemId: z.string(), quantity: z.union([positiveDecimal, z.literal('')]), unit: z.enum(units), unitCost: costDecimal, expiresAt: z.string() })) }).refine(value => value.items.some(item => item.quantity !== ''), { path: ['items'], message: 'Enter a received quantity for at least one ingredient.' });
const wasteSchema = z.object({ ingredientId: z.string().min(1, 'Select an ingredient.'), quantity: positiveDecimal, unit: z.enum(units), reason: z.string().trim().min(3, 'Explain why this stock was wasted.').max(1000) });
function unitOptions(unit?: Unit) { return unit === 'G' || unit === 'KG' ? ['G', 'KG'] as const : unit === 'ML' || unit === 'L' ? ['ML', 'L'] as const : ['PIECE'] as const; }
function remaining(item: PurchaseItem) { const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6)); }; const result = scaled(item.quantity) - scaled(item.receivedQuantity); return `${result / 1_000_000n}.${String(result % 1_000_000n).padStart(6, '0')}`.replace(/\.?0+$/, ''); }
function Errors({ message }: { message?: string }) { return message ? <span className="ops-error" role="alert">{message}</span> : null; }
function datePayload(value: string) { return value ? `${value}T00:00:00+05:00` : undefined; }

function SupplierForm({ supplier, done }: { supplier: Supplier | null; done: () => void }) {
  const command = useCommand();
  const form = useForm<z.infer<typeof supplierSchema>>({ resolver: zodResolver(supplierSchema), defaultValues: { name: '', contactName: '', email: '', phone: '', address: '', active: true } });
  const [success, setSuccess] = useState('');
  useEffect(() => { form.reset({ name: supplier?.name ?? '', contactName: supplier?.contactName ?? '', email: supplier?.email ?? '', phone: supplier?.phone ?? '', address: supplier?.address ?? '', active: supplier?.active ?? true }); setSuccess(''); }, [supplier, form]);
  const submit = form.handleSubmit(async values => {
    setSuccess('');
    try {
      await command.run(supplier ? `/suppliers/${supplier.id}` : '/suppliers', { ...values, contactName: values.contactName || null, email: values.email || null, phone: values.phone || null, address: values.address || null }, supplier ? 'PATCH' : 'POST');
      setSuccess(supplier ? 'Supplier updated.' : 'Supplier added.');
      if (!supplier) form.reset();
      done();
    } catch { /* Shared command displays the API error. */ }
  });
  return <form className="ops-form" onSubmit={submit} noValidate>
    <div className="ops-grid"><Field label="Supplier name"><input className="ops-input" {...form.register('name')} /><Errors message={form.formState.errors.name?.message} /></Field><Field label="Contact person"><input className="ops-input" {...form.register('contactName')} /></Field></div>
    <div className="ops-grid"><Field label="Email"><input className="ops-input" type="email" {...form.register('email')} /><Errors message={form.formState.errors.email?.message} /></Field><Field label="Phone"><input className="ops-input" type="tel" {...form.register('phone')} /></Field></div>
    <Field label="Address"><textarea className="ops-input" rows={2} {...form.register('address')} /><Errors message={form.formState.errors.address?.message} /></Field>
    {supplier && <label className="ops-check"><input type="checkbox" {...form.register('active')} /> Active supplier</label>}
    <FormMessage error={command.error} success={success} />
    <div className="ops-actions"><button className="ops-button" disabled={command.pending}>{command.pending ? 'Saving…' : supplier ? 'Save supplier' : 'Add supplier'}</button>{supplier && <button className="ops-button ops-button-secondary" type="button" onClick={done}>Cancel editing</button>}</div>
  </form>;
}

function PurchaseForm({ ingredients, suppliers, onCreated }: { ingredients: Ingredient[]; suppliers: Supplier[]; onCreated: (id: string) => void }) {
  const command = useCommand();
  const [success, setSuccess] = useState('');
  const form = useForm<z.infer<typeof purchaseSchema>>({ resolver: zodResolver(purchaseSchema), defaultValues: { supplierId: '', expectedAt: '', notes: '', items: [{ ingredientId: '', quantity: '', unit: 'G', unitCost: '' }] } });
  const lines = useFieldArray({ control: form.control, name: 'items' });
  const submit = form.handleSubmit(async values => {
    setSuccess('');
    try {
      const purchase = await command.run<Purchase>('/purchases', { ...values, expectedAt: datePayload(values.expectedAt), notes: values.notes || undefined });
      form.reset(); setSuccess(`Purchase order #${purchase.number} created as a draft.`); onCreated(purchase.id);
    } catch { /* Shared command displays the API error. */ }
  });
  return <form className="ops-form" onSubmit={submit} noValidate>
    <div className="ops-grid"><Field label="Supplier"><select className="ops-input" {...form.register('supplierId')}><option value="">Choose supplier</option>{suppliers.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><Errors message={form.formState.errors.supplierId?.message} /></Field><Field label="Expected delivery"><input className="ops-input" type="date" {...form.register('expectedAt')} /></Field></div>
    {lines.fields.map((line, index) => {
      const selected = ingredients.find(ingredient => ingredient.id === form.watch(`items.${index}.ingredientId`));
      const quotedUnit = form.watch(`items.${index}.unit`);
      const errors = form.formState.errors.items?.[index];
      return <fieldset className="ops-line" key={line.id}><legend>Ingredient {index + 1}</legend><div className="ops-grid">
        <Field label="Ingredient"><select className="ops-input" {...form.register(`items.${index}.ingredientId`, { onChange: event => { const ingredient = ingredients.find(row => row.id === event.target.value); if (ingredient) { form.setValue(`items.${index}.unit`, ingredient.unit); form.setValue(`items.${index}.unitCost`, ingredient.unitCost); } } })}><option value="">Choose ingredient</option>{ingredients.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.name} · {row.sku}</option>)}</select><Errors message={errors?.ingredientId?.message} /></Field>
        <Field label="Quantity"><input className="ops-input" inputMode="decimal" placeholder="e.g. 1000" {...form.register(`items.${index}.quantity`)} /><Errors message={errors?.quantity?.message} /></Field>
        <Field label="Quantity unit"><select className="ops-input" {...form.register(`items.${index}.unit`, { onChange: event => form.setValue(`items.${index}.unitCost`, convertQuotedCost(form.getValues(`items.${index}.unitCost`), quotedUnit, event.target.value as Unit), { shouldValidate: true }) })}>{unitOptions(selected?.unit).map(unit => <option key={unit}>{unit}</option>)}</select></Field>
        <Field label={`Quoted cost per ${quotedUnit} (PKR)`}><input className="ops-input" inputMode="decimal" {...form.register(`items.${index}.unitCost`)} /><Errors message={errors?.unitCost?.message} /></Field>
      </div>{lines.fields.length > 1 && <button className="ops-link" type="button" onClick={() => lines.remove(index)}><Trash2 size={14} /> Remove ingredient {index + 1}</button>}</fieldset>;
    })}
    <Errors message={form.formState.errors.items?.message ?? form.formState.errors.items?.root?.message} />
    <button className="ops-button ops-button-secondary" type="button" onClick={() => lines.append({ ingredientId: '', quantity: '', unit: 'G', unitCost: '' })}><Plus size={15} /> Add ingredient</button>
    <p className="ops-muted">Enter the quoted cost per selected quantity unit. Kilogram and litre quotations are converted to canonical stock units by the server.</p>
    <Field label="Purchase notes"><textarea className="ops-input" rows={2} {...form.register('notes')} /><Errors message={form.formState.errors.notes?.message} /></Field>
    <FormMessage error={command.error} success={success} /><button className="ops-button" disabled={command.pending || !suppliers.some(row => row.active) || !ingredients.some(row => row.active)}>{command.pending ? 'Creating…' : 'Create draft purchase order'}</button>
  </form>;
}

function ReceiptForm({ purchase }: { purchase: Purchase }) {
  const command = useCommand();
  const [success, setSuccess] = useState('');
  const outstanding = purchase.items.filter(item => remaining(item) !== '0');
  const form = useForm<z.infer<typeof receiptSchema>>({ resolver: zodResolver(receiptSchema), defaultValues: { invoiceReference: '', items: [] } });
  useEffect(() => { form.reset({ invoiceReference: '', items: purchase.items.filter(item => remaining(item) !== '0').map(item => ({ purchaseOrderItemId: item.id, quantity: '', unit: item.ingredient.unit, unitCost: item.unitCost, expiresAt: '' })) }); }, [purchase, form]);
  const submit = form.handleSubmit(async values => {
    setSuccess('');
    try {
      await command.run(`/purchases/${purchase.id}/receipts`, { invoiceReference: values.invoiceReference || undefined, items: values.items.filter(item => item.quantity !== '').map(item => ({ ...item, expiresAt: datePayload(item.expiresAt) })) });
      setSuccess('Delivery recorded. Stock and its weighted average cost have been updated.');
    } catch { /* Shared command displays the API error. */ }
  });
  return <form className="ops-form" onSubmit={submit} noValidate><p className="ops-muted">Record only the items delivered. Leave other quantities blank for a later receipt. Each receipt adds stock once.</p>
    <Field label="Supplier invoice reference"><input className="ops-input" {...form.register('invoiceReference')} /><Errors message={form.formState.errors.invoiceReference?.message} /></Field>
    {outstanding.map((item, index) => <fieldset className="ops-line" key={item.id}><legend>{item.ingredient.name}</legend><p className="ops-muted">Outstanding: {remaining(item)} {item.ingredient.unit}</p><div className="ops-grid">
      <Field label={`Received quantity · ${item.ingredient.name}`}><input className="ops-input" inputMode="decimal" placeholder="Leave blank if not delivered" {...form.register(`items.${index}.quantity`)} /><Errors message={form.formState.errors.items?.[index]?.quantity?.message} /></Field>
      <Field label={`Receipt unit · ${item.ingredient.name}`}><select className="ops-input" data-quoted-unit={form.watch(`items.${index}.unit`) ?? item.ingredient.unit} {...form.register(`items.${index}.unit`, { onChange: event => form.setValue(`items.${index}.unitCost`, convertQuotedCost(form.getValues(`items.${index}.unitCost`), event.target.dataset.quotedUnit as Unit, event.target.value as Unit), { shouldValidate: true }) })}>{unitOptions(item.ingredient.unit).map(unit => <option key={unit}>{unit}</option>)}</select></Field>
      <Field label={`Actual cost per ${form.watch(`items.${index}.unit`) ?? item.ingredient.unit} (PKR) · ${item.ingredient.name}`}><input className="ops-input" inputMode="decimal" {...form.register(`items.${index}.unitCost`)} /><Errors message={form.formState.errors.items?.[index]?.unitCost?.message} /></Field>
      <Field label={`Expiry date · ${item.ingredient.name}`}><input className="ops-input" type="date" {...form.register(`items.${index}.expiresAt`)} /></Field>
    </div></fieldset>)}
    <Errors message={form.formState.errors.items?.message ?? form.formState.errors.items?.root?.message} /><FormMessage error={command.error} success={success} />
    <button className="ops-button" disabled={command.pending || !outstanding.length}><PackageCheck size={16} />{command.pending ? 'Recording…' : 'Record goods receipt'}</button>
  </form>;
}

function PurchaseDetail({ purchase, canManage, canReceive, close }: { purchase: Purchase; canManage: boolean; canReceive: boolean; close: () => void }) {
  const command = useCommand();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [success, setSuccess] = useState('');
  async function changeStatus(status: string) {
    setSuccess('');
    try { await command.run(`/purchases/${purchase.id}/status`, { status }); setSuccess(status === 'ORDERED' ? 'Purchase order marked as ordered.' : 'Purchase order cancelled. Existing received stock is retained.'); setConfirmCancel(false); } catch { /* Shared command displays the API error. */ }
  }
  return <Panel title={`Purchase order #${purchase.number}`} action={<button className="ops-link" onClick={close}>Close details</button>}>
    <div className="ops-actions"><Status value={purchase.status} /><strong>{purchase.supplier.name}</strong>{purchase.expectedAt && <span className="ops-muted">Expected {dateTime(purchase.expectedAt)}</span>}</div>
    {purchase.notes && <p>{purchase.notes}</p>}
    <DataTable columns={['Ingredient', 'Ordered', 'Received', 'Remaining', 'Quoted unit cost']} rows={purchase.items.map(item => [item.ingredient.name, `${item.quantity} ${item.ingredient.unit}`, `${item.receivedQuantity} ${item.ingredient.unit}`, `${remaining(item)} ${item.ingredient.unit}`, <Money value={item.unitCost} />])} />
    <FormMessage error={command.error} success={success} />
    {canManage && <div className="ops-actions">{purchase.status === 'DRAFT' && <button className="ops-button" disabled={command.pending} onClick={() => void changeStatus('ORDERED')}><Truck size={15} /> Mark ordered</button>}{['DRAFT', 'ORDERED', 'PARTIAL'].includes(purchase.status) && !confirmCancel && <button className="ops-button ops-button-secondary" disabled={command.pending} onClick={() => setConfirmCancel(true)}>Cancel remaining order</button>}</div>}
    {confirmCancel && <div className="ops-callout" role="alert"><p>Cancel the undelivered part of purchase order #{purchase.number}? Received goods remain in stock.</p><div className="ops-actions"><button className="ops-button" disabled={command.pending} onClick={() => void changeStatus('CANCELLED')}>Confirm cancellation</button><button className="ops-button ops-button-secondary" onClick={() => setConfirmCancel(false)}>Keep order</button></div></div>}
    {canReceive && ['ORDERED', 'PARTIAL'].includes(purchase.status) && <div className="ops-section"><h3>Receive a delivery</h3><ReceiptForm key={purchase.id} purchase={purchase} /></div>}
    {purchase.status === 'DRAFT' && <p className="ops-muted">Mark the draft as ordered before receiving goods.</p>}
    <div className="ops-section"><h3>Goods receipt history</h3><DataTable columns={['Received', 'Invoice', 'Received by', 'Delivery items']} empty="No deliveries recorded for this purchase order." rows={(purchase.receipts ?? []).map(receipt => [dateTime(receipt.createdAt), receipt.invoiceReference || '—', receipt.receivedBy?.name ?? 'Staff member', <ul>{receipt.items.map(item => { const ordered = purchase.items.find(line => line.id === item.purchaseOrderItemId); return <li key={item.id}>{ordered?.ingredient.name ?? 'Ingredient'}: {item.quantity} {ordered?.ingredient.unit} at <Money value={item.unitCost} /> per {ordered?.ingredient.unit}{item.expiresAt && ` · expiry ${dateTime(item.expiresAt)}`}</li>; })}</ul>])} /></div>
  </Panel>;
}

export function PurchasingPage() {
  const auth = useData<AuthData>('/auth/me');
  const role = auth.data?.user?.role;
  const canManage = role === 'OWNER' || role === 'MANAGER';
  const canReceive = canManage || role === 'INVENTORY';
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supplierEdit, setSupplierEdit] = useState<Supplier | null>(null);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const suppliers = useList<Supplier>('/suppliers?pageSize=100');
  const ingredients = useList<Ingredient>('/ingredients?pageSize=100');
  const purchases = useList<Purchase>(`/purchases?page=${page}&pageSize=20`);
  const selected = purchases.data?.find(purchase => purchase.id === selectedId);
  return <><PageTitle title="Purchasing & receiving" description="Keep supplier orders, partial deliveries, and actual ingredient costs in one place." action={canManage && <button className="ops-button" onClick={() => setShowPurchaseForm(value => !value)}><Plus size={16} /> {showPurchaseForm ? 'Close new order' : 'New purchase order'}</button>} />
    {showPurchaseForm && canManage && <Panel title="New purchase order"><QueryState query={suppliers}><QueryState query={ingredients}><PurchaseForm suppliers={suppliers.data ?? []} ingredients={ingredients.data ?? []} onCreated={id => { setPage(1); setSelectedId(id); }} /></QueryState></QueryState></Panel>}
    <Panel title="Purchase orders"><QueryState query={purchases}><DataTable columns={['Order', 'Supplier', 'Status', 'Expected', 'Created', 'Details']} empty="No purchase orders yet. Create a draft to begin stocking up." rows={(purchases.data ?? []).map(purchase => [<strong>#{purchase.number}</strong>, purchase.supplier.name, <Status value={purchase.status} />, purchase.expectedAt ? dateTime(purchase.expectedAt) : '—', dateTime(purchase.createdAt), <button className="ops-link" onClick={() => setSelectedId(purchase.id)} aria-label={`View purchase order ${purchase.number}`}><ClipboardList size={15} /> View order</button>])} /><div className="ops-pagination"><button className="ops-button ops-button-secondary" disabled={page === 1 || purchases.isFetching} onClick={() => { setPage(value => value - 1); setSelectedId(null); }}>Previous</button><span>Page {page}</span><button className="ops-button ops-button-secondary" disabled={(purchases.data?.length ?? 0) < 20 || purchases.isFetching} onClick={() => { setPage(value => value + 1); setSelectedId(null); }}>Next</button></div></QueryState></Panel>
    {selected && <PurchaseDetail key={selected.id} purchase={selected} canManage={canManage} canReceive={canReceive} close={() => setSelectedId(null)} />}
    <Panel title="Supplier directory" action={canManage && <button className="ops-button ops-button-secondary" onClick={() => { setSupplierEdit(null); setShowSupplierForm(value => !value); }}><Plus size={15} /> {showSupplierForm ? 'Close supplier form' : 'Add supplier'}</button>}><QueryState query={suppliers}><DataTable columns={['Supplier', 'Contact', 'Email / phone', 'Status', ...(canManage ? ['Actions'] : [])]} empty="No suppliers yet." rows={(suppliers.data ?? []).map(supplier => [supplier.name, supplier.contactName || '—', <div>{supplier.email && <div>{supplier.email}</div>}{supplier.phone && <div>{supplier.phone}</div>}{!supplier.email && !supplier.phone && '—'}</div>, <Status value={supplier.active ? 'ACTIVE' : 'INACTIVE'} />, ...(canManage ? [<button className="ops-link" onClick={() => { setSupplierEdit(supplier); setShowSupplierForm(true); }} aria-label={`Edit supplier ${supplier.name}`}>Edit supplier</button>] : [])])} /></QueryState>{canManage && showSupplierForm && <div className="ops-section"><h3>{supplierEdit ? `Edit ${supplierEdit.name}` : 'Add a supplier'}</h3><SupplierForm supplier={supplierEdit} done={() => { if (supplierEdit) { setSupplierEdit(null); setShowSupplierForm(false); } }} /></div>}</Panel>
  </>;
}

export function WastePage() {
  const auth = useData<AuthData>('/auth/me');
  const canApprove = auth.data?.user?.role === 'OWNER' || auth.data?.user?.role === 'MANAGER';
  const ingredients = useList<Ingredient>('/ingredients?pageSize=100');
  const [page, setPage] = useState(1);
  const waste = useList<Waste>(`/waste?page=${page}&pageSize=20`);
  const command = useCommand();
  const approval = useCommand();
  const [success, setSuccess] = useState('');
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const form = useForm<z.infer<typeof wasteSchema>>({ resolver: zodResolver(wasteSchema), defaultValues: { ingredientId: '', quantity: '', unit: 'G', reason: '' } });
  const selected = ingredients.data?.find(ingredient => ingredient.id === form.watch('ingredientId'));
  const submit = form.handleSubmit(async values => { setSuccess(''); try { await command.run('/waste', values); form.reset(); setPage(1); setSuccess('Waste submitted for manager approval. Stock changes only after approval.'); } catch { /* Shared command displays the API error. */ } });
  async function approve(id: string) { setSuccess(''); try { await approval.run(`/waste/${id}/approve`, {}); setApprovingId(null); setSuccess('Waste approved and deducted from available stock.'); } catch { /* Shared command displays the API error. */ } }
  const awaiting = waste.data?.find(record => record.id === approvingId);
  return <><PageTitle title="Waste tracking" description="Record spoilage, preparation waste, or damaged ingredients and keep stock changes accountable." />
    <div className="ops-grid"><Panel title="Record waste"><QueryState query={ingredients}><form className="ops-form" onSubmit={submit} noValidate>
      <Field label="Wasted ingredient"><select className="ops-input" {...form.register('ingredientId', { onChange: event => { const ingredient = ingredients.data?.find(row => row.id === event.target.value); if (ingredient) form.setValue('unit', ingredient.unit); } })}><option value="">Choose ingredient</option>{(ingredients.data ?? []).filter(row => row.active).map(ingredient => <option value={ingredient.id} key={ingredient.id}>{ingredient.name} · {ingredient.sku}</option>)}</select><Errors message={form.formState.errors.ingredientId?.message} /></Field>
      <div className="ops-grid"><Field label="Wasted quantity"><input className="ops-input" inputMode="decimal" {...form.register('quantity')} /><Errors message={form.formState.errors.quantity?.message} /></Field><Field label="Waste quantity unit"><select className="ops-input" {...form.register('unit')}>{unitOptions(selected?.unit).map(unit => <option key={unit}>{unit}</option>)}</select></Field></div>
      <Field label="Reason for waste"><textarea className="ops-input" rows={3} placeholder="e.g. Spoiled during storage" {...form.register('reason')} /><Errors message={form.formState.errors.reason?.message} /></Field>
      <FormMessage error={command.error} /><button className="ops-button" disabled={command.pending || !ingredients.data?.some(row => row.active)}>{command.pending ? 'Submitting…' : 'Submit waste record'}</button>
    </form></QueryState></Panel><Panel title="An accurate stock history"><p>Staff can submit a waste record. A manager or owner reviews it before stock is deducted.</p><p className="ops-muted">The server checks available stock during approval. Reserved stock cannot be written off. Approved records retain their ingredient cost and create an immutable inventory movement.</p><div className="ops-callout"><Check size={18} /><p>Enter the quantity actually wasted. Use a specific reason so your team can act on recurring losses.</p></div></Panel></div>
    <FormMessage success={success} error={approval.error} />
    {awaiting && <Panel title="Approve waste deduction"><p>Deduct {awaiting.quantity} {awaiting.ingredient.unit} of {awaiting.ingredient.name}? Estimated loss: <Money value={awaiting.estimatedCost} />.</p><p className="ops-muted">{awaiting.reason}</p><div className="ops-actions"><button className="ops-button" disabled={approval.pending} onClick={() => void approve(awaiting.id)}>{approval.pending ? 'Approving…' : 'Approve & deduct stock'}</button><button className="ops-button ops-button-secondary" disabled={approval.pending} onClick={() => setApprovingId(null)}>Keep pending</button></div></Panel>}
    <Panel title="Waste records"><QueryState query={waste}><DataTable columns={['Recorded', 'Ingredient', 'Quantity', 'Reason', 'Estimated loss', 'Status', 'Submitted by', ...(canApprove ? ['Approval'] : [])]} empty="No waste recorded for this restaurant." rows={(waste.data ?? []).map(record => [dateTime(record.createdAt), record.ingredient.name, `${record.quantity} ${record.ingredient.unit}`, record.reason, <Money value={record.estimatedCost} />, <Status value={record.status} />, record.createdBy?.name ?? 'Staff member', ...(canApprove ? [record.status === 'PENDING' ? <button className="ops-link" disabled={approval.pending} onClick={() => setApprovingId(record.id)} aria-label={`Review waste of ${record.ingredient.name}`}>Review & approve</button> : record.approvedBy?.name ?? 'Reviewed'] : [])])} /><div className="ops-pagination"><button className="ops-button ops-button-secondary" disabled={page === 1 || waste.isFetching} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page}</span><button className="ops-button ops-button-secondary" disabled={(waste.data?.length ?? 0) < 20 || waste.isFetching} onClick={() => setPage(value => value + 1)}>Next</button></div></QueryState></Panel>
  </>;
}
