import { existsSync, readFileSync } from "node:fs";

const p = `${process.env.CANDIDATE_DIR}/answer.json`;
if (!existsSync(p)) {
  console.error("no answer.json");
  process.exit(1);
}
let a: any;
try {
  a = JSON.parse(readFileSync(p, "utf8"));
} catch {
  console.error("answer.json is not valid JSON");
  process.exit(1);
}
const text: string = typeof a.answer === "string" ? a.answer.toLowerCase().replace(/\s+/g, " ").trim() : "";
const nums = new Set<string>(text.match(/\d+(?:\.\d+)?/g) ?? []);
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

// Two requirements in force disagree (REQ-204: 30 s, REQ-219: 45 s). REQ-188 is replaced by both.
if (a.abstain === true && !Array.isArray(a.conflicts)) fail("no conflicts listed");
const ids = (Array.isArray(a.conflicts) ? a.conflicts : []).map((x: unknown) => String(x).toUpperCase().trim()).sort();
if (JSON.stringify(ids) !== JSON.stringify(["REQ-204", "REQ-219"])) fail(`conflicts must be exactly REQ-204 and REQ-219, got ${JSON.stringify(ids)}`);
if (nums.has("30") !== nums.has("45")) fail("the answer picks a side of a conflict");
console.log("ok");
