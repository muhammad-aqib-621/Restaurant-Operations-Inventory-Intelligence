import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownLeft, ArrowUpRight, Bell, Boxes, ChefHat, ChevronRight, ClipboardList, CreditCard, LayoutDashboard, LogOut, Menu, PackageSearch, ReceiptText, Settings, ShieldCheck, ShoppingBasket, TrendingUp, Users, UtensilsCrossed, X } from 'lucide-react';
import { api, businessDate, dateTime, setCsrfToken, useData, useList, type AuthData, type Role, type User } from './lib/client';
import { Button } from './components/ui/button';
import { DataTable, Money, PageTitle, Panel, QueryState, Status, useModalAccessibility } from './components/operations';
import { DashboardDates, ExpiringStockNotice, ServiceShortcuts } from './components/overview-tools';
import { WorkspaceSearch } from './components/workspace-search';
import { MenuPage, InventoryPage } from './features/catalog';
import { Login } from './features/auth';
import { POSPage, OrdersPage, KitchenPage } from './features/orders';
import { UsersPage, SettingsPage, NotificationsPage, AuditPage } from './features/admin';
import { PurchasingPage, WastePage } from './features/purchasing';
import { ReportsPage } from './features/reports';

const UserContext = createContext<User | null>(null);
export function useUser() { return useContext(UserContext)!; }
const all: Role[] = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'];
const leaders: Role[] = ['OWNER', 'MANAGER'];
const nav = [
  { path: '/', title: 'Overview', icon: LayoutDashboard, roles: leaders, group: 'WORKSPACE' },
  { path: '/pos', title: 'Point of sale', icon: CreditCard, roles: ['OWNER','MANAGER','CASHIER'], group: 'SERVICE' },
  { path: '/orders', title: 'Orders', icon: ReceiptText, roles: ['OWNER','MANAGER','CASHIER','KITCHEN'] },
  { path: '/kitchen', title: 'Kitchen display', icon: ChefHat, roles: ['OWNER','MANAGER','KITCHEN'] },
  { path: '/menu', title: 'Menu & recipes', icon: UtensilsCrossed, roles: ['OWNER','MANAGER','INVENTORY'] , group: 'OPERATIONS' },
  { path: '/inventory', title: 'Inventory', icon: Boxes, roles: ['OWNER','MANAGER','INVENTORY'] },
  { path: '/purchasing', title: 'Purchasing', icon: ShoppingBasket, roles: ['OWNER','MANAGER','INVENTORY'] },
  { path: '/waste', title: 'Waste & losses', icon: ArrowDownLeft, roles: ['OWNER','MANAGER','INVENTORY'] },
  { path: '/reports', title: 'Reports', icon: TrendingUp, roles: leaders, group: 'MANAGEMENT' },
  { path: '/team', title: 'Team members', icon: Users, roles: ['OWNER'] },
  { path: '/audit', title: 'Audit trail', icon: ShieldCheck, roles: ['OWNER'] },
  { path: '/settings', title: 'Settings', icon: Settings, roles: leaders },
];
function Brand() { return <Link to="/" className="brand"><span className="brand-mark"><UtensilsCrossed size={23} /></span><span>THE COPPER TABLE<small>RESTAURANT OPERATIONS</small></span></Link>; }
function Navigation({ user, close }: { user: User; close?: () => void }) { return <nav className="navigation" aria-label="Main navigation">{nav.filter((item) => item.roles.includes(user.role)).map((item, i) => <div key={item.path}>{item.group && <span className="nav-caption">{i === 0 ? 'WORKSPACE' : item.group}</span>}<NavLink end={item.path === '/'} to={item.path} onClick={close} className={({ isActive }) => `nav-link ${isActive ? 'nav-link--active' : ''}`}><item.icon size={19}/><span>{item.title}</span><ChevronRight className="nav-chevron" size={14}/></NavLink></div>)}</nav>; }
function MobileNav({ user }: { user: User }) { const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null); return <><button className="icon-button mobile-menu-button" aria-label="Open navigation" ref={trigger} onClick={() => dialog.current?.showModal()}><Menu size={23}/></button><dialog ref={dialog} className="mobile-navigation" aria-label="Workspace navigation" onClose={() => trigger.current?.focus()} onClick={(e) => { if (e.target === e.currentTarget) dialog.current?.close(); }}><div className="mobile-nav-head"><Brand/><button className="icon-button" aria-label="Close navigation" onClick={() => dialog.current?.close()}><X size={20}/></button></div><Navigation user={user} close={() => dialog.current?.close()}/></dialog></>; }
function LiveConnection() {
  const client = useQueryClient(); const [connected, setConnected] = useState(false);
  useEffect(() => { const socket = io({ withCredentials: true }); socket.on('connect', () => { setConnected(true); void client.invalidateQueries({ queryKey: ['api'] }); }); socket.on('disconnect', () => setConnected(false)); for (const event of ['orders:changed','inventory:changed','purchasing:changed','notifications:changed','notification','catalog:changed','settings:changed']) socket.on(event, () => void client.invalidateQueries({ queryKey: ['api'] })); return () => { socket.disconnect(); }; }, [client]);
  return <span className={`live-status ${connected ? 'live-status--online' : ''}`}><i/>{connected ? 'Live updates' : 'Reconnecting…'}</span>;
}
function Workspace({ user }: { user: User }) {
  useModalAccessibility();
  const client = useQueryClient(); const location = useLocation(); const notifications = useList<{ id: string; reads?: unknown[]; read?: boolean }>('/notifications');
  const [logoutError, setLogoutError] = useState('');
  const current = nav.find((item) => item.path === location.pathname);
  const home = leaders.includes(user.role) ? '/' : user.role === 'CASHIER' ? '/pos' : user.role === 'KITCHEN' ? '/kitchen' : '/inventory';
  async function logout() { try { await api('/auth/logout', { method: 'POST', body: {} }); setCsrfToken(''); client.removeQueries({ predicate: (query) => query.queryKey[0] === 'api' && query.queryKey[1] !== '/auth/me' }); await client.invalidateQueries({ queryKey: ['api','/auth/me'] }); } catch (problem) { setLogoutError((problem as Error).message); } }
  useEffect(() => { document.title = `${current?.title ?? 'Workspace'} · The Copper Table`; window.scrollTo?.({ top: 0 }); }, [current?.title]);
  const permit = (roles: Role[], element: React.ReactNode) => roles.includes(user.role) ? element : <Navigate to={home} replace/>;
  return <UserContext.Provider value={user}><div className="app-shell"><a href="#main-content" className="skip-link">Skip to content</a><aside className="sidebar"><Brand/><Navigation user={user}/><div className="sidebar-bottom"><div className="restaurant-label"><span className="location-mark"><UtensilsCrossed size={20}/></span><div>The Copper Table<small>Restaurant workspace</small></div></div><div className="sidebar-user"><span className="user-avatar">{user.name.split(' ').map((v) => v[0]).slice(0,2).join('')}</span><div>{user.name}<small>{user.role.toLowerCase()}</small></div><button aria-label="Sign out" className="icon-button" onClick={() => void logout()}><LogOut size={17}/></button></div>{logoutError && <p role="alert" className="ops-error">{logoutError}</p>}</div></aside><div className="app-content"><header className="topbar"><div className="topbar-start"><MobileNav user={user}/><span className="topbar-breadcrumb">Workspace<ChevronRight size={14}/><strong>{current?.title ?? 'Notifications'}</strong></span></div><div className="topbar-actions"><WorkspaceSearch items={[...nav.filter((item) => item.roles.includes(user.role)), { path: '/notifications', title: 'Notifications', keywords: ['alerts', 'updates'] }]} userScope={`${user.id}:${user.role}`}/><LiveConnection/><Link className="notification-button" to="/notifications" aria-label="Notifications"><Bell size={20}/>{notifications.data?.some((n) => !n.read && !n.reads?.length) && <i/>}</Link><span className="topbar-avatar">{user.name[0]}</span><button className="mobile-signout icon-button" aria-label="Sign out" onClick={() => void logout()}><LogOut size={18}/></button></div></header><main id="main-content" className="main-content" tabIndex={-1}><Routes><Route path="/" element={permit(leaders,<Dashboard/>)}/><Route path="/pos" element={permit(['OWNER','MANAGER','CASHIER'],<POSPage/>)}/><Route path="/orders" element={permit(['OWNER','MANAGER','CASHIER','KITCHEN'],<OrdersPage/>)}/><Route path="/kitchen" element={permit(['OWNER','MANAGER','KITCHEN'],<KitchenPage/>)}/><Route path="/menu" element={permit(['OWNER','MANAGER','INVENTORY'],<MenuPage/>)}/><Route path="/inventory" element={permit(['OWNER','MANAGER','INVENTORY'],<InventoryPage/>)}/><Route path="/purchasing" element={permit(['OWNER','MANAGER','INVENTORY'],<PurchasingPage/>)}/><Route path="/waste" element={permit(['OWNER','MANAGER','INVENTORY'],<WastePage/>)}/><Route path="/reports" element={permit(leaders,<ReportsPage/>)}/><Route path="/team" element={permit(['OWNER'],<UsersPage/>)}/><Route path="/settings" element={permit(leaders,<SettingsPage/>)}/><Route path="/audit" element={permit(['OWNER'],<AuditPage/>)}/><Route path="/notifications" element={<NotificationsPage/>}/><Route path="*" element={<div className="ops-empty"><h1>This page isn’t on the menu.</h1><Link className="ops-button" to={home}>Back to workspace</Link></div>}/></Routes></main><footer className="app-footer"><span>THE COPPER TABLE <span>/ OPERATIONS & INVENTORY INTELLIGENCE</span></span><span>Made for a better service.</span></footer></div></div></UserContext.Provider>;
}
interface DashboardData { sales: string; tax: string; collected: string; refunds: string; orderCount: number; averageOrderValue: string; estimatedCogs: string; grossProfit: string; lowStockCount: number; pendingPurchases: number; wasteCost: string; bestSellers: { name: string; quantity: number; sales?: string }[]; salesSeries: { date: string; label?: string; sales: string }[]; recentOrders: { id: string; number: number; status: string; total: string; createdAt: string }[] }
function Dashboard() {
  const user = useUser(); const restaurant = useData<{ isDemo: boolean }>('/settings'); const [from, setFrom] = useState(businessDate()); const [to, setTo] = useState(businessDate()); const query = useData<DashboardData>(`/reports/dashboard?from=${from}&to=${to}`); const data = query.data;
  return <><PageTitle title={`A good day starts here, ${user.name.split(' ')[0]}.`} description="Your restaurant at a glance. Every number, connected to your operations." action={<DashboardDates range={{ from, to }} onChange={(range) => { setFrom(range.from); setTo(range.to); }}/>}/>{restaurant.data?.isDemo && <div className="demo-banner"><ShieldCheck size={16}/><span>Development workspace · Demonstration data is enabled for this restaurant.</span></div>}<ServiceShortcuts/><QueryState query={query}>{data && <><div className="dashboard-stats">{[{ label: 'Net sales', value: <Money value={data.sales}/>, icon: TrendingUp, note: 'Sales before tax' }, { label: 'Orders paid', value: data.orderCount, icon: ReceiptText, note: 'Orders with payments in this period' }, { label: 'Average order', value: <Money value={data.averageOrderValue}/>, icon: CreditCard, note: 'Per order in this period' }, { label: 'Estimated gross profit', value: <Money value={data.grossProfit}/>, icon: ShoppingBasket, note: 'Net sales less recipe cost' }].map((stat) => <div className="stat-card" key={stat.label}><div className="stat-top"><span>{stat.label}</span><stat.icon size={19}/></div><strong>{stat.value}</strong><small>{stat.note}</small></div>)}</div><div className="finance-strip">{[{label:'Estimated recipe cost',value:data.estimatedCogs},{label:'Tax collected',value:data.tax},{label:'Gross collections',value:data.collected},{label:'Refunds',value:data.refunds}].map((item)=><div key={item.label}><span>{item.label}</span><Money value={item.value}/></div>)}</div><div className="dashboard-middle"><Panel title="Sales over time" action={<span className="chart-key"><i/>Net sales · PKR</span>}><div className="sales-chart">{data.salesSeries.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={data.salesSeries.map((point) => ({ ...point, sales: Number(point.sales) }))}><defs><linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#dba83f" stopOpacity={0.3}/><stop offset="100%" stopColor="#dba83f" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#eceee8"/><XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={52}/><Tooltip formatter={(value) => [`PKR ${Number(value).toLocaleString()}`, 'Net sales']}/><Area dataKey="sales" type="monotone" stroke="#c39435" strokeWidth={2.5} fill="url(#salesGradient)"/></AreaChart></ResponsiveContainer> : <div className="ops-empty">No sales in this period. Completed orders will appear here.</div>}</div></Panel><Panel title="Needs your attention"><Link to="/inventory?focus=low-stock" className="attention-row"><span className="attention-icon amber"><PackageSearch size={21}/></span><div><strong>{data.lowStockCount} low-stock ingredients</strong><small>Review availability and reorder needs</small></div><ChevronRight size={17}/></Link><Link to="/purchasing" className="attention-row"><span className="attention-icon sage"><ShoppingBasket size={21}/></span><div><strong>{data.pendingPurchases} open purchases</strong><small>Keep incoming stock moving</small></div><ChevronRight size={17}/></Link><Link to="/waste" className="attention-row"><span className="attention-icon rose"><ArrowDownLeft size={21}/></span><div><strong><Money value={data.wasteCost}/> waste cost</strong><small>Approved losses in this period</small></div><ChevronRight size={17}/></Link><ExpiringStockNotice/><div className="attention-note"><ShieldCheck size={17}/><p>Stock, sales, and costs are calculated from your recorded activity.</p></div></Panel></div><div className="dashboard-bottom"><Panel title="Recent orders" action={<Link to="/orders" className="ops-link">View all orders<ArrowUpRight size={15}/></Link>}><DataTable columns={['Order','Placed','Status','Total']} rows={data.recentOrders.map((order) => [<Link to={`/orders?order=${order.id}`} className="record-link">#{String(order.number).padStart(4,'0')}</Link>,dateTime(order.createdAt),<Status value={order.status}/>,<Money value={order.total}/>])} empty="Your next order starts the story."/></Panel><Panel title="Guest favorites" action={<UtensilsCrossed size={18}/>}><div className="best-sellers">{data.bestSellers.length ? data.bestSellers.slice(0,5).map((item,i) => <div className="best-seller" key={`${item.name}-${i}`}><span>{String(i+1).padStart(2,'0')}</span><div><strong>{item.name}</strong><small>{item.quantity} sold</small></div>{item.sales && <Money value={item.sales}/>}</div>) : <div className="ops-empty">Your best-selling dishes will appear after orders are completed.</div>}</div></Panel></div></>}</QueryState></>;
}
export function App() {
  const auth = useData<AuthData>('/auth/me');
  const client = useQueryClient();
  const accountKey = auth.data?.user ? `${auth.data.user.id}:${auth.data.user.role}` : null;
  const [workspaceAccount, setWorkspaceAccount] = useState<string | null>(null);
  // Unmount the previous workspace before a new account can read its query cache.
  useEffect(() => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] === 'api' && query.queryKey[1] !== '/auth/me' });
    setWorkspaceAccount(accountKey);
  }, [client, accountKey]);
  useEffect(() => {
    const expire = () => {
      setCsrfToken('');
      client.removeQueries({ predicate: (query) => query.queryKey[0] === 'api' && query.queryKey[1] !== '/auth/me' });
      client.setQueryData(['api', '/auth/me'], { user: null, csrfToken: '' });
      void client.invalidateQueries({ queryKey: ['api', '/auth/me'] });
    };
    window.addEventListener('auth:expired', expire);
    return () => window.removeEventListener('auth:expired', expire);
  }, [client]);
  if (auth.isPending || (auth.data?.user && workspaceAccount !== accountKey)) return <div className="auth-loading" role="status"><UtensilsCrossed size={30}/><span>Connecting to your workspace…</span></div>;
  if (auth.isError) return <main className="auth-loading"><h1>Your workspace is temporarily unavailable.</h1><p role="alert">{auth.error.message}</p><Button onClick={() => void auth.refetch()}>Retry connection</Button></main>;
  return auth.data?.user ? <Workspace key={accountKey} user={auth.data.user}/> : <Login/>;
}
