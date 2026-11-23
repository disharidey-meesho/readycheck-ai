<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# ReadyCheck — stay SOP-ready, every day

SOP-based PKTs (product knowledge tests), coaching and readiness tracking for customer-support agents.

## Run locally

**Prerequisites:** Node.js 22

1. `npm install`
2. Copy `.env.example` to `.env` (not `.env.local`: builders stores a published `.env` as secrets, any other file is published as code) and fill in `GEMINI_API_KEY`, the Google OAuth client and the Super Admin email (there is no password: the Super Admin signs in with Google too).
3. `npm run dev`

For production the server runs as plain JavaScript: `npm run build` (front end into `dist/`) and
`npm run build:server` (bundles `server.ts`, `pkt.ts` and `admin.ts` into `server.js`), then `npm start`.
`npm test` runs the PKT rule tests.

## Roles

Everyone signs in with their Meesho Google account and lands in the highest view they have; the
view switcher in the top bar opens the views below it.

| Role | Who | Sees |
|---|---|---|
| Agent | anyone with a @meesho.com account | their PKTs, results, training refresher, certificate, their batch leaderboard while in training |
| Trainer | added by the Super Admin, scoped to vendors / pods by an Admin | Agent view + Assign, Batches, Analytics, Leaderboard |
| Admin | added by the Super Admin | Trainer view + pods, SOPs, Google sync, trainer scope, settings |
| Super Admin | `SUPER_ADMIN_EMAIL` only | everything, plus vendors, user access, backups and the old-data import |

## Vendors

Agent emails look like `agentname_vendorname@meesho.com`. When agents are assigned, the vendor is read
from the part after the last underscore and matched (ignoring case, spaces and punctuation) to the
vendor list the Super Admin keeps in the Vendors tab, so `babulal.verma_technotask@meesho.com` is a
Technotask agent. Any other @meesho.com email (no vendor part, or one not in the list, e.g.
`dishari.dey@meesho.com`) is assigned to the internal vendor **Meesho**. Only non-@meesho.com emails are refused.

## PKT rules

The numbers below are the defaults. The Super Admin changes them, and switches features on or off,
under **Dynamic settings** (see below): no code change or redeploy needed.

- **Questions:** 20 new questions for every agent and every attempt, generated from that day's SOP
  (and the day's training content when synced), checked by a second AI pass against the SOP, with
  shuffled options. A personal set is prepared in the background before the PKT opens.
- **Test screen:** 25 minutes, select then Next, review before submitting; submits itself at 00:00.
- **No proctoring:** switching tabs or apps doesn't cancel anything. A test left unfinished (closed
  tab, lost connection) carries on with the same questions and the time left when the agent starts
  it again. A test past its time limit is dropped without using up the attempt.
- **New agents (pre-production):** the training start date is Day 1; each day's PKT opens at 5 PM IST.
  Pass mark 85%. Below it: an AI training refresher (mistakes, the exact SOP lines, how to handle it,
  practice questions that must all be answered correctly); the reattempt opens 4 hours after the
  refresher is finished. 2 reattempts; still below 85% is Exit. Passing every day issues a certificate.
- **Old agents (production):** a PKT every 14 days, pass mark 90%, 1 reattempt after the refresher.
- **Overdue:** new agents 24 hours after a PKT opens (or after a fail with the refresher untouched);
  production agents 3 days after. Missed fortnightly PKTs are counted.

## Dynamic settings (Super Admin)

Super Admin → **Dynamic settings**. Saved values apply to the whole app straight away (server rules,
agent / trainer screens, Google Chat messages); every change is logged with who made it.

| Group | Settings |
|---|---|
| Who can be assigned | Any @meesho.com email (on: vendor from the email, otherwise Meesho; off: only listed vendors) |
| PKT rules | Pass marks (new / production), attempts (new / production), questions per PKT, time limit, opening time (IST), production cycle (days), refresher required, waiting time before a reattempt, overdue limits |
| Features | Production agents, assign by file upload, leaderboard, agent leaderboard, certificates, report download, Google Chat release messages, Google Chat overdue list |
| Limits | Rows per assignment, AI calls per day |

Sign-in is not a setting: Google sign-in for verified meesho.com Workspace accounts stays fixed in the
code. Settings live in `src/app-config.ts` (defaults, ranges, help text); the server stores the saved
values in `app_meta` and checks every value against its range.

## SOPs from Google

Each pod links its full SOP (Google Doc) and its day-wise training manual (Google Doc or Slides).
ReadyCheck reads the manual's topics for each day, copies the matching sections of the SOP into
Day 1, Day 2, …, and re-syncs hourly when either file changes. An Admin connects Google Drive once
in Settings (read-only access to Docs/Slides, plus a "ReadyCheck backups" folder). Pasting the SOP
and manual text works without Drive.

## Leaderboard

Trainers and admins filter by agent type, vendor, pod, batch number, status, and either the training
start date (new agents: Day 1 to the last day) or a week / month (weeks follow the calendar month:
days 1–7 are the 1st week, 8–14 the 2nd, …). The top 3 get gold, silver and bronze with their name and
vendor. New agents see their own batch's leaderboard from Day 1 until their training ends.

## Notifications, backups, old data

- **Google Chat:** when a PKT opens (5 PM IST), "Day 3 PKT for the 2nd week of August has been released"
  (or "PKT for the 2nd week of August" for production agents) with a link to attempt it, and a morning list of overdue agents,
  to the batch's own space or the default space (webhooks, set in Batches / Settings).
- **Backups:** online snapshots of the database at most every 15 minutes after a change (last 30
  kept, the live app is never paused), a daily copy to Google Drive, and downloads for the Super Admin.
- **Old data:** the Super Admin can upload the previous app's `readycheck.db`; agents and results
  land in `LEGACY-<pod>` batches as history (they don't count toward attempts).

## Security

- **Sign-in:** Google only, Meesho accounts only (Workspace MFA applies). There is no password login;
  the Super Admin is `SUPER_ADMIN_EMAIL` signing in with Google.
- **Sessions:** the database stores only a SHA-256 of each session cookie, so a database copy can't be
  replayed. Expired sessions are swept every 15 minutes.
- **Limits:** request bodies are capped at 100 KB (1 MB on the few routes that carry documents or file
  chunks, answered with 413 above that); per-address and per-user rate limits answer 429; AI calls have a
  daily budget (`GEMINI_DAILY_CALL_LIMIT`, default 3000) with an alert in the logs at 80%.
- **Google Drive:** only the Super Admin connects it, and only with a verified @meesho.com account. Pod
  links must point to files inside the one approved SOP folder set in Settings; anything else is refused
  before it is read. Who set each link and who connected Drive is recorded.
- **Backups:** every copy (local, download, Drive) has sign-in sessions, PKT test sessions and the Drive
  token removed. Downloads are logged.
- **Data scope:** Trainers see only the vendors and pods in their trainer scope. Admins and the Super
  Admin are global by design: they manage every pod and see every agent's results.
- **Sign-in hardening:** Google OAuth uses a browser-bound `state` plus PKCE, and accepts only verified
  accounts of the meesho.com Workspace (`hd`). Responses carry HSTS and a Content Security Policy.
- **AI prompts:** SOPs, manuals and answers are passed to Gemini as delimited reference data, never as
  instructions, and no agent identity is sent; responses are schema-constrained JSON.

## Code

`pkt.ts` (PKT engine, agent and trainer APIs), `admin.ts` (Google Drive, Chat, backups, import,
scheduler), `server.ts` (login, roles, pods, SOPs), `src/services/geminiService.ts` (AI),
`src/pkt-ui.tsx`, `src/pkt-test.tsx`, `src/admin-ui.tsx`, `src/charts.tsx` (screens),
`tests/pkt-rules.test.ts` (rules).
