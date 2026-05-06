import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const petCore = await import(path.join(repoRoot, "extensions", "basic-tools", "pet-core.ts"));

async function createPetsHome() {
  const home = await mkdtemp(path.join(tmpdir(), "pi-basic-tools-pets-"));
  const petsDir = path.join(home, "pets");
  await mkdir(path.join(petsDir, "stacky-plus"), { recursive: true });
  await writeFile(
    path.join(petsDir, "stacky-plus", "pet.json"),
    JSON.stringify({
      id: "stacky",
      displayName: "Stacky Plus",
      description: "A test pet",
      spritesheetPath: "spritesheet.webp",
    }),
    "utf8",
  );
  await writeFile(path.join(petsDir, "stacky-plus", "spritesheet.webp"), "webp", "utf8");

  await mkdir(path.join(petsDir, "ghost"), { recursive: true });
  await writeFile(path.join(petsDir, "ghost", "pet.json"), JSON.stringify({ name: "Ghost" }), "utf8");

  return home;
}

test("pet-core discovers ready and not-ready Codex pets", async () => {
  const home = await createPetsHome();
  try {
    const pets = await petCore.listCodexPets(home);
    assert.equal(pets.length, 2);
    assert.deepEqual(
      pets.map((pet) => [pet.slug, pet.name, pet.hasSpritesheet]),
      [
        ["ghost", "Ghost", false],
        ["stacky-plus", "Stacky Plus", true],
      ],
    );
    assert.equal(petCore.findReadyCodexPet(pets, "Stacky Plus")?.slug, "stacky-plus");
    assert.equal(petCore.findReadyCodexPet(pets, "STACKY_PLUS")?.slug, "stacky-plus");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("package wires the pets command into basic-tools", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const extensionSource = await readFile(path.join(repoRoot, "extensions", "basic-tools.ts"), "utf8");
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.ok(packageJson.pi.extensions.includes("./extensions/basic-tools.ts"));
  assert.equal(packageJson.dependencies.sharp, "^0.34.5");
  assert.match(extensionSource, /registerPetsCommand\(pi\)/);
  assert.match(readme, /pi-better-openai/);
  assert.match(readme, /Contributing and credits/);
});

test("pet-core formats actionable diagnostics for missing pets", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-basic-tools-pets-empty-"));
  try {
    const pets = await petCore.listCodexPets(home);
    assert.deepEqual(pets, []);
    const message = petCore.formatNoReadyCodexPetsMessage(pets, home);
    assert.match(message, /No custom Codex pets found/);
    assert.match(message, /pets\/<pet-name>/);
    assert.match(message, /\$skill-installer hatch-pet/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("pet-core rejects spritesheet paths outside the pet folder", () => {
  assert.equal(petCore.resolvePetAssetPath("/tmp/pets/safe", "spritesheet.webp"), "/tmp/pets/safe/spritesheet.webp");
  assert.equal(petCore.resolvePetAssetPath("/tmp/pets/safe", "../escape.webp"), undefined);
});

test("pet-core completes pet subcommands and ready pet names", async () => {
  const home = await createPetsHome();
  try {
    assert.deepEqual(await petCore.petsArgumentCompletions("w", home), [
      { value: "wake", label: "wake", description: "Render a footer pet" },
    ]);
    assert.deepEqual(await petCore.petsArgumentCompletions("wake st", home), [
      { value: "wake Stacky Plus", label: "Stacky Plus", description: "stacky-plus - A test pet" },
    ]);
    assert.equal(await petCore.petsArgumentCompletions("tuck now", home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
