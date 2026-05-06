// Portions adapted from pi-better-openai (MIT License, Copyright (c) 2026).
import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type PetState = (typeof PET_STATES)[number];

export type AutocompleteItem = {
  value: string;
  label?: string;
  description?: string;
};

export type CodexPetPackage = {
  slug: string;
  id?: string;
  name: string;
  description?: string;
  dir: string;
  spritesheetPath: string;
  hasSpritesheet: boolean;
};

export type CodexPetSelectionIssue = {
  short: string;
  message: string;
};

const PETS_COMMAND = "pets";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function codexHome(env = process.env, home = homedir()): string {
  return env.CODEX_HOME?.trim() || join(home, ".codex");
}

export function codexPetsDir(home = codexHome()): string {
  return join(home, "pets");
}

export function petInfoFromJson(
  value: unknown,
  fallback: string,
): { id?: string; name: string; description?: string; spritesheetPath: string } {
  if (!isRecord(value)) return { name: fallback, spritesheetPath: "spritesheet.webp" };
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined;
  const displayName =
    typeof value.displayName === "string" && value.displayName.trim()
      ? value.displayName.trim()
      : undefined;
  const name =
    displayName ??
    (typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined) ??
    id ??
    fallback;
  const description =
    typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : undefined;
  const spritesheetPath =
    typeof value.spritesheetPath === "string" && value.spritesheetPath.trim()
      ? value.spritesheetPath.trim()
      : "spritesheet.webp";
  return { id, name, description, spritesheetPath };
}

export function resolvePetAssetPath(petDir: string, path: string): string | undefined {
  const resolvedPetDir = resolve(petDir);
  const resolved = resolve(resolvedPetDir, path);
  const prefix = resolvedPetDir.endsWith(sep) ? resolvedPetDir : `${resolvedPetDir}${sep}`;
  return resolved === resolvedPetDir || resolved.startsWith(prefix) ? resolved : undefined;
}

export async function listCodexPets(home = codexHome()): Promise<CodexPetPackage[]> {
  const dir = codexPetsDir(home);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const pets: CodexPetPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const petDir = join(dir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8")) as unknown;
    } catch {
      continue;
    }

    const { id, name, description, spritesheetPath } = petInfoFromJson(parsed, entry.name);
    let hasSpritesheet = false;
    try {
      const resolvedSpritesheetPath = resolvePetAssetPath(petDir, spritesheetPath);
      if (resolvedSpritesheetPath) {
        await access(resolvedSpritesheetPath);
        hasSpritesheet = true;
      }
    } catch {
      hasSpritesheet = false;
    }

    pets.push({
      slug: entry.name,
      id,
      name,
      description,
      dir: petDir,
      spritesheetPath,
      hasSpritesheet,
    });
  }

  return pets.sort((a, b) => a.name.localeCompare(b.name));
}

function petLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function petMatchesLookup(pet: CodexPetPackage, requested: string): boolean {
  return (
    petLookupKey(pet.slug) === requested ||
    (pet.id !== undefined && petLookupKey(pet.id) === requested) ||
    petLookupKey(pet.name) === requested
  );
}

export function findCodexPet(pets: CodexPetPackage[], value?: string): CodexPetPackage | undefined {
  const requested = value?.trim() ? petLookupKey(value.trim()) : "";
  if (!requested) return undefined;
  return pets.find((pet) => petMatchesLookup(pet, requested));
}

export function findReadyCodexPet(
  pets: CodexPetPackage[],
  value?: string,
): CodexPetPackage | undefined {
  const ready = pets.filter((pet) => pet.hasSpritesheet);
  if (!value?.trim()) return ready[0];
  const requested = petLookupKey(value.trim());
  return ready.find((pet) => petMatchesLookup(pet, requested));
}

export function formatCodexPetSetupInstructions(home = codexHome()): string {
  return [
    "Expected folder:",
    `  ${codexPetsDir(home)}/<pet-name>/`,
    "",
    "Expected files:",
    "  pet.json",
    "  spritesheet.webp",
    "",
    "Create one:",
    "  $skill-installer hatch-pet",
    "  Cmd/Ctrl+K -> Force Reload Skills",
    "  $hatch-pet create a new pet inspired by pi-basic-tools",
  ].join("\n");
}

export function formatNoReadyCodexPetsMessage(pets: CodexPetPackage[], home = codexHome()): string {
  if (pets.length === 0) {
    return [
      "No custom Codex pets found.",
      "",
      `Looked in: ${codexPetsDir(home)}`,
      "",
      formatCodexPetSetupInstructions(home),
    ].join("\n");
  }

  return [
    "Found custom Codex pets, but none are ready.",
    "",
    "A ready pet needs both pet.json and spritesheet.webp in its pet folder.",
    "Run /pets list to see what needs fixing, or create a new pet:",
    "",
    formatCodexPetSetupInstructions(home),
  ].join("\n");
}

export function describeCodexPetSelectionIssue(
  pets: CodexPetPackage[],
  slug?: string,
  home = codexHome(),
): CodexPetSelectionIssue {
  const requestedSlug = slug?.trim();
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);

  if (requestedSlug) {
    const matchingPet = findCodexPet(pets, requestedSlug);
    if (matchingPet && !matchingPet.hasSpritesheet) {
      return {
        short: `Pet "${matchingPet.name}" is not ready.`,
        message: [
          `Pet "${matchingPet.name}" (${matchingPet.slug}) exists but is not ready.`,
          `Missing or unreadable file: ${matchingPet.spritesheetPath}`,
          "",
          "Run /pets list for diagnostics, then fix the pet folder:",
          `  ${matchingPet.dir}/`,
        ].join("\n"),
      };
    }

    const readyList = readyPets.length
      ? ["Ready pets:", ...readyPets.map((pet) => `  - ${pet.slug} (${pet.name})`)].join("\n")
      : formatNoReadyCodexPetsMessage(pets, home);
    return {
      short: `No ready pet matching "${requestedSlug}".`,
      message: [`No ready pet matching "${requestedSlug}".`, "", readyList].join("\n"),
    };
  }

  if (pets.length === 0) {
    return {
      short: "No custom Codex pets found.",
      message: formatNoReadyCodexPetsMessage(pets, home),
    };
  }

  return {
    short: "No ready custom Codex pet found.",
    message: formatNoReadyCodexPetsMessage(pets, home),
  };
}

export function formatCodexPetsListMessage(pets: CodexPetPackage[], home = codexHome()): string {
  if (pets.length === 0) return formatNoReadyCodexPetsMessage(pets, home);

  const petLines = pets
    .map((pet) => {
      const status = pet.hasSpritesheet ? "ready" : `missing ${pet.spritesheetPath}`;
      return `${pet.name} (${pet.slug}) - ${status}${pet.description ? `\n  ${pet.description}` : ""}`;
    })
    .join("\n");

  if (pets.some((pet) => pet.hasSpritesheet)) return petLines;

  return [
    "Found custom Codex pets, but none are ready.",
    "",
    petLines,
    "",
    "Fix one of the pet folders above, or create a new pet:",
    "",
    formatCodexPetSetupInstructions(home),
  ].join("\n");
}

export function formatPetSelectPrompt(
  pets: CodexPetPackage[],
  home = codexHome(),
): { message: string; level: "info" | "warning" } {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  if (readyPets.length === 0) {
    return { message: formatNoReadyCodexPetsMessage(pets, home), level: "warning" };
  }

  const brokenPets = pets.filter((pet) => !pet.hasSpritesheet);
  const lines = [
    "Choose one with /pets select <slug>:",
    ...readyPets.map((pet) => `- ${pet.slug} (${pet.name})`),
  ];
  if (brokenPets.length > 0) {
    lines.push(
      "",
      "Not ready:",
      ...brokenPets.map((pet) => `- ${pet.slug} (${pet.name}) - missing ${pet.spritesheetPath}`),
    );
  }
  return { message: lines.join("\n"), level: "info" };
}

export function formatCodexPetsHelp(home = codexHome()): string {
  return [
    "Codex pets can render in the pi-basic-tools footer.",
    "",
    "Commands:",
    `  /${PETS_COMMAND} wake [slug]   Render a custom Codex pet in the footer`,
    `  /${PETS_COMMAND} tuck          Hide the footer pet`,
    `  /${PETS_COMMAND} select <slug> Select a pet without changing visibility`,
    `  /${PETS_COMMAND} list          List local custom pets`,
    "",
    formatCodexPetSetupInstructions(home),
    "",
    "The Codex app overlay is still controlled by Codex Settings > Appearance > Pets or /pet.",
  ].join("\n");
}

const PET_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "help", label: "help", description: "Show Codex pets setup and usage help" },
  { value: "list", label: "list", description: "List local custom Codex pets" },
  { value: "wake", label: "wake", description: "Render a footer pet" },
  { value: "tuck", label: "tuck", description: "Hide the footer pet" },
  {
    value: "select",
    label: "select",
    description: "Select a footer pet without changing visibility",
  },
];

function petCompletionValue(subcommand: string, pet: CodexPetPackage): string {
  return `${subcommand} ${pet.name}`;
}

export async function petsArgumentCompletions(
  argumentPrefix: string,
  home = codexHome(),
): Promise<AutocompleteItem[] | null> {
  const normalizedPrefix = argumentPrefix.trimStart();
  const parts = normalizedPrefix.split(/\s+/).filter(Boolean);
  const hasTrailingSpace = /\s$/.test(normalizedPrefix);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || (!hasTrailingSpace && parts.length <= 1)) {
    const query = subcommand ?? "";
    const matches = PET_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
    return matches.length > 0 ? matches : null;
  }

  if (subcommand !== "wake" && subcommand !== "select") return null;

  const petQuery = hasTrailingSpace ? "" : parts.slice(1).join(" ");
  const normalizedPetQuery = petLookupKey(petQuery);
  const pets = (await listCodexPets(home)).filter((pet) => pet.hasSpritesheet);
  const matches = pets.filter((pet) => {
    if (!normalizedPetQuery) return true;
    return (
      petLookupKey(pet.slug).includes(normalizedPetQuery) ||
      (pet.id !== undefined && petLookupKey(pet.id).includes(normalizedPetQuery)) ||
      petLookupKey(pet.name).includes(normalizedPetQuery)
    );
  });
  return matches.length > 0
    ? matches.map((pet) => ({
        value: petCompletionValue(subcommand, pet),
        label: pet.name,
        description: `${pet.slug}${pet.description ? ` - ${pet.description}` : ""}`,
      }))
    : null;
}

export const _petCoreTest = {
  PETS_COMMAND,
  petLookupKey,
};
