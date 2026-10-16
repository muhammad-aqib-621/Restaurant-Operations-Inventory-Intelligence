import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from './auth';
import { setCsrfToken } from '../lib/client';

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Login/></MemoryRouter></QueryClientProvider>);
  return client;
}
async function fillSignIn(email = ' OWNER@EXAMPLE.TEST ', password = 'a-long-password') {
  await userEvent.type(screen.getByLabelText('Email address'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
}
afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(''); });

describe('restaurant sign-in', () => {
  it('normalizes pasted email, preserves the password, and clears the previous account cache', async () => {
    const user = { id: 'owner-1', name: 'Owner', role: 'OWNER', active: true, email: 'owner@example.test' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { user, csrfToken: 'signed-in' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = renderLogin(); client.setQueryData(['api', '/orders'], [{ id: 'previous-user-order' }]);
    await fillSignIn(' OWNER@EXAMPLE.TEST ', ' my-passphrase ');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to workspace' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ body: JSON.stringify({ email: 'owner@example.test', password: ' my-passphrase ' }) }));
    expect(client.getQueryData(['api', '/auth/me'])).toEqual({ user, csrfToken: 'signed-in' });
    expect(client.getQueryData(['api', '/orders'])).toBeUndefined();
    expect(screen.queryByText(/DEMO_PASSWORD|\.env|Local demo/)).not.toBeInTheDocument();
  });
  it('connects field validation errors to their inputs before submitting', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); renderLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to workspace' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email address')).toHaveAccessibleDescription('Enter a valid email address.');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('lets the user inspect their password and warns about Caps Lock', async () => {
    renderLogin(); await fillSignIn();
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text'); expect(password).toHaveValue('a-long-password');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
    const event = new KeyboardEvent('keydown', { bubbles: true, key: 'A' });
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'CapsLock' });
    fireEvent(password, event);
    expect(screen.getByRole('status')).toHaveTextContent('Caps Lock is on.');
    fireEvent.blur(password); expect(screen.queryByText('Caps Lock is on.')).not.toBeInTheDocument();
  });
  it('prevents an overlong UTF-8 password from being sent to the service', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); renderLogin();
    await fillSignIn('owner@example.test', 'é'.repeat(37));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to workspace' }));
    expect(await screen.findByText('Use a password of 72 bytes or fewer.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps credentials available for retry after a connection failure', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Network disconnected')).mockResolvedValueOnce(Response.json({ data: { user: { id: 'owner-1' }, csrfToken: 'signed-in' } }));
    vi.stubGlobal('fetch', fetchMock); const client = renderLogin();
    await fillSignIn(); await userEvent.click(screen.getByRole('button', { name: 'Sign in to workspace' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Check your connection and try again.'); expect(alert).not.toHaveTextContent(/npm|PostgreSQL|\.env/);
    expect(screen.getByLabelText('Password')).toHaveValue('a-long-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to workspace' }));
    expect(client.getQueryData(['api', '/auth/me'])).toMatchObject({ user: { id: 'owner-1' } });
  });
  it('submits an access request without logging the applicant in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { message: 'Your account request has been submitted for owner review.' } }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock); const client = renderLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Need an account? Request access' }));
    expect(screen.getByText(/You can sign in after approval/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your name'), ' New Teammate '); await fillSignIn();
    await userEvent.click(screen.getByRole('button', { name: 'Request account access' }));
    expect(await screen.findByRole('status')).toHaveTextContent('owner review');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/register', expect.objectContaining({ body: JSON.stringify({ name: 'New Teammate', email: 'owner@example.test', password: 'a-long-password' }) }));
    expect(client.getQueryData(['api', '/auth/me'])).toBeUndefined(); expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
