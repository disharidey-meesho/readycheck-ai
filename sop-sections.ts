// Splitting a full SOP into numbered sections, and cutting a training manual into days, done
// locally so the AI only has to answer with section numbers and short markers (fast), while the
// day-wise SOPs keep the SOP's exact wording.

export interface Section { id: number; text: string }

const MAX_SECTION = 1800;
const MIN_SECTION = 240;

// a line that starts a new part of the document: numbered / lettered headings, short title-like
// lines, lines ending in ":", slide markers, markdown headings
function isHeading(line: string, next: string | undefined): boolean {
  const l = line.trim();
  if (!l) return false;
  if (/^(#{1,6}\s|---\s*(slide|sheet)|\d+(\.\d+)*[.)]?\s+\S|[A-Z][.)]\s|(section|chapter|part|step|day|module|annexure|appendix)\b)/i.test(l)) return true;
  if (l.length <= 70 && /:$/.test(l)) return true;
  if (l.length <= 60 && l === l.toUpperCase() && /[A-Z]/.test(l)) return true;
  return l.length <= 60 && !/[.,;]$/.test(l) && !!next && next.trim().length > l.length;
}

export function splitSopSections(text: string): Section[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const t = cur.join("\n").trim();
    if (t) blocks.push(t);
    cur = [];
  };
  lines.forEach((line, i) => {
    const size = cur.join("\n").length;
    if ((isHeading(line, lines[i + 1]) && size >= MIN_SECTION) || size + line.length > MAX_SECTION) flush();
    cur.push(line);
  });
  flush();
  // fold tiny trailing blocks into the one before
  const merged: string[] = [];
  for (const b of blocks) {
    if (merged.length && b.length < MIN_SECTION / 3 && merged[merged.length - 1].length + b.length <= MAX_SECTION) merged[merged.length - 1] += `\n${b}`;
    else merged.push(b);
  }
  return merged.map((t, i) => ({ id: i + 1, text: t }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// position of a short phrase in the manual, tolerant of punctuation / spacing differences
function findMarker(manual: string, marker: string): number {
  const words = norm(marker).split(" ").filter(Boolean);
  if (!words.length) return -1;
  const flat: number[] = []; // index in `manual` of each char of the normalized text
  let normText = "";
  let lastSpace = true;
  for (let i = 0; i < manual.length; i++) {
    const c = manual[i].toLowerCase();
    if (/[a-z0-9]/.test(c)) { normText += c; flat.push(i); lastSpace = false; }
    else if (!lastSpace) { normText += " "; flat.push(i); lastSpace = true; }
  }
  for (let n = words.length; n >= Math.min(3, words.length); n--) {
    const at = normText.indexOf(words.slice(0, n).join(" "));
    if (at >= 0) return flat[at];
  }
  return -1;
}

// each day's slice of the manual, from its start marker to the next day's
export function sliceManualByDay(manual: string, markers: string[]): string[] {
  const starts = markers.map((m) => findMarker(manual, m));
  return starts.map((s, i) => {
    if (s < 0) return "";
    const nextStarts = starts.filter((x) => x > s);
    const end = nextStarts.length ? Math.min(...nextStarts) : manual.length;
    return manual.slice(s, end).trim();
  });
}
