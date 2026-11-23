// The PKT test screen: rules, a timer, select-then-Next answering with a review page. The
// question count, time limit and pass mark come from the Super Admin's dynamic settings. A test
// left unfinished (closed tab, lost connection) carries on where it was when started again.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock, Loader2, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { useAppConfig } from './use-config';

const cn = (...inputs: ClassValue[]) => clsx(inputs);

export interface StartedPkt {
  token: string;
  unitLabel: string;
  attemptNo: number;
  maxAttempts: number;
  threshold: number;
  pod: string;
  startedAt: number;
  deadline: number;
  resumed?: boolean;
  questions: Array<{ id: string; scenario: string; options: string[] }>;
}

type Phase = 'rules' | 'loading' | 'test' | 'review' | 'submitting';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function PktRunner({ traineeId, unitLabel, onSubmitted, onHome }: {
  traineeId: number;
  unitLabel: string;
  onSubmitted: (result: any) => void;
  onHome: () => void;
}) {
  const cfg = useAppConfig();
  const [phase, setPhase] = useState<Phase>('rules');
  const [pkt, setPkt] = useState<StartedPkt | null>(null);
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [now, setNow] = useState(Date.now());
  const [progress, setProgress] = useState(0);
  const pktRef = useRef<StartedPkt | null>(null);
  const answersRef = useRef<number[]>([]);
  const doneRef = useRef(false);
  pktRef.current = pkt;
  answersRef.current = answers;

  const start = async () => {
    setPhase('loading');
    setError('');
    setProgress(0);
    const tick = setInterval(() => setProgress((p) => (p < 92 ? p + 1 : p)), 500);
    try {
      const res = await fetch('/api/pkt/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trainee_id: traineeId }) });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Could not start the PKT.'); setPhase('rules'); return; }
      doneRef.current = false;
      setPkt(data);
      setNow(Date.now());
      setAnswers(new Array(data.questions.length).fill(-1));
      setIdx(0);
      setPhase('test');
    } catch {
      setError('Could not reach ReadyCheck. Check your connection and try again.');
      setPhase('rules');
    } finally {
      clearInterval(tick);
      setProgress(100);
    }
  };

  const submit = useCallback(async () => {
    const p = pktRef.current;
    if (!p || doneRef.current) return;
    doneRef.current = true;
    setPhase('submitting');
    for (let tries = 0; tries < 4; tries++) {
      try {
        const res = await fetch('/api/pkt/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: p.token, answers: answersRef.current }) });
        const data = await res.json();
        if (!res.ok) { setError(data?.error || 'Could not submit.'); setPhase('review'); doneRef.current = false; return; }
        onSubmitted(data);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3000)); // brief network drop: retry
      }
    }
    setError('Your answers could not be sent. Check your connection — they will be retried when you press Submit again.');
    setPhase('review');
    doneRef.current = false;
  }, [onSubmitted]);

  // the timer while the test is running
  const active = phase === 'test' || phase === 'review';
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);

  // time up: submit whatever is answered
  useEffect(() => {
    if (active && pkt && now >= pkt.deadline) submit();
  }, [now, active, pkt, submit]);

  const remaining = pkt ? pkt.deadline - now : 0;
  const answered = answers.filter((a) => a >= 0).length;

  if (phase === 'rules') {
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 pb-24 sm:px-6">
        <button onClick={onHome} className="inline-flex items-center gap-2 text-sm font-semibold text-ink-soft hover:text-meesho-purple"><ArrowLeft size={16} /> Back to my PKTs</button>
        <div className="float-card space-y-6 p-6 sm:p-10">
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#A21CAF]">{unitLabel} PKT</p>
            <h2 className="text-[clamp(1.8rem,5vw,2.6rem)] font-extrabold leading-tight tracking-tight text-ink">Before you start</h2>
          </div>
          <ul className="space-y-3 text-[15px] text-ink">
            {[
              [Clock, `${cfg.questionsPerPkt} questions, ${cfg.testMinutes} minutes. The timer starts as soon as the questions appear and the test submits itself at 00:00.`],
              [CheckCircle2, 'Pick an answer, then press Next. You can go back and change answers, and review everything before submitting.'],
              [RotateCcw, 'If your page closes or the connection drops, start the PKT again: you get the same questions and the time you had left.'],
              [Sparkles, 'Your questions are new every time. Check your network before you begin.'],
            ].map(([Icon, text], i) => (
              <li key={i} className="flex items-start gap-3">
                {React.createElement(Icon as React.ElementType, { size: 20, className: 'mt-0.5 shrink-0 text-meesho-purple', 'aria-hidden': true })}
                <span>{text as string}</span>
              </li>
            ))}
          </ul>
          {error && <div className="flex items-start gap-3 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />{error}</div>}
          <button onClick={start} className="btn-primary w-full !py-4 text-base">I understand — start PKT</button>
        </div>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center gap-6 px-6 py-32 text-center">
        <Loader2 size={44} className="animate-spin text-meesho-purple" strokeWidth={1.5} aria-hidden />
        <div className="space-y-2">
          <h2 className="text-[clamp(1.8rem,5vw,2.4rem)] font-bold tracking-tight text-ink">Preparing your {unitLabel} PKT</h2>
          <p className="mx-auto max-w-md text-ink-soft">Your {cfg.questionsPerPkt} questions are made fresh for you from the SOP and checked for accuracy. If they weren't ready in advance this takes up to a minute.</p>
        </div>
        <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-[#F2EEFC]"><div className="h-full rounded-full bg-meesho-purple transition-all" style={{ width: `${progress}%` }} /></div>
      </div>
    );
  }

  if (phase === 'submitting') {
    return (
      <div className="flex flex-col items-center justify-center gap-6 px-6 py-32 text-center">
        <Loader2 size={44} className="animate-spin text-meesho-purple" strokeWidth={1.5} aria-hidden />
        <div className="space-y-2">
          <h2 className="text-3xl font-bold tracking-tight text-ink">Scoring your PKT…</h2>
          <p className="mx-auto max-w-md text-ink-soft">If you're below the pass mark, we're also preparing your training refresher. This can take up to a minute.</p>
        </div>
      </div>
    );
  }

  if (!pkt) return null;
  const q = pkt.questions[idx];
  const low = remaining < 5 * 60_000;

  const header = (
    <div className="sticky top-[76px] z-40 -mx-4 bg-[#F7F5FF]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft">{pkt.pod} · {pkt.unitLabel} · attempt {pkt.attemptNo}/{pkt.maxAttempts} · pass {pkt.threshold}%</p>
          <p className="text-sm font-semibold text-ink">{answered} of {pkt.questions.length} answered</p>
        </div>
        <div className={cn('flex shrink-0 items-center gap-2 rounded-2xl px-4 py-2 text-xl font-bold tabular-nums', low ? 'bg-rose-100 text-rose-800' : 'bg-white text-ink')} aria-live="polite" aria-label={`Time left ${mmss(remaining)}`}>
          <Clock size={18} aria-hidden /> {mmss(remaining)}
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#E9E3F7]"><div className="h-full rounded-full bg-meesho-purple transition-all" style={{ width: `${(answered / pkt.questions.length) * 100}%` }} /></div>
    </div>
  );

  if (phase === 'review') {
    return (
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-4 pb-24 sm:px-6">
        {header}
        <div className="float-card space-y-5 p-5 sm:p-8">
          <h3 className="text-2xl font-bold text-ink">Review your answers</h3>
          <p className="text-sm text-ink-soft">Tap a question to change it. Unanswered questions count as wrong.</p>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
            {pkt.questions.map((_, i) => (
              <button key={i} onClick={() => { setIdx(i); setPhase('test'); }}
                className={cn('flex h-11 items-center justify-center rounded-xl text-sm font-bold', answers[i] >= 0 ? 'bg-[#EADCF8] text-[#6B1A70]' : 'border-2 border-dashed border-amber-400 bg-amber-50 text-amber-800')}
                aria-label={`Question ${i + 1}${answers[i] >= 0 ? ', answered' : ', not answered'}`}>
                {i + 1}{answers[i] < 0 && <span className="sr-only">not answered</span>}
              </button>
            ))}
          </div>
          {answered < pkt.questions.length && (
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle size={16} aria-hidden /> {pkt.questions.length - answered} question(s) not answered (dashed boxes).</p>
          )}
          {error && <p className="rounded-2xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            <button onClick={() => { setIdx(pkt.questions.length - 1); setPhase('test'); }} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink"><ArrowLeft size={16} aria-hidden /> Back to questions</button>
            <button onClick={submit} className="btn-primary"><ShieldCheck size={16} aria-hidden /> Submit PKT</button>
          </div>
        </div>
      </div>
    );
  }

  const chosen = answers[idx];
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-4 pb-24 sm:px-6">
      {header}
      <div className="float-card space-y-6 p-5 sm:p-10">
        <p className="text-sm font-semibold text-ink-soft">Question {idx + 1} of {pkt.questions.length}</p>
        <h4 className="text-[clamp(1.2rem,3.5vw,1.6rem)] font-bold leading-snug tracking-tight text-ink">{q.scenario}</h4>
        <div className="grid gap-3" role="radiogroup" aria-label="Answer options">
          {q.options.map((opt, i) => {
            const selected = chosen === i;
            return (
              <button key={i} role="radio" aria-checked={selected}
                onClick={() => setAnswers((a) => a.map((v, j) => (j === idx ? i : v)))}
                className={cn('flex w-full items-center gap-4 rounded-2xl px-4 py-3.5 text-left transition-colors sm:px-5',
                  selected ? 'bg-[#6B1A70] text-white ring-2 ring-[#6B1A70]' : 'bg-[#F2EEFC] text-ink hover:bg-[#E8E1F8]')}>
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold', selected ? 'bg-white text-[#6B1A70]' : 'bg-white text-meesho-purple')}>
                  {selected ? <CheckCircle2 size={18} aria-hidden /> : String.fromCharCode(65 + i)}
                </span>
                <span className="text-base font-medium">{opt}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 pt-2">
          <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}
            className="inline-flex items-center gap-2 rounded-2xl bg-[#F2EEFC] px-5 py-3 text-sm font-semibold text-ink disabled:opacity-40"><ArrowLeft size={16} aria-hidden /> Back</button>
          {idx < pkt.questions.length - 1 ? (
            <button onClick={() => setIdx((i) => i + 1)} disabled={chosen < 0} className="btn-primary">Next <ArrowRight size={16} aria-hidden /></button>
          ) : (
            <button onClick={() => setPhase('review')} disabled={chosen < 0} className="btn-primary">Review answers <ArrowRight size={16} aria-hidden /></button>
          )}
        </div>
        {chosen < 0 && <p className="text-right text-xs text-ink-soft">Select an answer to continue</p>}
      </div>
    </div>
  );
}
