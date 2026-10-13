import assert from "node:assert/strict";
import { buildSingleFile, OUTPUT } from "./build_single_file.ts";

Deno.test("dashboard single-file function is up to date", () => {
  assert.equal(
    Deno.readTextFileSync(OUTPUT),
    buildSingleFile(),
    "supabase/dashboard/index.ts is stale — run build_single_file.ts",
  );
});

Deno.test("dashboard single-file has no local imports", () => {
  assert.doesNotMatch(buildSingleFile(), /from "\.\//);
});
