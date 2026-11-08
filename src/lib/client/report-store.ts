import type { LabResult } from "@/lib/types";

export type StoredLabResult = LabResult & { runId: string };

const DB_NAME = "website-testing-labs";
const STORE_NAME = "reports";
const DB_VERSION = 1;
const MAX_REPORTS = 20;

function openReportDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Browser report storage is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "runId" });
        store.createIndex("completedAt", "completedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open report history."));
  });
}

export async function getStoredReports(): Promise<StoredLabResult[]> {
  const db = await openReportDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as StoredLabResult[]).sort((a, b) => b.completedAt.localeCompare(a.completedAt)));
      request.onerror = () => reject(request.error || new Error("Could not load report history."));
    });
  } finally {
    db.close();
  }
}

export async function saveStoredReport(report: StoredLabResult): Promise<void> {
  const db = await openReportDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        ...report,
        // Keep report history useful without retaining every large screenshot in every record.
        screenshots: report.screenshots.slice(0, 4),
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save report."));
      transaction.onabort = () => reject(transaction.error || new Error("Report save was aborted."));
    });
    const reports = await getStoredReports();
    if (reports.length > MAX_REPORTS) {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        reports.slice(MAX_REPORTS).forEach((report) => store.delete(report.runId));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Could not trim report history."));
      });
    }
  } finally {
    db.close();
  }
}

export async function deleteStoredReport(runId: string): Promise<void> {
  const db = await openReportDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(runId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not delete report."));
    });
  } finally {
    db.close();
  }
}
