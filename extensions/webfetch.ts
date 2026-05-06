/**
 * OpenCode-style WebFetch extension.
 *
 * Fetches a URL and returns the requested representation directly to the
 * model. It is read-only and does not persist response artifacts.
 */

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const webfetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from (must start with http:// or https://)" }),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Optional request timeout in seconds (default 30, max 120)" })),
});

type WebFetchFormat = "text" | "markdown" | "html";

interface WebFetchDetails {
  url: string;
  format: WebFetchFormat;
  contentType: string;
  responseBytes: number;
  title: string;
  image: boolean;
}

const DESCRIPTION = [
  "Fetches content from a specified URL.",
  "Takes a URL and optional format as input.",
  "Fetches the URL content, converts to the requested format (markdown by default), and returns the content directly.",
  "Use this tool when you need to retrieve and analyze web content.",
  "",
  "Usage notes:",
  "- The URL must be a fully-formed valid URL.",
  '- Format options: "markdown" (default), "text", or "html".',
  "- This tool is read-only and does not modify any files.",
  "- Results may be truncated by the host if the content is very large.",
].join("\n");

function normalizeFormat(value: unknown): WebFetchFormat {
  if (value === undefined || value === null || value === "") return "markdown";
  if (value === "text" || value === "markdown" || value === "html") return value;
  throw new Error("Format must be one of: text, markdown, html");
}

function acceptHeaderFor(format: WebFetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function contentMime(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isHtmlContent(contentType: string): boolean {
  const mime = contentMime(contentType);
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function isImageAttachmentMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndownService.remove(["script", "style", "meta", "link"]);
  return turndownService.turndown(html);
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&([a-z]+);/gi, (match, value: string) => entities[value.toLowerCase()] ?? match);
}

function extractTextFromHTML(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
      .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
      .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function responseTitle(url: string, contentType: string): string {
  return contentType ? `${url} (${contentType})` : url;
}

function buildHeaders(format: WebFetchFormat, userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: acceptHeaderFor(format),
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function fetchWithRetry(url: string, format: WebFetchFormat, signal: AbortSignal): Promise<Response> {
  const browserUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

  const first = await fetch(url, {
    signal,
    headers: buildHeaders(format, browserUA),
    redirect: "follow",
  });
  if (first.status !== 403 || first.headers.get("cf-mitigated") !== "challenge") return first;

  return fetch(url, {
    signal,
    headers: buildHeaders(format, "opencode"),
    redirect: "follow",
  });
}

function renderSummary(details: WebFetchDetails, theme: any): string {
  const lines = [
    theme.fg("success", details.image ? "Fetched image" : "Fetched"),
    theme.fg("dim", `Format: ${details.format}`),
    theme.fg("dim", `Size: ${formatBytes(details.responseBytes)}`),
  ];
  if (details.contentType) lines.splice(1, 0, theme.fg("dim", `Type: ${details.contentType}`));
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "webfetch",
    description: DESCRIPTION,
    promptSnippet: "Fetch web content from a specific URL.",
    promptGuidelines: [
      "Use this tool when you need to retrieve and analyze content from a known URL.",
      "Use markdown format by default for web pages unless raw text or HTML is specifically needed.",
      "This tool is read-only and does not write fetched content to the workspace.",
    ],
    parameters: webfetchSchema,

    async execute(_toolCallId, params, signal) {
      const url: string = params.url;
      const format = normalizeFormat(params.format);
      const timeoutSec = Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        const response = await fetchWithRetry(url, format, controller.signal);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get("content-length");
        if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_RESPONSE_BYTES) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentMime(contentType);
        const title = responseTitle(url, contentType);
        const details: WebFetchDetails = {
          url,
          format,
          contentType,
          responseBytes: arrayBuffer.byteLength,
          title,
          image: isImageAttachmentMime(mime),
        };

        if (details.image) {
          return {
            content: [
              { type: "text" as const, text: "Image fetched successfully" },
              { type: "image" as const, data: Buffer.from(arrayBuffer).toString("base64"), mimeType: mime },
            ],
            details,
          };
        }

        const body = new TextDecoder().decode(arrayBuffer);
        let output = body;
        if (format === "markdown" && isHtmlContent(contentType)) {
          output = convertHTMLToMarkdown(body);
        } else if (format === "text" && isHtmlContent(contentType)) {
          output = extractTextFromHTML(body);
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details,
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    renderCall(args, theme) {
      const previewUrl = args.url.length > 80 ? `${args.url.slice(0, 77)}...` : args.url;
      return new Text(`${theme.fg("toolTitle", theme.bold("webfetch "))}${theme.fg("accent", previewUrl)}`, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      }

      const details = result.details as WebFetchDetails | undefined;
      if (!details) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(content?.type === "text" ? content.text : theme.fg("error", "No output"), 0, 0);
      }

      return new Text(renderSummary(details, theme), 0, 0);
    },
  });
}
