import { useEffect, type ReactNode } from 'react';
import { AlertCircle, Inbox, LoaderCircle } from 'lucide-react';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <Card className="ops-panel"><div className="ops-panel-heading"><h2>{title}</h2>{action}</div><div className="ops-panel-body">{children}</div></Card>; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="ops-field"><span>{label}</span>{children}</label>; }
export function DataTable({ columns, rows, empty = 'No records yet.' }: { columns: string[]; rows: ReactNode[][]; empty?: string }) { return <div className="ops-table-scroll"><table className="ops-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>) : <tr><td colSpan={columns.length}><div className="ops-empty"><Inbox size={25} /><p>{empty}</p></div></td></tr>}</tbody></table></div>; }
export function Money({ value, precision = 2 }: { value: string | number | null | undefined; precision?: number }) { return <span className="money">{new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: precision, maximumFractionDigits: precision }).format(Number(value ?? 0))}</span>; }
export function Status({ value }: { value: string }) { const good = ['ACTIVE', 'COMPLETED', 'RECEIVED', 'APPROVED', 'READY'].includes(value); const bad = ['CANCELLED', 'REJECTED', 'INACTIVE'].includes(value); return <Badge variant={good ? 'success' : bad ? 'neutral' : 'amber'}>{value.replaceAll('_', ' ').toLowerCase()}</Badge>; }
export function PageTitle({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="ops-page-title"><div><div className="ops-eyebrow">THE COPPER TABLE · OPERATIONS</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function QueryState({ query, children }: { query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; children: ReactNode }) { if (query.isPending) return <div className="ops-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading records…</div>; if (query.isError) return <div className="ops-error" role="alert"><AlertCircle size={18} /><div>{query.error?.message}<button className="ops-link" onClick={() => void query.refetch()}>Try again</button></div></div>; return <>{children}</>; }
export function FormMessage({ error, success }: { error?: string | null; success?: string | null }) { return <>{error && <p role="alert" className="ops-error">{error}</p>}{success && <p role="status" className="ops-success">{success}</p>}</>; }
export function Empty({ message }: { message: string }) { return <div className="ops-empty"><Inbox size={28} /><p>{message}</p></div>; }

export function useModalAccessibility() {
  useEffect(() => {
    let active: HTMLElement | null = null;
    let previous: HTMLElement | null = null;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';
    const sync = () => {
      const modal = document.querySelector<HTMLElement>('.ops-modal[role="dialog"]');
      if (modal === active) return;
      if (modal) {
        previous = document.activeElement as HTMLElement;
        active = modal;
        modal.querySelector<HTMLElement>(selector)?.focus();
      } else { active = null; if (previous?.isConnected) previous.focus(); previous = null; }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.key === 'Escape') { event.preventDefault(); active.querySelector<HTMLButtonElement>('button[aria-label^="Close"]')?.click(); }
      if (event.key !== 'Tab') return;
      const controls = [...active.querySelectorAll<HTMLElement>(selector)].filter((element) => element.getAttribute('type') !== 'hidden');
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', keydown); sync();
    return () => { observer.disconnect(); document.removeEventListener('keydown', keydown); };
  }, []);
}
