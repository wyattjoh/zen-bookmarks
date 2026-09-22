import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BookmarkCandidate } from "./bookmark-candidates.ts";
import type { NetworkDebugLogger } from "./network-debug.ts";
import type { CachedLinkRecord, SearchCache } from "./search-cache.ts";

const CLASSIFICATION_VERSION = 1;
const MAX_BODY_BYTES = 1_000_000;
const MAX_INDEXED_TEXT = 20_000;

const CLASSIFICATION_QUESTIONS = {
  resourceKind: choice(
    "Which single resource kind best describes `link`? Choose from the supplied kinds using its title, URL, metadata, and excerpt.",
    {
      documentation: "Reference documentation, specification, tutorial, or educational guide.",
      source_code: "Source-code repository, package, library, framework, or developer project.",
      application: "Interactive software application, dashboard, console, or online tool.",
      article: "Article, blog post, news item, essay, paper, or other authored reading.",
      product_service: "Product, company, or service landing page primarily describing an offering.",
      media: "Video, audio, image, presentation, or other media content.",
      commerce: "Shopping, product listing, booking, or purchasing page.",
      community: "Forum, social network, issue tracker, chat, or community discussion.",
      internal_tool: "Private, local, administrative, or organization-specific resource.",
      other: "None of the other resource kinds is supported by the available evidence.",
    },
  ),
  purpose: choice(
    "What is the primary user purpose of `link`? Choose the action this bookmark most directly supports.",
    {
      learn: "Learn a concept, follow a guide, or read explanatory material.",
      build: "Create, program, design, test, or develop something.",
      operate: "Configure, administer, deploy, or operate a system or service.",
      monitor: "Observe status, analytics, logs, metrics, or ongoing activity.",
      communicate: "Communicate, collaborate, or coordinate with other people.",
      buy: "Evaluate, purchase, book, or subscribe to a product or service.",
      entertain: "Consume entertainment, hobbies, or leisure content.",
      reference: "Look up stable facts, APIs, records, or reference information.",
      other: "No supplied purpose is clearly supported by the available evidence.",
    },
  ),
  aiAgents: noul("Is `link` substantially about AI, machine learning, models, or software agents?"),
  softwareDevelopment: noul(
    "Is `link` substantially about programming, developer tools, APIs, testing, or software engineering?",
  ),
  identitySecurity: noul(
    "Is `link` substantially about authentication, identity, authorization, privacy, or security?",
  ),
  cloudInfrastructure: noul(
    "Is `link` substantially about cloud services, deployment, networking, infrastructure, or operations?",
  ),
  data: noul(
    "Is `link` substantially about databases, storage, analytics, search, or data processing?",
  ),
  design: noul(
    "Is `link` substantially about user interfaces, visual design, graphics, or user experience?",
  ),
  productivity: noul(
    "Is `link` substantially about productivity, organization, planning, or personal workflows?",
  ),
  businessFinance: noul(
    "Is `link` substantially about business, commerce, accounting, banking, or finance?",
  ),
  personalLifestyle: noul(
    "Is `link` substantially about personal life, health, travel, home, relationships, or lifestyle?",
  ),
  food: noul("Is `link` substantially about food, cooking, recipes, dining, or meal delivery?"),
  hardware: noul(
    "Is `link` substantially about physical hardware, electronics, devices, or maker projects?",
  ),
  entertainment: noul(
    "Is `link` substantially about games, music, video, books, events, or entertainment?",
  ),
} as const;

const TOPIC_LABELS = {
  aiAgents: "AI machine learning models software agents",
  softwareDevelopment: "programming developer tools APIs testing software engineering",
  identitySecurity: "authentication identity authorization privacy security",
  cloudInfrastructure: "cloud deployment networking infrastructure operations",
  data: "databases storage analytics search data processing",
  design: "user interface visual design graphics user experience",
  productivity: "productivity organization planning personal workflows",
  businessFinance: "business commerce accounting banking finance",
  personalLifestyle: "personal life health travel home relationships lifestyle",
  food: "food cooking recipes dining meal delivery",
  hardware: "hardware electronics devices maker projects",
  entertainment: "games music video books events entertainment",
} as const;

/**
 * Structured reusable TypeSafe facets cached for one link.
 */
export type LinkClassification = {
  version: number;
  model: string;
  resourceKind: {
    value: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  purpose: {
    value: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  topics: Record<keyof typeof TOPIC_LABELS, number>;
};

/**
 * Fetched public content used to enrich one bookmark.
 */
export type LinkContent = {
  fetchStatus: "ok" | "skipped" | "error";
  finalUrl: string | null;
  pageTitle: string | null;
  description: string | null;
  text: string;
  error: string | null;
};

/**
 * Structured input used by the cached TypeSafe link classifier.
 */
export type LinkClassificationState = {
  link: {
    title: string;
    url: string;
    currentUrl: string | null;
    workspace: string;
    folderPath: string[];
    pageTitle: string | null;
    description: string | null;
    excerpt: string;
  };
};

/**
 * TypeSafe classifier that batches all reusable facets for one link.
 */
export type LinkClassifier = {
  model: string;
  classify(state: LinkClassificationState): Promise<LinkClassification>;
};

/**
 * Function that safely loads public content for one URL.
 */
export type LinkContentLoader = (url: string) => Promise<LinkContent>;

/**
 * Summary of one cache-indexing pass.
 */
export type LinkIndexResult = {
  total: number;
  cached: number;
  indexed: number;
};

/**
 * Normalize a bookmark URL for cache identity.
 *
 * @param rawUrl - Bookmark URL
 * @returns URL without a fragment, or the original non-standard value
 */
export function canonicalLinkUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

/**
 * Check URL-level public-fetch policy before DNS resolution.
 *
 * @param rawUrl - Bookmark URL
 * @returns Whether the URL is eligible for a public fetch
 */
export function isPotentiallyPublicUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    return false;
  }
  if (/^(login|dashboard|console|admin|account)\./.test(hostname)) return false;
  if (/^\/(login|signin|sign-in|dashboard|admin|account)(\/|$)/i.test(url.pathname)) {
    return false;
  }
  for (const key of url.searchParams.keys()) {
    if (/(token|secret|session|signature|credential|password|api[_-]?key|auth|code)/i.test(key)) {
      return false;
    }
  }
  return true;
}

async function publicUrlReason(rawUrl: string): Promise<string | null> {
  if (!isPotentiallyPublicUrl(rawUrl)) return "URL is outside the public-fetch policy";
  const url = new URL(rawUrl);
  if (isIP(url.hostname)) {
    return isPrivateAddress(url.hostname) ? "URL resolves to a private address" : null;
  }
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return "URL resolves to a private address";
    }
  } catch (error) {
    return `DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_BODY_BYTES - total;
    chunks.push(value.slice(0, remaining));
    total += Math.min(value.length, remaining);
    if (value.length > remaining) break;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function tagAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ? decodeHtml(match[2].trim()) : null;
}

function extractHtmlContent(html: string): Pick<LinkContent, "pageTitle" | "description" | "text"> {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let description: string | null = null;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = tagAttribute(tag, "name") ?? tagAttribute(tag, "property");
    if (name?.toLowerCase() === "description" || name?.toLowerCase() === "og:description") {
      description = tagAttribute(tag, "content");
      if (description) break;
    }
  }
  const text = decodeHtml(
    html
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, MAX_INDEXED_TEXT);
  return {
    pageTitle: titleMatch ? decodeHtml(titleMatch.replace(/\s+/g, " ").trim()) : null,
    description,
    text,
  };
}

/**
 * Fetch metadata and bounded readable text while rejecting private or credential-bearing URLs.
 *
 * @param rawUrl - Bookmark URL
 * @returns Fetched content or a cached skip/error result
 */
export async function fetchPublicLinkContent(rawUrl: string): Promise<LinkContent> {
  let currentUrl = rawUrl;
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const reason = await publicUrlReason(currentUrl);
      if (reason) {
        return {
          fetchStatus: "skipped",
          finalUrl: null,
          pageTitle: null,
          description: null,
          text: "",
          error: reason,
        };
      }
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "zen-bookmarks/0.2 link indexer" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect ${response.status} has no location`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("html") && !contentType.startsWith("text/")) {
        return {
          fetchStatus: "skipped",
          finalUrl: currentUrl,
          pageTitle: null,
          description: null,
          text: "",
          error: `Unsupported content type: ${contentType || "unknown"}`,
        };
      }
      const body = await readLimitedBody(response);
      const extracted = contentType.includes("html")
        ? extractHtmlContent(body)
        : { pageTitle: null, description: null, text: body.slice(0, MAX_INDEXED_TEXT) };
      return {
        fetchStatus: "ok",
        finalUrl: currentUrl,
        ...extracted,
        error: null,
      };
    }
    throw new Error("Too many redirects");
  } catch (error) {
    return {
      fetchStatus: "error",
      finalUrl: currentUrl === rawUrl ? null : currentUrl,
      pageTitle: null,
      description: null,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a TypeSafe classifier that asks every reusable link-facet question together.
 *
 * @param apiKey - TypeSafe API key
 * @returns Batched per-link classifier
 */
export function createTypeSafeLinkClassifier(apiKey: string): LinkClassifier {
  const client = new TypeSafeClient({ apiKey });
  return {
    model: client.defaultModel,
    async classify(state) {
      const response = await client.systemOne({ state, questions: CLASSIFICATION_QUESTIONS });
      const resourceKind = response.answers.resourceKind;
      const purpose = response.answers.purpose;
      return {
        version: CLASSIFICATION_VERSION,
        model: response.model,
        resourceKind: {
          value: resourceKind.choice,
          confidence: resourceKind.confidence,
          probabilities: { ...resourceKind.probabilities },
        },
        purpose: {
          value: purpose.choice,
          confidence: purpose.confidence,
          probabilities: { ...purpose.probabilities },
        },
        topics: {
          aiAgents: response.answers.aiAgents.noul,
          softwareDevelopment: response.answers.softwareDevelopment.noul,
          identitySecurity: response.answers.identitySecurity.noul,
          cloudInfrastructure: response.answers.cloudInfrastructure.noul,
          data: response.answers.data.noul,
          design: response.answers.design.noul,
          productivity: response.answers.productivity.noul,
          businessFinance: response.answers.businessFinance.noul,
          personalLifestyle: response.answers.personalLifestyle.noul,
          food: response.answers.food.noul,
          hardware: response.answers.hardware.noul,
          entertainment: response.answers.entertainment.noul,
        },
      };
    },
  };
}

function classificationIsCurrent(record: CachedLinkRecord): boolean {
  try {
    return (JSON.parse(record.classificationJson) as LinkClassification).version === CLASSIFICATION_VERSION;
  } catch {
    return false;
  }
}

function classificationState(
  candidate: BookmarkCandidate,
  content: LinkContent,
): LinkClassificationState {
  return {
    link: {
      title: candidate.bookmark.title,
      url: candidate.bookmark.url,
      currentUrl: candidate.bookmark.currentUrl ?? null,
      workspace: candidate.workspaceName,
      folderPath: candidate.folderPath,
      pageTitle: content.pageTitle,
      description: content.description,
      excerpt: content.text.slice(0, 6_000),
    },
  };
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await transform(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
}

/**
 * Populate missing cached link content and batched TypeSafe facets.
 *
 * @param candidates - Flattened sidebar bookmarks
 * @param cache - Persistent SQLite cache
 * @param classifier - Per-link TypeSafe classifier
 * @param loader - Safe public content loader
 * @param refresh - Whether to replace existing cache entries
 * @param concurrency - Maximum simultaneous fetch/classification operations
 * @param debug - Optional network/cache debug event receiver
 * @returns Indexing counts
 */
export async function indexBookmarkLinks(
  candidates: BookmarkCandidate[],
  cache: SearchCache,
  classifier: LinkClassifier,
  loader: LinkContentLoader = fetchPublicLinkContent,
  refresh = false,
  concurrency = 4,
  debug: NetworkDebugLogger | undefined = undefined,
): Promise<LinkIndexResult> {
  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [canonicalLinkUrl(candidate.bookmark.url), candidate]),
    ).values(),
  ];
  let cached = 0;
  let indexed = 0;
  await mapConcurrent(uniqueCandidates, concurrency, async (candidate) => {
    const url = canonicalLinkUrl(candidate.bookmark.url);
    const existing = cache.getLink(url);
    if (!refresh && existing && classificationIsCurrent(existing)) {
      cached += 1;
      return;
    }
    const content = await loader(url);
    const classification = await classifier.classify(classificationState(candidate, content));
    const classificationJson = JSON.stringify(classification);
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          url,
          finalUrl: content.finalUrl,
          pageTitle: content.pageTitle,
          description: content.description,
          text: content.text,
          classification,
        }),
      )
      .digest("hex");
    cache.putLink({
      url,
      fetchedAt: Date.now(),
      fetchStatus: content.fetchStatus,
      finalUrl: content.finalUrl,
      pageTitle: content.pageTitle,
      description: content.description,
      text: content.text,
      classificationJson,
      contentHash,
      error: content.error,
    });
    indexed += 1;
  });
  debug?.("network.cache_summary", {
    operation: "link-index",
    cache_hits: cached,
    network_candidates: indexed,
    total: uniqueCandidates.length,
  });
  return { total: uniqueCandidates.length, cached, indexed };
}

/**
 * Convert cached TypeSafe facets into deterministic terms for local retrieval.
 *
 * @param classificationJson - Cached classification JSON
 * @returns Searchable human-readable facet labels
 */
export function classificationSearchText(classificationJson: string): string {
  try {
    const classification = JSON.parse(classificationJson) as LinkClassification;
    const topics = Object.entries(classification.topics)
      .filter(([, probability]) => probability >= 0.5)
      .map(([name]) => TOPIC_LABELS[name as keyof typeof TOPIC_LABELS]);
    return [classification.resourceKind.value, classification.purpose.value, ...topics].join(" ");
  } catch {
    return "";
  }
}
