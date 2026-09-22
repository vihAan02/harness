// Merges branding/product.overrides.json into the checkout's product.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ide = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(ide, "vscode", "product.json");
const product = JSON.parse(readFileSync(target, "utf8"));
const overrides = JSON.parse(readFileSync(join(ide, "branding", "product.overrides.json"), "utf8"));
for (const key of overrides.$remove ?? []) delete product[key];
delete overrides.$remove;
writeFileSync(target, JSON.stringify({ ...product, ...overrides }, null, "\t") + "\n");
