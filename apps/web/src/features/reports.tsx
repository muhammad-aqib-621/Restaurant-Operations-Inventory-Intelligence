import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart2, RefreshCw } from 'lucide-react';
import { ApiError, businessDate, dateTime } from '../lib/client';
import { DataTable, Field, FormMessage, Money, PageTitle, Panel, QueryState, Status } from '../components/operations';

const reports = [
  { value: 'sales', label: 'Sales & profitability', description: 'Payment-based sales, tax, refunds, and estimated gross profit.' },
  { value: 'items', label: 'Menu item performance', description: 'Sales and estimated margins from historical order item snapshots.' },
  { value: 'hourly', label: 'Hourly sales', description: 'Understand the pace of service by business date and hour.' },
  { value: 'consumption', label: 'Ingredient consumption', description: 'Actual ingredient usage recorded in the stock ledger.' },
  { value: 'valuation', label: 'Inventory valuation', description: 'Current on-hand inventory valued at weighted average unit cost.' },
  { value: 'movements', label: 'Stock movement history', description: 'An immutable record of stock additions, deductions, and corrections.' },
  { value: 'waste', label: 'Waste & losses', description: 'Recorded waste, its approval status, and approved stock losses.' },
  { value: 'purchases', label: 'Purchasing & receipts', description: 'Supplier orders and the actual cost of deliveries in the selected dates.' },
  { value: 'reorder', label: 'Reorder planning', description: 'Current available stock, minimum levels, and consumption-based estimates.' },
] as const;
type ReportType = typeof reports[number]['value'];
type Cell = string | number | boolean | null;
interface Filters { type: ReportType; from: string; to: string; granularity: 'day' | 'month' }
interface ReportData { type: ReportType; from: string; to: string; timezone: string; columns: string[]; rows: Record<string, Cell>[]; summary: Record<string, Cell>; definitions: string[] }
interface ReportResponse { data: ReportData; pagination: { page: number; pageSize: number; total: number } }
const pageSize = 25;
const moneyColumns = new Set(['sales', 'tax', 'collected', 'refunds', 'estimatedCogs', 'grossProfit', 'averageOrderValue', 'unitCost', 'cost', 'value', 'estimatedCost', 'orderedCost', 'receivedCost', 'consumptionCost', 'inventoryValue', 'approvedWasteCost']);
const labels: Record<string, string> = {
  estimatedCogs: 'Estimated COGS', grossProfit: 'Estimated gross profit', averageOrderValue: 'Average order value',
  menuItemId: 'Menu item ID', ingredientId: 'Ingredient ID', id: 'Record ID', name: 'Menu item',
  collected: 'Payments collected', sales: 'Net sales', orderCount: 'Paid orders',
  value: 'Stock value', asOf: 'Valuation time', observationDays: 'Observation days', targetDays: 'Target stock days',
  dailyConsumptionEstimate: 'Est. daily consumption', daysRemainingEstimate: 'Est. days remaining',
};
function label(column: string) { return labels[column] ?? column.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase()); }
function display(column: string, value: Cell | undefined): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="ops-muted">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (moneyColumns.has(column) && Number.isFinite(Number(value))) return <Money value={value} />;
  if (['createdAt', 'approvedAt', 'expectedAt', 'asOf', 'forecastFrom', 'forecastTo'].includes(column) && typeof value === 'string') return dateTime(value);
  if (['status', 'type', 'forecastStatus'].includes(column)) return <Status value={String(value)} />;
  return String(value);
}
function initialFilters(): Filters {
  const to = businessDate();
  const start = new Date(`${to}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { type: 'sales', from: start.toISOString().slice(0, 10), to, granularity: 'day' };
}
function queryString(filters: Filters, page?: number) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.type === 'sales') query.set('granularity', filters.granularity);
  if (page !== undefined) { query.set('page', String(page)); query.set('pageSize', String(pageSize)); }
  return query;
}
async function requestReport(path: string, accept: string, signal?: AbortSignal) {
  let response: Response;
  try { response = await fetch(`/api${path}`, { headers: { Accept: accept }, credentials: 'include', signal }); }
  catch (problem) {
    if (signal?.aborted) throw problem;
    throw new ApiError('The service cannot be reached. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('auth:expired'));
    const problem = await response.json().catch(() => null) as { error?: { message?: string; requestId?: string } } | null;
    throw new ApiError(problem?.error?.message ?? 'The report could not be loaded. Please retry.', response.status, problem?.error?.requestId);
  }
  return response;
}

export function ReportsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [draft, setDraft] = useState<Filters>(filters);
  const [page, setPage] = useState(1);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const path = `/reports/${filters.type}?${queryString(filters, page)}`;
  // Keep the response envelope here: report pagination totals live alongside data.
  const query = useQuery({ queryKey: ['api', path], queryFn: async ({ signal }) => {
    const response = await requestReport(path, 'application/json', signal);
    const result = await response.json() as ReportResponse;
    if (!result?.data || !Array.isArray(result.data.rows) || !result.pagination) throw new ApiError('The service returned an unexpected report. Please retry.');
    return result;
  } });
  const report = query.data?.data;
  const pagination = query.data?.pagination;
  const selected = reports.find(item => item.value === filters.type)!;
  const totalPages = Math.max(1, Math.ceil((pagination?.total ?? 0) / pageSize));

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = Date.parse(`${draft.from}T00:00:00Z`), end = Date.parse(`${draft.to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { setFilterError('Choose a valid start and end date.'); return; }
    if (end < start) { setFilterError('The end date must be on or after the start date.'); return; }
    if ((end - start) / 86_400_000 > 365) { setFilterError('Select at most 366 business dates per report.'); return; }
    setFilterError(null); setDownloadError(null); setDownloaded(false); setPage(1); setFilters({ ...draft });
  }
  async function download() {
    setDownloading(true); setDownloadError(null); setDownloaded(false);
    try {
      const search = queryString(filters); search.set('format', 'csv');
      const response = await requestReport(`/reports/${filters.type}?${search}`, 'text/csv');
      if (!response.headers.get('content-type')?.includes('text/csv')) throw new ApiError('The service returned an unexpected export. Please retry.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${filters.type}-${filters.from}-${filters.to}.csv`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded(true);
    } catch (problem) { setDownloadError(problem instanceof Error ? problem.message : 'The report could not be exported. Please retry.'); }
    finally { setDownloading(false); }
  }

  return <>
    <PageTitle title="A clear view of your business." description="Review sales, understand ingredient costs, and plan your next move with real operational data." action={<button className="ops-button" disabled={downloading || !report || query.isError} onClick={() => void download()}><Download size={16} />{downloading ? 'Exporting…' : 'Export CSV'}</button>} />
    <Panel title="Build your report" action={<FileBarChart2 size={19} aria-hidden="true" />}>
      <form className="ops-form" onSubmit={apply}>
        <div className="ops-grid">
          <Field label="Report"><select className="ops-input" value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as ReportType })}>{reports.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
          <Field label="From date"><input className="ops-input" type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></Field>
          <Field label="To date"><input className="ops-input" type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></Field>
          {draft.type === 'sales' && <Field label="Group sales by"><select className="ops-input" value={draft.granularity} onChange={event => setDraft({ ...draft, granularity: event.target.value as Filters['granularity'] })}><option value="day">Day</option><option value="month">Month</option></select></Field>}
        </div>
        <div className="ops-actions"><button className="ops-button" type="submit">Apply filters</button><span className="ops-muted">Dates are inclusive in the restaurant business time zone{report ? ` (${report.timezone})` : ''}.</span></div>
        {draft.type === 'valuation' && <p className="ops-muted">Valuation shows current balances. Date filters do not reconstruct past inventory.</p>}
        <FormMessage error={filterError} />
      </form>
    </Panel>
    <FormMessage error={downloadError} success={downloaded ? 'CSV exported with all matching rows, including rows beyond the current page.' : null} />
    <QueryState query={query}>
      {report && <>
        <section className="dashboard-stats" aria-label="Report summary">
          {Object.entries(report.summary).map(([key, value]) => <div className="stat-card" key={key}><div className="stat-top"><span>{label(key)}</span></div><strong>{display(key, value)}</strong></div>)}
        </section>
        <Panel title={selected.label} action={<button className="ops-button ops-button-secondary" disabled={query.isFetching} onClick={() => void query.refetch()} aria-label="Refresh report"><RefreshCw size={14} className={query.isFetching ? 'spin' : ''} />Refresh</button>}>
          <p className="ops-muted">{selected.description} · {report.from} to {report.to}{filters.type === 'sales' ? ` · ${filters.granularity === 'month' ? 'Monthly' : 'Daily'}` : ''}</p>
          <DataTable columns={report.columns.map(label)} rows={report.rows.map(row => report.columns.map(column => display(column, row[column])))} empty="No records match the selected report and dates. Try another date range." />
          <div className="ops-pagination" aria-label="Report pagination">
            <span aria-live="polite">{pagination?.total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, pagination.total)} of ${pagination.total} rows` : '0 rows'} · Page {page} of {totalPages}</span>
            <button className="ops-button ops-button-secondary" disabled={page === 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>Previous</button>
            <button className="ops-button ops-button-secondary" disabled={page >= totalPages || query.isFetching} onClick={() => setPage(value => value + 1)}>Next</button>
          </div>
        </Panel>
        <Panel title="How to read this report"><ul className="ops-muted">{report.definitions.map(definition => <li key={definition}>{definition}</li>)}</ul></Panel>
      </>}
    </QueryState>
  </>;
}
