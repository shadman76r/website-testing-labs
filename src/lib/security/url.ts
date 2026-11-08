import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid absolute website URL, including https://.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS website URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded usernames or passwords are not allowed.");
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("For safety, only standard HTTP (80) and HTTPS (443) ports are allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostname ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".invalid")
  ) {
    throw new Error("Local, private and reserved hostnames cannot be tested.");
  }

  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new Error("Private, loopback, link-local and reserved IP addresses are blocked.");
    }
  } else {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("The website hostname could not be resolved.");
    }
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new Error("The hostname resolves to a private or non-public IP address and was blocked.");
    }
  }

  return url;
}

export function normalizeUrlForComparison(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  url.hostname = url.hostname.toLowerCase();
  return url.toString().replace(/\/$/, "");
}
