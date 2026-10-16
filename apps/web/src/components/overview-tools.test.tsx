import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DashboardDates, dashboardDateRange, ExpiringStockNotice } from './overview-tools';

describe('dashboard period selection', () => {
  it('includes seven calendar days across year and leap-year boundaries', () => {
    expect(dashboardDateRange('week', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(dashboardDateRange('week', '2024-03-02')).toEqual({ from: '2024-02-25', to: '2024-03-02' });
    expect(dashboardDateRange('month', '2026-10-17')).toEqual({ from: '2026-10-01', to: '2026-10-17' });
  });
  it('prevents inverted date ranges when either boundary changes', () => {
    const onChange = vi.fn();
    render(<DashboardDates range={{ from: '2026-10-10', to: '2026-10-17' }} onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('Dashboard from date'), { target: { value: '2026-10-20' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-20', to: '2026-10-20' });
    fireEvent.change(screen.getByLabelText('Dashboard to date'), { target: { value: '2026-10-02' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-02', to: '2026-10-02' });
  });
  it('applies a date preset with one action', async () => {
    const onChange = vi.fn();
    render(<DashboardDates range={{ from: '2026-01-01', to: '2026-01-01' }} onChange={onChange}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    expect(onChange).toHaveBeenCalledWith(dashboardDateRange('week'));
  });
});

describe('live expiry reminders', () => {
  function renderNotice() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(<QueryClientProvider client={client}><MemoryRouter><ExpiringStockNotice/></MemoryRouter></QueryClientProvider>);
  }
  it('links real expiry alerts to the focused inventory view', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { expiring: [{ id: 'milk', name: 'Milk' }, { id: 'cream', name: 'Cream' }] } })));
    renderNotice();
    const link = await screen.findByRole('link', { name: /2 ingredients to review for expiry/ });
    expect(link).toHaveAttribute('href', '/inventory?focus=expiring');
    expect(link).toHaveTextContent('Milk, Cream');
  });
  it('reports unavailable data without inventing a zero count and supports retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 })).mockResolvedValueOnce(Response.json({ data: { expiring: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    renderNotice();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry expiry check' }));
    expect(await screen.findByRole('link', { name: /0 ingredients to review for expiry/ })).toHaveTextContent('No stocked ingredients expiring in the next 7 days');
  });
});
