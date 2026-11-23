// Role-based login, the agent's PKT home / result / training refresher, and the trainer's
// Assign, Analytics and User Access screens.
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, AlertTriangle, ArrowLeft, Award, BarChart3, BookOpen, CheckCircle2, ChevronDown, ChevronUp, Circle, Clock, Download,
  FileUp, GraduationCap, Headphones, Layers, ListChecks, Loader2, Lock, Play, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles,
  Trash2, Trophy, UserCog, UserPlus, Users, XCircle,
} from 'lucide-react';
import { BarList, Heatmap, TrendChart } from './charts';
import { vendorFromEmail, type VendorMatch } from './vendor-email';
import { hoursLabel, releaseLabel } from './app-config';
import { useAppConfig } from './use-config';
import { BatchesPanel, LeaderboardPanel } from './admin-ui';
import { clsx, type ClassValue } from 'clsx';
// nosemgrep: ssc-b9f8e938-4de9-4305-93e1-fe2997ee8bde
// @e965/xlsx is a security-patched fork of xlsx that resolves CVE-2023-30533.
import * as XLSX from '@e965/xlsx';

const cn = (...inputs: ClassValue[]) => clsx(inputs);

// ── shared types ──────────────────────────────────────────────────────────────

export type Role = 'agent' | 'trainer' | 'admin' | 'super_admin';
export const ROLE_LEVEL: Record<Role, number> = { agent: 0, trainer: 1, admin: 2, super_admin: 3 };
export const ROLE_LABEL: Record<Role, string> = { agent: 'Agent', trainer: 'Trainer', admin: 'Admin', super_admin: 'Super Admin' };

export interface SessionUser { email: string; name: string; role: Role; view: Role; }
export interface PodInfo { name: string; training_days: number; }

type DialogType = 'error' | 'warning' | 'success' | 'confirm' | 'info';
export type ShowDialog = (cfg: { type: DialogType; title: string; message: string; confirmLabel?: string; onConfirm?: () => void }) => void;

interface UnitState { unit: number; label: string; state: 'passed' | 'failed' | 'open' | 'locked' | 'upcoming' | 'missed'; opensAt: number; best: number | null; attempts: number; }
interface TraineeState {
  status: 'not_started' | 'in_progress' | 'reattempt' | 'passed' | 'exit';
  unit: number | null; unitLabel: string; canStart: boolean; opensAt: number | null;
  attemptNo: number; attemptsUsed: number; maxAttempts: number; threshold: number;
  lastFailedAttemptId: number | null; needsRefresher: boolean; reattemptAt: number | null;
  nextPktAt: number | null; overdue: boolean; overdueSince: number | null; missedPkts: number; exitReason: 'failed' | 'legacy' | null; units: UnitState[];
}
interface Enrollment {
  trainee_id: number; batch_no: string; vendor: string; pod: string; kind: 'new' | 'old';
  start_date: string; training_days: number; state: TraineeState; certificate_id: string | null;
  attempts: Array<{ id: number; unit: number; attempt_no: number; percent: number; passed: boolean; created_at: string; has_coaching: boolean; refresher_done_at: number | null }>;
}
interface Coaching {
  summary: string;
  focusAreas: Array<{ topic: string; yourMistake: string; correctSop: string; sopExcerpt?: string; howToHandle: string }>;
  quiz: Array<{ question: string; options: string[]; correctIndex: number; why: string }>;
}
export interface PktResult {
  attempt_id: number; unitLabel: string; attemptNo: number; maxAttempts: number; threshold: number;
  score: number; total: number; percent: number; passed: boolean; exited?: boolean; canReattempt?: boolean;
  coaching: Coaching | null; refresher_done_at?: number | null; reattempt_at?: number | null; certificate_id?: string | null;
  details: Array<{ scenario: string; options: string[]; correctAnswerIndex: number; userAnswer: number; explanation: string; sopPoint: string; topic?: string }>;
}

const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata' };
export const fmtWhen = (v: number | string | null | undefined) => {
  if (v === null || v === undefined || v === '') return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).includes('T') || String(v).endsWith('Z') ? v : `${String(v).replace(' ', 'T')}Z`);
  return d.toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const fmtDate = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`);

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { data, status: res.status });
  return data as T;
}

// small, consistent building blocks so every screen lines up the same way
export function PageHeader({ eyebrow, title, accent, subtitle, right }: { eyebrow: string; title: string; accent?: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 flex-1 space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#C026D3]">{eyebrow}</p>
        <h2 className="text-[clamp(2.2rem,5vw,3.5rem)] font-extrabold leading-[1.02] tracking-tight text-ink">
          {title} {accent && <span className="text-gradient">{accent}</span>}
        </h2>
        {subtitle && <p className="max-w-2xl text-base text-ink-soft sm:text-lg">{subtitle}</p>}
      </div>
      {right && <div className="min-w-0 lg:max-w-[55%]">{right}</div>}
    </div>
  );
}

export function TabBar<T extends string>({ tabs, active, onChange }: { tabs: Array<{ id: T; label: string; icon: React.ElementType }>; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex w-full max-w-full flex-wrap gap-1.5 rounded-3xl bg-[#F2EEFC] p-1.5 sm:w-fit" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2.5 text-sm font-semibold transition-all sm:flex-none',
            active === tab.id ? 'bg-white text-ink shadow-[0_8px_20px_rgba(166,77,224,0.14)]' : 'text-ink-soft hover:text-ink'
          )}
          role="tab"
          aria-selected={active === tab.id}
        >
          <tab.icon size={16} /> {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('float-card p-5 sm:p-8', className)}>{children}</div>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">{children}</label>;
}

const STATUS_STYLE: Record<string, { cls: string; icon: React.ElementType }> = {
  not_started: { cls: 'bg-slate-100 text-slate-700', icon: Circle },
  in_progress: { cls: 'bg-blue-50 text-blue-800', icon: Play },
  reattempt: { cls: 'bg-amber-50 text-amber-900', icon: BookOpen },
  passed: { cls: 'bg-emerald-50 text-emerald-800', icon: CheckCircle2 },
  exit: { cls: 'bg-rose-50 text-rose-800', icon: XCircle },
  overdue: { cls: 'bg-orange-100 text-orange-900', icon: Clock },
};

export function StatusPill({ status, label }: { status: string; label: string }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.not_started;
  return (
    <span className={cn('inline-flex w-fit shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold', s.cls)}>
      <s.icon size={12} aria-hidden /> {label}
    </span>
  );
}

// ── login ─────────────────────────────────────────────────────────────────────

const LOGIN_CARDS: Array<{ role: Role; icon: React.ElementType; blurb: string }> = [
  { role: 'agent', icon: Headphones, blurb: 'Everyone with a Meesho account. Take your daily PKT, see your scores, refresher, certificate and your batch leaderboard during training.' },
  { role: 'trainer', icon: GraduationCap, blurb: 'Assign agents, manage batches, and track PKT scores, TNI, top issues and overdue agents for your vendors and pods.' },
  { role: 'admin', icon: UserCog, blurb: 'Manage pods, training days and SOPs, plus everything trainers can do.' },
  { role: 'super_admin', icon: ShieldCheck, blurb: 'Full access, including who gets Trainer and Admin access.' },
];

const AUTH_ERRORS: Record<string, string> = {
  domain_restricted: 'Only verified @meesho.com Google accounts can sign in.',
  access_denied: 'Google sign-in was cancelled.',
  not_configured: 'Google sign-in is not configured yet.',
  server_error: 'Something went wrong with Google sign-in. Please try again.',
  expired: 'That sign-in link expired. Please sign in again.',
};

export function RoleLoginView() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  const deniedAs = params.get('as') as Role | null;
  const errorText = authError === 'no_access'
    ? `Your account doesn't have ${deniedAs ? ROLE_LABEL[deniedAs] : 'that'} access. Ask the Super Admin to add you.`
    : authError ? AUTH_ERRORS[authError] || 'Sign-in failed. Please try again.' : '';

  return (
    <div className="min-h-screen pb-20">
      <div className="mx-auto max-w-6xl px-4 pt-5 sm:px-6">
        <div className="flex items-center justify-between rounded-full bg-[#7A1C86] px-3 py-2 text-white sm:px-4">
          <div className="flex items-center gap-2.5 pl-1">
            <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Meesho_logo.png/500px-Meesho_logo.png" alt="Meesho" className="h-7 w-auto rounded-md bg-white p-1 object-contain" />
            <span className="text-[15px] font-semibold">ReadyCheck</span>
          </div>
        </div>
      </div>

      <section className="mx-auto max-w-5xl px-6 pb-4 pt-14 text-center sm:pt-20">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#A21CAF]">Backed by the SOP</p>
        <h1 className="display-heading mt-6">
          Stay <span className="word-magenta">SOP-ready,</span>
          <br />
          every <span className="word-lilac">day.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-ink-soft sm:text-xl">Get ready in training. Stay ready on the floor.</p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <a href="/auth/google" className="btn-primary !px-8 !py-4 text-base">Sign in with Google</a>
          <p className="text-sm text-ink-soft">Use your Meesho account. You'll land in the highest view you have access to, and can switch views from the top bar.</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        {errorText && (
          <div className="mx-auto mb-6 flex max-w-3xl items-start gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle size={18} className="mt-0.5 shrink-0" /> <span>{errorText}</span>
          </div>
        )}
        <p className="mb-4 mt-6 text-center text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Who sees what</p>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {LOGIN_CARDS.map(({ role, icon: Icon, blurb }) => (
            <div key={role} className="category-card flex h-full flex-col p-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-meesho-purple">
                <Icon size={28} strokeWidth={1.6} aria-hidden />
              </div>
              <h3 className="mt-5 text-2xl font-bold tracking-tight text-ink">{ROLE_LABEL[role]}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-soft">{blurb}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ViewSwitcher({ user, onSwitch }: { user: SessionUser; onSwitch: (v: Role) => void }) {
  const allowed = (Object.keys(ROLE_LEVEL) as Role[]).filter((r) => ROLE_LEVEL[r] <= ROLE_LEVEL[user.role]);
  if (allowed.length < 2) return null;
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Switch view</span>
      <select
        value={user.view}
        onChange={(e) => onSwitch(e.target.value as Role)}
        className="appearance-none rounded-full bg-white/15 py-2 pl-4 pr-9 text-sm font-semibold text-white outline-none hover:bg-white/25"
      >
        {allowed.map((r) => <option key={r} value={r} className="text-ink">{ROLE_LABEL[r]} view</option>)}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 text-white/80" />
    </label>
  );
}

// ── agent: PKT home ──────────────────────────────────────────────────────────

const UNIT_STYLE: Record<UnitState['state'], string> = {
  passed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  open: 'bg-white text-meesho-purple ring-meesho-purple',
  locked: 'bg-white text-ink-soft ring-slate-200',
  upcoming: 'bg-white/60 text-slate-400 ring-slate-100',
  missed: 'bg-amber-50 text-amber-700 ring-amber-200',
};

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function countdown(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function AgentHome({ user, onStart, onOpenResult, onOpenRefresher, onOpenCertificate }: {
  user: SessionUser;
  onStart: (traineeId: number, unitLabel: string) => void;
  onOpenResult: (attemptId: number) => void;
  onOpenRefresher: (attemptId: number) => void;
  onOpenCertificate: (id: string) => void;
}) {
  const cfg = useAppConfig();
  const [items, setItems] = useState<Enrollment[] | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'pkts' | 'leaderboard'>('pkts');
  const now = useNow();
  const wait = hoursLabel(cfg.coolDownHours);

  const load = () => api<{ show_leaderboard: boolean; items: Enrollment[] }>('/api/my/pkts')
    .then((d) => { setItems(d.items); setShowBoard(d.show_leaderboard); if (!d.show_leaderboard) setTab('pkts'); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  // refresh when a waiting PKT or cool-down is due to open
  useEffect(() => {
    if (!items) return;
    const due = items.some((it) => {
      const t = it.state.reattemptAt ?? it.state.opensAt;
      return !it.state.canStart && t && t <= now;
    });
    if (due) load();
  }, [now]);

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 pb-24 sm:px-6 lg:px-10">
      <PageHeader eyebrow="Agent" title="Your" accent="PKTs" subtitle={`Signed in as ${user.email}. New PKTs open at ${releaseLabel(cfg)} IST on their day.`}
        right={showBoard ? <TabBar<'pkts' | 'leaderboard'> tabs={[{ id: 'pkts', label: 'My PKTs', icon: ListChecks }, { id: 'leaderboard', label: 'Leaderboard', icon: Trophy }]} active={tab} onChange={setTab} /> : undefined} />

      {tab === 'leaderboard' && <LeaderboardPanel staff={false} />}
      {tab === 'pkts' && (<>
      <div className="flex justify-end"><button onClick={load} className="inline-flex items-center gap-2 rounded-full bg-[#F2EEFC] px-4 py-2.5 text-sm font-semibold text-ink hover:bg-[#E8E1F8]"><RefreshCw size={15} aria-hidden /> Refresh</button></div>
      {error && <Card><p className="text-rose-800">{error}</p></Card>}
      {!items && !error && <div className="flex justify-center py-24"><Loader2 className="animate-spin text-meesho-purple" size={36} /></div>}
      {items && items.length === 0 && (
        <Card className="py-14 text-center">
          <BookOpen className="mx-auto text-meesho-purple" size={40} strokeWidth={1.5} aria-hidden />
          <h3 className="mt-4 text-2xl font-bold text-ink">No PKTs assigned yet</h3>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">Your trainer hasn't added you to a batch. Once they do, your PKTs show up here automatically.</p>
        </Card>
      )}

      {items?.map((it) => {
        const s = it.state;
        const lastFailed = it.attempts.find((a) => a.id === s.lastFailedAttemptId);
        const statusLabel = s.status === 'reattempt' ? 'Refresher / reattempt' : s.status === 'not_started' ? 'Not started' : s.status === 'in_progress' ? 'In progress' : s.status === 'passed' ? 'Passed' : 'Exit';
        return (
          <Card key={it.trainee_id} className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">{it.kind === 'new' ? 'New agent training' : 'Production refresher PKT'} · {it.vendor}</p>
                <h3 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">{it.pod}</h3>
                <p className="mt-1 text-sm text-ink-soft">Batch {it.batch_no} · started {fmtDate(it.start_date)} · pass mark {s.threshold}%</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {s.overdue && <StatusPill status="overdue" label="Overdue" />}
                <StatusPill status={s.status} label={statusLabel} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {s.units.map((u) => (
                <span key={u.unit} className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1', UNIT_STYLE[u.state])}>
                  {u.state === 'passed' ? <CheckCircle2 size={13} aria-hidden /> : u.state === 'failed' ? <XCircle size={13} aria-hidden /> : u.state === 'locked' || u.state === 'upcoming' ? <Lock size={12} aria-hidden /> : u.state === 'missed' ? <AlertCircle size={13} aria-hidden /> : <Play size={12} aria-hidden />}
                  {u.label}{u.best !== null ? ` · ${pct(u.best)}` : ''}{u.state === 'missed' ? ' · missed' : ''}
                </span>
              ))}
            </div>

            {s.overdue && (
              <div className="flex items-start gap-3 rounded-2xl bg-orange-50 px-4 py-3 text-sm font-semibold text-orange-900">
                <Clock size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  {s.needsRefresher ? 'Your training refresher is overdue. Finish it today so you can reattempt.' : `${s.unitLabel} is overdue. Please take it today.`}
                  {s.missedPkts > 0 ? ` You have missed ${s.missedPkts} fortnightly PKT${s.missedPkts > 1 ? 's' : ''}.` : ''}
                </span>
              </div>
            )}

            <div className="rounded-3xl bg-[#F7F5FF] p-5 sm:p-6">
              {s.status === 'exit' && (
                <Action icon={XCircle} tone="rose" title="You've been marked Exit"
                  text={`You didn't reach ${s.threshold}% on ${s.unitLabel} after ${s.maxAttempts} attempt${s.maxAttempts > 1 ? 's' : ''}. Please talk to your trainer.`} />
              )}
              {s.status === 'passed' && (
                <Action icon={CheckCircle2} tone="emerald" title={it.kind === 'new' ? 'All training days passed' : `${s.unitLabel} passed`}
                  text={it.kind === 'new' ? 'Great work — you have cleared every day of this training.' : `Your next PKT opens on ${fmtWhen(s.nextPktAt)}.`}
                  button={it.certificate_id ? <button onClick={() => onOpenCertificate(it.certificate_id!)} className="btn-primary w-full sm:w-auto"><Award size={16} aria-hidden /> View certificate</button> : undefined} />
              )}
              {s.status !== 'exit' && s.status !== 'passed' && s.needsRefresher && lastFailed && (
                <Action icon={BookOpen} tone="amber" title={`Training refresher for ${s.unitLabel}`}
                  text={`You scored ${pct(lastFailed.percent)} (pass mark ${s.threshold}%). Go through your refresher and get every practice question right. Your reattempt opens ${wait === 'straight away' ? 'as soon as you finish it' : `${wait} after you finish it`}.`}
                  button={<button onClick={() => onOpenRefresher(lastFailed.id)} className="btn-primary w-full sm:w-auto"><BookOpen size={16} aria-hidden /> Open training refresher</button>} />
              )}
              {s.status === 'reattempt' && !s.needsRefresher && s.reattemptAt && now < s.reattemptAt && (
                <Action icon={Clock} tone="blue" title={cfg.refresherRequired ? 'Refresher done — cool-down running' : 'Reattempt opens soon'}
                  text={`Your reattempt of ${s.unitLabel} opens at ${fmtWhen(s.reattemptAt)} (in ${countdown(s.reattemptAt - now)}).`}
                  button={lastFailed ? <button onClick={() => onOpenRefresher(lastFailed.id)} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-meesho-purple sm:w-auto">{cfg.refresherRequired ? 'Review refresher' : 'Open training refresher'}</button> : undefined} />
              )}
              {s.status !== 'exit' && s.status !== 'passed' && !s.canStart && !s.needsRefresher && !(s.reattemptAt && now < s.reattemptAt) && (
                <Action icon={Lock} tone="slate" title={`${s.unitLabel} PKT is not open yet`} text={s.opensAt ? `It opens at ${fmtWhen(s.opensAt)}.` : 'It will open soon.'} />
              )}
              {s.canStart && (
                <Action icon={Play} tone="purple" title={`${s.unitLabel} PKT is open`}
                  text={`Attempt ${s.attemptNo} of ${s.maxAttempts} · ${cfg.questionsPerPkt} questions · ${cfg.testMinutes} minutes · pass mark ${s.threshold}%.`}
                  button={<button onClick={() => onStart(it.trainee_id, s.unitLabel)} className="btn-primary w-full sm:w-auto"><Play size={16} aria-hidden /> {s.attemptNo > 1 ? 'Start reattempt' : 'Start PKT'}</button>} />
              )}
            </div>

            {it.attempts.length > 0 && (
              <div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-[0.1em] text-ink-soft">
                      <th className="py-2 pr-3 font-semibold">PKT</th>
                      <th className="py-2 pr-3 font-semibold">Score</th><th className="py-2 pr-3 font-semibold">When</th><th className="py-2 text-right font-semibold" />
                    </tr>
                  </thead>
                  <tbody>
                    {[...it.attempts].reverse().map((a) => (
                      <tr key={a.id} className="border-t border-slate-100">
                        <td className="py-3 pr-3 text-ink"><span className="font-semibold">{it.kind === 'new' ? `Day ${a.unit}` : `PKT ${a.unit}`}</span><span className="block text-xs text-ink-soft">attempt {a.attempt_no}</span></td>
                        <td className={cn('py-3 pr-3 font-semibold', a.passed ? 'text-emerald-600' : 'text-rose-600')}>{pct(a.percent)}</td>
                        <td className="py-3 pr-3 text-ink-soft">{fmtWhen(a.created_at)}</td>
                        <td className="py-3 text-right">
                          <button onClick={() => onOpenResult(a.id)} className="font-semibold text-meesho-purple hover:underline">Review</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
      </>)}
    </div>
  );
}

const TONE: Record<string, string> = {
  rose: 'bg-rose-100 text-rose-600', emerald: 'bg-emerald-100 text-emerald-600', amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-blue-100 text-blue-600', slate: 'bg-slate-200 text-slate-600', purple: 'bg-[#EADCF8] text-meesho-purple',
};

function Action({ icon: Icon, tone, title, text, button }: { icon: React.ElementType; tone: string; title: string; text: string; button?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl', TONE[tone])}><Icon size={22} /></div>
        <div className="min-w-0">
          <p className="text-lg font-bold text-ink">{title}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{text}</p>
        </div>
      </div>
      {button && <div className="shrink-0">{button}</div>}
    </div>
  );
}

// ── agent: result and answer review ──────────────────────────────────────────

export function PktResultView({ result, onRefresher, onHome, onCertificate }: { result: PktResult; onRefresher: () => void; onHome: () => void; onCertificate?: (id: string) => void }) {
  const cfg = useAppConfig();
  const [open, setOpen] = useState<number | null>(null);
  const exited = result.exited ?? (!result.passed && result.attemptNo >= result.maxAttempts);
  const canReattempt = result.canReattempt ?? (!result.passed && !exited);
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 pb-24 sm:px-6 lg:px-10">
      <button onClick={onHome} className="inline-flex items-center gap-2 text-sm font-semibold text-ink-soft hover:text-meesho-purple"><ArrowLeft size={16} /> Back to my PKTs</button>
      <Card className="text-center">
        <p className="eyebrow">{result.unitLabel} · attempt {result.attemptNo} of {result.maxAttempts}</p>
        <p className={cn('mt-4 text-[clamp(4rem,12vw,6.5rem)] font-bold leading-none tracking-tight', result.passed ? 'text-emerald-500' : 'text-rose-500')}>{pct(result.percent)}</p>
        <p className="mt-3 text-ink-soft">{result.score} of {result.total} correct · pass mark {result.threshold}%</p>
        <div className="mx-auto mt-6 max-w-xl text-left">
          {result.passed && <Action icon={CheckCircle2} tone="emerald" title="Passed" text={result.certificate_id ? 'Well done — you have completed the whole training. Your certificate is ready.' : 'Well done. Your next PKT will show up on your home page when it opens.'}
            button={result.certificate_id && onCertificate ? <button onClick={() => onCertificate(result.certificate_id!)} className="btn-primary w-full sm:w-auto"><Award size={16} aria-hidden /> View certificate</button> : undefined} />}
          {exited && <Action icon={XCircle} tone="rose" title="Marked Exit" text={`This was your last attempt and it was below ${result.threshold}%. Please talk to your trainer.`} />}
          {canReattempt && !result.refresher_done_at && (
            <div className="space-y-5">
              <Action icon={BookOpen} tone="amber" title="Below the pass mark"
                text={`Open your training refresher now. It shows the SOP points you missed and how to handle them. ${cfg.refresherRequired ? `Your reattempt opens ${hoursLabel(cfg.coolDownHours) === 'straight away' ? 'as soon as you finish it' : `${hoursLabel(cfg.coolDownHours)} after you finish it`}.` : `Your reattempt opens ${hoursLabel(cfg.coolDownHours) === 'straight away' ? 'straight away' : `${hoursLabel(cfg.coolDownHours)} after this attempt`}.`}`} />
              <button onClick={onRefresher} className="btn-primary w-full"><BookOpen size={16} /> Open training refresher</button>
            </div>
          )}
          {canReattempt && result.refresher_done_at && (
            <div className="space-y-5">
              <Action icon={CheckCircle2} tone="blue" title="Refresher completed"
                text={`You finished the training refresher on ${fmtWhen(result.refresher_done_at)}.${result.reattempt_at ? ` The reattempt opens at ${fmtWhen(result.reattempt_at)}.` : ''}`} />
              <button onClick={onRefresher} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink hover:bg-[#E8E1F8]"><BookOpen size={16} /> Review refresher</button>
            </div>
          )}
        </div>
      </Card>

      <div className="space-y-3">
        <h3 className="px-1 text-xl font-bold text-ink">Answer review</h3>
        {result.details.map((q, i) => {
          const right = q.userAnswer === q.correctAnswerIndex;
          return (
            <div key={i} className="float-card overflow-hidden">
              <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-start gap-3 p-5 text-left">
                {right ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-500" size={20} /> : <XCircle className="mt-0.5 shrink-0 text-rose-500" size={20} />}
                <span className="min-w-0 flex-1 font-medium text-ink">{i + 1}. {q.scenario}</span>
                {open === i ? <ChevronUp className="shrink-0 text-ink-soft" size={18} /> : <ChevronDown className="shrink-0 text-ink-soft" size={18} />}
              </button>
              {open === i && (
                <div className="space-y-3 border-t border-slate-100 px-5 pb-5 pt-4 text-sm">
                  {q.options.map((o, oi) => (
                    <p key={oi} className={cn('rounded-xl px-4 py-2.5',
                      oi === q.correctAnswerIndex ? 'bg-emerald-50 font-semibold text-emerald-800' : oi === q.userAnswer ? 'bg-rose-50 text-rose-700' : 'bg-slate-50 text-ink-soft')}>
                      {String.fromCharCode(65 + oi)}. {o}{oi === q.userAnswer && oi !== q.correctAnswerIndex ? ' (your answer)' : ''}
                    </p>
                  ))}
                  <p className="leading-relaxed text-ink"><span className="font-semibold">Why: </span>{q.explanation}</p>
                  <p className="text-xs text-ink-soft">SOP point: {q.sopPoint}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── agent: training refresher (coaching) ─────────────────────────────────────

export function RefresherView({ attemptId, onHome, showDialog }: { attemptId: number; onHome: () => void; showDialog: ShowDialog }) {
  const cfg = useAppConfig();
  const [data, setData] = useState<PktResult | null>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, { correct: boolean; why: string | null }>>({});
  const [saving, setSaving] = useState(false);
  const now = useNow();

  const pick = async (qi: number, oi: number) => {
    setPicked((p) => ({ ...p, [qi]: oi }));
    try {
      const r = await api<{ correct: boolean; why: string | null }>(`/api/pkt/attempts/${attemptId}/quiz-check`, { method: 'POST', json: { index: qi, answer: oi } });
      setChecked((c) => ({ ...c, [qi]: r }));
    } catch (e: any) {
      setPicked((p) => { const n = { ...p }; delete n[qi]; return n; });
      showDialog({ type: 'error', title: 'Could not check answer', message: e.message });
    }
  };
  const retry = (qi: number) => {
    setPicked((p) => { const n = { ...p }; delete n[qi]; return n; });
    setChecked((c) => { const n = { ...c }; delete n[qi]; return n; });
  };

  useEffect(() => {
    api<PktResult>(`/api/pkt/attempts/${attemptId}`).then(setData).catch((e) => showDialog({ type: 'error', title: 'Could not open refresher', message: e.message }));
  }, [attemptId]);

  const complete = async () => {
    setSaving(true);
    try {
      const quiz_answers = (data?.coaching?.quiz ?? []).map((_, i) => picked[i]);
      const r = await api<{ refresher_done_at: number; reattempt_at: number }>(`/api/pkt/attempts/${attemptId}/refresher-done`, { method: 'POST', json: { quiz_answers } });
      setData((d) => (d ? { ...d, refresher_done_at: r.refresher_done_at, reattempt_at: r.reattempt_at } : d));
      showDialog({ type: 'success', title: 'Refresher completed', message: r.reattempt_at <= Date.now() ? 'Your reattempt is open now.' : `Your reattempt opens at ${fmtWhen(r.reattempt_at)}.` });
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not save', message: e.message });
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="flex justify-center py-32"><Loader2 className="animate-spin text-meesho-purple" size={36} /></div>;
  const c = data.coaching;
  // after completion the server returns the answer key; before it, each answer is checked on the server
  const isRight = (q: { correctIndex: number }, i: number) => (q.correctIndex >= 0 ? picked[i] === q.correctIndex : checked[i]?.correct === true);
  const quizDone = !c?.quiz.length || c.quiz.every((q, i) => isRight(q, i));
  const quizRight = c?.quiz.filter((q, i) => isRight(q, i)).length ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 pb-24 sm:px-6 lg:px-10">
      <button onClick={onHome} className="inline-flex items-center gap-2 text-sm font-semibold text-ink-soft hover:text-meesho-purple"><ArrowLeft size={16} /> Back to my PKTs</button>
      <PageHeader eyebrow={`${data.unitLabel} · you scored ${pct(data.percent)}`} title="Training" accent="refresher"
        subtitle={`Read each point and the exact SOP lines, get every practice question right, then mark the refresher complete.${cfg.refresherRequired && cfg.coolDownHours > 0 ? ` Your reattempt opens ${hoursLabel(cfg.coolDownHours)} later.` : ''}`} />

      {!c ? (
        <Card><p className="text-ink-soft">There's no refresher for this attempt.</p></Card>
      ) : (
        <>
          {c.summary && (
            <Card className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#EADCF8] text-meesho-purple"><Sparkles size={22} /></div>
              <p className="text-base leading-relaxed text-ink sm:text-lg">{c.summary}</p>
            </Card>
          )}

          <div className="space-y-4">
            <h3 className="px-1 text-xl font-bold text-ink">What to fix</h3>
            {c.focusAreas.map((f, i) => (
              <Card key={i} className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-meesho-purple">{i + 1}. {f.topic}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-rose-50 p-4"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-rose-600">What you did</p><p className="mt-1.5 text-sm leading-relaxed text-ink">{f.yourMistake}</p></div>
                  <div className="rounded-2xl bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-emerald-700">Correct SOP</p><p className="mt-1.5 text-sm leading-relaxed text-ink">{f.correctSop}</p></div>
                </div>
                {f.sopExcerpt && (
                  <blockquote className="rounded-2xl border-l-4 border-meesho-purple bg-white p-4 text-sm leading-relaxed text-ink shadow-sm">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-meesho-purple"><BookOpen size={13} aria-hidden /> From the SOP</p>
                    <p className="whitespace-pre-line">{f.sopExcerpt}</p>
                  </blockquote>
                )}
                <div className="rounded-2xl bg-[#F7F5FF] p-4"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-soft">How to handle it next time</p><p className="mt-1.5 text-sm leading-relaxed text-ink">{f.howToHandle}</p></div>
              </Card>
            ))}
          </div>

          {c.quiz.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
                <h3 className="text-xl font-bold text-ink">Practice questions</h3>
                <p className="text-sm font-semibold text-ink-soft">{quizRight} of {c.quiz.length} right</p>
              </div>
              {c.quiz.map((q, qi) => (
                <Card key={qi} className="space-y-3">
                  <p className="font-semibold text-ink">{qi + 1}. {q.question}</p>
                  <div className="grid gap-2">
                    {q.options.map((o, oi) => {
                      const chosen = picked[qi];
                      const show = chosen !== undefined && (q.correctIndex >= 0 || !!checked[qi]);
                      const right = isRight(q, qi);
                      return (
                        <button key={oi} disabled={chosen !== undefined} onClick={() => pick(qi, oi)}
                          className={cn('rounded-xl px-4 py-2.5 text-left text-sm transition-colors',
                            !show ? (oi === chosen ? 'bg-[#E8E1F8]' : 'bg-[#F2EEFC] hover:bg-[#E8E1F8]') : oi === chosen && right ? 'bg-emerald-50 font-semibold text-emerald-800' : oi === chosen ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-ink-soft')}>
                          {String.fromCharCode(65 + oi)}. {o}
                        </button>
                      );
                    })}
                  </div>
                  {picked[qi] !== undefined && (q.correctIndex >= 0 || checked[qi]) && (isRight(q, qi) ? (
                    <p className="flex items-start gap-2 text-sm text-emerald-800"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /><span><span className="font-semibold">Correct. </span>{q.why || checked[qi]?.why}</span></p>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="flex items-start gap-2 text-sm text-rose-800"><XCircle size={16} className="mt-0.5 shrink-0" aria-hidden /><span><span className="font-semibold">Not quite. </span>Re-read the SOP lines above and try again.</span></p>
                      <button onClick={() => retry(qi)} className="shrink-0 rounded-xl bg-[#F2EEFC] px-4 py-2 text-sm font-semibold text-ink">Try again</button>
                    </div>
                  ))}
                </Card>
              ))}
            </div>
          )}

          <Card className="space-y-4">
            {data.refresher_done_at ? (
              <Action icon={Clock} tone="blue" title="Refresher completed"
                text={data.reattempt_at && now < data.reattempt_at ? `Your reattempt opens at ${fmtWhen(data.reattempt_at)} (in ${countdown(data.reattempt_at - now)}).` : 'Your reattempt is open now. Go back to your PKTs to start it.'}
                button={<button onClick={onHome} className="btn-primary w-full sm:w-auto">Back to my PKTs</button>} />
            ) : (
              <>
                <p className="text-sm text-ink-soft">{quizDone ? 'All set. Mark the refresher complete to start your 4-hour cool-down.' : 'Get every practice question right, then mark the refresher complete.'}</p>
                <button onClick={complete} disabled={!quizDone || saving} className="btn-primary w-full">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} I've completed the refresher
                </button>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── trainer: Assign ──────────────────────────────────────────────────────────

type Kind = 'new' | 'old';
interface ImportRow { pod: string; batch_no: string; start_date: string; agent_name: string; agent_email: string; }
interface ImportResult { added: number; already_there: number; new_batches: string[]; errors: Array<{ row: number; message: string }>; }

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

const HEADER_KEYS: Record<keyof ImportRow, string[]> = {
  pod: ['pod', 'podname', 'client', 'account'],
  batch_no: ['batch', 'batchno', 'batchnumber', 'batchid'],
  start_date: ['trainingstartdate', 'startdate', 'trainingdate', 'date', 'firstpktdate'],
  agent_name: ['agentname', 'name', 'agent'],
  agent_email: ['agentemail', 'email', 'emailid', 'agentemailid', 'ssoid', 'sso'],
};

function normalizeDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // Indian DD/MM/YYYY
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : normalizeDate(d);
}

function readSheetRows(file: File): Promise<ImportRow[]> {
  return file.arrayBuffer().then((buf) => {
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
    return raw.map((r) => {
      const byKey = new Map(Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]));
      const get = (field: keyof ImportRow) => {
        for (const k of HEADER_KEYS[field]) if (byKey.has(k)) return byKey.get(k);
        return '';
      };
      return {
        pod: String(get('pod') ?? '').trim(),
        batch_no: String(get('batch_no') ?? '').trim(),
        start_date: normalizeDate(get('start_date')),
        agent_name: String(get('agent_name') ?? '').trim(),
        agent_email: String(get('agent_email') ?? '').trim(),
      };
    }).filter((r) => Object.values(r).some(Boolean));
  });
}

function downloadTemplate(kind: Kind) {
  const header = kind === 'new'
    ? ['Pod', 'Batch Number', 'Training Start Date', 'Agent Name', 'Agent Email']
    : ['Pod', 'Batch Number (optional)', 'First PKT Date (optional)', 'Agent Name', 'Agent Email'];
  const sample = kind === 'new'
    ? ['Atomberg', 'ATM-NOV-01', todayIST(), 'Babulal Verma', 'babulal.verma_technotask@meesho.com']
    : ['Noise', '', '', 'Agent Two', 'agent.two_technotask@meesho.com'];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, sample]), 'Agents');
  XLSX.writeFile(wb, kind === 'new' ? 'readycheck-new-agents-template.xlsx' : 'readycheck-production-agents-template.xlsx');
}

// vendor read from an agent email (a listed vendor, or Meesho for any other @meesho.com email
// while the Super Admin allows any @meesho.com email)
function VendorChip({ match, compact, anyEmail }: { match: VendorMatch | null; compact?: boolean; anyEmail: boolean }) {
  if (!match) return compact ? null : <span className="hidden h-[52px] items-center px-2 text-sm text-ink-soft sm:flex">Vendor: auto</span>;
  if (match.internal && !anyEmail) {
    return (
      <span title="The vendor in this email isn't in the Vendors list" className={cn('flex items-center gap-1.5 text-sm font-semibold text-rose-800', !compact && 'min-h-[52px] rounded-2xl bg-rose-50 px-3')}>
        <AlertTriangle size={16} className="shrink-0" aria-hidden />{compact ? 'Not in vendor list' : 'Vendor not found'}
      </span>
    );
  }
  return (
    <span title={match.internal ? 'No listed vendor in the email, so this agent is a Meesho agent' : undefined}
      className={cn('flex items-center gap-1.5 text-sm font-semibold', match.internal ? 'text-meesho-purple' : 'text-emerald-800', !compact && cn('h-[52px] rounded-2xl px-3', match.internal ? 'bg-[#F2EEFC]' : 'bg-emerald-50'))}>
      <CheckCircle2 size={16} className="shrink-0" aria-hidden />{match.vendor}
    </span>
  );
}

export function AssignPanel({ pods, showDialog }: { pods: PodInfo[]; showDialog: ShowDialog }) {
  const cfg = useAppConfig();
  const [kindChoice, setKind] = useState<Kind>('new');
  const [modeChoice, setMode] = useState<'manual' | 'upload'>('manual');
  // a switched-off option falls back to the one that is always there
  const kind: Kind = cfg.featureOldAgents ? kindChoice : 'new';
  const mode = cfg.featureBulkUpload ? modeChoice : 'manual';
  const wait = hoursLabel(cfg.coolDownHours);
  const reattempts = (n: number) => `${n - 1} reattempt${n - 1 === 1 ? '' : 's'}`;
  const [vendors, setVendors] = useState<string[]>([]);
  useEffect(() => { api<Array<{ name: string }>>('/api/vendors').then((v) => setVendors(v.map((x) => x.name))).catch(() => {}); }, []);
  const vendorOf = (email: string) => (email.trim() ? vendorFromEmail(email, vendors) : null);
  const [pod, setPod] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [startDate, setStartDate] = useState(todayIST());
  const [agents, setAgents] = useState([{ name: '', email: '' }]);
  const [fileRows, setFileRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [chatWebhook, setChatWebhook] = useState('');

  const reset = () => { setAgents([{ name: '', email: '' }]); setBatchNo(''); setFileRows(null); setFileName(''); };

  const submit = async (rows: ImportRow[]) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<ImportResult>('/api/trainer/import', { method: 'POST', json: { kind, rows, chat_webhook: chatWebhook || undefined } });
      setResult(r);
      if (r.added && !r.errors.length) reset();
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not assign', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const submitManual = () => {
    const rows = agents.filter((a) => a.email.trim()).map((a) => ({
      pod, batch_no: batchNo, start_date: kind === 'old' && !startDate ? '' : startDate, agent_name: a.name, agent_email: a.email,
    }));
    if (!pod || (kind === 'new' && (!batchNo.trim() || !startDate)) || !rows.length) {
      showDialog({ type: 'warning', title: 'Missing details', message: kind === 'new' ? 'Fill in pod, batch number, training start date and at least one agent.' : 'Fill in pod and at least one agent.' });
      return;
    }
    submit(rows);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rows = await readSheetRows(f);
      setFileName(f.name);
      setFileRows(rows);
      setResult(null);
      if (!rows.length) showDialog({ type: 'warning', title: 'Empty file', message: 'No rows found. Use the template headers.' });
    } catch {
      showDialog({ type: 'error', title: 'Could not read file', message: 'Upload a .csv or .xlsx file that uses the template headers.' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {cfg.featureOldAgents ? (
          <TabBar<Kind> tabs={[{ id: 'new' as Kind, label: 'New agents', icon: UserPlus }, { id: 'old' as Kind, label: 'Old agents (prod)', icon: Users }]}
            active={kind} onChange={(k) => { setKind(k); setResult(null); setFileRows(null); }} />
        ) : <span />}
        {cfg.featureBulkUpload && (
          <TabBar<'manual' | 'upload'> tabs={[{ id: 'manual' as const, label: 'Enter manually', icon: Plus }, { id: 'upload' as const, label: 'Upload file', icon: FileUp }]}
            active={mode} onChange={setMode} />
        )}
      </div>

      <Card className="space-y-2 !py-4 text-sm text-ink-soft">
        {kind === 'new'
          ? <p><span className="font-semibold text-ink">New agents (pre-production):</span> the training start date is Day 1. Each day's PKT opens at {releaseLabel(cfg)} IST for every agent in the batch. Pass mark {cfg.passMarkNew}%. Below it the agent gets a training refresher{cfg.refresherRequired ? `, can reattempt ${wait === 'straight away' ? 'as soon as they finish it' : `${wait} after finishing it`}` : `, can reattempt ${wait === 'straight away' ? 'straight away' : `${wait} later`}`}, and gets {reattempts(cfg.attemptsNew)} before Exit.</p>
          : <p><span className="font-semibold text-ink">Old agents (production):</span> they get a PKT every {cfg.productionCycleDays} days from the first PKT date ({releaseLabel(cfg)} IST). Pass mark {cfg.passMarkOld}%. Below it they get a training refresher and {reattempts(cfg.attemptsOld)}{cfg.coolDownHours ? ` (${wait} after ${cfg.refresherRequired ? 'finishing the refresher' : 'the fail'})` : ''}. Failing all of them means Exit.</p>}
      </Card>

      {mode === 'manual' ? (
        <Card className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label>Pod</Label>
              <select className="input-field" value={pod} onChange={(e) => setPod(e.target.value)}>
                <option value="">Select pod</option>
                {pods.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.training_days} days)</option>)}
              </select>
            </div>
            <div><Label>{kind === 'new' ? 'Batch number' : 'Batch number (optional)'}</Label><input className="input-field" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder={kind === 'new' ? 'Unique, e.g. ATM-NOV-01' : 'Auto if blank'} /></div>
            <div><Label>{kind === 'new' ? 'Training start date' : 'First PKT date'}</Label><input type="date" className="input-field" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          </div>

          <div>
            <Label>Google Chat space webhook for this batch (optional)</Label>
            <input className="input-field" placeholder="https://chat.googleapis.com/v1/spaces/… — leave blank to use the default space" value={chatWebhook} onChange={(e) => setChatWebhook(e.target.value)} />
          </div>

          <div className="space-y-3">
            <Label>Agents</Label>
            {cfg.assignAnyMeeshoEmail
              ? <p className="-mt-1 text-sm text-ink-soft">Any @meesho.com email works. The vendor is filled in from the email: agentname_<span className="font-semibold text-ink">vendorname</span>@meesho.com gives that vendor; any other @meesho.com email is a <span className="font-semibold text-ink">Meesho</span> agent.</p>
              : <p className="-mt-1 text-sm text-ink-soft">Use agentname_<span className="font-semibold text-ink">vendorname</span>@meesho.com. The vendor is filled in from the email and must be in the Vendors list.</p>}
            {agents.map((a, i) => (
              <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_12rem_auto]">
                <input className="input-field" placeholder="Agent name" value={a.name} onChange={(e) => setAgents((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="input-field" type="email" placeholder="babulal.verma_technotask@meesho.com" value={a.email} onChange={(e) => setAgents((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                <VendorChip match={vendorOf(a.email)} anyEmail={cfg.assignAnyMeeshoEmail} />
                <button onClick={() => setAgents((l) => (l.length > 1 ? l.filter((_, j) => j !== i) : l))} disabled={agents.length === 1}
                  className="inline-flex h-[52px] items-center justify-center rounded-2xl px-4 text-rose-500 hover:bg-rose-50 disabled:opacity-30" title="Remove agent">
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            <button onClick={() => setAgents((l) => [...l, { name: '', email: '' }])} className="inline-flex items-center gap-2 text-sm font-semibold text-meesho-purple hover:underline"><Plus size={16} /> Add another agent</button>
          </div>

          <div className="flex justify-end">
            <button onClick={submitManual} disabled={busy} className="btn-primary w-full sm:w-auto">{busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} Assign {agents.filter((a) => a.email.trim()).length || ''} agent(s)</button>
          </div>
        </Card>
      ) : (
        <Card className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-semibold text-ink">Upload a .csv or .xlsx file</p>
              <p className="text-sm text-ink-soft">Columns: Pod, Batch Number, {kind === 'new' ? 'Training Start Date' : 'First PKT Date (optional)'}, Agent Name, Agent Email. The vendor is read from each agent email. Up to {cfg.maxUploadRows} rows at a time.</p>
            </div>
            <button onClick={() => downloadTemplate(kind)} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink hover:bg-[#E8E1F8]"><Download size={16} /> Download template</button>
          </div>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-[#DCCDF3] bg-[#FBFAFF] px-6 py-10 text-center hover:border-meesho-purple">
            <FileUp className="text-meesho-purple" size={32} strokeWidth={1.5} />
            <span className="font-semibold text-ink">{fileName || 'Choose a file'}</span>
            <span className="text-sm text-ink-soft">{fileRows ? `${fileRows.length} row(s) ready` : 'CSV or Excel'}</span>
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={onFile} />
          </label>
          {fileRows && fileRows.length > 0 && (
            <>
              <div className="max-h-72 overflow-auto rounded-2xl border border-slate-100">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
                    <tr>{['#', 'Vendor', 'Pod', 'Batch', 'Start', 'Agent', 'Email'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {fileRows.slice(0, 200).map((r, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-ink-soft">{i + 1}</td><td className="px-3 py-2"><VendorChip match={vendorOf(r.agent_email)} anyEmail={cfg.assignAnyMeeshoEmail} compact /></td><td className="px-3 py-2">{r.pod}</td>
                        <td className="px-3 py-2">{r.batch_no}</td><td className="px-3 py-2">{r.start_date}</td><td className="px-3 py-2">{r.agent_name}</td><td className="px-3 py-2">{r.agent_email}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <button onClick={() => submit(fileRows)} disabled={busy} className="btn-primary w-full sm:w-auto">{busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} Assign {fileRows.length} row(s)</button>
              </div>
            </>
          )}
        </Card>
      )}

      {result && (
        <Card className="space-y-3">
          <p className="font-semibold text-ink">
            {result.added} agent(s) assigned{result.already_there ? `, ${result.already_there} already in their batch` : ''}{result.new_batches.length ? ` · new batch: ${result.new_batches.join(', ')}` : ''}.
          </p>
          {result.errors.length > 0 && (
            <div className="space-y-1 rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">
              <p className="font-semibold">{result.errors.length} row(s) were skipped:</p>
              {result.errors.slice(0, 50).map((e) => <p key={e.row}>Row {e.row}: {e.message}</p>)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── trainer: Analytics ───────────────────────────────────────────────────────

interface Report {
  rows: Array<{
    trainee_id: number; type: string; kind: Kind; vendor: string; pod: string; batch_no: string; start_date: string;
    agent_name: string; agent_email: string; status: string; status_label: string; current: string; attempts_used: number;
    max_attempts: number; refresher: string; reattempt_at: number | null; avg_score: number | null; last_score: number | null;
    overdue: boolean; missed_pkts: number; certificate_id: string | null;
    last_attempt_at: string | null; exited_at: string | null; units: Array<{ label: string; best: number | null; attempts: number; state: string }>;
  }>;
  summary: { total: number; not_started: number; in_progress: number; reattempt: number; passed: number; exit: number; failed_once: number; overdue: number };
  no_scope?: boolean;
  sop_points: Array<{ topic: string; sopPoint: string; asked: number; wrong: number; accuracy: number; agents: number; example: string; common_wrong_answer: string | null }>;
  charts: {
    trend: ChartPoint[]; by_unit: ChartPoint[]; by_batch: ChartPoint[]; by_vendor: ChartPoint[];
    heatmap: { topics: string[]; rows: Array<{ agent: string; cells: Array<number | null> }> };
  };
  scores: { overall_avg: number | null; first_attempt_avg: number | null; attempts: number; pass_rate: number | null };
  la_scores: Array<{ agent_name: string; agent_email: string; batch_no: string; pod: string; attempts: number; avg_score: number | null; best_score: number | null; status_label: string; tni: Array<{ topic: string; accuracy: number; wrong: number }> }>;
  tni: Array<{ topic: string; asked: number; wrong: number; accuracy: number }>;
  top_issues: Array<{ topic: string; sopPoint: string; wrong: number; agents: number }>;
  options: { vendors: string[]; pods: string[]; batches: Array<{ batch_no: string; kind: Kind; vendor: string; pod: string }>; start_dates: string[] };
}

type AnalyticsTab = 'overview' | 'charts' | 'agents' | 'tni' | 'points';
type ChartPoint = { label: string; attempts: number; avg_score: number | null; pass_rate: number | null };

export function AnalyticsPanel({ showDialog }: { showDialog: ShowDialog }) {
  const cfg = useAppConfig();
  const empty = { kind: '', vendor: '', pod: '', batch_no: '', start_date: '', agent: '', status: '' };
  const [f, setF] = useState(empty);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<AnalyticsTab>('overview');

  const load = async (filters = f) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
      setReport(await api<Report>(`/api/trainer/report${qs ? `?${qs}` : ''}`));
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not load analytics', message: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const removeAgent = (id: number, name: string) => showDialog({
    type: 'confirm', title: 'Remove agent?', message: `${name} and all their PKT attempts in this batch will be deleted.`, confirmLabel: 'Remove',
    onConfirm: async () => {
      try { await api(`/api/trainer/trainees/${id}`, { method: 'DELETE' }); load(); showDialog({ type: 'success', title: 'Removed', message: `${name} was removed.` }); }
      catch (e: any) { showDialog({ type: 'error', title: 'Could not remove', message: e.message }); }
    },
  });

  const download = () => {
    if (!report) return;
    const maxUnits = Math.max(0, ...report.rows.map((r) => r.units.length));
    const agents = report.rows.map((r) => {
      const row: Record<string, unknown> = {
        Type: r.type, 'Vendor / BPO': r.vendor, Pod: r.pod, 'Batch Number': r.batch_no, 'Training Start Date': r.start_date,
        'Agent Name': r.agent_name, 'Agent Email': r.agent_email, Status: r.status_label, Overdue: r.overdue ? 'Yes' : '', 'Missed PKTs': r.missed_pkts || '', 'Current PKT': r.current,
        'Attempts on current': `${r.attempts_used}/${r.max_attempts}`, Refresher: r.refresher, 'Reattempt opens': r.reattempt_at ? fmtWhen(r.reattempt_at) : '',
        Certificate: r.certificate_id ?? '',
        'Average score %': r.avg_score ?? '', 'Last score %': r.last_score ?? '', 'Last attempt': r.last_attempt_at ? fmtWhen(r.last_attempt_at) : '', 'Exit date': r.exited_at ? fmtWhen(r.exited_at) : '',
      };
      for (let i = 0; i < maxUnits; i++) {
        const u = r.units[i];
        row[u ? `${u.label} best %` : `PKT ${i + 1} best %`] = u?.best ?? '';
      }
      return row;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(agents.length ? agents : [{ Note: 'No agents match these filters' }]), 'Agents');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.la_scores.map((l) => ({
      'Agent Name': l.agent_name, 'Agent Email': l.agent_email, Batch: l.batch_no, Pod: l.pod, Attempts: l.attempts,
      'Average PKT %': l.avg_score ?? '', 'Best PKT %': l.best_score ?? '', Status: l.status_label,
      'TNI (weakest SOP areas)': l.tni.map((t) => `${t.topic} (${t.accuracy}%)`).join('; '),
    }))), 'Agent-wise score & TNI');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.tni.map((t) => ({ 'SOP area': t.topic, 'Questions asked': t.asked, Wrong: t.wrong, 'Accuracy %': t.accuracy }))), 'Overall TNI');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.top_issues.map((t, i) => ({ Rank: i + 1, 'SOP area': t.topic, 'SOP point': t.sopPoint, 'Times wrong': t.wrong, 'Agents affected': t.agents }))), 'Top issues');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.sop_points.map((t) => ({ 'SOP area': t.topic, 'SOP point': t.sopPoint, Asked: t.asked, Wrong: t.wrong, 'Accuracy %': t.accuracy, 'Agents wrong': t.agents, 'Most common wrong answer': t.common_wrong_answer ?? '', 'Example question': t.example }))), 'SOP points');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(report.charts.trend.map((t) => ({ Date: t.label, Attempts: t.attempts, 'Average %': t.avg_score ?? '', 'Pass rate %': t.pass_rate ?? '' }))), 'Daily trend');
    XLSX.writeFile(wb, `readycheck-pkt-report-${todayIST()}.xlsx`);
  };

  const batches = useMemo(() => (report?.options.batches ?? []).filter((b) =>
    (!f.kind || b.kind === f.kind) && (!f.vendor || b.vendor === f.vendor) && (!f.pod || b.pod === f.pod)), [report, f]);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const s = report?.summary;
  return (
    <div className="space-y-6">
      <Card className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><Label>Agent type</Label><select className="input-field" value={f.kind} onChange={set('kind')}><option value="">All</option><option value="new">New (pre-production)</option><option value="old">Old (production)</option></select></div>
          <div><Label>Vendor / BPO</Label><select className="input-field" value={f.vendor} onChange={set('vendor')}><option value="">All</option>{report?.options.vendors.map((v) => <option key={v}>{v}</option>)}</select></div>
          <div><Label>Pod</Label><select className="input-field" value={f.pod} onChange={set('pod')}><option value="">All</option>{report?.options.pods.map((v) => <option key={v}>{v}</option>)}</select></div>
          <div><Label>Batch number</Label><select className="input-field" value={f.batch_no} onChange={set('batch_no')}><option value="">All</option>{batches.map((b) => <option key={b.batch_no}>{b.batch_no}</option>)}</select></div>
          <div><Label>Training start date</Label><select className="input-field" value={f.start_date} onChange={set('start_date')}><option value="">All</option>{report?.options.start_dates.map((v) => <option key={v} value={v}>{fmtDate(v)}</option>)}</select></div>
          <div><Label>Status</Label><select className="input-field" value={f.status} onChange={set('status')}><option value="">All</option><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="reattempt">Failed – refresher / reattempt</option><option value="passed">Passed</option><option value="exit">Exit</option><option value="overdue">Overdue</option></select></div>
          <div className="sm:col-span-2"><Label>Agent name or email</Label>
            <div className="relative"><Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft" /><input className="input-field pl-11" value={f.agent} onChange={set('agent')} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Search" /></div>
          </div>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button onClick={() => { setF(empty); load(empty); }} className="rounded-2xl px-5 py-3 text-sm font-semibold text-ink-soft hover:bg-slate-50">Clear filters</button>
          {cfg.featureReportDownload && <button onClick={download} disabled={!report} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink hover:bg-[#E8E1F8] disabled:opacity-50"><Download size={16} /> Download report</button>}
          <button onClick={() => load()} disabled={loading} className="btn-primary">{loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Apply filters</button>
        </div>
      </Card>

      {!report ? (
        <div className="flex justify-center py-20"><Loader2 className="animate-spin text-meesho-purple" size={32} /></div>
      ) : (
        <>
          {report.no_scope && (
            <Card className="flex items-start gap-3 !py-4 text-sm font-semibold text-amber-900"><AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden /> You don't have a trainer scope yet, so no batches are shown. Ask an Admin to set your vendors and pods.</Card>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {[
              ['Agents', s!.total, 'text-ink'], ['Not started', s!.not_started, 'text-slate-700'], ['In progress', s!.in_progress, 'text-blue-700'],
              ['Refresher / reattempt', s!.reattempt, 'text-amber-700'], ['Overdue', s!.overdue, 'text-orange-700'], ['Failed at least once', s!.failed_once, 'text-orange-700'],
              ['Passed', s!.passed, 'text-emerald-700'], ['Exit', s!.exit, 'text-rose-700'],
            ].map(([label, value, color]) => (
              <div key={label as string} className="float-card flex flex-col justify-between p-4">
                <p className="text-xs font-semibold leading-tight text-ink-soft">{label}</p>
                <p className={cn('mt-2 text-3xl font-bold tracking-tight', color as string)}>{value as number}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Overall PKT score', pct(report.scores.overall_avg), 'average of all attempts'],
              ['First-attempt score', pct(report.scores.first_attempt_avg), 'average of 1st attempts'],
              ['Pass rate', pct(report.scores.pass_rate), 'of all attempts'],
              ['Attempts', String(report.scores.attempts), 'PKTs taken'],
            ].map(([label, value, note]) => (
              <div key={label} className="category-card p-4 sm:p-5">
                <p className="text-sm font-semibold text-ink-soft">{label}</p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-meesho-purple sm:text-4xl">{value}</p>
                <p className="mt-1 text-xs text-ink-soft">{note}</p>
              </div>
            ))}
          </div>

          <TabBar<AnalyticsTab> tabs={[
            { id: 'overview', label: 'Agents & status', icon: Users },
            { id: 'charts', label: 'Charts', icon: BarChart3 },
            { id: 'agents', label: 'Agent-wise score & TNI', icon: Layers },
            { id: 'tni', label: 'Overall TNI', icon: GraduationCap },
            { id: 'points', label: 'Top issues & SOP points', icon: AlertCircle },
          ]} active={tab} onChange={setTab} />

          {tab === 'overview' && (
            <Card className="!p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
                    <tr>{['Agent', 'Batch / pod', 'Status', 'Current', 'Day-wise best', 'Refresher', 'Avg', ''].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {report.rows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-ink-soft">No agents match these filters.</td></tr>}
                    {report.rows.map((r) => (
                      <tr key={r.trainee_id} className="border-t border-slate-100 align-top">
                        <td className="px-4 py-3"><p className="font-semibold text-ink">{r.agent_name}</p><p className="text-xs text-ink-soft">{r.agent_email}</p></td>
                        <td className="px-4 py-3"><p className="font-medium text-ink">{r.batch_no}</p><p className="text-xs text-ink-soft">{r.vendor} · {r.pod} · {r.kind === 'new' ? 'New' : 'Production'}</p></td>
                        <td className="px-4 py-3"><div className="flex flex-col gap-1.5"><StatusPill status={r.status} label={r.status_label} />{r.overdue && <StatusPill status="overdue" label={r.missed_pkts ? `Overdue · ${r.missed_pkts} missed` : 'Overdue'} />}{r.certificate_id && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800"><Award size={12} aria-hidden /> {r.certificate_id}</span>}</div></td>
                        <td className="px-4 py-3 text-ink">{r.current}<p className="text-xs text-ink-soft">{r.attempts_used}/{r.max_attempts} attempts</p></td>
                        <td className="px-4 py-3">
                          <div className="flex max-w-[260px] flex-wrap gap-1">
                            {r.units.map((u) => (
                              <span key={u.label} className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
                                u.state === 'passed' ? 'bg-emerald-50 text-emerald-800' : u.state === 'failed' ? 'bg-rose-50 text-rose-800' : u.best !== null ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-500')}>
                                {`${u.label.replace('Day ', 'D').replace('PKT ', 'P')} · ${u.best !== null ? `${Math.round(u.best)}%` : '–'}${u.state === 'passed' ? ' ✓' : u.state === 'failed' ? ' ✗' : ''}`}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-ink-soft">{r.refresher || '—'}</td>
                        <td className="px-4 py-3 font-semibold text-ink">{pct(r.avg_score)}</td>
                        <td className="px-4 py-3 text-right"><button onClick={() => removeAgent(r.trainee_id, r.agent_name)} className="rounded-xl p-2 text-rose-500 hover:bg-rose-50" title="Remove agent"><Trash2 size={16} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {tab === 'agents' && (
            <Card className="!p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
                    <tr>{['Agent (LA)', 'Batch / pod', 'Attempts', 'Avg PKT', 'Best', 'Status', 'TNI – weakest SOP areas'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {report.la_scores.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-ink-soft">No agents match these filters.</td></tr>}
                    {[...report.la_scores].sort((a, b) => (a.avg_score ?? 101) - (b.avg_score ?? 101)).map((l) => (
                      <tr key={`${l.agent_email}-${l.batch_no}`} className="border-t border-slate-100 align-top">
                        <td className="px-4 py-3"><p className="font-semibold text-ink">{l.agent_name}</p><p className="text-xs text-ink-soft">{l.agent_email}</p></td>
                        <td className="px-4 py-3 text-ink-soft">{l.batch_no} · {l.pod}</td>
                        <td className="px-4 py-3 text-ink">{l.attempts}</td>
                        <td className="px-4 py-3 font-semibold text-ink">{pct(l.avg_score)}</td>
                        <td className="px-4 py-3 text-ink">{pct(l.best_score)}</td>
                        <td className="px-4 py-3 text-ink-soft">{l.status_label}</td>
                        <td className="px-4 py-3">
                          {l.tni.length === 0 ? <span className="text-ink-soft">—</span> : (
                            <div className="flex flex-wrap gap-1.5">{l.tni.map((t) => <span key={t.topic} className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{t.topic} · {t.accuracy}%</span>)}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {tab === 'tni' && (
            <Card className="space-y-4">
              <p className="text-sm text-ink-soft">SOP areas ranked by accuracy across all attempts in this filter. Low accuracy = training need.</p>
              {report.tni.length === 0 && <p className="py-6 text-center text-ink-soft">No attempts yet.</p>}
              {report.tni.map((t) => (
                <div key={t.topic} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,240px)_1fr_auto] sm:items-center sm:gap-4">
                  <p className="truncate font-semibold text-ink" title={t.topic}>{t.topic}</p>
                  <div className="h-3 overflow-hidden rounded-full bg-[#F2EEFC]">
                    <div className={cn('h-full rounded-full', t.accuracy < 85 ? 'bg-rose-400' : t.accuracy < 90 ? 'bg-amber-400' : 'bg-emerald-400')} style={{ width: `${Math.max(2, t.accuracy)}%` }} />
                  </div>
                  <p className="text-sm text-ink-soft sm:text-right"><span className="font-semibold text-ink">{t.accuracy}%</span> · {t.wrong}/{t.asked} wrong</p>
                </div>
              ))}
            </Card>
          )}

          {tab === 'charts' && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card className="space-y-3 lg:col-span-2">
                <p className="font-bold text-ink">Average PKT score by day</p>
                <TrendChart data={report.charts.trend} />
              </Card>
              <Card className="space-y-4"><p className="font-bold text-ink">By training day / PKT</p><BarList data={report.charts.by_unit} /></Card>
              <Card className="space-y-4"><p className="font-bold text-ink">By batch</p><BarList data={report.charts.by_batch} /></Card>
              <Card className="space-y-4"><p className="font-bold text-ink">By vendor</p><BarList data={report.charts.by_vendor} /></Card>
              <Card className="space-y-4 lg:col-span-2"><p className="font-bold text-ink">TNI heatmap — agent × SOP area</p><Heatmap topics={report.charts.heatmap.topics} rows={report.charts.heatmap.rows} /></Card>
            </div>
          )}

          {tab === 'points' && (
            <Card className="space-y-3">
              <p className="text-sm text-ink-soft">Every agent gets different questions, so results are grouped by the SOP point each question tested. Ranked by how often agents got it wrong.</p>
              {report.sop_points.length === 0 && <p className="py-6 text-center text-ink-soft">No attempts yet.</p>}
              {report.sop_points.slice(0, 40).map((t, i) => (
                <details key={i} className="group rounded-2xl bg-[#F7F5FF] p-4">
                  <summary className="flex cursor-pointer list-none items-start gap-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-sm font-bold text-meesho-purple">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">{t.sopPoint}</p>
                      <p className="text-xs text-ink-soft">{t.topic} · asked {t.asked}× · {t.agents} agent(s) got it wrong</p>
                    </div>
                    <div className="shrink-0 text-right text-sm">
                      <p className={cn('font-bold', t.accuracy < 85 ? 'text-rose-700' : 'text-emerald-700')}>{t.accuracy}% {t.accuracy < 85 ? '✗' : '✓'}</p>
                      <p className="text-xs text-ink-soft">{t.wrong}× wrong</p>
                    </div>
                  </summary>
                  <div className="mt-3 space-y-2 border-t border-[#E9E3F7] pt-3 text-sm">
                    <p className="text-ink"><span className="font-semibold">Example question: </span>{t.example}</p>
                    {t.common_wrong_answer && <p className="text-rose-800"><span className="font-semibold">Most common wrong answer: </span>{t.common_wrong_answer}</p>}
                  </div>
                </details>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── super admin: user access ─────────────────────────────────────────────────

export function UserAccessPanel({ showDialog }: { showDialog: ShowDialog }) {
  const [rows, setRows] = useState<Array<{ email: string; role: Role; added_by: string; added_at: string }>>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'trainer' | 'admin'>('trainer');
  const [busy, setBusy] = useState(false);
  const load = () => api<typeof rows>('/api/user-roles').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);

  const add = async () => {
    setBusy(true);
    try { await api('/api/user-roles', { method: 'POST', json: { email, role } }); setEmail(''); load(); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not add', message: e.message }); }
    finally { setBusy(false); }
  };
  const remove = (e: string) => showDialog({
    type: 'confirm', title: 'Remove access?', message: `${e} will only be able to sign in as an Agent.`, confirmLabel: 'Remove',
    onConfirm: async () => { try { await api(`/api/user-roles/${encodeURIComponent(e)}`, { method: 'DELETE' }); load(); showDialog({ type: 'success', title: 'Access removed', message: `${e} is now an Agent only.` }); } catch (err: any) { showDialog({ type: 'error', title: 'Could not remove', message: err.message }); } },
  });

  return (
    <div className="space-y-6">
      <Card className="space-y-5">
        <div>
          <p className="text-lg font-bold text-ink">Give access</p>
          <p className="text-sm text-ink-soft">Trainer: Agent + Trainer views. Admin: Agent + Trainer + Admin views. Everyone else signs in as an Agent.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px_auto]">
          <input className="input-field" type="email" placeholder="name@meesho.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <select className="input-field" value={role} onChange={(e) => setRole(e.target.value as 'trainer' | 'admin')}>
            <option value="trainer">Trainer</option><option value="admin">Admin</option>
          </select>
          <button onClick={add} disabled={busy || !email.trim()} className="btn-primary">{busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} Give access</button>
        </div>
      </Card>
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
              <tr>{['Email', 'Access', 'Added by', ''].map((h) => <th key={h} className="px-5 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="px-5 py-10 text-center text-ink-soft">No Trainers or Admins yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.email} className="border-t border-slate-100">
                  <td className="px-5 py-3 font-semibold text-ink">{r.email}</td>
                  <td className="px-5 py-3"><span className={cn('rounded-full px-3 py-1 text-xs font-semibold', r.role === 'admin' ? 'bg-indigo-50 text-indigo-700' : 'bg-[#F2EEFC] text-meesho-purple')}>{ROLE_LABEL[r.role]}</span></td>
                  <td className="px-5 py-3 text-ink-soft">{r.added_by}</td>
                  <td className="px-5 py-3 text-right"><button onClick={() => remove(r.email)} className="rounded-xl p-2 text-rose-500 hover:bg-rose-50" title="Remove access"><Trash2 size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── trainer view ─────────────────────────────────────────────────────────────

export function TrainerDashboard({ pods, showDialog }: { pods: PodInfo[]; showDialog: ShowDialog }) {
  type T = 'assign' | 'batches' | 'analytics' | 'leaderboard';
  const cfg = useAppConfig();
  const [tab, setTab] = useState<T>('assign');
  return (
    <div className="mx-auto max-w-6xl min-w-0 space-y-8 px-4 py-8 pb-24 sm:px-6 lg:px-10">
      <PageHeader eyebrow="Trainer" title="Training" accent="desk" subtitle="Assign agents, manage batches, and track PKT scores, TNI, top issues and overdue agents." />
      <TabBar<T> tabs={[
        { id: 'assign', label: 'Assign', icon: UserPlus },
        { id: 'batches', label: 'Batches', icon: Layers },
        { id: 'analytics', label: 'Analytics', icon: BarChart3 },
        ...(cfg.featureLeaderboard ? [{ id: 'leaderboard' as const, label: 'Leaderboard', icon: Trophy }] : []),
      ]} active={tab} onChange={setTab} />
      {tab === 'assign' && <AssignPanel pods={pods} showDialog={showDialog} />}
      {tab === 'batches' && <BatchesPanel showDialog={showDialog} />}
      {tab === 'analytics' && <AnalyticsPanel showDialog={showDialog} />}
      {tab === 'leaderboard' && cfg.featureLeaderboard && <LeaderboardPanel staff />}
    </div>
  );
}
