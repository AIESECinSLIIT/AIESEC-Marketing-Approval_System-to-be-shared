import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function value(flag) { const i = args.indexOf(flag); return i < 0 ? "" : (args[i + 1] || "").trim(); }
const name = value("--name");
const email = value("--admin-email").toLowerCase();
if (!/^AIESEC in [A-Za-z0-9][A-Za-z0-9 .&-]{2,80}$/.test(name)) {
 console.error('Use --name "AIESEC in Your University" (letters, numbers, spaces, dot, ampersand and hyphen only).');process.exit(1);
}
if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || email.endsWith(".example")) {
 console.error('Use --admin-email "real-admin@university.edu" with a real entity-controlled address.');process.exit(1);
}
const OLD_NAME = "AIESEC in Your Entity";
const OLD_EMAIL = "admin@your-entity.example";
const ext = new Set([".js", ".jsx", ".ts", ".mjs", ".sql", ".md", ".html", ".json", ".webmanifest", ".example"]);
const skip = new Set(["scripts/configure-entity.mjs", "package-lock.json", "package.json"]);
let matched = 0;
async function walk(dir) {
 for (const entry of await readdir(dir,{withFileTypes:true})) {
  if (["node_modules", ".git", "dist", ".netlify", ".supabase"].includes(entry.name)) continue;
  const path = join(dir, entry.name), rel = relative(root,path).replaceAll("\\","/");
  if (entry.isDirectory()) { await walk(path); continue; }
  if (skip.has(rel) || !(ext.has(extname(path)) || basename(path)===".env.example")) continue;
  const prior = await readFile(path,"utf8");
  let next = prior.replaceAll(OLD_NAME,name).replaceAll(OLD_EMAIL,email);
  if (prior!==next) {await writeFile(path,next);matched++;}
 }
}
await walk(root);
if (!matched) {console.error("No placeholder matches found. This copy may already have been configured. Use a fresh starter kit for initial setup.");process.exit(1);}
console.log(`Configured ${matched} files for ${name}. Review changes and deploy only to YOUR new Supabase + Netlify projects.`);
