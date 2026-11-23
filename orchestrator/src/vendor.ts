// What every vendor (ticket tracker or code host) gets from the factory when it
// is created: env access that names the vendor in errors, and the dry-run flag.

export interface VendorEnv {
  /** Reads a required environment variable; throws a clear error if it's missing. */
  requireEnv(name: string): string;
  /** Reads an optional environment variable (empty counts as unset). */
  env(name: string): string | undefined;
  /** When true, log every write instead of making it. Reads still happen. */
  dryRun: boolean;
}

export function vendorEnv(vendorName: string, dryRun: boolean, source: NodeJS.ProcessEnv = process.env): VendorEnv {
  return {
    dryRun,
    env: (name) => source[name] || undefined,
    requireEnv: (name) => {
      const v = source[name];
      if (!v) throw new Error(`missing env ${name} (needed by ${vendorName})`);
      return v;
    },
  };
}

/**
 * Picks the vendor-specific instance for each repo: one instance per vendor
 * type in use, created on first need.
 */
export class PerType<T> {
  private byType = new Map<string, T>();
  constructor(types: string[], make: (type: string) => T) {
    for (const t of types) if (!this.byType.has(t)) this.byType.set(t, make(t));
  }
  get(type: string, what: string): T {
    const v = this.byType.get(type);
    if (!v) throw new Error(`no ${what} of type "${type}"`);
    return v;
  }
}
