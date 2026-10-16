import { useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { accountEmailSchema, signInSchema } from '@nk/shared';
import { z } from 'zod';
import { ArrowUpRight, Boxes, ChefHat, Eye, EyeOff, ShieldCheck, TrendingUp, UtensilsCrossed } from 'lucide-react';
import { Button } from '../components/ui/button';
import { api, ApiError, type AuthData } from '../lib/client';
import './auth.css';

const formFields = z.object({
  name: z.string().trim().optional(),
  email: accountEmailSchema,
  password: signInSchema.shape.password,
});

function authErrorMessage(problem: unknown) {
  if (problem instanceof ApiError && problem.status === 401) return 'Email or password is incorrect, or your account is awaiting approval. Check your details or ask the restaurant owner for help.';
  if (problem instanceof ApiError && problem.code === 'CSRF_REJECTED') return 'Your secure session needs to be refreshed. Reload this page and try again.';
  return problem instanceof Error ? problem.message : 'We could not complete your request. Please try again.';
}

function AuthBrand() {
  return <Link to="/" className="auth-brand" aria-label="The Copper Table home"><span className="auth-brand-mark"><UtensilsCrossed size={24} aria-hidden="true"/></span><span>THE COPPER TABLE<small>RESTAURANT OPERATIONS</small></span></Link>;
}

export function Login() {
  const client = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const submitting = useRef(false);
  const formSchema = formFields.superRefine((values, context) => {
    if (mode !== 'register') return;
    if (!values.name || values.name.length < 2) context.addIssue({ code: 'custom', path: ['name'], message: 'Enter your name (at least 2 characters).' });
    if (values.name && values.name.length > 100) context.addIssue({ code: 'custom', path: ['name'], message: 'Use a name of 100 characters or fewer.' });
    if (values.password.length < 12) context.addIssue({ code: 'custom', path: ['password'], message: 'Use at least 12 characters.' });
  });
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<z.infer<typeof formFields>>({ resolver: zodResolver(formSchema) });
  const submit = handleSubmit(async values => {
    if (submitting.current) return;
    submitting.current = true;
    setError(''); setSuccess('');
    try {
      if (mode === 'register') {
        const result = await api<{ message: string }>('/auth/register', { method: 'POST', body: { name: values.name, email: values.email, password: values.password } });
        setSuccess(result.message);
        reset({ name: '', email: '', password: '' });
        setVisible(false);
        return;
      }
      const data = await api<AuthData>('/auth/login', { method: 'POST', body: { email: values.email, password: values.password } });
      client.removeQueries({ predicate: query => query.queryKey[0] === 'api' && query.queryKey[1] !== '/auth/me' });
      client.setQueryData(['api', '/auth/me'], data);
    } catch (problem) { setError(authErrorMessage(problem)); }
    finally { submitting.current = false; }
  });
  function changeMode() {
    setMode(mode === 'login' ? 'register' : 'login');
    setError(''); setSuccess(''); setVisible(false); setCapsLock(false);
    reset({ name: '', email: '', password: '' });
  }
  function checkCapsLock(event: KeyboardEvent<HTMLInputElement>) { setCapsLock(event.getModifierState('CapsLock')); }

  return <main className="auth-page">
    <section className="auth-story" aria-label="Your restaurant workspace">
      <AuthBrand/>
      <div className="auth-story-content">
        <span className="auth-eyebrow"><span/> MADE FOR A BETTER SERVICE</span>
        <h1>Every shift.<br/>Every detail.<br/><em>All together.</em></h1>
        <p>A clear view of your restaurant, from the first order to the last plate.</p>
        <div className="auth-story-features">
          <div><span><ChefHat size={20} aria-hidden="true"/></span><p><strong>Keep service moving</strong><small>Orders flow from your till to the kitchen.</small></p></div>
          <div><span><Boxes size={20} aria-hidden="true"/></span><p><strong>Know what’s in stock</strong><small>Recipes, ingredients, and purchasing stay connected.</small></p></div>
          <div><span><TrendingUp size={20} aria-hidden="true"/></span><p><strong>See the bigger picture</strong><small>Sales and costs, ready when you need them.</small></p></div>
        </div>
      </div>
      <div className="auth-story-footer"><span>Thoughtful tools. Smoother operations.</span><UtensilsCrossed size={18} aria-hidden="true"/></div>
    </section>
    <section className="auth-form-side" aria-labelledby="auth-title">
      <div className="auth-form-card">
        <div className="auth-mobile-brand"><AuthBrand/></div>
        <span className="auth-form-eyebrow">YOUR RESTAURANT WORKSPACE</span>
        <h2 id="auth-title">{mode === 'login' ? 'Welcome back.' : 'Request an account.'}</h2>
        <p className="auth-intro">{mode === 'login' ? 'Good service starts with a clear view. Let’s sign you in.' : 'Join your team with a secure, personal sign-in.'}</p>
        <form onSubmit={event => void submit(event)} noValidate aria-busy={isSubmitting}>
          {mode === 'register' && <div className="auth-field"><label htmlFor="auth-name">Your name</label><input id="auth-name" autoComplete="name" className="ops-input" type="text" placeholder="Full name" disabled={isSubmitting} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'auth-name-error' : undefined} {...register('name')}/>{errors.name && <small id="auth-name-error" className="auth-field-error">{errors.name.message}</small>}</div>}
          <div className="auth-field"><label htmlFor="auth-email">Email address</label><input id="auth-email" autoComplete={mode === 'login' ? 'username' : 'email'} autoCapitalize="none" spellCheck={false} className="ops-input" type="email" inputMode="email" placeholder="you@restaurant.com" disabled={isSubmitting} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'auth-email-error' : undefined} {...register('email')}/>{errors.email && <small id="auth-email-error" className="auth-field-error">{errors.email.message}</small>}</div>
          <div className="auth-field"><label htmlFor="auth-password">Password</label><div className="auth-password"><input id="auth-password" className="ops-input" type={visible ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'login' ? 'Enter your password' : 'At least 12 characters'} disabled={isSubmitting} aria-invalid={Boolean(errors.password)} aria-describedby={[errors.password ? 'auth-password-error' : '', capsLock ? 'auth-caps-lock' : '', mode === 'register' ? 'auth-password-help' : ''].filter(Boolean).join(' ') || undefined} onKeyDown={checkCapsLock} onKeyUp={checkCapsLock} {...register('password', { onBlur: () => setCapsLock(false) })}/><button className="auth-password-toggle" type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} aria-controls="auth-password" disabled={isSubmitting} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={19} aria-hidden="true"/> : <Eye size={19} aria-hidden="true"/>}</button></div>{errors.password && <small id="auth-password-error" className="auth-field-error">{errors.password.message}</small>}{capsLock && <small id="auth-caps-lock" className="auth-caps-lock" role="status">Caps Lock is on.</small>}{mode === 'register' && <small id="auth-password-help" className="auth-field-hint">Use at least 12 characters. A longer passphrase is easier to remember.</small>}</div>
          {mode === 'register' && <div className="auth-approval"><ShieldCheck size={19} aria-hidden="true"/><p>Your restaurant owner will review your request and assign your role. You can sign in after approval.</p></div>}
          {error && <div role="alert" className="auth-message auth-message--error">{error}</div>}
          {success && <div role="status" className="auth-message auth-message--success">{success}</div>}
          <Button type="submit" className="auth-submit" disabled={isSubmitting}>{isSubmitting ? mode === 'login' ? 'Signing in…' : 'Submitting request…' : mode === 'login' ? 'Sign in to workspace' : 'Request account access'}<ArrowUpRight size={18} aria-hidden="true"/></Button>
        </form>
        <button type="button" className="auth-mode-toggle" onClick={changeMode} disabled={isSubmitting}>{mode === 'login' ? 'Need an account? Request access' : 'Already have an account? Sign in'}</button>
        <div className="auth-security"><ShieldCheck size={16} aria-hidden="true"/><span>Secure access. The right tools for every role.</span></div>
      </div>
      <small className="auth-copyright">The Copper Table <span>·</span> Built for your team.</small>
    </section>
  </main>;
}
