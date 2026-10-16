import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, CornerDownLeft, Search, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import './workspace-search.css';

export interface WorkspaceSearchItem {
  path: string;
  title: string;
  group?: string;
  keywords?: readonly string[];
}

interface WorkspaceSearchProps {
  /** Supply the navigation items the current user is allowed to access. */
  items: readonly WorkspaceSearchItem[];
  /** Changing the session or role closes any search left open by that user. */
  userScope?: string;
}

function searchable(value: string) {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function WorkspaceSearch({ items, userScope }: WorkspaceSearchProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K';
  const results = useMemo(() => {
    const terms = searchable(query).split(' ').filter(Boolean);
    return items.filter((item) => {
      const text = searchable([item.title, item.path, item.group, ...(item.keywords ?? [])].filter(Boolean).join(' '));
      return terms.every((term) => text.includes(term));
    });
  }, [items, query]);
  const selectedIndex = Math.min(activeIndex, Math.max(results.length - 1, 0));
  const selectedId = results.length ? `${id}-result-${selectedIndex}` : undefined;

  const close = useCallback(() => {
    if (dialog.current?.open) dialog.current.close();
  }, []);

  const restoreFocus = useCallback(() => {
    setIsOpen(false);
    const target = previousFocus.current;
    previousFocus.current = null;
    if (target?.isConnected && target !== document.body) target.focus();
    else trigger.current?.focus();
  }, []);

  const open = useCallback(() => {
    if (!dialog.current || dialog.current.open) return;
    // Leave an active order or edit dialog in control of its own keyboard shortcuts.
    const existingModal = document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], .ops-modal[role="dialog"]');
    if (existingModal && existingModal !== dialog.current) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActiveIndex(0);
    dialog.current.showModal();
    setIsOpen(true);
    input.current?.focus();
  }, []);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (dialog.current?.open) close();
      else open();
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, [close, open]);

  useEffect(() => { close(); }, [close, userScope, location.key]);

  useEffect(() => {
    if (isOpen) document.getElementById(selectedId ?? '')?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, selectedId]);

  function choose(item: WorkspaceSearchItem) {
    close();
    navigate(item.path);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActiveIndex((index) => (Math.min(index, results.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[selectedIndex];
      if (item) choose(item);
    }
  }

  return <>
    <button ref={trigger} type="button" className="workspace-search-trigger" aria-label="Search workspace" aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={`${id}-dialog`} aria-keyshortcuts="Control+k Meta+k" onClick={open}>
      <Search size={17} aria-hidden="true"/>
      <span>Search workspace</span>
      <kbd aria-hidden="true">{shortcut}</kbd>
    </button>
    <dialog ref={dialog} id={`${id}-dialog`} className="workspace-search-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClose={restoreFocus} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="workspace-search-heading">
        <div><span className="workspace-search-eyebrow">QUICK NAVIGATION</span><h2 id={`${id}-title`}>Where would you like to go?</h2><p id={`${id}-description`}>Find pages and everyday tools in your workspace.</p></div>
        <button type="button" className="workspace-search-close" aria-label="Close workspace search" onClick={close}><X size={19} aria-hidden="true"/></button>
      </div>
      <div className="workspace-search-field"><Search size={20} aria-hidden="true"/><input ref={input} type="text" role="combobox" aria-label="Search pages and tools" aria-autocomplete="list" aria-expanded={isOpen} aria-controls={`${id}-results`} aria-activedescendant={selectedId} autoComplete="off" spellCheck={false} placeholder="Try “inventory”, “orders”, or “reports”…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={onInputKeyDown}/>{query && <button type="button" aria-label="Clear workspace search" onClick={() => { setQuery(''); setActiveIndex(0); input.current?.focus(); }}><X size={16} aria-hidden="true"/></button>}</div>
      <div className="workspace-search-results">
        <div className="workspace-search-results-heading">{query.trim() ? 'SEARCH RESULTS' : 'YOUR WORKSPACE'}<span role="status" aria-live="polite">{results.length} {results.length === 1 ? 'page' : 'pages'}</span></div>
        <ul role="listbox" id={`${id}-results`} aria-label="Workspace pages">{results.map((item, index) => <li key={item.path} id={`${id}-result-${index}`} role="option" aria-selected={index === selectedIndex} className={`workspace-search-result${index === selectedIndex ? ' workspace-search-result--selected' : ''}`} onMouseMove={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
          <span className="workspace-search-result-icon"><ArrowUpRight size={18} aria-hidden="true"/></span><span className="workspace-search-result-copy"><strong>{item.title}</strong><small>{item.group?.toLowerCase() ?? 'Workspace'}</small></span>{location.pathname === item.path ? <span className="workspace-search-current">Current page</span> : <CornerDownLeft size={16} className="workspace-search-enter" aria-hidden="true"/>}
        </li>)}</ul>
        {!results.length && <div className="workspace-search-empty"><Search size={25} aria-hidden="true"/><strong>No matching pages</strong><p>Try a page name or a simpler search. Results include pages you can access.</p><button type="button" onClick={() => { setQuery(''); setActiveIndex(0); input.current?.focus(); }}>Show all workspace pages</button></div>}
      </div>
      <div className="workspace-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to move <kbd>↵</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
    </dialog>
  </>;
}
