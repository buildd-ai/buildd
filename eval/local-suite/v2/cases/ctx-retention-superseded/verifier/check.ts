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

// Expected 60. 90 (superseded by REQ-117) and 30 (EU only) are wrong, and so is abstaining.
if (a.abstain === true || !text) fail("wrong_abstention: the notes settle this");
if (!nums.has("60")) fail("answer does not give 60 days");
if (nums.has("90")) fail("followed_superseded or mentions the superseded 90");
if (nums.has("30")) fail("applied the EU-only figure to a US tenant");
console.log("ok");
