import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { InventoryPage, type Ingredient } from './catalog';

vi.mock('../App', () => ({ useUser: () => ({ role: 'OWNER' }) }));

const ingredient = (id: string, name: string, values: Partial<Ingredient> = {}): Ingredient => ({
  id, name, sku: id.toUpperCase(), category: 'Kitchen', unit: 'G', onHand: '100', reserved: '0',
  minimumStock: '10', unitCost: '2', active: true, ...values,
});
const tomato = ingredient('tomato-1', 'Tomato', { expiresAt: '2020-01-01T00:00:00.000Z' });
const flour = ingredient('flour-1', 'Flour', { onHand: '35', reserved: '30' });
const retired = ingredient('cheese-1', 'Retired cheese', { active: false, onHand: '0' });
// Alerts are unpaginated and can contain an ingredient outside the first catalog page.
const oil = ingredient('oil-101', 'Kitchen oil', { onHand: '5' });

function NavigationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>;
}

function renderInventory(path = '/inventory', failAlerts = false) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/ingredients?pageSize=100') return Response.json({ data: [tomato, flour, retired] });
    if (path === '/api/inventory/alerts') {
      if (failAlerts) return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
      return Response.json({ data: { lowStock: [flour, oil, retired], expiring: [tomato, retired], forecasts: [] } });
    }
    return Response.json({ data: [] });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><NavigationControls/><InventoryPage/></MemoryRouter></QueryClientProvider>);
}

describe('inventory stock focus', () => {
  it('starts with active ingredients and gives inactive stock a separate, editable view', async () => {
    renderInventory();
    expect(await screen.findByText('Showing 2 of 2 ingredients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All active' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Tomato', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText('Retired cheese', { selector: 'strong' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Inactive' }));
    expect(screen.getByText('Showing 1 of 1 ingredient')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeEnabled();
    expect(screen.queryByText('Tomato', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('opens low-stock deep links using the complete alert payload and excludes inactive alerts', async () => {
    renderInventory('/inventory?focus=low-stock');
    expect(await screen.findByText('Showing 2 of 2 ingredients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Low stock' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Flour', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Kitchen oil', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText('Retired cheese', { selector: 'strong' })).not.toBeInTheDocument();
    expect(screen.queryByText('Tomato', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('combines case-insensitive SKU search with the chosen focus and explains empty results', async () => {
    renderInventory('/inventory?focus=low-stock');
    await screen.findByText('Showing 2 of 2 ingredients');
    await userEvent.type(screen.getByRole('textbox', { name: 'Search inventory' }), '  oIl-101  ');
    expect(screen.getByText('Showing 1 of 2 ingredients')).toBeInTheDocument();
    expect(screen.getByText('Kitchen oil', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText('Flour', { selector: 'strong' })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search inventory' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search inventory' }), 'Tomato');
    expect(screen.getByText('Showing 0 of 2 ingredients')).toBeInTheDocument();
    expect(screen.getByText(/No ingredients match “Tomato” in this view/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Showing 2 of 2 ingredients')).toBeInTheDocument();
  });

  it('restores the selected focus with browser history and preserves unrelated query parameters', async () => {
    renderInventory('/inventory?focus=expiring&warehouse=kitchen');
    expect(await screen.findByText('Showing 1 of 1 ingredient')).toBeInTheDocument();
    expect(screen.getByText('Tomato', { selector: 'strong' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Low stock' }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/inventory?focus=low-stock&warehouse=kitchen');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Expiring soon' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Tomato', { selector: 'strong' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByRole('button', { name: 'Low stock' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'All active' }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/inventory?warehouse=kitchen');
  });

  it('safely defaults an unknown focus to active ingredients', async () => {
    renderInventory('/inventory?focus=unknown');
    expect(await screen.findByText('Showing 2 of 2 ingredients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All active' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Retired cheese', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('shows alert service failures with retry while keeping the ordinary stock view usable', async () => {
    renderInventory('/inventory?focus=expiring', true);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByText(/No active ingredients with stock are expired/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All active' }));
    await waitFor(() => expect(screen.getByText('Showing 2 of 2 ingredients')).toBeInTheDocument());
  });
});
