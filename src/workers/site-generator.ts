import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { prisma } from "../db/client";
import { connection, enqueueImage, SiteJob } from "../queue";

const workerName = "site-generator";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.SITE_GENERATOR_CONCURRENCY ?? defaultConcurrency);
const aiCopyEnabled = (process.env.AI_COPY_ENABLED ?? "false").toLowerCase() === "true";
const openAiApiKey = process.env.OPENAI_API_KEY ?? "";
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const openAiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

type GenerateSiteInput = {
  leadId: string;
  businessName: string;
  city: string;
  niche: string;
  sourceMode: string | null;
  websiteUrl: string | null;
  services: string[];
  claims: string[];
  brandColors: string[];
  summary: string;
  sheetDataUrl: string | null;
  phone: string | null;
  email: string | null;
};

type GenerateSiteOutput = {
  zipPath: string;
  summary: string;
};

type GeneratedCopy = {
  heroSummary: string;
  aboutHeadline: string;
  aboutBio: string;
  trustPoints: string[];
  serviceDescriptions: Record<string, string>;
  testimonials: string[];
};

export interface OpenClawClient {
  generateSite(input: GenerateSiteInput): Promise<GenerateSiteOutput>;
}

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const sanitizeFileSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

const defaultPalette = {
  brand: "#0f4c81",
  accent: "#f59e0b",
  ink: "#172235"
};

const normalizeHexColor = (value: string): string | null => {
  const cleaned = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(cleaned)) {
    return `#${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}${cleaned[3]}${cleaned[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
};

const paletteFromBrandColors = (brandColors: string[]): { brand: string; accent: string; ink: string } => {
  const valid = brandColors
    .map(normalizeHexColor)
    .filter((color): color is string => typeof color === "string");

  return {
    brand: valid[0] ?? defaultPalette.brand,
    accent: valid[1] ?? defaultPalette.accent,
    ink: valid[2] ?? defaultPalette.ink
  };
};

const toTitleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const buildFallbackSummary = (niche: string, city: string): string =>
  `Trusted ${niche} team serving ${city} with responsive service, transparent quotes, and high-quality workmanship.`;

const toSentence = (value: string): string => {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  const withCapital = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /[.!?]$/.test(withCapital) ? withCapital : `${withCapital}.`;
};

const serviceDescription = (service: string, city: string): string =>
  `Tailored ${service.toLowerCase()} solutions for property owners in ${city}, with durable materials and clean execution.`;

const inferNicheLabel = (niche: string, businessName: string, websiteUrl: string | null): string => {
  const joined = `${niche} ${businessName} ${websiteUrl ?? ""}`.toLowerCase();
  if (joined.includes("construction")) return "construction";
  if (joined.includes("remodel")) return "remodeling";
  if (joined.includes("plumb")) return "plumbing";
  if (joined.includes("electrical") || joined.includes("electrician")) return "electrical";
  if (joined.includes("hvac") || joined.includes("heating") || joined.includes("cooling")) return "hvac";
  if (joined.includes("roof")) return "roofing";
  return niche;
};

const sanitizeScrapedSentence = (value: string): string => {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/©[^.]*\.?/gi, "")
    .replace(/\blicense\b[^.]*\.?/gi, "")
    .replace(/\bprivacy policy\b/gi, "")
    .replace(/\bcookie(s)?\b/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .trim();
  return cleaned;
};

const looksUnusableCopy = (value: string): boolean => {
  if (!value || value.length < 24) {
    return true;
  }
  const lowered = value.toLowerCase();
  return (
    lowered.includes("copyright") ||
    lowered.includes("cookie") ||
    lowered.includes("privacy") ||
    lowered.includes("lorem ipsum") ||
    lowered.includes("project authors")
  );
};

const sanitizeServiceName = (service: string): string | null => {
  const cleaned = service
    .replace(/[^a-z0-9\s&/-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return null;
  }
  const lowered = cleaned.toLowerCase();
  const blocked = ["copyright", "cookie", "privacy", "blog", "home", "video", "author"];
  if (blocked.some((term) => lowered.includes(term))) {
    return null;
  }
  return cleaned;
};

const buildTrustPoints = (
  claims: string[],
  services: string[],
  city: string
): string[] => {
  const trustFromClaims = claims.map((claim) =>
    claim.toLowerCase().includes("estimate")
      ? "Fast estimates and clear project scope"
      : `${toTitleCase(claim)} local team standards`
  );
  const trustFromServices =
    services.length > 0
      ? [
          `${toTitleCase(services[0])} specialists for ${city} homes`,
          "Clear communication from first call to final walkthrough"
        ]
      : [];

  const combined = [...trustFromClaims, ...trustFromServices, "On-time scheduling and clean job-site finish"];
  return Array.from(new Set(combined)).slice(0, 4);
};

const aiCopySchema = z.object({
  heroSummary: z.string().min(20).max(260),
  aboutHeadline: z.string().min(6).max(90),
  aboutBio: z.string().min(20).max(360),
  trustPoints: z.array(z.string().min(8).max(120)).min(3).max(5),
  serviceDescriptions: z.record(z.string().min(6).max(220)).optional(),
  testimonials: z.array(z.string().min(12).max(200)).min(2).max(3)
});

const tryExtractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
};

const generateAICopy = async (input: GenerateSiteInput): Promise<GeneratedCopy | null> => {
  if (!aiCopyEnabled || !openAiApiKey) {
    return null;
  }

  const prompt = [
    "You write concise homepage copy for local contractor websites.",
    "Return JSON only. No markdown. No code fences.",
    "Keys required: heroSummary, aboutHeadline, aboutBio, trustPoints, serviceDescriptions, testimonials.",
    "Rules:",
    "- Keep tone professional, specific, and trustworthy.",
    "- Mention city naturally.",
    "- Avoid unverifiable claims.",
    "- Keep heroSummary one sentence.",
    "- trustPoints: 3-5 short bullets.",
    "- testimonials: 2-3 realistic sounding quotes without names.",
    "",
    "Input:",
    JSON.stringify({
      businessName: input.businessName,
      city: input.city,
      niche: input.niche,
      services: input.services,
      claims: input.claims,
      summary: input.summary,
      websiteUrl: input.websiteUrl
    })
  ].join("\n");

  const response = await fetch(`${openAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: "You are a conversion-focused copywriter for local service businesses."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    return null;
  }

  const payloadUnknown: unknown = await response.json();
  const content = (() => {
    if (
      !payloadUnknown ||
      typeof payloadUnknown !== "object" ||
      !("choices" in payloadUnknown) ||
      !Array.isArray((payloadUnknown as { choices?: unknown }).choices)
    ) {
      return "";
    }
    const choices = (payloadUnknown as { choices: Array<{ message?: { content?: unknown } }> }).choices;
    const first = choices[0];
    if (!first?.message || typeof first.message.content !== "string") {
      return "";
    }
    return first.message.content;
  })();

  if (!content) {
    return null;
  }

  const jsonSegment = tryExtractJsonObject(content);
  if (!jsonSegment) {
    return null;
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(jsonSegment);
  } catch {
    return null;
  }

  const parsed = aiCopySchema.safeParse(parsedUnknown);
  if (!parsed.success) {
    return null;
  }

  return {
    heroSummary: parsed.data.heroSummary,
    aboutHeadline: parsed.data.aboutHeadline,
    aboutBio: parsed.data.aboutBio,
    trustPoints: parsed.data.trustPoints,
    serviceDescriptions: parsed.data.serviceDescriptions ?? {},
    testimonials: parsed.data.testimonials
  };
};

const buildIndexHtml = (input: GenerateSiteInput, aiCopy: GeneratedCopy | null): string => {
  const palette = paletteFromBrandColors(input.brandColors);
  const sheetDataUrlLiteral = JSON.stringify(input.sheetDataUrl ?? "");
  const inferredNiche = inferNicheLabel(input.niche, input.businessName, input.websiteUrl);
  const displayNiche = toTitleCase(inferredNiche);
  const cityLabel =
    input.sourceMode === "manual-one" && input.city.toLowerCase() === "service area"
      ? "your area"
      : input.city;
  const cleanedSummary = sanitizeScrapedSentence(toSentence(aiCopy?.heroSummary ?? "") || toSentence(input.summary));
  const primarySummary =
    looksUnusableCopy(cleanedSummary) ? buildFallbackSummary(inferredNiche, cityLabel) : cleanedSummary;
  const aboutHeadline = aiCopy?.aboutHeadline || `${displayNiche} Experts in ${input.city}`;
  const aboutBio =
    aiCopy?.aboutBio ||
    (looksUnusableCopy(sanitizeScrapedSentence(toSentence(input.summary)))
      ? ""
      : sanitizeScrapedSentence(toSentence(input.summary))) ||
    `From small repairs to full replacements, ${input.businessName} delivers dependable ${inferredNiche.toLowerCase()} support across ${cityLabel}.`;
  const trustItems = aiCopy?.trustPoints ?? buildTrustPoints(input.claims, input.services, cityLabel);
  const trustPoints = trustItems.map((item) => `<li>${item}</li>`).join("");
  const sourceHost = input.websiteUrl
    ? (() => {
        try {
          return new URL(input.websiteUrl).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })()
    : null;

  const services = input.services.length > 0
    ? input.services.map(sanitizeServiceName).filter((item): item is string => Boolean(item))
    : ["roof replacement", "metal roofing", "emergency repairs"];
  const servicesMarkup = services.slice(0, 3).map((service, idx) => {
    const serviceTitle = toTitleCase(service);
    const description = aiCopy?.serviceDescriptions[service] ?? serviceDescription(service, cityLabel);
    const imageKey = idx === 0 ? "{{SERVICE_IMAGE_URL_1}}" : idx === 1 ? "{{SERVICE_IMAGE_URL_2}}" : "{{SERVICE_IMAGE_URL_3}}";
    return `<article class="service-card">
      <img src="${imageKey}" alt="${serviceTitle} project" loading="lazy" />
      <div class="service-copy">
        <p class="chip">Service ${idx + 1}</p>
        <h3>${serviceTitle}</h3>
        <p>${description}</p>
        <a href="#contact" class="text-link">Learn More</a>
      </div>
    </article>`;
  }).join("");

  const trustBadges = (input.claims.length > 0 ? input.claims : ["licensed", "insured", "free estimates"])
    .slice(0, 3)
    .map((claim) => `<span class="badge">${claim}</span>`)
    .join("");

  const testimonialsMarkup = (aiCopy?.testimonials ?? [
    "Quick response, detailed quote, and excellent final quality.",
    "Professional crew, clear updates, and no surprises.",
    "Clear timeline, fair pricing, and spotless cleanup after completion."
  ])
    .slice(0, 3)
    .map((line) => `<article class="review-card"><p>"${line}"</p><span>Verified Local Client</span></article>`)
    .join("");

  const phoneHref = (input.phone ?? "5550000000").replace(/[^0-9+]/g, "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${input.businessName} | ${displayNiche} in ${cityLabel}</title>
    <style>
      :root {
        --brand: ${palette.brand};
        --accent: ${palette.accent};
        --ink: ${palette.ink};
        --muted: #59657a;
        --bg: #f5f5f6;
        --surface: #ffffff;
        --line: #d8dde7;
        --dark: #12151d;
        --space-1: 8px;
        --space-2: 16px;
        --space-3: 24px;
        --space-4: 32px;
        --space-5: 48px;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; overflow-x: hidden; }
      body {
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: var(--ink);
        background: var(--bg);
        line-height: 1.5;
      }
      a { color: inherit; }
      h1, h2, h3, p { margin: 0; }
      p { color: var(--muted); }
      .container { width: min(1140px, 100% - 24px); margin-inline: auto; }
      .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }

      .site-header {
        background: rgba(255,255,255,0.92);
        border-bottom: 1px solid var(--line);
        position: sticky;
        top: 0;
        z-index: 20;
        backdrop-filter: blur(8px);
      }
      .nav-wrap { display: flex; align-items: center; justify-content: space-between; min-height: 64px; }
      .brand { font-weight: 700; text-decoration: none; }
      .nav-right { display: flex; align-items: center; gap: 10px; }
      .menu-button {
        min-width: 44px; min-height: 44px; border: 1px solid var(--line);
        background: var(--surface); border-radius: 10px; cursor: pointer;
      }
      .nav-links {
        list-style: none; margin: 0; padding: 12px; display: none; flex-direction: column; gap: 8px;
        position: absolute; right: 12px; top: 70px; width: min(260px, calc(100vw - 24px));
        background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
      }
      .nav-links.open { display: flex; }
      .nav-links a {
        min-height: 44px; display: inline-flex; align-items: center; border-radius: 8px; text-decoration: none; padding: 0 8px;
      }
      .nav-cta {
        min-height: 38px;
        border-radius: 999px;
        background: #0f121a;
        color: #fff;
        text-decoration: none;
        padding: 0 14px;
        display: inline-flex;
        align-items: center;
        font-size: 13px;
        font-weight: 600;
        border: 1px solid #0f121a;
      }
      .nav-links a:hover, .btn:hover, .text-link:hover { filter: brightness(0.96); }
      .menu-button:focus-visible, .nav-links a:focus-visible, .btn:focus-visible {
        outline: 3px solid #7dd3fc; outline-offset: 2px;
      }

      .hero {
        margin-top: 12px;
        position: relative;
        border-radius: 16px;
        overflow: hidden;
        min-height: 460px;
        display: grid;
        align-items: end;
        padding: var(--space-4) var(--space-3);
      }
      .hero-media { position: absolute; inset: 0; }
      .hero-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .hero::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(100deg, rgba(8, 10, 16, 0.88) 0%, rgba(8, 10, 16, 0.68) 45%, rgba(8, 10, 16, 0.35) 100%);
        z-index: 1;
      }
      .hero-copy { position: relative; z-index: 2; max-width: 650px; }
      .hero-copy .eyebrow { color: rgba(255,255,255,0.8); margin-bottom: 8px; }
      #businessName { color: #fff; font-size: clamp(2rem, 8vw, 3.2rem); line-height: 1.03; margin-bottom: 12px; }
      #heroSummary { color: rgba(255,255,255,0.9); margin-bottom: 14px; max-width: 56ch; }
      .trust-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .badge {
        font-size: 12px; text-transform: capitalize; border-radius: 999px;
        padding: 6px 12px; background: rgba(255,255,255,0.14); color: #fff; border: 1px solid rgba(255,255,255,0.32);
      }
      .btn-row { display: flex; flex-direction: column; gap: 8px; }
      .btn {
        min-height: 44px; border-radius: 10px; text-decoration: none; font-weight: 650;
        padding: 10px 14px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent;
      }
      .btn-primary { background: var(--brand); color: #fff; }
      .btn-secondary { background: rgba(255,255,255,0.95); color: var(--ink); }

      .trust-strip {
        margin-top: -18px;
        position: relative;
        z-index: 3;
        display: grid;
        gap: 8px;
      }
      .trust-card {
        background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px;
        box-shadow: 0 8px 24px rgba(9, 14, 24, 0.08);
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 10px;
        align-items: center;
      }
      .trust-dot { width: 28px; height: 28px; border-radius: 50%; background: #f0f4ff; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; color: var(--brand); font-size: 14px; }
      .trust-card strong { display: block; font-size: 16px; margin-bottom: 2px; }
      .trust-card span { font-size: 13px; color: var(--muted); }

      main { display: grid; gap: 18px; padding: 18px 0 30px; }
      .section {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: var(--space-3);
      }
      .section-head { margin-bottom: 12px; }
      .section-head h2 { font-size: clamp(1.5rem, 5vw, 2rem); margin-top: 4px; }

      .services-grid { display: grid; gap: 12px; }
      .service-card { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #fff; }
      .service-card img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; }
      .service-copy { padding: 12px; display: grid; gap: 8px; }
      .chip {
        display: inline-flex; width: fit-content; padding: 4px 8px; border-radius: 999px;
        background: #f3f6fa; border: 1px solid var(--line); color: var(--muted); font-size: 12px;
      }
      .service-copy h3 { font-size: 19px; }
      .text-link { color: var(--brand); text-decoration: none; font-weight: 600; min-height: 44px; display: inline-flex; align-items: center; }

      .why-grid { display: grid; gap: 14px; align-items: center; }
      .why-grid img { width: 100%; border-radius: 12px; aspect-ratio: 4/5; object-fit: cover; }
      .checklist { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
      .checklist li { color: var(--muted); }

      .projects-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .projects-grid img { width: 100%; display: block; border-radius: 10px; object-fit: cover; aspect-ratio: 1/1; }

      .reviews-grid { display: grid; gap: 10px; }
      .review-card {
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 4px 14px rgba(17, 24, 39, 0.04);
      }
      .review-card p { color: #303a4f; margin-bottom: 8px; }
      .review-card span { color: var(--muted); font-size: 13px; }

      .estimate-grid { display: grid; gap: 14px; }
      .mock-form {
        border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: grid; gap: 10px;
      }
      .mock-row { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
      .mock-input {
        background: #f7f9fc; border: 1px solid var(--line); border-radius: 8px; padding: 10px; min-height: 42px; color: var(--muted);
      }
      .map-box img { width: 100%; border-radius: 10px; aspect-ratio: 16/10; object-fit: cover; }

      .cta-band {
        background: var(--dark); color: #fff; border-radius: 14px; padding: 26px 18px;
        text-align: center; display: grid; gap: 10px;
      }
      .cta-band p { color: rgba(255,255,255,0.78); }
      .cta-actions { display: flex; flex-direction: column; gap: 8px; justify-content: center; }
      .cta-actions .btn-secondary { background: transparent; color: #fff; border-color: rgba(255,255,255,0.28); }

      .site-footer {
        border-top: 1px solid var(--line);
        padding: 22px 0 28px;
        background: #f0f2f7;
      }
      .footer-grid { display: grid; gap: 12px; font-size: 14px; color: var(--muted); }
      .footer-grid strong { color: var(--ink); display: block; margin-bottom: 2px; }

      @media (min-width: 768px) {
        .container { width: min(1140px, 100% - 32px); }
        .menu-button { display: none; }
        .nav-links {
          position: static; display: flex; flex-direction: row; gap: 8px; background: transparent;
          width: auto; border: 0; padding: 0;
        }
        .nav-cta { margin-left: 6px; }
        .btn-row { flex-direction: row; }
        .trust-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .services-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .why-grid { grid-template-columns: 1fr 0.9fr; }
        .projects-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .reviews-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .estimate-grid { grid-template-columns: 1fr 1fr; }
        .cta-actions { flex-direction: row; }
        .footer-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <header class="site-header">
      <div class="container nav-wrap">
        <a class="brand" href="#" aria-label="${input.businessName} home">${input.businessName}</a>
        <div class="nav-right">
          <button class="menu-button" aria-label="Toggle navigation menu" aria-expanded="false" aria-controls="site-nav" id="menuButton">Menu</button>
          <nav aria-label="Primary">
            <ul class="nav-links" id="site-nav">
              <li><a href="#services">Services</a></li>
              <li><a href="#projects">Projects</a></li>
              <li><a href="#reviews">Reviews</a></li>
              <li><a href="#contact">Contact</a></li>
            </ul>
          </nav>
          <a class="nav-cta" href="#contact">Free Quote</a>
        </div>
      </div>
    </header>

    <main class="container">
      <section class="hero">
        <div class="hero-media">
          <img src="{{HERO_IMAGE_URL}}" alt="Roofing team working on a residential project" />
        </div>
        <div class="hero-copy">
          <p class="eyebrow">${displayNiche} in ${cityLabel}</p>
          <h1 id="businessName">Protect Your Home with Expert Roofing Solutions</h1>
          <p id="heroSummary">${primarySummary}</p>
          <div class="trust-badges">${trustBadges}</div>
          <div class="btn-row">
            <a class="btn btn-primary" href="#contact">Get Free Estimate</a>
            <a class="btn btn-secondary" href="tel:${phoneHref}">Call Now</a>
          </div>
        </div>
      </section>

      <section class="trust-strip">
        <article class="trust-card"><span class="trust-dot">★</span><div><strong>4.9/5 Rating</strong><span>Trusted by homeowners across ${cityLabel}</span></div></article>
        <article class="trust-card"><span class="trust-dot">✓</span><div><strong>Licensed & Insured</strong><span>Code-compliant and safety-first project delivery</span></div></article>
        <article class="trust-card"><span class="trust-dot">⚡</span><div><strong>Fast Turnarounds</strong><span>Clear timelines with consistent updates</span></div></article>
      </section>

      <section class="section" id="services">
        <div class="section-head">
          <p class="eyebrow">Our Services</p>
          <h2>Comprehensive Roofing Solutions</h2>
        </div>
        <div class="services-grid" id="servicesGrid">${servicesMarkup}</div>
      </section>

      <section class="section">
        <div class="why-grid">
          <article>
            <div class="section-head">
              <p class="eyebrow">About Us</p>
              <h2 id="aboutHeadline">${aboutHeadline}</h2>
            </div>
            <p id="aboutBio">${aboutBio}</p>
            <ul class="checklist">${trustPoints}</ul>
            <p id="businessAddress" style="margin-top:10px;">Based in ${cityLabel}, serving nearby neighborhoods and surrounding suburbs.</p>
            ${sourceHost ? `<p style="margin-top:8px;">Source profile: ${sourceHost}</p>` : ""}
          </article>
          <div>
            <img src="{{SERVICE_IMAGE_URL_1}}" alt="Professional roofing team at work" loading="lazy" />
          </div>
        </div>
      </section>

      <section class="section" id="projects">
        <div class="section-head">
          <p class="eyebrow">Recent Projects</p>
          <h2>Built for Durability and Curb Appeal</h2>
        </div>
        <div class="projects-grid">
          <img src="{{SERVICE_IMAGE_URL_1}}" alt="Roof project gallery item 1" loading="lazy" />
          <img src="{{SERVICE_IMAGE_URL_2}}" alt="Roof project gallery item 2" loading="lazy" />
          <img src="{{SERVICE_IMAGE_URL_3}}" alt="Roof project gallery item 3" loading="lazy" />
          <img src="{{SERVICE_IMAGE_URL_2}}" alt="Roof project gallery item 4" loading="lazy" />
        </div>
      </section>

      <section class="section" id="reviews">
        <div class="section-head">
          <p class="eyebrow">Testimonials</p>
          <h2>What Our Customers Say</h2>
        </div>
        <div class="reviews-grid" id="testimonialsGrid">${testimonialsMarkup}</div>
      </section>

      <section class="section" id="contact">
        <div class="section-head">
          <p class="eyebrow">Get In Touch</p>
          <h2>Get Your Free Estimate</h2>
        </div>
        <div class="estimate-grid">
          <div class="mock-form">
            <div class="mock-row">
              <div class="mock-input">Full Name</div>
              <div class="mock-input">Phone</div>
            </div>
            <div class="mock-row">
              <div class="mock-input">Email</div>
              <div class="mock-input">Address</div>
            </div>
            <div class="mock-input">Tell us about your project</div>
            <a class="btn btn-primary" href="tel:${phoneHref}">Request Estimate</a>
          </div>
          <div class="mock-form">
            <p><strong>Contact Information</strong></p>
            <p>Phone: <span id="businessPhone">${input.phone ?? "555-000-0000"}</span></p>
            <p>Email: <span id="businessEmail">${input.email ?? "hello@example.com"}</span></p>
            <p>Hours: <span id="businessHours">Mon-Fri 8:00 AM - 6:00 PM</span></p>
            <div class="map-box">
              <img src="{{SERVICE_IMAGE_URL_3}}" alt="Service area map placeholder" loading="lazy" />
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band">
        <h2>Ready to Protect Your Home?</h2>
        <p>Schedule your free estimate and get a clear plan for your project.</p>
        <div class="cta-actions">
          <a class="btn btn-primary" href="#contact">Schedule Estimate</a>
          <a class="btn btn-secondary" href="tel:${phoneHref}">Call ${input.phone ?? "Now"}</a>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div class="container footer-grid">
        <div>
          <strong>${input.businessName}</strong>
          <span>${input.city}</span>
        </div>
        <div>
          <strong>Contact</strong>
          <span>${input.phone ?? "555-000-0000"}</span>
        </div>
        <div>
          <strong>Email</strong>
          <span>${input.email ?? "hello@example.com"}</span>
        </div>
        <div>
          <strong>Hours</strong>
          <span>Mon-Fri 8:00 AM - 6:00 PM</span>
        </div>
      </div>
    </footer>

    <script>
      (function () {
        const SHEET_DATA_URL = ${sheetDataUrlLiteral};
        const button = document.getElementById("menuButton");
        const nav = document.getElementById("site-nav");
        if (!button || !nav) return;

        button.addEventListener("click", function () {
          const isOpen = nav.classList.toggle("open");
          button.setAttribute("aria-expanded", isOpen ? "true" : "false");
        });

        nav.querySelectorAll("a").forEach(function (link) {
          link.addEventListener("click", function () {
            nav.classList.remove("open");
            button.setAttribute("aria-expanded", "false");
          });
        });

        const getValue = (obj, keys) => {
          for (const key of keys) {
            const val = obj && typeof obj[key] === "string" ? obj[key] : "";
            if (val) return val;
          }
          return "";
        };

        const escapeHtml = (str) =>
          String(str)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");

        const applySheetData = (data) => {
          const business = data && typeof data.business === "object" ? data.business : {};
          const services = Array.isArray(data && data.services) ? data.services : [];
          const about = data && typeof data.about === "object" ? data.about : {};
          const testimonials = Array.isArray(data && data.testimonials) ? data.testimonials : [];

          const businessName = getValue(business, ["name", "businessName", "Business Name"]);
          const phone = getValue(business, ["phone", "Phone", "phone_number"]);
          const email = getValue(business, ["email", "Email"]);
          const hours = getValue(business, ["hours", "Hours", "openingHours"]);
          const address = getValue(business, ["address", "Address"]);

          if (businessName) {
            const heading = document.getElementById("businessName");
            if (heading) heading.textContent = businessName;
            document.title = businessName + " | ${displayNiche} in ${cityLabel}";
          }
          if (phone) {
            const phoneEl = document.getElementById("businessPhone");
            if (phoneEl) phoneEl.textContent = phone;
          }
          if (email) {
            const emailEl = document.getElementById("businessEmail");
            if (emailEl) emailEl.textContent = email;
          }
          if (hours) {
            const hoursEl = document.getElementById("businessHours");
            if (hoursEl) hoursEl.textContent = hours;
          }
          if (address) {
            const addressEl = document.getElementById("businessAddress");
            if (addressEl) addressEl.textContent = address;
          }

          const headline = getValue(about, ["headline", "Headline", "title"]);
          const bio = getValue(about, ["bio", "Bio", "description"]);
          const photoUrl = getValue(about, ["photo URL", "photoUrl", "photo", "image"]);
          if (headline) {
            const aboutHeadlineEl = document.getElementById("aboutHeadline");
            if (aboutHeadlineEl) aboutHeadlineEl.textContent = headline;
          }
          if (bio) {
            const aboutBioEl = document.getElementById("aboutBio");
            if (aboutBioEl) aboutBioEl.textContent = bio;
          }
          if (photoUrl) {
            const heroImg = document.querySelector(".hero-media img");
            if (heroImg) heroImg.setAttribute("src", photoUrl);
          }

          if (services.length > 0) {
            const servicesGrid = document.getElementById("servicesGrid");
            if (servicesGrid) {
              const cards = services.slice(0, 3).map((service, i) => {
                const name = getValue(service, ["name", "service", "title"]) || "Service";
                const price = getValue(service, ["price", "Price"]);
                const description = getValue(service, ["description", "Description"]) || "Quality service for local customers.";
                const detail = price ? description + " — " + price : description;
                const image = i === 0 ? "{{SERVICE_IMAGE_URL_1}}" : i === 1 ? "{{SERVICE_IMAGE_URL_2}}" : "{{SERVICE_IMAGE_URL_3}}";
                return '<article class="service-card"><img src="' + image + '" alt="' + escapeHtml(name) + ' project" loading="lazy" /><div class="service-copy"><p class="chip">Service ' + (i + 1) + '</p><h3>' + escapeHtml(name) + '</h3><p>' + escapeHtml(detail) + '</p><a href="#contact" class="text-link">Learn More</a></div></article>';
              }).join("");
              servicesGrid.innerHTML = cards;
            }
          }

          if (testimonials.length > 0) {
            const testimonialsGrid = document.getElementById("testimonialsGrid");
            if (testimonialsGrid) {
              const items = testimonials.slice(0, 3).map((entry) => {
                const review = getValue(entry, ["review", "Review"]) || "Great service and communication.";
                return '<article class="review-card"><p>"' + escapeHtml(review) + '"</p><span>Verified Local Client</span></article>';
              }).join("");
              testimonialsGrid.innerHTML = items;
            }
          }
        };

        if (SHEET_DATA_URL) {
          fetch(SHEET_DATA_URL)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySheetData(data);
            })
            .catch(() => {
              // Keep fallback content if external sheet fetch fails.
            });
        }
      })();
    </script>
  </body>
</html>`;
};

const writeZip = async (zipPath: string, files: Record<string, string>): Promise<void> => {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, content]) => {
    zip.file(name, content);
  });

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(zipPath, buffer);
};

const fakeOpenClawClient: OpenClawClient = {
  async generateSite(input: GenerateSiteInput): Promise<GenerateSiteOutput> {
    const safeLeadId = sanitizeFileSegment(input.leadId);
    const zipPath = path.join("/tmp", `${safeLeadId}.zip`);
    const aiCopy = await generateAICopy(input);

    const files = {
      "index.html": buildIndexHtml(input, aiCopy)
    };

    await writeZip(zipPath, files);

    return {
      zipPath,
      summary: aiCopy
        ? `Generated AI-personalized site bundle for ${input.businessName}`
        : `Generated MVP static site bundle for ${input.businessName}`
    };
  }
};

const openClawClient: OpenClawClient = fakeOpenClawClient;

const processSiteJob = async (job: Job<SiteJob>): Promise<void> => {
  const { leadId } = job.data;
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { campaign: true }
  });

  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  const campaignId = lead.campaignId;
  const servicesFromEvents = await prisma.event.findMany({
    where: {
      campaignId,
      leadId,
      type: EventType.LEAD_ENRICHED
    },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { metadata: true }
  });

  const latestMetadata = servicesFromEvents[0]?.metadata as
    | { serviceKeywords?: unknown; claims?: unknown; brandColors?: unknown; summary?: unknown }
    | undefined;
  const services = Array.isArray(latestMetadata?.serviceKeywords)
    ? latestMetadata.serviceKeywords.filter((item): item is string => typeof item === "string")
    : [];
  const claims = Array.isArray(latestMetadata?.claims)
    ? latestMetadata.claims.filter((item): item is string => typeof item === "string")
    : [];
  const brandColors = Array.isArray(latestMetadata?.brandColors)
    ? latestMetadata.brandColors.filter((item): item is string => typeof item === "string")
    : [];
  const summary = typeof latestMetadata?.summary === "string" ? latestMetadata.summary : "";

  const campaignConfigEvent = await prisma.event.findFirst({
    where: {
      campaignId,
      type: EventType.CAMPAIGN_CREATED
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true }
  });
  const campaignConfig = campaignConfigEvent?.metadata as
    | { sheetDataUrl?: unknown; mode?: unknown }
    | undefined;
  const sheetDataUrl =
    typeof campaignConfig?.sheetDataUrl === "string"
      ? campaignConfig.sheetDataUrl
      : null;
  const sourceMode =
    typeof campaignConfig?.mode === "string"
      ? campaignConfig.mode
      : null;

  const output = await openClawClient.generateSite({
    leadId: lead.id,
    businessName: lead.businessName ?? "Local Contractor",
    city: lead.campaign.city,
    niche: lead.campaign.niche,
    sourceMode,
    websiteUrl: lead.websiteUrl,
    services,
    claims,
    brandColors,
    summary,
    sheetDataUrl,
    phone: lead.phone,
    email: lead.email
  });

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status: LeadStatus.SITE_GENERATED,
      lastError: null
    }
  });

  await prisma.event.create({
    data: {
      campaignId,
      leadId: lead.id,
      type: EventType.SITE_GENERATED,
      metadata: {
        zipPath: output.zipPath,
        summary: output.summary
      }
    }
  });

  await enqueueImage({ leadId: lead.id });
  logMessage(campaignId, lead.id, `site generated at ${output.zipPath}`);
};

export const siteGeneratorWorker = new Worker<SiteJob>("site", processSiteJob, {
  connection,
  concurrency: workerConcurrency
});

siteGeneratorWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

siteGeneratorWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
