// Vendor from an agent's email: agentname_vendorname@meesho.com → the vendor in the Super Admin's
// vendor list whose name matches "vendorname" (case, spaces and punctuation ignored). Any other
// @meesho.com email (no vendor part, or one not in the list) belongs to the internal vendor "Meesho".
// Shared by the server (import) and the Assign screen (preview).

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// "babulal.verma_technotask@meesho.com" → "technotask"; "" when the email has no _vendor part
export function vendorKeyFromEmail(email: string): string {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  const at = local.lastIndexOf("_");
  return at > 0 ? key(local.slice(at + 1)) : "";
}

export const INTERNAL_VENDOR = "Meesho";

// internal: true when no listed vendor matched and the agent counts as a Meesho employee
export type VendorMatch = { vendor: string; internal: boolean };

export function vendorFromEmail(email: string, vendors: string[]): VendorMatch {
  const k = vendorKeyFromEmail(email);
  const found = k ? vendors.find((v) => key(v) === k) : undefined;
  return found ? { vendor: found, internal: false } : { vendor: INTERNAL_VENDOR, internal: true };
}
