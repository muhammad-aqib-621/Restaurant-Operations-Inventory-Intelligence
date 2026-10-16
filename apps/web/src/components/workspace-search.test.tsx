import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceSearch, type WorkspaceSearchItem } from './workspace-search';

const pages: WorkspaceSearchItem[] = [
  { path: '/pos', title: 'Point of sale', group: 'Service', keywords: ['checkout', 'take payment', 'new order'] },
  { path: '/orders', title: 'Orders', group: 'Service', keywords: ['tickets'] },
  { path: '/inventory', title: 'Inventory', group: 'Operations', keywords: ['stock', 'ingredients', 'réorder'] },
];

// jsdom has a dialog element but does not yet implement the native modal methods.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  } });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}
function SearchHarness({ items = pages, userScope = 'cashier-1' }: { items?: WorkspaceSearchItem[]; userScope?: string }) {
  return <MemoryRouter initialEntries={['/orders']}><button type="button">Customer notes</button><WorkspaceSearch items={items} userScope={userScope}/><CurrentPath/></MemoryRouter>;
}

describe('workspace quick navigation', () => {
  it('opens from its trigger, focuses search, and identifies the current page', async () => {
    render(<SearchHarness/>);
    const trigger = screen.getByRole('button', { name: 'Search workspace' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Where would you like to go?' });
    expect(within(dialog).getByRole('combobox')).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('option', { name: /Orders/ })).toHaveTextContent('Current page');
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 pages');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close workspace search' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('matches multiple action keywords and opens the result with Enter', async () => {
    render(<SearchHarness/>);
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    const input = screen.getByRole('combobox');
    await userEvent.type(input, ' TAKE payment ');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Point of sale');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option').id);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/pos');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search workspace' })).toHaveFocus();
  });

  it('wraps arrow navigation and resets the selection when the query changes', async () => {
    render(<SearchHarness/>);
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: /Inventory/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Point of sale/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Orders/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.type(screen.getByRole('combobox'), 'reorder');
    expect(screen.getByRole('option', { name: /Inventory/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/inventory');
  });

  it('limits searches to supplied permissions and recovers from an empty result', async () => {
    render(<SearchHarness items={pages.slice(0, 2)}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    await userEvent.type(screen.getByRole('combobox'), 'inventory');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No matching pages')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/orders');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all workspace pages' }));
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /Inventory/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /Point of sale/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/pos');
  });

  it('supports Ctrl and Command shortcuts and restores the original focus on Escape', async () => {
    render(<SearchHarness/>);
    const notes = screen.getByRole('button', { name: 'Customer notes' });
    notes.focus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(notes).toHaveFocus();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('combobox')).toHaveFocus();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(notes).toHaveFocus();
  });

  it('clears the search without losing input focus and closes on the native cancel event', async () => {
    render(<SearchHarness/>);
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    await userEvent.type(screen.getByRole('combobox'), 'stock');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Clear workspace search' }));
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search workspace' })).toHaveFocus();
  });

  it('dismisses an open search when the session scope changes', async () => {
    const view = render(<SearchHarness/>);
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    await userEvent.type(screen.getByRole('combobox'), 'inventory');
    view.rerender(<SearchHarness items={pages.slice(0, 2)} userScope="cashier-2"/>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Search workspace' }));
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('keeps an existing edit dialog in control of the shortcut', async () => {
    render(<><SearchHarness/><div role="dialog" aria-modal="true" aria-label="Edit order">Order details</div></>);
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Where would you like to go?' })).not.toBeInTheDocument();
  });
});
