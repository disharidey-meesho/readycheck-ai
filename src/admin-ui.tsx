// Batch management, trainer scope, admin settings (Google Drive, Google Chat, backups, old-data
// import), Google sync per pod, the vendor list, the leaderboard and certificates.
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowRightLeft, Award, CheckCircle2, CloudUpload, Database, Download, ExternalLink, FileText,
  Link2, Loader2, MessageSquare, Pencil, Plus, Printer, RefreshCw, Save, SlidersHorizontal, Trash2, Trophy, Upload, X,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { api, Card, Label, StatusPill, fmtWhen, type ShowDialog, type PodInfo } from './pkt-ui';
import { CONFIG_FIELDS, CONFIG_GROUPS, DEFAULT_CONFIG, type AppConfig } from './app-config';
import { setAppConfig, useAppConfig } from './use-config';
import { ACCEPTED_FILES, fileToText } from './file-text';

const cn = (...inputs: ClassValue[]) => clsx(inputs);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`);
const fmtDate = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

// ── batches ──────────────────────────────────────────────────────────────────

interface BatchRow {
  id: number; batch_no: string; vendor: string; pod: string; start_date: string; kind: 'new' | 'old'; chat_webhook: string | null; agents: number;
  trainees: Array<{ id: number; agent_name: string; agent_email: string; status: string; status_label: string; current: string; overdue: boolean }>;
}

export function BatchesPanel({ showDialog }: { showDialog: ShowDialog }) {
  const [batches, setBatches] = useState<BatchRow[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [form, setForm] = useState({ batch_no: '', vendor: '', start_date: '', chat_webhook: '' });
  const [moving, setMoving] = useState<{ traineeId: number; name: string; pod: string; kind: string; from: number } | null>(null);
  const [filter, setFilter] = useState('');
  const load = () => api<BatchRow[]>('/api/trainer/batches').then(setBatches).catch((e) => showDialog({ type: 'error', title: 'Could not load batches', message: e.message }));
  useEffect(() => { load(); }, []);

  const save = async (b: BatchRow) => {
    const body: Record<string, string> = { batch_no: form.batch_no, vendor: form.vendor, start_date: form.start_date };
    if (form.chat_webhook !== '__keep__') body.chat_webhook = form.chat_webhook;
    try {
      await api(`/api/trainer/batches/${b.id}`, { method: 'PATCH', json: body });
      setEditing(null);
      load();
      if (form.start_date !== b.start_date) showDialog({ type: 'success', title: 'Batch updated', message: 'PKT dates now follow the new start date.' });
    } catch (e: any) { showDialog({ type: 'error', title: 'Could not save', message: e.message }); }
  };

  const move = async (batchId: number) => {
    if (!moving) return;
    try {
      await api(`/api/trainer/trainees/${moving.traineeId}/move`, { method: 'POST', json: { batch_id: batchId } });
      setMoving(null);
      load();
    } catch (e: any) { showDialog({ type: 'error', title: 'Could not move', message: e.message }); }
  };

  const shown = useMemo(() => (batches ?? []).filter((b) => !filter || `${b.batch_no} ${b.vendor} ${b.pod}`.toLowerCase().includes(filter.toLowerCase())), [batches, filter]);
  if (!batches) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-meesho-purple" size={32} /></div>;

  return (
    <div className="space-y-5">
      <Card className="flex flex-col gap-3 !py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-soft">Rename a batch, change its vendor or start date, set its Google Chat space, or move agents between batches of the same pod.</p>
        <input className="input-field sm:max-w-xs" placeholder="Search batches" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search batches" />
      </Card>
      {shown.length === 0 && <Card className="py-10 text-center text-ink-soft">No batches yet. Add agents from the Assign tab.</Card>}
      {shown.map((b) => (
        <Card key={b.id} className="space-y-4">
          {editing === b.id ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div><Label>Batch number</Label><input className="input-field" value={form.batch_no} onChange={(e) => setForm({ ...form, batch_no: e.target.value })} /></div>
                <div><Label>Vendor</Label><input className="input-field" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
                <div><Label>{b.kind === 'new' ? 'Training start date' : 'First PKT date'}</Label><input type="date" className="input-field" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
              </div>
              <div>
                <Label>Google Chat webhook for this batch (optional)</Label>
                <input className="input-field" placeholder={b.chat_webhook ? 'A webhook is set — paste a new one to replace it, or clear to remove' : 'https://chat.googleapis.com/v1/spaces/…'}
                  value={form.chat_webhook === '__keep__' ? '' : form.chat_webhook} onChange={(e) => setForm({ ...form, chat_webhook: e.target.value })} />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button onClick={() => setEditing(null)} className="rounded-2xl px-5 py-3 text-sm font-semibold text-ink-soft hover:bg-slate-50">Cancel</button>
                <button onClick={() => save(b)} className="btn-primary"><Save size={16} aria-hidden /> Save batch</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">{b.kind === 'new' ? 'New agents' : 'Production agents'} · {b.vendor}</p>
                <h3 className="mt-1 break-words text-xl font-bold text-ink">{b.batch_no} <span className="font-semibold text-ink-soft">· {b.pod}</span></h3>
                <p className="text-sm text-ink-soft">{b.kind === 'new' ? 'Starts' : 'First PKT'} {fmtDate(b.start_date)} · {b.agents} agent(s) · {b.chat_webhook ? 'Google Chat on' : 'Google Chat: default space'}</p>
              </div>
              <button onClick={() => { setEditing(b.id); setForm({ batch_no: b.batch_no, vendor: b.vendor, start_date: b.start_date, chat_webhook: '__keep__' }); }}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-4 py-2.5 text-sm font-semibold text-ink hover:bg-[#E8E1F8]"><Pencil size={15} aria-hidden /> Edit batch</button>
            </div>
          )}
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
            {b.trainees.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{t.agent_name}</p>
                  <p className="truncate text-xs text-ink-soft">{t.agent_email} · {t.current}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {t.overdue && <StatusPill status="overdue" label="Overdue" />}
                  <StatusPill status={t.status} label={t.status_label} />
                  <button onClick={() => setMoving({ traineeId: t.id, name: t.agent_name, pod: b.pod, kind: b.kind, from: b.id })}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-meesho-purple hover:bg-[#F2EEFC]"><ArrowRightLeft size={14} aria-hidden /> Move</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {moving && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-label="Move agent">
          <div className="w-full max-w-md space-y-4 rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-ink">Move {moving.name}</h3>
                <p className="text-sm text-ink-soft">Their PKT history moves with them. Only batches of {moving.pod} ({moving.kind === 'new' ? 'new agents' : 'production'}) are shown.</p>
              </div>
              <button onClick={() => setMoving(null)} className="rounded-full p-2 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {batches.filter((x) => x.pod === moving.pod && x.kind === moving.kind && x.id !== moving.from).map((x) => (
                <button key={x.id} onClick={() => move(x.id)} className="flex w-full items-center justify-between rounded-2xl border-2 border-slate-100 px-4 py-3 text-left hover:border-meesho-purple">
                  <span><span className="font-semibold text-ink">{x.batch_no}</span> <span className="text-sm text-ink-soft">· {x.vendor} · {fmtDate(x.start_date)}</span></span>
                  <ArrowRightLeft size={16} className="text-meesho-purple" aria-hidden />
                </button>
              ))}
              {batches.filter((x) => x.pod === moving.pod && x.kind === moving.kind && x.id !== moving.from).length === 0 && <p className="py-4 text-center text-sm text-ink-soft">No other batch of this pod yet. Create one from Assign first.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── trainer scope ────────────────────────────────────────────────────────────

export function TrainerScopePanel({ showDialog }: { showDialog: ShowDialog }) {
  const [data, setData] = useState<{ vendors: string[]; pods: string[]; trainers: Array<{ email: string; scopes: Array<{ vendor: string; pod: string }> }> } | null>(null);
  const [draft, setDraft] = useState<Record<string, Array<{ vendor: string; pod: string }>>>({});
  const load = () => api<NonNullable<typeof data>>('/api/admin/trainer-scopes').then((d) => { setData(d); setDraft(Object.fromEntries(d.trainers.map((t) => [t.email, t.scopes]))); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async (email: string) => {
    try {
      await api(`/api/admin/trainer-scopes/${encodeURIComponent(email)}`, { method: 'PUT', json: { scopes: draft[email] ?? [] } });
      showDialog({ type: 'success', title: 'Scope saved', message: `${email} now sees only the vendors and pods listed.` });
      load();
    } catch (e: any) { showDialog({ type: 'error', title: 'Could not save', message: e.message }); }
  };
  if (!data) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-meesho-purple" size={32} /></div>;

  return (
    <div className="space-y-5">
      <Card className="!py-4 text-sm text-ink-soft">
        Choose which vendors and pods each Trainer can see in Assign, Batches, Analytics and the leaderboard. A Trainer with no scope sees nothing. “All” covers every vendor or pod, including new ones. Add Trainers in User access.
      </Card>
      {data.trainers.length === 0 && <Card className="py-10 text-center text-ink-soft">No Trainers yet.</Card>}
      {data.trainers.map((t) => {
        const rows = draft[t.email] ?? [];
        const set = (rowsNext: Array<{ vendor: string; pod: string }>) => setDraft((d) => ({ ...d, [t.email]: rowsNext }));
        return (
          <Card key={t.email} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-ink">{t.email}</p>
              <p className="text-xs text-ink-soft">{rows.length ? `${rows.length} rule(s)` : 'No access yet'}</p>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <select className="input-field" value={r.vendor} aria-label="Vendor" onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, vendor: e.target.value } : x)))}>
                  <option value="*">All vendors</option>
                  {[...new Set([...data.vendors, r.vendor].filter((v) => v !== '*'))].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select className="input-field" value={r.pod} aria-label="Pod" onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, pod: e.target.value } : x)))}>
                  <option value="*">All pods</option>
                  {data.pods.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <button onClick={() => set(rows.filter((_, j) => j !== i))} className="rounded-2xl px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-50">Remove</button>
              </div>
            ))}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              <button onClick={() => set([...rows, { vendor: '*', pod: data.pods[0] ?? '*' }])} className="rounded-2xl bg-[#F2EEFC] px-4 py-2.5 text-sm font-semibold text-ink">+ Add vendor / pod</button>
              <button onClick={() => save(t.email)} className="btn-primary"><Save size={16} aria-hidden /> Save scope</button>
            </div>
            <p className="text-xs text-ink-soft">Vendor names come from existing batches; you can also type a new one later by editing a batch.</p>
          </Card>
        );
      })}
    </div>
  );
}

// ── Google sync for one pod ──────────────────────────────────────────────────

interface Source { pod: string; sop_url: string | null; manual_url: string | null; last_synced_at: number | null; status: string | null; message: string | null; set_by?: string | null; set_at?: number | null; }

export function PodSyncCard({ pod, onSynced, showDialog }: { pod: string; onSynced: () => void; showDialog: ShowDialog }) {
  const [src, setSrc] = useState<Source | null>(null);
  const [driveOn, setDriveOn] = useState(false);
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null);
  const [sopUrl, setSopUrl] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [mode, setMode] = useState<'upload' | 'links' | 'paste'>('upload');
  const [files, setFiles] = useState<{ sop?: { name: string; text: string }; manual?: { name: string; text: string } }>({});
  const [reading, setReading] = useState<'' | 'sop' | 'manual'>('');
  const [sopText, setSopText] = useState('');
  const [manualText, setManualText] = useState('');
  const load = async () => {
    const d = await api<{ drive_connected: boolean; sop_folder: { id: string; name: string } | null; sources: Source[] }>('/api/admin/pod-sources');
    const s = d.sources.find((x) => x.pod === pod) ?? null;
    setDriveOn(d.drive_connected && !!d.sop_folder);
    setFolder(d.sop_folder);
    setSrc(s);
    if (s && !sopUrl) { setSopUrl(s.sop_url ?? ''); setManualUrl(s.manual_url ?? ''); }
    return s;
  };
  useEffect(() => { load().catch(() => {}); }, [pod]);
  // poll while a sync is running
  useEffect(() => {
    if (src?.status !== 'syncing' && src?.status !== 'pending') return;
    const t = setInterval(async () => {
      const s = await load().catch(() => null);
      if (s?.status === 'ok') { clearInterval(t); onSynced(); }
      if (s?.status === 'error') clearInterval(t);
    }, 5000);
    return () => clearInterval(t);
  }, [src?.status]);

  const saveLinks = async () => {
    try {
      const r = await api<{ message: string }>(`/api/admin/pod-sources/${encodeURIComponent(pod)}`, { method: 'PUT', json: { sop_url: sopUrl, manual_url: manualUrl } });
      showDialog({ type: 'success', title: 'Links saved', message: r.message });
      load();
    } catch (e: any) { showDialog({ type: 'error', title: 'Could not save', message: e.message }); }
  };
  const syncNow = async () => {
    try { await api(`/api/admin/pod-sources/${encodeURIComponent(pod)}/sync`, { method: 'POST', json: {} }); setSrc((s) => (s ? { ...s, status: 'syncing', message: 'Syncing…' } : s)); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not sync', message: e.message }); }
  };
  const readFile = async (which: 'sop' | 'manual', file: File) => {
    setReading(which);
    try {
      const text = await fileToText(file);
      setFiles((f) => ({ ...f, [which]: { name: file.name, text } }));
    } catch (e: any) {
      showDialog({ type: 'error', title: `Couldn't read ${file.name}`, message: e.message });
    } finally {
      setReading('');
    }
  };
  const build = async (sop: string, manual: string) => {
    if (sop.length + manual.length > 900_000) {
      showDialog({ type: 'error', title: 'Files too large', message: 'Together the SOP and manual are over 900,000 characters. Split the SOP or remove appendices, then try again.' });
      return;
    }
    try { await api(`/api/admin/pod-sources/${encodeURIComponent(pod)}/paste`, { method: 'POST', json: { sop_text: sop, manual_text: manual } }); setSrc({ pod, sop_url: null, manual_url: null, last_synced_at: null, status: 'syncing', message: 'Processing…' }); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not process', message: e.message }); }
  };

  const busy = src?.status === 'syncing';
  return (
    <div className="space-y-4 rounded-3xl border-2 border-[#EADCF8] bg-[#FBFAFF] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-lg font-bold text-ink"><RefreshCw size={18} className="text-meesho-purple" aria-hidden /> Build day-wise SOPs from the SOP + training manual</p>
          <p className="text-sm text-ink-soft">Give the app the full SOP and the day-wise training manual: upload the files, link them from Google Drive, or paste the text. It finds each day's topics in the manual and pulls the matching SOP sections into Day 1, Day 2…</p>
        </div>
        <div className="flex rounded-full bg-[#F2EEFC] p-1 text-sm font-semibold">
          {(['upload', 'links', 'paste'] as const).map((m) => <button key={m} onClick={() => setMode(m)} className={cn('rounded-full px-3 py-1.5', mode === m ? 'bg-white text-ink shadow' : 'text-ink-soft')}>{m === 'upload' ? 'Upload files' : m === 'links' ? 'Google links' : 'Paste text'}</button>)}
        </div>
      </div>
      {src?.status && (
        <p className={cn('flex items-start gap-2 rounded-2xl px-4 py-3 text-sm font-medium',
          src.status === 'ok' ? 'bg-emerald-50 text-emerald-900' : src.status === 'error' ? 'bg-rose-50 text-rose-900' : 'bg-blue-50 text-blue-900')}>
          {src.status === 'ok' ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden /> : src.status === 'error' ? <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden /> : <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" aria-hidden />}
          <span>{src.message}{src.last_synced_at ? ` · last synced ${fmtWhen(src.last_synced_at)}` : ''}</span>
        </p>
      )}
      {mode === 'upload' && (
        <>
          <p className="text-sm text-ink-soft">From Google use <b>File → Download</b>: Docs as Word (.docx) or PDF, Slides as PowerPoint (.pptx) or PDF, Sheets as Excel (.xlsx) or .csv. Upload again whenever the SOP or manual changes.</p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {([['sop', 'Full SOP'], ['manual', 'Training manual (day-wise)']] as const).map(([which, label]) => (
              <div key={which} className="min-w-0">
                <Label>{label}</Label>
                <label className={cn('flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-4 text-center', files[which] ? 'border-emerald-300 bg-emerald-50' : 'border-[#DCCDF3] bg-white hover:border-meesho-purple')}>
                  {reading === which ? <Loader2 size={20} className="animate-spin text-meesho-purple" aria-hidden /> : files[which] ? <CheckCircle2 size={20} className="text-emerald-700" aria-hidden /> : <Upload size={20} className="text-meesho-purple" aria-hidden />}
                  <span className="max-w-full truncate text-sm font-semibold text-ink">{reading === which ? 'Reading…' : files[which]?.name || 'Choose file'}</span>
                  <span className="text-xs text-ink-soft">{files[which] ? `${files[which]!.text.length.toLocaleString('en-IN')} characters read` : '.docx · .pptx · .pdf · .xlsx · .csv · .txt'}</span>
                  <input type="file" accept={ACCEPTED_FILES} className="hidden" disabled={!!reading || busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readFile(which, f); }} />
                </label>
                {files[which] && <details className="mt-2 text-xs text-ink-soft"><summary className="cursor-pointer font-semibold">Preview text</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 font-sans">{files[which]!.text.slice(0, 2000)}{files[which]!.text.length > 2000 ? '…' : ''}</pre></details>}
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <button onClick={() => build(files.sop!.text, files.manual!.text)} disabled={busy || !files.sop || !files.manual} className="btn-primary"><FileText size={16} aria-hidden /> Build day-wise SOPs</button>
          </div>
        </>
      )}
      {mode === 'links' && (
        <>
          {!driveOn
            ? <p className="flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"><AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden /> Google sync isn't set up yet. The Super Admin connects Google Drive and chooses the approved SOP folder in Settings. Until then, use Upload files.</p>
            : <p className="text-sm text-ink-soft">Only files inside the approved SOP folder <span className="font-semibold text-ink">“{folder?.name}”</span> can be linked.{src?.set_by ? ` Links last set by ${src.set_by}${src.set_at ? ` on ${fmtWhen(src.set_at)}` : ''}.` : ''}</p>}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div><Label>Full SOP (Google Doc)</Label><input className="input-field" placeholder="https://docs.google.com/document/d/…" value={sopUrl} onChange={(e) => setSopUrl(e.target.value)} /></div>
            <div><Label>Training manual, day-wise (Google Doc or Slides)</Label><input className="input-field" placeholder="https://docs.google.com/presentation/d/…" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} /></div>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {src?.sop_url && <button onClick={syncNow} disabled={busy || !driveOn} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink disabled:opacity-50"><RefreshCw size={16} aria-hidden /> Sync now</button>}
            <button onClick={saveLinks} disabled={busy || !driveOn || !sopUrl || !manualUrl} className="btn-primary"><Link2 size={16} aria-hidden /> Save links & sync</button>
          </div>
        </>
      )}
      {mode === 'paste' && (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div><Label>Full SOP text</Label><textarea className="input-field h-48 resize-y" value={sopText} onChange={(e) => setSopText(e.target.value)} /></div>
            <div><Label>Training manual text (day-wise)</Label><textarea className="input-field h-48 resize-y" value={manualText} onChange={(e) => setManualText(e.target.value)} /></div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => build(sopText, manualText)} disabled={busy || sopText.length < 50 || manualText.length < 50} className="btn-primary"><FileText size={16} aria-hidden /> Build day-wise SOPs</button>
          </div>
        </>
      )}
      <p className="text-xs text-ink-soft">Building takes about a minute. It replaces this pod's day SOPs and sets its number of training days from the manual.</p>
    </div>
  );
}

// ── settings ─────────────────────────────────────────────────────────────────

const CHUNK = 512 * 1024;

export function SettingsPanel({ isSuperAdmin, showDialog }: { isSuperAdmin: boolean; showDialog: ShowDialog }) {
  const [s, setS] = useState<{
    chat_default_webhook: string | null; drive_connected: boolean; drive_connected_email: string | null; drive_connected_by: string | null;
    drive_connected_at: number | null; last_drive_backup: string | null; sop_folder: { id: string; name: string; set_by: string | null } | null;
  } | null>(null);
  const [folderUrl, setFolderUrl] = useState('');
  const [webhook, setWebhook] = useState('');
  const [bk, setBk] = useState<{ backups: Array<{ name: string; size: number; created_at: number }> } | null>(null);
  const [busy, setBusy] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const load = () => {
    api<NonNullable<typeof s>>('/api/admin/settings').then(setS).catch(() => {});
    if (isSuperAdmin) api<NonNullable<typeof bk>>('/api/admin/backups').then(setBk).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const saveWebhook = async (value: string) => {
    try { await api('/api/admin/settings', { method: 'PUT', json: { chat_default_webhook: value } }); setWebhook(''); load(); showDialog({ type: 'success', title: 'Saved', message: value ? 'Default Google Chat space saved.' : 'Default Google Chat space removed.' }); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not save', message: e.message }); }
  };
  const testChat = async () => {
    try { await api('/api/admin/chat/test', { method: 'POST', json: { webhook } }); showDialog({ type: 'success', title: 'Sent', message: 'A test message was posted to the Google Chat space.' }); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not send', message: e.message }); }
  };
  const saveFolder = async (value: string) => {
    try { const r = await api<{ name?: string }>('/api/admin/settings/drive/folder', { method: 'PUT', json: { folder_url: value } }); setFolderUrl(''); load(); showDialog({ type: 'success', title: 'Saved', message: value ? `SOP links must now be inside “${r.name}”.` : 'Approved SOP folder removed. Google sync is off until a folder is chosen.' }); }
    catch (e: any) { showDialog({ type: 'error', title: 'Could not save', message: e.message }); }
  };
  const backupNow = async (toDrive: boolean) => {
    setBusy(toDrive ? 'drive' : 'backup');
    try { const r = await api<{ name: string; drive: boolean }>('/api/admin/backups', { method: 'POST', json: { to_drive: toDrive } }); load(); showDialog({ type: 'success', title: 'Backup taken', message: `${r.name}${r.drive ? ' — also copied to Google Drive (“ReadyCheck backups”).' : ''}` }); }
    catch (e: any) { showDialog({ type: 'error', title: 'Backup failed', message: e.message }); }
    finally { setBusy(''); }
  };
  const importOld = async (file: File) => {
    setBusy('import');
    setImportMsg('Uploading…');
    try {
      const id = crypto.randomUUID();
      const buf = new Uint8Array(await file.arrayBuffer());
      const total = Math.ceil(buf.length / CHUNK);
      for (let i = 0; i < total; i++) {
        const part = buf.subarray(i * CHUNK, (i + 1) * CHUNK);
        let bin = '';
        for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode(...part.subarray(j, j + 0x8000));
        await api('/api/admin/legacy/chunk', { method: 'POST', json: { upload_id: id, index: i, data: btoa(bin) } });
        setImportMsg(`Uploading… ${Math.round(((i + 1) / total) * 100)}%`);
      }
      setImportMsg('Importing…');
      const r = await api<{ pods: number; sops: number; admins: number; agents: number; results: number }>('/api/admin/legacy/import', { method: 'POST', json: { upload_id: id, total } });
      setImportMsg(`Imported ${r.agents} agents, ${r.results} past results, ${r.sops} SOP days, ${r.pods} pods and ${r.admins} admins. Old agents are in LEGACY-<pod> batches; past results show in analytics but don't count toward attempts.`);
    } catch (e: any) {
      setImportMsg('');
      showDialog({ type: 'error', title: 'Import failed', message: e.message });
    } finally { setBusy(''); }
  };

  if (!s) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-meesho-purple" size={32} /></div>;
  const params = new URLSearchParams(window.location.search);

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <p className="flex items-center gap-2 text-lg font-bold text-ink"><Link2 size={18} className="text-meesho-purple" aria-hidden /> Google Drive</p>
        <p className="text-sm text-ink-soft">Lets ReadyCheck read each pod's SOP and training manual from one approved folder (read-only) and save daily database backups to a “ReadyCheck backups” folder. Only the Super Admin connects it, with a Meesho account (ideally a shared team account that can open only the SOP folder). Backups never include sign-in sessions.</p>
        {params.get('drive') === 'error' && <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-900">Google Drive couldn't be connected. Try again, or check that the Google Cloud app allows Drive access.</p>}
        {params.get('drive') === 'not_meesho' && <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-900">Only a verified @meesho.com Google account can be connected. Personal Gmail accounts are refused.</p>}
        {s.drive_connected ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800"><CheckCircle2 size={18} aria-hidden /> Connected as {s.drive_connected_email || 'Google account'}{s.drive_connected_by && s.drive_connected_by !== s.drive_connected_email ? ` (by ${s.drive_connected_by})` : ''}{s.drive_connected_at ? ` since ${fmtWhen(s.drive_connected_at)}` : ''}</p>
            {isSuperAdmin && (
              <div className="flex gap-2">
                <a href="/auth/google/drive" className="rounded-2xl bg-[#F2EEFC] px-4 py-2.5 text-sm font-semibold text-ink">Reconnect</a>
                <button onClick={async () => { await api('/api/admin/settings/drive/disconnect', { method: 'POST', json: {} }); load(); }} className="rounded-2xl px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-50">Disconnect</button>
              </div>
            )}
          </div>
        ) : isSuperAdmin ? (
          <a href="/auth/google/drive" className="btn-primary w-full sm:w-auto"><Link2 size={16} aria-hidden /> Connect Google Drive</a>
        ) : (
          <p className="text-sm font-semibold text-ink">Not connected. The Super Admin can connect it.</p>
        )}
        {s.drive_connected && (
          <div className="space-y-2 border-t border-slate-100 pt-4">
            <p className="text-sm font-semibold text-ink">Approved SOP folder</p>
            <p className="text-sm text-ink-soft">{s.sop_folder ? <>Pod links must point to files inside <span className="font-semibold text-ink">“{s.sop_folder.name}”</span>{s.sop_folder.set_by ? ` (set by ${s.sop_folder.set_by})` : ''}. Files anywhere else are refused before they are read.</> : 'No folder chosen yet, so Google sync is off. Put the SOPs and training manuals in one Drive folder and paste its link here.'}</p>
            {isSuperAdmin && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <input className="input-field" placeholder="https://drive.google.com/drive/folders/…" value={folderUrl} onChange={(e) => setFolderUrl(e.target.value)} aria-label="Approved SOP folder link" />
                <button onClick={() => saveFolder(folderUrl)} disabled={!folderUrl} className="btn-primary">Save folder</button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-4">
        <p className="flex items-center gap-2 text-lg font-bold text-ink"><MessageSquare size={18} className="text-meesho-purple" aria-hidden /> Google Chat reminders</p>
        <p className="text-sm text-ink-soft">At 5 PM IST, when a PKT opens, a message lists the agents who should take it; every morning, overdue agents are listed. Messages go to the batch's own space if set (Batches tab), otherwise to this default space. In Google Chat: open the space → Apps & integrations → Webhooks → add one and paste its URL here.</p>
        <p className="text-sm font-semibold text-ink">{s.chat_default_webhook ? '✓ A default space is set.' : 'No default space yet.'}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input className="input-field" placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…" value={webhook} onChange={(e) => setWebhook(e.target.value)} aria-label="Google Chat webhook URL" />
          <button onClick={testChat} className="rounded-2xl bg-[#F2EEFC] px-4 py-3 text-sm font-semibold text-ink">Send test</button>
          <button onClick={() => saveWebhook(webhook)} disabled={!webhook} className="btn-primary">Save</button>
        </div>
        {s.chat_default_webhook && <button onClick={() => saveWebhook('')} className="text-sm font-semibold text-rose-700 hover:underline">Remove default space</button>}
        <p className="text-xs text-ink-soft">The app sends reminders while it is running; builders may pause an idle app, so a reminder can arrive late if nobody has used the app for a while.</p>
      </Card>

      {isSuperAdmin && (
        <Card className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-bold text-ink"><Database size={18} className="text-meesho-purple" aria-hidden /> Backups</p>
          <p className="text-sm text-ink-soft">The app snapshots its database automatically (at most every 15 minutes after a change, last 30 kept) without touching the live app, and copies one to Google Drive every day when Drive is connected. Download a copy any time.{s.last_drive_backup ? ` Last Drive copy: ${fmtWhen(Number(s.last_drive_backup))}.` : ''}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button onClick={() => backupNow(false)} disabled={!!busy} className="btn-primary">{busy === 'backup' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} aria-hidden />} Back up now</button>
            <button onClick={() => backupNow(true)} disabled={!!busy || !s.drive_connected} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink disabled:opacity-50">{busy === 'drive' ? <Loader2 size={16} className="animate-spin" /> : <CloudUpload size={16} aria-hidden />} Back up to Google Drive</button>
          </div>
          <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-2xl border border-slate-100">
            {(bk?.backups ?? []).length === 0 && <p className="px-4 py-6 text-center text-sm text-ink-soft">No backups yet.</p>}
            {(bk?.backups ?? []).map((b) => (
              <div key={b.name} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate text-ink">{fmtWhen(b.created_at)} <span className="text-ink-soft">· {(b.size / 1024).toFixed(0)} KB</span></span>
                <a href={`/api/admin/backups/${encodeURIComponent(b.name)}/download`} className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-meesho-purple hover:underline"><Download size={15} aria-hidden /> Download</a>
              </div>
            ))}
          </div>
        </Card>
      )}

      {isSuperAdmin && (
        <Card className="space-y-4">
          <p className="flex items-center gap-2 text-lg font-bold text-ink"><Upload size={18} className="text-meesho-purple" aria-hidden /> Import data from the old system</p>
          <p className="text-sm text-ink-soft">Upload the old app's <code>readycheck.db</code> file. Its pods, SOPs, admins, agents and past results are added; nothing existing is overwritten.</p>
          <label className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#DCCDF3] px-5 py-6 text-sm font-semibold text-ink hover:border-meesho-purple', busy === 'import' && 'pointer-events-none opacity-60')}>
            {busy === 'import' ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} aria-hidden />} Choose readycheck.db
            <input type="file" accept=".db,.sqlite,.bak" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importOld(f); }} />
          </label>
          {importMsg && <p className="rounded-2xl bg-[#F7F5FF] px-4 py-3 text-sm text-ink">{importMsg}</p>}
        </Card>
      )}
    </div>
  );
}

// ── vendors (Super Admin) ────────────────────────────────────────────────────

export function VendorsPanel({ showDialog }: { showDialog: ShowDialog }) {
  const [rows, setRows] = useState<Array<{ name: string; created_by: string | null; batches: number }> | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Array<{ name: string; created_by: string | null; batches: number }>>('/api/vendors').then(setRows).catch((e) => showDialog({ type: 'error', title: 'Could not load vendors', message: e.message }));
  useEffect(() => { load(); }, []);
  const cfg = useAppConfig();
  const emailPart = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api('/api/admin/vendors', { method: 'POST', json: { name } });
      setName('');
      load();
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not add vendor', message: e.message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (v: string) => {
    try {
      await api(`/api/admin/vendors/${encodeURIComponent(v)}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not remove vendor', message: e.message });
    }
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div>
          <p className="text-lg font-bold text-ink">Add a vendor</p>
          <p className="text-sm text-ink-soft">Agent emails look like agentname_<span className="font-semibold text-ink">vendorname</span>@meesho.com. When a Trainer assigns an agent, the part after the underscore is matched to this list (capitals, spaces and dots don't matter) and the vendor is filled in for them. {cfg.assignAnyMeeshoEmail ? 'Any other @meesho.com email is assigned to the vendor Meesho.' : 'Emails without a listed vendor are refused (Dynamic settings → Any @meesho.com email can be assigned is off).'}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Label>Vendor name</Label>
            <input className="input-field" value={name} maxLength={60} placeholder="e.g. Technotask" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            {name.trim() && <p className="mt-2 text-sm text-ink-soft">Matches emails like <span className="font-mono text-ink">agent.name_{emailPart(name) || '…'}@meesho.com</span></p>}
          </div>
          <button onClick={add} disabled={busy || !name.trim()} className="btn-primary h-[52px] w-full self-start sm:mt-[30px] sm:w-auto">{busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add vendor</button>
        </div>
      </Card>
      <Card className="!p-0 overflow-hidden">
        {!rows ? <div className="flex justify-center py-12"><Loader2 className="animate-spin text-meesho-purple" size={28} /></div> : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-ink-soft">No vendors yet. Add the first one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
                <tr>{['Vendor', 'Email part', 'Batches', ''].map((h, i) => <th key={i} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-semibold text-ink">{r.name}</td>
                    <td className="px-4 py-3 font-mono text-ink-soft">_{emailPart(r.name)}@meesho.com</td>
                    <td className="px-4 py-3 text-ink">{r.batches}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => remove(r.name)} disabled={r.batches > 0} title={r.batches > 0 ? 'This vendor has batches' : `Remove ${r.name}`}
                        className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-30">
                        <Trash2 size={15} aria-hidden /> Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── leaderboard ──────────────────────────────────────────────────────────────

interface LeaderRow {
  rank: number; agent_name: string; agent_email?: string; vendor: string; pod: string; batch_no: string; kind: 'new' | 'old';
  avg_score: number | null; best_score: number | null; first_try_passes: number; attempts: number; status_label: string; me: boolean;
}
interface LeaderData {
  hidden?: boolean; type: 'all' | 'new' | 'old'; window: string; rows: LeaderRow[]; podium: LeaderRow[];
  options?: {
    vendors: string[]; pods: string[]; start_dates: string[]; periods: Array<{ id: string; label: string }>;
    batches: Array<{ batch_no: string; vendor: string; pod: string; kind: 'new' | 'old'; start_date: string }>;
  };
}

const PODIUM = [
  { name: 'Gold', medal: '🥇', card: 'border-amber-300 bg-gradient-to-b from-amber-50 to-white', tag: 'bg-amber-100 text-amber-900' },
  { name: 'Silver', medal: '🥈', card: 'border-slate-300 bg-gradient-to-b from-slate-50 to-white', tag: 'bg-slate-200 text-slate-800' },
  { name: 'Bronze', medal: '🥉', card: 'border-orange-300 bg-gradient-to-b from-orange-50 to-white', tag: 'bg-orange-100 text-orange-900' },
];

export function LeaderboardPanel({ staff }: { staff: boolean }) {
  const blank = { type: 'all', vendor: '', pod: '', batch_no: '', start_date: '', period: '', status: '' };
  const [f, setF] = useState(blank);
  const [data, setData] = useState<LeaderData | null>(null);
  const [opts, setOpts] = useState<LeaderData['options']>();
  useEffect(() => {
    setData(null);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as Array<[string, string]>).toString();
    api<LeaderData>(`/api/leaderboard${staff && qs ? `?${qs}` : ''}`)
      .then((d) => { setData(d); if (d.options) setOpts(d.options); })
      .catch(() => setData({ type: 'all', window: '', rows: [], podium: [] }));
  }, [staff, f]);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setF((cur) => ({ ...cur, [k]: v, ...(k === 'type' ? { start_date: '', period: '', batch_no: '' } : {}), ...(k === 'vendor' || k === 'pod' ? { batch_no: '' } : {}) }));
  };
  const batches = (opts?.batches ?? []).filter((b) => (f.type === 'all' || b.kind === f.type) && (!f.vendor || b.vendor === f.vendor) && (!f.pod || b.pod === f.pod) && (!f.start_date || b.start_date === f.start_date));
  const periods = (opts?.periods ?? []).filter((p) => (f.type === 'old' ? p.id.startsWith('w:') : true));
  const mine = data?.rows.find((r) => r.me);
  const rows = staff ? data?.rows ?? [] : (data?.rows ?? []).slice(0, 10);

  if (data?.hidden) {
    return (
      <Card className="py-14 text-center">
        <Trophy size={36} className="mx-auto text-amber-600" aria-hidden />
        <p className="mt-4 text-lg font-bold text-ink">The leaderboard is for agents in training</p>
        <p className="mx-auto mt-2 max-w-md text-ink-soft">It shows your batch's PKT scores from Day 1 until your training ends.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-lg font-bold text-ink"><Trophy size={20} className="text-amber-600" aria-hidden /> Leaderboard</p>
        {data?.window && <p className="text-sm text-ink-soft">{data.window}</p>}
      </div>

      {staff && (
        <Card className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div><Label>Agent type</Label><select className="input-field" value={f.type} onChange={set('type')}><option value="all">All</option><option value="new">New (in training)</option><option value="old">Old (production)</option></select></div>
          <div><Label>Vendor / BPO</Label><select className="input-field" value={f.vendor} onChange={set('vendor')}><option value="">All</option>{opts?.vendors.map((v) => <option key={v}>{v}</option>)}</select></div>
          <div><Label>Pod</Label><select className="input-field" value={f.pod} onChange={set('pod')}><option value="">All</option>{opts?.pods.map((v) => <option key={v}>{v}</option>)}</select></div>
          <div><Label>Batch number</Label><select className="input-field" value={f.batch_no} onChange={set('batch_no')}><option value="">All</option>{batches.map((b) => <option key={b.batch_no}>{b.batch_no}</option>)}</select></div>
          {f.type === 'new' ? (
            <div><Label>Training start date</Label><select className="input-field" value={f.start_date} onChange={set('start_date')}><option value="">All</option>{opts?.start_dates.map((v) => <option key={v} value={v}>{fmtDate(v)}</option>)}</select></div>
          ) : (
            <div><Label>{f.type === 'old' ? 'Week' : 'Week / month'}</Label><select className="input-field" value={f.period} onChange={set('period')}>{periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
          )}
          <div><Label>Status</Label><select className="input-field" value={f.status} onChange={set('status')}><option value="">All</option><option value="active">In training / active</option><option value="passed">Passed</option><option value="exit">Exit</option></select></div>
        </Card>
      )}

      {!data ? <div className="flex justify-center py-12"><Loader2 className="animate-spin text-meesho-purple" size={28} /></div> : data.rows.length === 0 ? (
        <Card><p className="py-8 text-center text-ink-soft">No PKT scores for these filters yet.</p></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {data.podium.map((r, i) => (
              <div key={`${r.rank}-${r.agent_name}`} className={cn('rounded-[24px] border-2 p-5 shadow-sm', PODIUM[i].card, r.me && 'ring-2 ring-meesho-purple')}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-4xl" aria-hidden>{PODIUM[i].medal}</span>
                  <span className={cn('rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.12em]', PODIUM[i].tag)}>{PODIUM[i].name} · #{r.rank}</span>
                </div>
                <p className="mt-4 break-words text-lg font-bold text-ink">{r.agent_name}{r.me && <span className="ml-2 rounded-full bg-[#EADCF8] px-2 py-0.5 text-xs text-[#6B1A70]">You</span>}</p>
                <p className="text-sm font-semibold text-ink-soft">{r.vendor}</p>
                <p className="mt-3 text-3xl font-extrabold text-ink">{pct(r.avg_score)}</p>
                <p className="text-xs text-ink-soft">average PKT score · {r.pod} · {r.batch_no}</p>
              </div>
            ))}
          </div>
          {!staff && mine && mine.rank > 10 && <Card className="!py-4 text-sm font-semibold text-ink">You are #{mine.rank} in your batch with {pct(mine.avg_score)} average.</Card>}
          {rows.length > 3 && (
            <Card className="!p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.08em] text-ink-soft">
                    <tr>{['Rank', 'Agent', 'Vendor', 'Pod / batch', 'Avg score', 'First-try passes', 'PKTs', ...(staff ? ['Status'] : [])].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.slice(3).map((r) => (
                      <tr key={`${r.rank}-${r.agent_name}`} className={cn('border-t border-slate-100', r.me && 'bg-[#F7F2FF]')}>
                        <td className="px-4 py-3 font-bold text-ink">#{r.rank}</td>
                        <td className="px-4 py-3 font-semibold text-ink">{r.agent_name}{r.me && <span className="ml-2 rounded-full bg-[#EADCF8] px-2 py-0.5 text-xs text-[#6B1A70]">You</span>}</td>
                        <td className="px-4 py-3 text-ink">{r.vendor}</td>
                        <td className="px-4 py-3 text-ink-soft">{r.pod} · {r.batch_no}</td>
                        <td className="px-4 py-3 font-bold text-ink">{pct(r.avg_score)}</td>
                        <td className="px-4 py-3 text-ink">{r.first_try_passes}</td>
                        <td className="px-4 py-3 text-ink">{r.attempts}</td>
                        {staff && <td className="px-4 py-3 text-ink-soft">{r.status_label}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
      <p className="text-xs text-ink-soft">Ranked by average PKT score, then first-try passes, then speed. Weeks follow the calendar month: days 1–7 are the 1st week, 8–14 the 2nd, and so on (IST).</p>
    </div>
  );
}

// ── certificate ──────────────────────────────────────────────────────────────

export function CertificateView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/api/certificates/${encodeURIComponent(id)}`).then(setC).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="mx-auto max-w-3xl px-4 py-10"><Card><p className="text-rose-800">{error}</p></Card></div>;
  if (!c) return <div className="flex justify-center py-32"><Loader2 className="animate-spin text-meesho-purple" size={36} /></div>;
  const issued = new Date(String(c.issued_at).includes('T') ? c.issued_at : `${String(c.issued_at).replace(' ', 'T')}Z`);
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 pb-24 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <button onClick={onBack} className="text-sm font-semibold text-ink-soft hover:text-meesho-purple">← Back</button>
        <button onClick={() => window.print()} className="btn-primary"><Printer size={16} aria-hidden /> Print / save as PDF</button>
      </div>
      <div className="rounded-[28px] border-[10px] border-double border-[#9D2AA3] bg-white p-8 text-center shadow-2xl sm:p-14 print:shadow-none">
        <Award size={64} className="mx-auto text-[#9D2AA3]" strokeWidth={1.4} aria-hidden />
        <p className="mt-4 text-sm font-bold uppercase tracking-[0.3em] text-[#A21CAF]">Meesho · ReadyCheck</p>
        <h1 className="mt-4 text-[clamp(2rem,6vw,3.25rem)] font-extrabold leading-tight tracking-tight text-ink">Certificate of SOP readiness</h1>
        <p className="mt-6 text-lg text-ink-soft">This certifies that</p>
        <p className="mt-2 text-[clamp(1.8rem,5vw,2.75rem)] font-bold text-[#6B1A70]">{c.agent_name || c.agent_email}</p>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-ink">
          has completed all {c.training_days} training days and passed every day's PKT for <strong>{c.pod}</strong>
          {c.vendor ? <> ({c.vendor})</> : null}{c.batch_no ? <>, batch {c.batch_no}</> : null}
          {c.avg_score !== null ? <>, with an average passing score of <strong>{pct(c.avg_score)}</strong></> : null}.
        </p>
        <div className="mx-auto mt-10 flex max-w-xl flex-col items-center justify-between gap-4 border-t border-slate-200 pt-6 text-sm text-ink-soft sm:flex-row">
          <span>Issued {issued.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}</span>
          <span className="font-mono font-semibold text-ink">ID {c.id}</span>
        </div>
      </div>
    </div>
  );
}

// ── dynamic settings (Super Admin) ───────────────────────────────────────────

export function DynamicSettingsPanel({ showDialog }: { showDialog: ShowDialog }) {
  const [saved, setSaved] = useState<AppConfig | null>(null);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [meta, setMeta] = useState<{ updated_by: string | null; updated_at: number | null }>({ updated_by: null, updated_at: null });
  const [busy, setBusy] = useState(false);
  const load = () => api<{ config: AppConfig; updated_by: string | null; updated_at: number | null }>('/api/admin/config')
    .then((r) => { setSaved(r.config); setDraft(r.config); setMeta({ updated_by: r.updated_by, updated_at: r.updated_at }); })
    .catch((e) => showDialog({ type: 'error', title: 'Could not load settings', message: e.message }));
  useEffect(() => { load(); }, []);

  if (!saved || !draft) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-meesho-purple" size={32} /></div>;
  const changed = CONFIG_FIELDS.filter((f) => draft[f.key] !== saved[f.key]);
  const set = (key: keyof AppConfig, value: unknown) => setDraft((d) => (d ? ({ ...d, [key]: value } as AppConfig) : d));

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ config: AppConfig }>('/api/admin/config', { method: 'PUT', json: { config: draft } });
      setAppConfig(r.config);
      await load();
      showDialog({ type: 'success', title: 'Settings saved', message: `${changed.length} setting${changed.length === 1 ? '' : 's'} changed. The app uses the new values straight away.` });
    } catch (e: any) {
      showDialog({ type: 'error', title: 'Could not save', message: e.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-2 !py-5">
        <p className="flex items-center gap-2 text-lg font-bold text-ink"><SlidersHorizontal size={18} className="text-meesho-purple" aria-hidden /> Dynamic settings</p>
        <p className="text-sm text-ink-soft">Change how ReadyCheck works without a code change. Saved settings apply to the whole app straight away: new PKTs, the agent and trainer screens, and Google Chat messages. Tests already in progress keep their questions. Sign-in (Google, @meesho.com accounts only) is fixed and isn't a setting.</p>
        {meta.updated_by && <p className="text-xs text-ink-soft">Last changed by {meta.updated_by}{meta.updated_at ? ` on ${fmtWhen(meta.updated_at)}` : ''}.</p>}
      </Card>

      {CONFIG_GROUPS.map((group) => (
        <Card key={group} className="space-y-1">
          <p className="pb-2 text-base font-bold text-ink">{group}</p>
          {CONFIG_FIELDS.filter((f) => f.group === group).map((f) => {
            const value = draft[f.key];
            const isChanged = value !== saved[f.key];
            const isDefault = value === DEFAULT_CONFIG[f.key];
            return (
              <div key={f.key} className="flex flex-col gap-3 border-t border-slate-100 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 sm:pr-6">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                    {f.label}
                    {isChanged && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900">Not saved</span>}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-soft">{f.help}{!isDefault ? ` Default: ${f.type === 'bool' ? (DEFAULT_CONFIG[f.key] ? 'on' : 'off') : `${DEFAULT_CONFIG[f.key]}${f.type === 'number' && f.unit ? ` ${f.unit}` : ''}`}.` : ''}</p>
                </div>
                <div className="shrink-0">
                  {f.type === 'bool' ? (
                    <button role="switch" aria-checked={!!value} aria-label={f.label} onClick={() => set(f.key, !value)}
                      className={cn('relative inline-flex h-8 w-14 items-center rounded-full transition-colors', value ? 'bg-meesho-purple' : 'bg-slate-300')}>
                      <span className={cn('inline-block h-6 w-6 rounded-full bg-white shadow transition-transform', value ? 'translate-x-7' : 'translate-x-1')} />
                    </button>
                  ) : f.type === 'time' ? (
                    <input type="time" className="input-field !w-36" value={String(value)} aria-label={f.label}
                      onChange={(e) => e.target.value && set(f.key, e.target.value)} />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input type="number" className="input-field !w-28" min={f.min} max={f.max} value={Number(value)} aria-label={f.label}
                        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(f.key, n); }}
                        onBlur={() => set(f.key, Math.min(f.max, Math.max(f.min, Math.round(Number(value)))))} />
                      {f.unit && <span className="text-sm text-ink-soft">{f.unit}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      ))}

      <div className="sticky bottom-4 z-30 flex flex-col gap-3 rounded-3xl bg-white/95 p-4 shadow-lg ring-1 ring-slate-100 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-ink">{changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'All settings saved'}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button onClick={() => setDraft({ ...DEFAULT_CONFIG, aiDailyCallLimit: draft.aiDailyCallLimit })} className="rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink hover:bg-[#E8E1F8]">Reset to defaults</button>
          <button onClick={() => setDraft(saved)} disabled={!changed.length} className="rounded-2xl px-5 py-3 text-sm font-semibold text-ink-soft hover:bg-slate-50 disabled:opacity-40">Discard changes</button>
          <button onClick={save} disabled={!changed.length || busy} className="btn-primary">{busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save settings</button>
        </div>
      </div>
    </div>
  );
}
