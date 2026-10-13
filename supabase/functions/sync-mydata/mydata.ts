// RequestVatInfo client: pagination via continuationToken + retry on transient errors.
// Read-only: this module only ever calls RequestVatInfo.

import { MyDataError, parseVatInfo, type VatEntry } from "./parse.ts";
import { toMyDataDate } from "./dates.ts";

export const PROD_BASE_URL = "https://mydatapi.aade.gr/myDATA";
const MAX_PAGES = 200;
const MAX_ATTEMPTS = 3;

export interface MyDataConfig {
  baseUrl: string;
  userId: string;
  subscriptionKey: string;
}

type Fetch = typeof fetch;

async function getWithRetry(url: string, cfg: MyDataConfig, fetchFn: Fetch, sleep: (ms: number) => Promise<void>) {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: {
          "aade-user-id": cfg.userId,
          "ocp-apim-subscription-key": cfg.subscriptionKey,
          "Accept": "application/xml",
        },
      });
      const body = await res.text();
      if (res.ok) return body;
      lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      // 4xx other than 429 (bad credentials, bad request) won't fix themselves.
      if (res.status !== 429 && res.status < 500) throw new MyDataError(lastError);
    } catch (e) {
      if (e instanceof MyDataError) throw e;
      lastError = `Σφάλμα δικτύου: ${(e as Error).message}`;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** attempt);
  }
  throw new MyDataError(`Αποτυχία μετά από ${MAX_ATTEMPTS} προσπάθειες: ${lastError}`);
}

export async function fetchVatInfo(
  cfg: MyDataConfig,
  from: string,
  to: string,
  fetchFn: Fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<VatEntry[]> {
  const entries: VatEntry[] = [];
  let next: { partitionKey: string; rowKey: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      dateFrom: toMyDataDate(from),
      dateTo: toMyDataDate(to),
      GroupedPerDay: "false",
    });
    if (next) {
      params.set("nextPartitionKey", next.partitionKey);
      params.set("nextRowKey", next.rowKey);
    }
    const xml = await getWithRetry(`${cfg.baseUrl}/RequestVatInfo?${params}`, cfg, fetchFn, sleep);
    const result = parseVatInfo(xml);
    entries.push(...result.entries);
    if (!result.next) return entries;
    next = result.next;
  }
  throw new MyDataError(`Υπέρβαση ορίου σελίδων (${MAX_PAGES})`);
}
