/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  ClipboardCheck, 
  BookOpen, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  ChevronRight, 
  RotateCcw,
  Loader2,
  Award,
  FileText,
  Lock,
  Unlock,
  Users,
  BarChart3,
  Download,
  ChevronDown,
  ChevronUp,
  LogOut,
  ShieldCheck,
  Search,
  Sparkles,
  Database,
  UserPlus,
  FileUp,
  Table,
  Plus,
  Trash2,
  Edit3,
  Filter,
  Upload,
  Clock,
  HelpCircle,
  XCircle,
  Layers,
  Settings,
  Trophy,
  Building2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import {
  AgentHome, AnalyticsPanel, AssignPanel, PageHeader, PktResultView, RefresherView, RoleLoginView, TabBar,
  TrainerDashboard, UserAccessPanel, ViewSwitcher, ROLE_LABEL, ROLE_LEVEL,
  type PktResult, type PodInfo, type Role, type SessionUser,
} from './pkt-ui';
import { PktRunner } from './pkt-test';
import { BatchesPanel, CertificateView, DynamicSettingsPanel, LeaderboardPanel, PodSyncCard, SettingsPanel, TrainerScopePanel, VendorsPanel } from './admin-ui';
import { loadAppConfig, useAppConfig } from './use-config';
import { SlidersHorizontal } from 'lucide-react';

type Question = {
  id: string;
  scenario: string;
  options: string[];
  correctAnswerIndex: number;
  sopPoint: string;
  explanation: string;
  category: string;
};

function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// --- Types ---

interface SOP {
  account_id: string;
  sop_text: string;
  is_locked: boolean;
  last_modified_by?: string;
  last_modified_at?: string;
}

// --- Day-wise SOP helpers ---

const getSopKey = (account: string, day: number) => `${account}_Day${day}`;
const MAX_TRAINING_DAYS = 10;
const dayList = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// mirrors questionPlan() in pkt.ts for new agents
function getPlanLabel(dayNo: number, trainingDays: number, total: number): string {
  if (trainingDays === 1 || dayNo === 1) return `${total}q from Day 1`;
  if (dayNo === trainingDays) return `Final day: ${total}q spread across Days 1–${trainingDays}`;
  const fromYesterday = Math.round(total / 4);
  return `${fromYesterday}q Day ${dayNo - 1} + ${total - fromYesterday}q Day ${dayNo}`;
}

// --- Dialog System ---

interface DialogState {
  open: boolean;
  type: 'error' | 'warning' | 'success' | 'confirm' | 'info';
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
}

function AppDialog({ dialog, onClose }: { dialog: DialogState; onClose: () => void }) {
  if (!dialog.open) return null;

  type ConfigMap = {
    [K in DialogState['type']]: {
      Icon: React.ElementType;
      bg: string;
      iconColor: string;
      btnClass: string;
    };
  };

  const CONFIG: ConfigMap = {
    error:   { Icon: XCircle,     bg: 'bg-rose-50',    iconColor: 'text-rose-500',    btnClass: 'bg-rose-500 hover:bg-rose-600 shadow-rose-200' },
    warning: { Icon: AlertCircle,  bg: 'bg-amber-50',   iconColor: 'text-amber-500',   btnClass: 'bg-amber-500 hover:bg-amber-600 shadow-amber-200' },
    success: { Icon: CheckCircle2, bg: 'bg-emerald-50', iconColor: 'text-emerald-500', btnClass: 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-200' },
    confirm: { Icon: AlertCircle,  bg: 'bg-amber-50',   iconColor: 'text-amber-500',   btnClass: 'bg-rose-500 hover:bg-rose-600 shadow-rose-200' },
    info:    { Icon: HelpCircle,   bg: 'bg-blue-50',    iconColor: 'text-blue-500',    btnClass: 'bg-blue-500 hover:bg-blue-600 shadow-blue-200' },
  };

  const { Icon, bg, iconColor, btnClass } = CONFIG[dialog.type];

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.88, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.88, y: 16 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        className="bg-white rounded-xl p-12 max-w-md w-full space-y-8 shadow-2xl"
      >
        {/* Icon */}
        <div className={cn('w-20 h-20 rounded-lg mx-auto flex items-center justify-center', bg)}>
          <Icon size={40} className={iconColor} strokeWidth={1.5} />
        </div>

        {/* Text */}
        <div className="text-center space-y-3">
          <h3 className="text-2xl font-semibold text-slate-900 font-display tracking-tight">
            {dialog.title}
          </h3>
          <p className="text-slate-500 font-medium leading-relaxed text-[15px]">{dialog.message}</p>
        </div>

        {/* Actions */}
        <div className={cn('flex gap-4', dialog.type === 'confirm' ? 'flex-row' : 'flex-col')}>
          {dialog.type === 'confirm' && (
            <button
              onClick={onClose}
              className="flex-1 py-4 rounded-2xl border-2 border-slate-200 text-slate-600 font-semibold text-sm hover:bg-slate-50 transition-all"
            >
              {dialog.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            onClick={() => {
              if (dialog.type === 'confirm') {
                dialog.onConfirm?.();
              } else {
                onClose();
              }
            }}
            className={cn(
              'flex-1 py-4 rounded-2xl text-white font-semibold text-sm transition-all shadow-lg',
              btnClass
            )}
          >
            {dialog.type === 'confirm' ? (dialog.confirmLabel || 'Confirm') : 'OK'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// --- Components ---

type View = 'login' | 'home' | 'pkt_run' | 'pkt_result' | 'refresher' | 'certificate';

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('login');
  const [sops, setSops] = useState<Record<string, SOP>>({});
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [run, setRun] = useState<{ traineeId: number; unitLabel: string } | null>(null);
  const [result, setResult] = useState<PktResult | null>(null);
  const [certificateId, setCertificateId] = useState<string | null>(null);
  const [refresherId, setRefresherId] = useState<number | null>(null);

  // --- Dialog state ---
  const [dialog, setDialog] = useState<DialogState>({ open: false, type: 'info', title: '', message: '' });
  const closeDialog = () => setDialog(d => ({ ...d, open: false }));
  const showDialog = (config: Omit<DialogState, 'open'>) => setDialog({ ...config, open: true });

  const fetchPods = async () => {
    try {
      const res = await fetch('/api/pods');
      const data = await res.json();
      setPods(Array.isArray(data) ? data.map((p: any) => ({ name: p.name ?? p, training_days: p.training_days ?? 5 })) : []);
    } catch (err) {
      console.error("Failed to fetch pods", err);
    }
  };

  const fetchSops = async () => {
    try {
      const res = await fetch('/api/sops');
      if (!res.ok) return;
      const data = await res.json();
      const sopMap: Record<string, SOP> = {};
      data.forEach((s: any) => {
        sopMap[s.account_id] = { ...s, is_locked: !!s.is_locked };
      });
      setSops(sopMap);
    } catch (err) {
      console.error("Failed to fetch SOPs", err);
    }
  };

  const enter = async (u: SessionUser) => {
    setUser(u);
    setView('home');
    const drive = new URLSearchParams(window.location.search).get('drive');
    if (drive === 'connected') showDialog({ type: 'success', title: 'Google Drive connected', message: 'ReadyCheck can now read your SOP and training manual files and save daily backups. Add the links on each pod.' });
    else if (drive) showDialog({ type: 'error', title: 'Google Drive not connected', message: drive === 'no_refresh_token' ? 'Google did not grant offline access. Remove ReadyCheck from your Google account permissions and connect again.' : 'Something went wrong connecting Google Drive. Please try again from Settings.' });
    if (window.location.search) window.history.replaceState(null, '', '/');
    await loadAppConfig(true);
    await fetchPods();
    if (ROLE_LEVEL[u.view] >= ROLE_LEVEL.admin) await fetchSops();
  };

  // Resume an existing session (including the one Google sign-in just created)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/me');
        const { user } = await res.json();
        if (user?.email) await enter(user);
      } catch {}
      setBooting(false);
    })();
  }, []);

  // --- Auth Handlers ---

  const switchView = async (v: Role) => {
    try {
      const res = await fetch('/api/session/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ view: v }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      await enter(data.user);
    } catch (err: any) {
      showDialog({ type: 'error', title: 'Could not switch view', message: err?.message || 'Please try again.' });
    }
  };

  const handleLogout = async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    setUser(null);
    setView('login');
    setSops({});
    setRun(null);
    setResult(null);
  };

  // --- PKT Handlers ---

  const startPkt = (traineeId: number, unitLabel: string) => {
    setRun({ traineeId, unitLabel });
    setView('pkt_run');
  };

  const openResult = async (attemptId: number) => {
    try {
      const res = await fetch(`/api/pkt/attempts/${attemptId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      setResult(data);
      setView('pkt_result');
    } catch (err: any) {
      showDialog({ type: 'error', title: 'Could not open', message: err?.message || 'Please try again.' });
    }
  };

  const openRefresher = (attemptId: number) => {
    setRefresherId(attemptId);
    setView('refresher');
  };

  const openCertificate = (id: string) => {
    setCertificateId(id);
    setView('certificate');
  };

  if (booting) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="animate-spin text-meesho-purple" size={36} /></div>;
  }

  const navTitle = view === 'home' && user ? (user.view === 'agent' ? 'ReadyCheck' : `${ROLE_LABEL[user.view]} console`) : 'ReadyCheck';

  return (
    <div className="min-h-screen flex flex-col">
      {view !== 'login' && (
        <nav className="sticky top-0 z-50 px-4 py-4 sm:px-6 print:hidden">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full bg-[#7A1C86] px-3 py-2 text-white sm:px-4">
            <button onClick={() => user && setView('home')} className="flex min-w-0 items-center gap-3 pl-1 text-left">
              <img
                src="https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Meesho_logo.png/500px-Meesho_logo.png"
                alt="Meesho"
                className="h-7 w-auto shrink-0 rounded-md bg-white p-1 object-contain"
              />
              <div className={cn('min-w-0 leading-tight', user && 'hidden sm:block')}>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/70">Meesho</p>
                <h1 className="truncate text-[15px] font-semibold">{navTitle}</h1>
              </div>
            </button>
            {user && (
              <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                <p className="hidden max-w-[200px] truncate text-sm text-white/80 lg:block">{user.email}</p>
                {view === 'home' && <ViewSwitcher user={user} onSwitch={switchView} />}
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm font-semibold text-[#7A1C86] sm:px-4"
                  title="Sign out"
                >
                  <LogOut size={15} /> <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            )}
          </div>
        </nav>
      )}

      <main className="flex-1">
        {view === 'login' && <RoleLoginView />}
        {view === 'home' && user?.view === 'agent' && (
          <AgentHome user={user} onStart={startPkt} onOpenResult={openResult} onOpenRefresher={openRefresher} onOpenCertificate={openCertificate} />
        )}
        {view === 'home' && user?.view === 'trainer' && <TrainerDashboard pods={pods} showDialog={showDialog} />}
        {view === 'home' && user && ROLE_LEVEL[user.view] >= ROLE_LEVEL.admin && (
          <CreatorDashboardView
            user={user}
            sops={sops}
            pods={pods}
            onSopUpdate={fetchSops}
            onPodsUpdate={fetchPods}
            showDialog={showDialog}
            closeDialog={closeDialog}
          />
        )}
        {view === 'pkt_run' && run && (
          <PktRunner
            key={`${run.traineeId}-${run.unitLabel}`}
            traineeId={run.traineeId}
            unitLabel={run.unitLabel}
            onSubmitted={(data) => { setResult(data); setView('pkt_result'); }}
            onHome={() => setView('home')}
          />
        )}
        {view === 'pkt_result' && result && (
          <PktResultView result={result} onHome={() => setView('home')} onRefresher={() => openRefresher(result.attempt_id)} onCertificate={openCertificate} />
        )}
        {view === 'refresher' && refresherId !== null && (
          <RefresherView attemptId={refresherId} onHome={() => setView('home')} showDialog={showDialog} />
        )}
        {view === 'certificate' && certificateId && <CertificateView id={certificateId} onBack={() => setView('home')} />}
      </main>

      {/* Global dialog overlay */}
      <AnimatePresence>
        {dialog.open && <AppDialog dialog={dialog} onClose={closeDialog} />}
      </AnimatePresence>
    </div>
  );
}

// --- View Components ---

function CreatorDashboardView({ user, sops, pods, onSopUpdate, onPodsUpdate, showDialog, closeDialog }: { 
  user: SessionUser,
  sops: Record<string, SOP>,
  pods: PodInfo[],
  onPodsUpdate: () => void,
  onSopUpdate: () => void,
  showDialog: (config: Omit<DialogState, 'open'>) => void,
  closeDialog: () => void
}) {
  // the chosen view decides what shows: a Super Admin in Admin view sees the Admin screens
  const role = user.view;
  const cfg = useAppConfig();
  type AdminTab = 'sop' | 'assign' | 'batches' | 'analytics' | 'leaderboard' | 'scope' | 'settings' | 'dynamic' | 'vendors' | 'users';
  const [activeTab, setActiveTab] = useState<AdminTab>('sop');
  const [selectedAcc, setSelectedAcc] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(1);
  const [sopInput, setSopInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingDays, setIsSavingDays] = useState(false);
  const podNames = pods.map(p => p.name);
  const daysOf = (acc: string) => pods.find(p => p.name === acc)?.training_days ?? 5;

  // Delete Pod modal state
  const [showDeletePodModal, setShowDeletePodModal] = useState(false);
  const [podToDelete, setPodToDelete] = useState<string | null>(null);
  const [isDeletingPod, setIsDeletingPod] = useState(false);

  const saveTrainingDays = async (acc: string, days: number) => {
    setIsSavingDays(true);
    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(acc)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ training_days: days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      await onPodsUpdate();
      await onSopUpdate();
      if (selectedDay > days) { setSelectedDay(1); setSopInput(sops[getSopKey(acc, 1)]?.sop_text || ''); }
    } catch (err: any) {
      showDialog({ type: 'error', title: 'Could not update', message: err?.message || 'Please try again.' });
    } finally {
      setIsSavingDays(false);
    }
  };

  const deletePod = async () => {
    if (!podToDelete) return;
    setIsDeletingPod(true);
    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(podToDelete)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      await onPodsUpdate();
      await onSopUpdate();
      setShowDeletePodModal(false);
      setPodToDelete(null);
      showDialog({ type: 'success', title: 'Pod Deleted', message: `"${podToDelete}" and all its SOPs have been removed.` });
    } catch (err) {
      showDialog({ type: 'error', title: 'Delete Failed', message: 'Could not delete pod. Please try again.' });
    } finally {
      setIsDeletingPod(false);
    }
  };

  const saveSop = async (lock: boolean) => {
    if (!selectedAcc) return;
    const sopKey = getSopKey(selectedAcc, selectedDay);
    setIsSaving(true);
    try {
      const res = await fetch('/api/sops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          account_id: sopKey, 
          sop_text: sopInput, 
          is_locked: lock,
          last_modified_by: user.email
        })
      });
      if (res.ok) {
        await onSopUpdate();
      } else {
        const data = await res.json();
        showDialog({
          type: 'error',
          title: 'Save Failed',
          message: data.error || 'Failed to save SOP. Please try again.',
        });
      }
    } catch (err) {
      console.error(err);
      showDialog({
        type: 'error',
        title: 'Network Error',
        message: 'An unexpected error occurred while saving. Please check your connection and try again.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl min-w-0 space-y-8 px-4 py-8 pb-24 sm:px-6 lg:px-10">
      {/* Delete Pod Modal */}
      <AnimatePresence>
        {showDeletePodModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white rounded-3xl p-6 sm:p-10 max-w-md w-full space-y-6 shadow-2xl"
            >
              <div className="flex justify-between items-start gap-4">
                <div className="space-y-2">
                  <h3 className="text-3xl font-semibold text-slate-900 font-display">Delete Pod</h3>
                  <p className="text-slate-500 font-medium">Select a pod to permanently delete it and all its day-wise SOPs.</p>
                </div>
                <button onClick={() => setShowDeletePodModal(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                  <XCircle size={24} className="text-slate-400" />
                </button>
              </div>
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {podNames.map(pod => (
                  <button
                    key={pod}
                    onClick={() => setPodToDelete(pod)}
                    className={cn(
                      "w-full text-left px-6 py-4 rounded-2xl border-2 font-semibold text-sm transition-all",
                      podToDelete === pod
                        ? "border-rose-400 bg-rose-50 text-rose-700"
                        : "border-slate-100 hover:border-rose-200 hover:bg-rose-50/50 text-slate-700"
                    )}
                  >
                    {pod}
                  </button>
                ))}
              </div>
              <div className="flex gap-4 pt-2">
                <button
                  onClick={() => { setShowDeletePodModal(false); setPodToDelete(null); }}
                  className="flex-1 py-4 rounded-2xl border-2 border-slate-200 text-slate-600 font-semibold text-sm hover:bg-slate-50 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={deletePod}
                  disabled={!podToDelete || isDeletingPod}
                  className="flex-1 py-4 rounded-2xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-rose-200"
                >
                  {isDeletingPod ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                  {isDeletingPod ? 'Deleting...' : 'Delete Pod'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header — Admin / Super Admin dashboard */}
      <PageHeader
        eyebrow={`${ROLE_LABEL[role]} console`}
        title="System"
        accent="control"
        subtitle={role === 'super_admin' ? 'Pods, SOPs, assignments, analytics and who gets access.' : 'Pods, SOPs, assignments and analytics.'}
      />
      {/* tabs get their own full-width row so the heading never gets squeezed */}
      <TabBar
            tabs={[
              { id: 'sop' as const, label: 'Pods & SOPs', icon: FileText },
              { id: 'assign' as const, label: 'Assign', icon: UserPlus },
              { id: 'batches' as const, label: 'Batches', icon: Layers },
              { id: 'analytics' as const, label: 'Analytics', icon: BarChart3 },
              ...(cfg.featureLeaderboard ? [{ id: 'leaderboard' as const, label: 'Leaderboard', icon: Trophy }] : []),
              { id: 'scope' as const, label: 'Trainer scope', icon: ShieldCheck },
              { id: 'settings' as const, label: 'Settings', icon: Settings },
              ...(role === 'super_admin' ? [
                { id: 'dynamic' as const, label: 'Dynamic settings', icon: SlidersHorizontal },
                { id: 'vendors' as const, label: 'Vendors', icon: Building2 },
                { id: 'users' as const, label: 'User access', icon: Users },
              ] : []),
            ]}
            active={activeTab}
            onChange={(t) => { setActiveTab(t); setSelectedAcc(null); }}
      />

      {/* Content Area */}
      <div className="space-y-12">
        {activeTab === 'sop' && (
          <div className="space-y-12">
            {!selectedAcc ? (
              <>
                {/* Manage Pods toolbar */}
                <ManagePodsBar onPodsUpdate={onPodsUpdate} onDeleteClick={(_name) => { setPodToDelete(null); setShowDeletePodModal(true); }} showDialog={showDialog} />
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                {podNames.map(acc => {
                  const totalDays = daysOf(acc);
                  const lockedDays = dayList(totalDays).filter(d => sops[getSopKey(acc, d)]?.is_locked).length;
                  const hasSop = dayList(totalDays).some(d => sops[getSopKey(acc, d)]?.sop_text?.trim());
                  return (
                    <button 
                      key={acc}
                      onClick={() => { setSelectedAcc(acc); setSelectedDay(1); setSopInput(sops[getSopKey(acc, 1)]?.sop_text || ''); }}
                      className="category-card group flex h-full flex-col space-y-5 p-6 text-left transition-transform hover:-translate-y-1 sm:p-7"
                    >
                      <div className="flex justify-between items-start">
                        <div className="w-16 h-16 bg-meesho-light rounded-2xl flex items-center justify-center text-meesho-purple group-hover:bg-meesho-purple group-hover:text-white transition-all duration-500">
                          <FileText size={32} strokeWidth={1.5} />
                        </div>
                        <div className="flex flex-col items-end gap-1.5">
                          <div className={cn(
                            "px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 border",
                            lockedDays > 0 ? "bg-emerald-50 text-emerald-800 border-emerald-100" : "bg-white text-ink-soft border-slate-200"
                          )}>
                            {lockedDays > 0 ? <Lock size={12} /> : <Unlock size={12} />}
                            {lockedDays}/{totalDays} Locked
                          </div>
                          <div className="flex max-w-[140px] flex-wrap justify-end gap-1">
                            {dayList(totalDays).map(d => (
                              <div key={d} className={cn(
                                "w-4 h-1.5 rounded-full",
                                sops[getSopKey(acc, d)]?.is_locked ? "bg-emerald-400" :
                                sops[getSopKey(acc, d)]?.sop_text?.trim() ? "bg-amber-300" : "bg-slate-200"
                              )} title={`Day ${d}`} />
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <h3 className="break-words text-[26px] font-bold tracking-tight text-ink">{acc}</h3>
                        <p className="text-base font-medium text-ink-soft">
                          {totalDays} training day{totalDays > 1 ? 's' : ''} · {hasSop ? `${lockedDays} locked` : 'no SOPs yet'}
                        </p>
                        {sops[getSopKey(acc, 1)]?.last_modified_by ? (
                          <div className="pt-2 space-y-1">
                            <p className="text-xs font-medium text-ink-soft">
                              Last by: <span className="text-meesho-purple">{sops[getSopKey(acc, 1)].last_modified_by}</span>
                            </p>
                            {sops[getSopKey(acc, 1)]?.last_modified_at && (
                              <p className="text-xs text-ink-soft">
                                {new Date(sops[getSopKey(acc, 1)].last_modified_at!).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="pt-2 text-xs font-medium text-ink-soft">Open to add SOPs</p>
                        )}
                      </div>
                    </button>
                  );
                })}
                </div>
              </>
            ) : (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="float-card space-y-8 p-5 sm:p-10">
                {/* Header */}
                <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-6">
                  <div className="min-w-0 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#A21CAF]">SOP editor</p>
                    <h3 className="break-words text-3xl font-bold tracking-tight text-ink">{selectedAcc}</h3>
                    <p className="text-sm text-ink-soft">Day {selectedDay} PKT: {getPlanLabel(selectedDay, daysOf(selectedAcc!), cfg.questionsPerPkt)}</p>
                    <label className="flex flex-wrap items-center gap-2 pt-1 text-sm font-semibold text-ink">
                      Training days
                      <select
                        value={daysOf(selectedAcc!)}
                        disabled={isSavingDays}
                        onChange={(e) => saveTrainingDays(selectedAcc!, Number(e.target.value))}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold outline-none focus:border-meesho-purple"
                      >
                        {dayList(MAX_TRAINING_DAYS).map(d => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
                      </select>
                      {isSavingDays && <Loader2 size={14} className="animate-spin text-meesho-purple" />}
                    </label>
                  </div>
                  <button onClick={() => { setSelectedAcc(null); setSelectedDay(1); }} className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-[#F2EEFC] px-4 py-2.5 text-sm font-semibold text-ink transition-all hover:bg-[#E8E1F8]">
                    <RotateCcw size={16} aria-hidden /> All pods
                  </button>
                </div>

                <PodSyncCard pod={selectedAcc!} onSynced={() => { onPodsUpdate(); onSopUpdate(); }} showDialog={showDialog} />

                {/* Day Tabs */}
                <p className="text-sm font-semibold text-ink">Or edit each day's SOP by hand</p>
                <div className="flex flex-wrap gap-1.5 rounded-3xl bg-[#F2EEFC] p-1.5 sm:w-fit sm:rounded-full">
                  {dayList(daysOf(selectedAcc!)).map(day => {
                    const daySop = sops[getSopKey(selectedAcc!, day)];
                    const isLocked = daySop?.is_locked;
                    const hasSop = !!daySop?.sop_text?.trim();
                    return (
                      <button
                        key={day}
                        onClick={() => { setSelectedDay(day); setSopInput(sops[getSopKey(selectedAcc!, day)]?.sop_text || ''); }}
                        className={cn(
                          "flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-all",
                          selectedDay === day ? "bg-white text-ink shadow-[0_8px_20px_rgba(166,77,224,0.14)]" : "text-ink-soft hover:text-ink"
                        )}
                        aria-label={`Day ${day}: ${isLocked ? 'locked' : hasSop ? 'draft' : 'empty'}`}
                      >
                        Day {day}
                        {isLocked ? <Lock size={13} className="text-emerald-700" aria-hidden /> : hasSop ? <Edit3 size={13} className="text-amber-700" aria-hidden /> : <span className="h-2 w-2 rounded-full bg-slate-300" aria-hidden />}
                      </button>
                    );
                  })}
                </div>

                {/* Day SOP status bar */}
                {(() => {
                  const currentDaySop = sops[getSopKey(selectedAcc!, selectedDay)];
                  return (
                    <>
                      {currentDaySop?.last_modified_by && (
                        <p className="text-xs font-medium text-ink-soft">
                          Day {selectedDay} last saved by <span className="text-meesho-purple">{currentDaySop.last_modified_by}</span>
                          {currentDaySop.last_modified_at && (
                            <> &mdash; {new Date(currentDaySop.last_modified_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</>
                          )}
                        </p>
                      )}

                      {/* Lock status badge */}
                      {currentDaySop?.is_locked && (
                        <div className="flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800">
                          <Lock size={14} /> Day {selectedDay} SOP Locked
                        </div>
                      )}

                      {/* Textarea */}
                      <div className="relative">
                        <textarea 
                          className="input-field h-[420px] resize-y !p-5 leading-relaxed sm:h-[500px] sm:!p-8"
                          placeholder={`Paste Day ${selectedDay} SOP guidelines here...`}
                          value={sopInput}
                          onChange={(e) => setSopInput(e.target.value)}
                          disabled={!!currentDaySop?.is_locked}
                        />
                        {currentDaySop?.is_locked && (
                          <div className="absolute inset-0 bg-white/10 backdrop-blur-[1px] rounded-xl pointer-events-none" />
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row sm:justify-end sm:gap-4">
                        {currentDaySop?.is_locked ? (
                          role === 'super_admin' ? (
                            <button 
                              onClick={() => saveSop(false)}
                              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-6 py-3.5 text-sm font-semibold text-ink transition-all hover:bg-[#E8E1F8]"
                            >
                              <Unlock size={20} /> Unlock &amp; Edit
                            </button>
                          ) : (
                            <div className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50 px-5 py-4 text-sm font-bold text-amber-700">
                              <Lock size={18} /> Only the Super Admin can unlock this SOP.
                            </div>
                          )
                        ) : (
                          <>
                            <button 
                              onClick={() => saveSop(false)}
                              disabled={isSaving}
                              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-6 py-3.5 text-sm font-semibold text-ink transition-all hover:bg-[#E8E1F8] disabled:opacity-50"
                            >
                              {isSaving ? <Loader2 className="animate-spin" size={20} /> : <FileText size={20} />}
                              Save Draft
                            </button>
                            <button 
                              onClick={() => saveSop(true)}
                              disabled={isSaving}
                              className="btn-primary"
                            >
                              {isSaving ? <Loader2 className="animate-spin" size={20} /> : <Lock size={20} />}
                              {isSaving ? 'Saving...' : `Save & Lock Day ${selectedDay}`}
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  );
                })()}
              </motion.div>
            )}
          </div>
        )}

        {activeTab === 'assign' && <AssignPanel pods={pods} showDialog={showDialog} />}

        {activeTab === 'batches' && <BatchesPanel showDialog={showDialog} />}

        {activeTab === 'leaderboard' && cfg.featureLeaderboard && <LeaderboardPanel staff />}
        {activeTab === 'dynamic' && role === 'super_admin' && <DynamicSettingsPanel showDialog={showDialog} />}

        {activeTab === 'scope' && <TrainerScopePanel showDialog={showDialog} />}

        {activeTab === 'settings' && <SettingsPanel isSuperAdmin={role === 'super_admin'} showDialog={showDialog} />}

        {activeTab === 'analytics' && <AnalyticsPanel showDialog={showDialog} />}

        {activeTab === 'vendors' && role === 'super_admin' && <VendorsPanel showDialog={showDialog} />}
        {activeTab === 'users' && role === 'super_admin' && <UserAccessPanel showDialog={showDialog} />}
      </div>
    </div>
  );
}

// ─── ManagePodsBar ────────────────────────────────────────────────────────────
function ManagePodsBar({ onPodsUpdate, onDeleteClick, showDialog }: {
  onPodsUpdate: () => void;
  onDeleteClick: (name: string) => void;
  showDialog: (cfg: Omit<DialogState, 'open'>) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newDays, setNewDays] = useState(5);
  const [isAdding, setIsAdding] = useState(false);

  const addPod = async () => {
    const name = newName.trim();
    if (!name) return;
    setIsAdding(true);
    try {
      const res = await fetch('/api/pods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, training_days: newDays }),
      });
      if (!res.ok) {
        const err = await res.json();
        showDialog({ type: 'error', title: 'Add Failed', message: err.error ?? 'Could not add pod.' });
        return;
      }
      setNewName('');
      setNewDays(5);
      await onPodsUpdate();
      showDialog({ type: 'success', title: 'Pod created', message: `${name} is ready with ${newDays} training day${newDays > 1 ? 's' : ''}. Open it to add each day's SOP.` });
    } catch {
      showDialog({ type: 'error', title: 'Add Failed', message: 'Network error. Please try again.' });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="float-card flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-ink">Create pod</p>
          <p className="text-sm text-ink-soft">Name the pod and choose how many training days it has. Each day gets its own SOP and PKT.</p>
        </div>
        <button
          onClick={() => onDeleteClick('__open__')}
          className="inline-flex items-center gap-2 rounded-xl border-2 border-rose-100 px-4 py-2.5 text-xs font-semibold text-rose-500 transition-all hover:bg-rose-50"
        >
          <Trash2 size={14} />
          Delete pod
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_auto]">
        <input
          type="text"
          placeholder="Pod name, e.g. Atomberg"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addPod()}
          className="input-field"
          aria-label="Pod name"
        />
        <select value={newDays} onChange={e => setNewDays(Number(e.target.value))} className="input-field" aria-label="Number of training days">
          {dayList(MAX_TRAINING_DAYS).map(d => <option key={d} value={d}>{d} training day{d > 1 ? 's' : ''}</option>)}
        </select>
        <button onClick={addPod} disabled={!newName.trim() || isAdding} className="btn-primary">
          {isAdding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Create pod
        </button>
      </div>
    </div>
  );
}
