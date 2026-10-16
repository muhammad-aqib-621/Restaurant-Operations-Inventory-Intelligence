import { Link } from 'react-router-dom';
import { ArrowUpRight, ChefHat, CreditCard, PackageSearch, TrendingUp } from 'lucide-react';
import { businessDate, useData } from '../lib/client';
import './overview-tools.css';

export type DateRange = { from: string; to: string };
export type DatePreset = 'today' | 'week' | 'month';

export function dashboardDateRange(preset: DatePreset, today = businessDate()): DateRange {
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'week') {
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: start.toISOString().slice(0, 10), to: today };
  }
  return { from: today, to: today };
}

export function DashboardDates({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  return <div className="overview-date-controls">
    <div className="overview-presets" role="group" aria-label="Dashboard date presets">
      {([['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']] as const).map(([preset, label]) => {
        const next = dashboardDateRange(preset);
        return <button key={preset} type="button" aria-pressed={range.from === next.from && range.to === next.to} onClick={() => onChange(next)}>{label}</button>;
      })}
    </div>
    <div className="date-filter">
      <label>From<input aria-label="Dashboard from date" className="ops-input" type="date" value={range.from} onChange={(event) => { const from = event.target.value; if (from) onChange({ from, to: from > range.to ? from : range.to }); }}/></label>
      <label>To<input aria-label="Dashboard to date" className="ops-input" type="date" value={range.to} onChange={(event) => { const to = event.target.value; if (to) onChange({ from: to < range.from ? to : range.from, to }); }}/></label>
    </div>
  </div>;
}

export function ServiceShortcuts() {
  return <section className="service-shortcuts" aria-label="Service shortcuts">
    <div className="service-shortcuts-label"><span className="ops-eyebrow">READY FOR SERVICE</span><strong>Make the next move.</strong></div>
    {[
      { to: '/pos', title: 'New sale', description: 'Take an order', icon: CreditCard },
      { to: '/kitchen', title: 'Kitchen queue', description: 'Keep service moving', icon: ChefHat },
      { to: '/reports', title: 'Explore reports', description: 'See the bigger picture', icon: TrendingUp },
    ].map((action) => <Link className="service-shortcut" to={action.to} key={action.to}><action.icon size={19}/><span><strong>{action.title}</strong><small>{action.description}</small></span><ArrowUpRight size={16}/></Link>)}
  </section>;
}

interface StockAlerts { expiring: { id: string; name: string }[]; asOf?: string }
export function ExpiringStockNotice() {
  const alerts = useData<StockAlerts>('/inventory/alerts');
  if (alerts.isPending) return <p className="overview-stock-status" role="status">Checking expiry reminders…</p>;
  if (alerts.isError) return <div className="overview-stock-status"><span>Expiry reminders are temporarily unavailable.</span><button type="button" className="ops-link" onClick={() => void alerts.refetch()}>Retry expiry check</button></div>;
  const expiring = alerts.data?.expiring ?? [];
  return <Link to="/inventory?focus=expiring" className="attention-row"><span className="attention-icon rose"><PackageSearch size={21}/></span><div><strong>{expiring.length} ingredients to review for expiry</strong><small>{expiring.length ? `${expiring.slice(0, 2).map((item) => item.name).join(', ')}${expiring.length > 2 ? ` +${expiring.length - 2} more` : ''}` : 'No stocked ingredients expiring in the next 7 days'}</small></div><ArrowUpRight size={17}/></Link>;
}
