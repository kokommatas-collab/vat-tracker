// Generates supabase/dashboard/index.ts: the Edge Function inlined into one
// file for pasting into the Supabase dashboard editor.
// Run from this folder:  deno run --allow-read --allow-write build_single_file.ts

const MODULES = ["dates.ts", "parse.ts", "summary.ts", "mydata.ts", "index.ts"];
const here = new URL(".", import.meta.url);
export const OUTPUT = new URL("../../dashboard/index.ts", here);

export function buildSingleFile(): string {
  const externalImports: string[] = [];
  const parts = MODULES.map((name) => {
    const src = Deno.readTextFileSync(new URL(name, here))
      .split("\n")
      .filter((line) => {
        if (!line.startsWith("import ")) return true;
        if (!/ from "\.\//.test(line)) externalImports.push(line); // hoisted to the top
        return false; // local imports are inlined
      })
      .map((line) => line.replace(/^export (?=(const|function|async|class|interface|type) )/, ""))
      .join("\n")
      .trim();
    return `// ---- ${name} ${"-".repeat(70 - name.length)}\n\n${src}\n`;
  });
  return [
    "// GENERATED FILE — do not edit. Source: supabase/functions/sync-mydata/*.ts",
    "// Regenerate: cd supabase/functions/sync-mydata && deno run --allow-read --allow-write build_single_file.ts",
    "// Paste this whole file into Supabase → Edge Functions → sync-mydata (Verify JWT: OFF).",
    "",
    ...externalImports,
    "",
    ...parts,
  ].join("\n");
}

if (import.meta.main) {
  Deno.mkdirSync(new URL(".", OUTPUT), { recursive: true });
  Deno.writeTextFileSync(OUTPUT, buildSingleFile());
  console.log(`Wrote ${OUTPUT.pathname}`);
}
