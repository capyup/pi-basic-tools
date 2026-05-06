// Portions adapted from pi-better-openai (MIT License, Copyright (c) 2026).
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  calculateImageRows,
  getCapabilities,
  getCellDimensions,
  Image,
  imageFallback,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  codexHome,
  describeCodexPetSelectionIssue,
  findReadyCodexPet,
  formatCodexPetsHelp,
  formatCodexPetsListMessage,
  formatPetSelectPrompt,
  listCodexPets,
  petsArgumentCompletions,
  PET_STATES,
  resolvePetAssetPath,
  type CodexPetPackage,
  type PetState,
} from "./pet-core.ts";

const PETS_COMMAND = "pets";
const PET_COLUMNS = 8;
const PET_ROWS = 9;
const DEFAULT_CELL_WIDTH = 192;
const DEFAULT_CELL_HEIGHT = 208;
const PET_FOOTER_IMAGE_ID = 0x51000000;
const SETTINGS_PATH = path.join(getAgentDir(), "basic-tools-pets.json");

export const PET_ANIMATION_ROWS: Record<PetState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export type PetFrame = {
  data?: string;
  rawRgbaData?: string;
  kittyImageId?: number;
  kittyUploaded?: boolean;
  mimeType: "image/png";
  durationMs: number;
  widthPx: number;
  heightPx: number;
};

export type LoadedCodexPet = {
  pet: CodexPetPackage;
  states: Record<PetState, PetFrame[]>;
};

type ThemeLike = {
  fg(color: string, value: string): string;
};

type PetSettings = {
  enabled?: boolean;
  slug?: string;
  state?: PetState;
  thinkingState?: PetState;
  toolState?: PetState;
  failedToolState?: PetState;
  sizeCells?: number;
};

const DEFAULT_PET_SETTINGS: Required<PetSettings> = {
  enabled: false,
  slug: "",
  state: "idle",
  thinkingState: "review",
  toolState: "running",
  failedToolState: "failed",
  sizeCells: 10,
};

function isPetState(value: unknown): value is PetState {
  return typeof value === "string" && (PET_STATES as readonly string[]).includes(value);
}

function normalizePetSettings(value: unknown): Required<PetSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PET_SETTINGS };
  const record = value as Record<string, unknown>;
  const sizeCells =
    typeof record.sizeCells === "number" && Number.isFinite(record.sizeCells)
      ? Math.round(record.sizeCells)
      : DEFAULT_PET_SETTINGS.sizeCells;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_PET_SETTINGS.enabled,
    slug: typeof record.slug === "string" ? record.slug.trim() : DEFAULT_PET_SETTINGS.slug,
    state: isPetState(record.state) ? record.state : DEFAULT_PET_SETTINGS.state,
    thinkingState: isPetState(record.thinkingState)
      ? record.thinkingState
      : DEFAULT_PET_SETTINGS.thinkingState,
    toolState: isPetState(record.toolState) ? record.toolState : DEFAULT_PET_SETTINGS.toolState,
    failedToolState: isPetState(record.failedToolState)
      ? record.failedToolState
      : DEFAULT_PET_SETTINGS.failedToolState,
    sizeCells: Math.max(4, Math.min(24, sizeCells)),
  };
}

async function loadPetSettings(): Promise<Required<PetSettings>> {
  try {
    return normalizePetSettings(JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as unknown);
  } catch {
    return { ...DEFAULT_PET_SETTINGS };
  }
}

async function savePetSettings(settings: Required<PetSettings>): Promise<void> {
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function kittyImageBaseForPet(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 0xffff;
  return 0x50000000 + hash * 100;
}

export async function loadCodexPet(
  slug?: string,
  home = codexHome(),
  options: { sizeCells?: number } = {},
): Promise<LoadedCodexPet | undefined> {
  const pet = findReadyCodexPet(await listCodexPets(home), slug);
  if (!pet) return undefined;

  const spritesheetPath = resolvePetAssetPath(pet.dir, pet.spritesheetPath);
  if (!spritesheetPath)
    throw new Error(`Invalid spritesheetPath outside pet folder: ${pet.spritesheetPath}`);

  const source = sharp(spritesheetPath, { animated: false });
  const metadata = await source.metadata();
  if (
    metadata.width !== DEFAULT_CELL_WIDTH * PET_COLUMNS ||
    metadata.height !== DEFAULT_CELL_HEIGHT * PET_ROWS
  ) {
    throw new Error(
      `Invalid Codex pet atlas dimensions: ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${DEFAULT_CELL_WIDTH * PET_COLUMNS}x${DEFAULT_CELL_HEIGHT * PET_ROWS}.`,
    );
  }

  const states = {} as Record<PetState, PetFrame[]>;
  const imageProtocol = getCapabilities().images;
  const useKitty = imageProtocol === "kitty";
  const kittyImageBase = kittyImageBaseForPet(pet.slug);
  let kittyFrameOffset = 1;
  const cellDimensions = getCellDimensions();
  const targetWidthPx = options.sizeCells
    ? Math.max(1, Math.round(options.sizeCells * cellDimensions.widthPx))
    : undefined;
  const targetHeightPx = targetWidthPx
    ? Math.max(
        1,
        Math.ceil((DEFAULT_CELL_HEIGHT * targetWidthPx) / DEFAULT_CELL_WIDTH / cellDimensions.heightPx) *
          cellDimensions.heightPx,
      )
    : undefined;

  for (const [state, animation] of Object.entries(PET_ANIMATION_ROWS) as Array<
    [PetState, (typeof PET_ANIMATION_ROWS)[PetState]]
  >) {
    states[state] = [];
    for (let column = 0; column < animation.durations.length; column++) {
      const durationMs = animation.durations[column] ?? 150;
      const frameWidthPx = targetWidthPx ?? DEFAULT_CELL_WIDTH;
      const frameHeightPx = targetHeightPx ?? DEFAULT_CELL_HEIGHT;
      if (!imageProtocol) {
        states[state].push({
          mimeType: "image/png",
          durationMs,
          widthPx: frameWidthPx,
          heightPx: frameHeightPx,
        });
        continue;
      }

      let frame = source.clone().extract({
        left: column * DEFAULT_CELL_WIDTH,
        top: animation.row * DEFAULT_CELL_HEIGHT,
        width: DEFAULT_CELL_WIDTH,
        height: DEFAULT_CELL_HEIGHT,
      });
      if (targetWidthPx && targetHeightPx) {
        frame = frame.resize(targetWidthPx, targetHeightPx, {
          fit: "fill",
          kernel: sharp.kernel.nearest,
        });
      }
      const encoded = useKitty
        ? { rawRgbaData: (await frame.clone().ensureAlpha().raw().toBuffer()).toString("base64") }
        : { data: (await frame.clone().png().toBuffer()).toString("base64") };
      states[state].push({
        ...encoded,
        kittyImageId: useKitty ? kittyImageBase + kittyFrameOffset++ : undefined,
        mimeType: "image/png",
        durationMs,
        widthPx: frameWidthPx,
        heightPx: frameHeightPx,
      });
    }
  }

  return { pet, states };
}

function animationCursor(frames: PetFrame[], now = Date.now(), durationMultiplier = 1) {
  const multiplier = Math.max(0.1, durationMultiplier);
  const total = frames.reduce((sum, frame) => sum + frame.durationMs * multiplier, 0);
  return { multiplier, total, cursor: total > 0 ? now % total : 0 };
}

export function animationFrameAt(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): PetFrame | undefined {
  if (frames.length === 0) return undefined;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    cursor -= frame.durationMs * multiplier;
    if (cursor < 0) return frame;
  }
  return frames[0];
}

export function nextAnimationFrameDelayMs(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): number {
  if (frames.length === 0) return 120;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    const duration = frame.durationMs * multiplier;
    if (cursor < duration) return Math.max(1, Math.ceil(duration - cursor));
    cursor -= duration;
  }
  return Math.max(1, Math.ceil(frames[0]?.durationMs ?? 120));
}

const previousKittyFrameByPlacement = new Map<number, number>();

export function resetCodexPetKittyCache(pet?: LoadedCodexPet, placementImageId?: number): void {
  if (placementImageId !== undefined) previousKittyFrameByPlacement.delete(placementImageId);
  if (!pet) return;
  for (const frames of Object.values(pet.states)) {
    for (const frame of frames) frame.kittyUploaded = false;
  }
}

export function deleteCodexPetKittyPlacement(imageId: number): string {
  return `\x1b_Ga=d,d=i,i=${imageId},p=1,q=2\x1b\\`;
}

function placeKittyImage(imageId: number, columns: number, rows: number): string {
  return `\x1b_Ga=p,i=${imageId},p=1,c=${columns},r=${rows},q=2,C=1\x1b\\`;
}

function encodeKittyRawRgba(frame: PetFrame, imageId: number): string {
  const rawRgbaData = frame.rawRgbaData;
  if (!rawRgbaData) return "";
  const chunkSize = 4096;
  const params = [
    "a=t",
    "f=32",
    `s=${frame.widthPx}`,
    `v=${frame.heightPx}`,
    `i=${imageId}`,
    "q=2",
  ];
  if (rawRgbaData.length <= chunkSize) {
    return `\x1b_G${params.join(",")};${rawRgbaData}\x1b\\`;
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < rawRgbaData.length; offset += chunkSize) {
    const chunk = rawRgbaData.slice(offset, offset + chunkSize);
    const first = offset === 0;
    const last = offset + chunkSize >= rawRgbaData.length;
    if (first) chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
    else chunks.push(`\x1b_Gm=${last ? 0 : 1};${chunk}\x1b\\`);
  }
  return chunks.join("");
}

function renderKittyPetFrame(
  frame: PetFrame,
  width: number,
  options: { sizeCells: number; imageId: number },
): string[] {
  const columns = Math.max(1, Math.min(Math.max(1, width - 2), options.sizeCells));
  const rows = calculateImageRows(
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
    columns,
    getCellDimensions(),
  );
  const frameImageId = frame.kittyImageId ?? options.imageId;
  const previousFrameImageId = previousKittyFrameByPlacement.get(options.imageId);
  const deletePrevious =
    previousFrameImageId !== undefined && previousFrameImageId !== frameImageId
      ? deleteCodexPetKittyPlacement(previousFrameImageId)
      : "";
  const deleteCurrent = deleteCodexPetKittyPlacement(frameImageId);
  const upload = frame.kittyUploaded ? "" : encodeKittyRawRgba(frame, frameImageId);
  frame.kittyUploaded = true;
  previousKittyFrameByPlacement.set(options.imageId, frameImageId);
  const sequence = `${deletePrevious}${deleteCurrent}${upload}${placeKittyImage(frameImageId, columns, rows)}`;
  const lines: string[] = [];
  for (let i = 0; i < rows - 1; i++) lines.push("");
  const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
  const moveDown = rows > 1 ? `\x1b[${rows - 1}B` : "";
  lines.push(moveUp + sequence + moveDown);
  return lines;
}

export function renderCodexPetFrame(
  pet: LoadedCodexPet,
  state: PetState,
  width: number,
  theme: ThemeLike,
  options: { sizeCells: number; imageId: number; now?: number; durationMultiplier?: number },
): string[] {
  const frame = animationFrameAt(
    pet.states[state] ?? pet.states.idle,
    options.now,
    options.durationMultiplier,
  );
  if (!frame) return [];
  const imageProtocol = getCapabilities().images;
  if (imageProtocol === "kitty") return renderKittyPetFrame(frame, width, options);
  if (!imageProtocol) {
    const fallback = imageFallback(frame.mimeType, {
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
    });
    return [truncateToWidth(theme.fg("dim", fallback), width, theme.fg("dim", "..."))];
  }

  if (!frame.data) return [];
  const imageTheme = { fallbackColor: (value: string) => theme.fg("dim", value) };
  const image = new Image(
    frame.data,
    frame.mimeType,
    imageTheme,
    { maxWidthCells: Math.min(options.sizeCells, width), imageId: options.imageId },
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
  );
  return image.render(width);
}

async function notifyPetsList(ctx: ExtensionContext): Promise<void> {
  const home = codexHome();
  const pets = await listCodexPets(home);
  ctx.ui.notify(
    formatCodexPetsListMessage(pets, home),
    pets.some((pet) => pet.hasSpritesheet) ? "info" : "warning",
  );
}

export function registerPetsCommand(pi: ExtensionAPI): void {
  let settingsCache = { ...DEFAULT_PET_SETTINGS };
  let pet: LoadedCodexPet | undefined;
  let petError: string | undefined;
  let footerInstalled = false;
  let requestFooterRender: (() => void) | undefined;
  let animationTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeState: PetState = settingsCache.state;
  let flashState: PetState | undefined;
  const activeToolCallIds = new Set<string>();

  function currentPetState(): PetState {
    return flashState ?? runtimeState ?? settingsCache.state;
  }

  function stopAnimation(): void {
    if (animationTimer) clearTimeout(animationTimer);
    animationTimer = undefined;
  }

  function scheduleAnimation(ctx: ExtensionContext): void {
    stopAnimation();
    if (!footerInstalled || !pet || !settingsCache.enabled) return;
    const frames = pet.states[currentPetState()] ?? pet.states.idle;
    const delay = Math.min(500, Math.max(50, nextAnimationFrameDelayMs(frames)));
    animationTimer = setTimeout(() => {
      requestFooterRender?.();
      scheduleAnimation(ctx);
    }, delay);
  }

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      requestFooterRender?.();
      scheduleAnimation(ctx);
      return;
    }

    footerInstalled = true;
    ctx.ui.setFooter((tui, theme) => {
      requestFooterRender = () => tui.requestRender();
      return {
        dispose: () => {
          footerInstalled = false;
          requestFooterRender = undefined;
          stopAnimation();
        },
        invalidate() {
          resetCodexPetKittyCache(pet, PET_FOOTER_IMAGE_ID);
        },
        render(width: number): string[] {
          if (!settingsCache.enabled) return [];
          if (petError) {
            return [
              truncateToWidth(theme.fg("warning", `pet: ${petError}`), width, theme.fg("warning", "...")),
            ];
          }
          if (!pet) return [theme.fg("dim", "pet loading...")];

          const renderWidth = Math.max(1, Math.min(width, settingsCache.sizeCells));
          const lines = renderCodexPetFrame(pet, currentPetState(), renderWidth, theme, {
            sizeCells: renderWidth,
            imageId: PET_FOOTER_IMAGE_ID,
            now: Date.now(),
            durationMultiplier: 1,
          });
          const label = truncateToWidth(
            theme.fg("dim", `pet ${pet.pet.name}`),
            width,
            theme.fg("dim", "..."),
          );
          return lines.length > 0 ? [...lines, label] : [label];
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    stopAnimation();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = undefined;
    flashState = undefined;
    resetCodexPetKittyCache(pet, PET_FOOTER_IMAGE_ID);
    pet = undefined;
    petError = undefined;
    if (footerInstalled) ctx.ui.setFooter(undefined);
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  async function writePetSettings(patch: PetSettings): Promise<Required<PetSettings>> {
    settingsCache = normalizePetSettings({ ...settingsCache, ...patch });
    await savePetSettings(settingsCache);
    return settingsCache;
  }

  async function refreshPet(
    ctx: ExtensionContext,
    settings = settingsCache,
    notify = false,
  ): Promise<void> {
    if (!settings.enabled) return;
    try {
      pet = await loadCodexPet(settings.slug || undefined, codexHome(), {
        sizeCells: settings.sizeCells,
      });
      if (!pet) {
        const pets = await listCodexPets();
        const issue = describeCodexPetSelectionIssue(pets, settings.slug || undefined);
        petError = issue.short;
        ctx.ui.notify(issue.message, "warning");
        installFooter(ctx);
        requestFooterRender?.();
        return;
      }

      petError = undefined;
      installFooter(ctx);
      requestFooterRender?.();
      scheduleAnimation(ctx);
      if (notify) ctx.ui.notify(`Rendering ${pet.pet.name} in the pi-basic-tools footer.`, "info");
    } catch (error) {
      pet = undefined;
      petError = error instanceof Error ? error.message : String(error);
      installFooter(ctx);
      requestFooterRender?.();
      ctx.ui.notify(`Could not render Codex pet: ${petError}`, "warning");
    }
  }

  function setRuntimeState(ctx: ExtensionContext, state: PetState): void {
    runtimeState = state;
    requestFooterRender?.();
    scheduleAnimation(ctx);
  }

  function playFlash(ctx: ExtensionContext, state: PetState): void {
    flashState = state;
    requestFooterRender?.();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashState = undefined;
      requestFooterRender?.();
      scheduleAnimation(ctx);
    }, 1200);
  }

  pi.registerCommand(PETS_COMMAND, {
    description: "Render, select, or list Codex pets from ${CODEX_HOME:-~/.codex}/pets",
    getArgumentCompletions: petsArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const normalized = subcommand.toLowerCase();
      const slug = rest.join(" ").trim() || undefined;

      if (normalized === "help") {
        ctx.ui.notify(formatCodexPetsHelp(), "info");
        return;
      }
      if (normalized === "list") {
        await notifyPetsList(ctx);
        return;
      }
      if (normalized === "wake") {
        const pets = await listCodexPets();
        const requestedSlug = (slug ?? settingsCache.slug) || undefined;
        const selectedPet = findReadyCodexPet(pets, requestedSlug);
        if (!selectedPet) {
          const issue = describeCodexPetSelectionIssue(pets, requestedSlug);
          ctx.ui.notify(issue.message, "warning");
          return;
        }

        const next = await writePetSettings({ enabled: true, slug: selectedPet.slug });
        await refreshPet(ctx, next, true);
        return;
      }
      if (normalized === "tuck") {
        await writePetSettings({ enabled: false });
        clearFooter(ctx);
        ctx.ui.notify("Footer pet tucked away.", "info");
        return;
      }
      if (normalized === "select") {
        const pets = await listCodexPets();
        if (!slug) {
          const prompt = formatPetSelectPrompt(pets);
          ctx.ui.notify(prompt.message, prompt.level);
          return;
        }

        const selectedPet = findReadyCodexPet(pets, slug);
        if (!selectedPet) {
          const issue = describeCodexPetSelectionIssue(pets, slug);
          ctx.ui.notify(issue.message, "warning");
          return;
        }

        const next = await writePetSettings({ slug: selectedPet.slug });
        if (next.enabled) await refreshPet(ctx, next, true);
        else {
          ctx.ui.notify(
            `Selected ${selectedPet.name} (${selectedPet.slug}) for the footer pet. Use /pets wake to show it.`,
            "info",
          );
        }
        return;
      }

      ctx.ui.notify(`Usage: /${PETS_COMMAND} [help|list|wake [slug]|tuck|select <slug>]`, "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    settingsCache = await loadPetSettings();
    runtimeState = settingsCache.state;
    if (settingsCache.enabled) await refreshPet(ctx, settingsCache);
  });

  pi.on("agent_start", (_event, ctx) => {
    activeToolCallIds.clear();
    flashState = undefined;
    setRuntimeState(ctx, settingsCache.thinkingState);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolCallIds.add(event.toolCallId);
    setRuntimeState(ctx, settingsCache.toolState);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeToolCallIds.delete(event.toolCallId);
    if (event.isError) {
      playFlash(ctx, settingsCache.failedToolState);
      return;
    }
    setRuntimeState(ctx, activeToolCallIds.size > 0 ? settingsCache.toolState : settingsCache.thinkingState);
  });

  pi.on("agent_end", (_event, ctx) => {
    activeToolCallIds.clear();
    setRuntimeState(ctx, settingsCache.state);
  });

  pi.on("session_shutdown", () => {
    stopAnimation();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = undefined;
    activeToolCallIds.clear();
    resetCodexPetKittyCache(pet, PET_FOOTER_IMAGE_ID);
    pet = undefined;
    petError = undefined;
  });
}
