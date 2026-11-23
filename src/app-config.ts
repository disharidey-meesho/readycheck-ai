// Dynamic settings: the rules and features the Super Admin can change from the app, without a
// code change or a redeploy. Shared by the server (which enforces them) and the screens (which
// show or hide things). Sign-in itself (Google, verified @meesho.com accounts only) is not a
// setting: it stays fixed in the code, as approved in the security review.

export interface AppConfig {
  // who can be assigned
  assignAnyMeeshoEmail: boolean;
  // PKT rules
  passMarkNew: number;
  passMarkOld: number;
  attemptsNew: number;
  attemptsOld: number;
  questionsPerPkt: number;
  testMinutes: number;
  releaseTimeIst: string;
  productionCycleDays: number;
  refresherRequired: boolean;
  coolDownHours: number;
  overdueNewHours: number;
  overdueOldDays: number;
  // features
  featureOldAgents: boolean;
  featureBulkUpload: boolean;
  featureLeaderboard: boolean;
  featureAgentLeaderboard: boolean;
  featureCertificates: boolean;
  featureReportDownload: boolean;
  featureChatReleaseMessages: boolean;
  featureChatOverdueDigest: boolean;
  // limits
  maxUploadRows: number;
  aiDailyCallLimit: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  assignAnyMeeshoEmail: true,
  passMarkNew: 85,
  passMarkOld: 90,
  attemptsNew: 3,
  attemptsOld: 2,
  questionsPerPkt: 20,
  testMinutes: 25,
  releaseTimeIst: "17:00",
  productionCycleDays: 14,
  refresherRequired: true,
  coolDownHours: 4,
  overdueNewHours: 24,
  overdueOldDays: 3,
  featureOldAgents: true,
  featureBulkUpload: true,
  featureLeaderboard: true,
  featureAgentLeaderboard: true,
  featureCertificates: true,
  featureReportDownload: true,
  featureChatReleaseMessages: true,
  featureChatOverdueDigest: true,
  maxUploadRows: 2000,
  aiDailyCallLimit: 3000,
};

type Key = keyof AppConfig;
export type ConfigField =
  | { key: Key; group: string; label: string; help: string; type: "bool" }
  | { key: Key; group: string; label: string; help: string; type: "number"; min: number; max: number; unit?: string }
  | { key: Key; group: string; label: string; help: string; type: "time" };

export const CONFIG_GROUPS = ["Who can be assigned", "PKT rules", "Features", "Limits"] as const;

export const CONFIG_FIELDS: ConfigField[] = [
  { key: "assignAnyMeeshoEmail", group: "Who can be assigned", type: "bool", label: "Any @meesho.com email can be assigned",
    help: "On: agentname_vendor@meesho.com gets that listed vendor, and any other @meesho.com email gets the vendor Meesho. Off: only emails whose vendor is in the Vendors list can be assigned." },

  { key: "passMarkNew", group: "PKT rules", type: "number", min: 1, max: 100, unit: "%", label: "Pass mark: new agents", help: "Score needed to pass a day's PKT in training." },
  { key: "passMarkOld", group: "PKT rules", type: "number", min: 1, max: 100, unit: "%", label: "Pass mark: production agents", help: "Score needed to pass a fortnightly PKT." },
  { key: "attemptsNew", group: "PKT rules", type: "number", min: 1, max: 10, label: "Attempts per day: new agents", help: "Total attempts, including the first. 3 means 1 attempt + 2 reattempts. Failing them all is an Exit." },
  { key: "attemptsOld", group: "PKT rules", type: "number", min: 1, max: 10, label: "Attempts per PKT: production agents", help: "Total attempts, including the first. Failing them all is an Exit." },
  { key: "questionsPerPkt", group: "PKT rules", type: "number", min: 5, max: 50, label: "Questions per PKT", help: "Used for every new PKT. Tests already started keep their questions." },
  { key: "testMinutes", group: "PKT rules", type: "number", min: 5, max: 120, unit: "min", label: "Time limit", help: "Minutes to finish a PKT. The test submits itself when time runs out." },
  { key: "releaseTimeIst", group: "PKT rules", type: "time", label: "PKT opening time (IST)", help: "When each day's PKT, and each fortnightly PKT, opens." },
  { key: "productionCycleDays", group: "PKT rules", type: "number", min: 1, max: 90, unit: "days", label: "Production PKT every", help: "Days between PKTs for production agents, counted from their first PKT date." },
  { key: "refresherRequired", group: "PKT rules", type: "bool", label: "Refresher required before a reattempt",
    help: "On: after a fail the agent must finish the training refresher, then the reattempt opens after the waiting time. Off: the refresher is optional and the waiting time counts from the fail." },
  { key: "coolDownHours", group: "PKT rules", type: "number", min: 0, max: 72, unit: "hours", label: "Waiting time before a reattempt", help: "0 means the reattempt opens straight away." },
  { key: "overdueNewHours", group: "PKT rules", type: "number", min: 1, max: 240, unit: "hours", label: "Overdue after: new agents", help: "A PKT (or refresher) left this long after it opened shows as Overdue." },
  { key: "overdueOldDays", group: "PKT rules", type: "number", min: 1, max: 30, unit: "days", label: "Overdue after: production agents", help: "A PKT left this long after it opened shows as Overdue." },

  { key: "featureOldAgents", group: "Features", type: "bool", label: "Production (old) agents", help: "Lets trainers assign production agents for fortnightly PKTs." },
  { key: "featureBulkUpload", group: "Features", type: "bool", label: "Assign by file upload", help: "Shows Upload file (CSV / Excel) on the Assign screen." },
  { key: "featureLeaderboard", group: "Features", type: "bool", label: "Leaderboard", help: "Shows the Leaderboard to trainers, admins and agents." },
  { key: "featureAgentLeaderboard", group: "Features", type: "bool", label: "Leaderboard for agents", help: "Agents in training see their batch leaderboard. Needs Leaderboard on." },
  { key: "featureCertificates", group: "Features", type: "bool", label: "Certificates", help: "Agents who pass every training day get a certificate." },
  { key: "featureReportDownload", group: "Features", type: "bool", label: "Download report (Excel)", help: "Shows Download report on Analytics." },
  { key: "featureChatReleaseMessages", group: "Features", type: "bool", label: "Google Chat: PKT released", help: "Posts a message in the batch's Google Chat space when a PKT opens." },
  { key: "featureChatOverdueDigest", group: "Features", type: "bool", label: "Google Chat: overdue list", help: "Posts the list of overdue agents every morning after 10 AM IST." },

  { key: "maxUploadRows", group: "Limits", type: "number", min: 10, max: 5000, label: "Rows per assignment", help: "Most agents a trainer can assign at once." },
  { key: "aiDailyCallLimit", group: "Limits", type: "number", min: 100, max: 50000, label: "AI calls per day", help: "Gemini calls allowed per day (question building, coaching, SOP build). An alert is logged at 80%." },
];

const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// a full, valid config: unknown keys dropped, bad values replaced by the base value
export function sanitizeConfig(input: unknown, base: AppConfig = DEFAULT_CONFIG): AppConfig {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out = { ...base } as Record<Key, unknown>;
  for (const f of CONFIG_FIELDS) {
    const v = src[f.key];
    if (v === undefined) continue;
    if (f.type === "bool" && typeof v === "boolean") out[f.key] = v;
    else if (f.type === "number" && typeof v === "number" && Number.isFinite(v)) out[f.key] = Math.min(f.max, Math.max(f.min, Math.round(v)));
    else if (f.type === "time" && isTime(v)) out[f.key] = v;
  }
  return out as unknown as AppConfig;
}

// minutes after midnight IST
export const releaseMinutes = (c: AppConfig) => {
  const [h, m] = c.releaseTimeIst.split(":").map(Number);
  return h * 60 + m;
};

// "5 PM", "5:30 PM"
export function releaseLabel(c: AppConfig): string {
  const total = releaseMinutes(c);
  const h = Math.floor(total / 60), m = total % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

export const hoursLabel = (h: number) => (h === 0 ? "straight away" : `${h} hour${h === 1 ? "" : "s"}`);
