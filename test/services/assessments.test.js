import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.CACHE_ENABLED = "false";
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const { parseAssessment } = await import("../../src/services/assessments.js");
const { assessmentEntry } = await import("../../src/upstream/assessments.js");
const { ASSESSMENTS_REPO } = await import("../../src/lib/constants.js");
const fixture = JSON.parse(readFileSync(new URL("../fixtures/assessments.json", import.meta.url)));
let files, tree, calls, failed, treeDown;
beforeEach(() => {
  files = { ...fixture.files }; tree = structuredClone(fixture.tree); calls = []; failed = new Set(); treeDown = false;
  setFetchImpl(async (url) => {
    calls.push(url);
    assert.ok(url.includes(`/${ASSESSMENTS_REPO}/`));
    if (url.includes("/git/trees/")) return treeDown ? new Response("down", { status: 503 }) : Response.json(tree);
    const api = url.startsWith("https://api.github.com/");
    const path = new URL(url).pathname.split(api ? "/contents/" : "/main/")[1];
    if (failed.has(path)) return new Response("down", { status: 503 });
    if (/^assessments\/(published|draft|deprecated)$/.test(path)) return Response.json(tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(path + "/")).map((e) => ({ ...e, type: "file" })));
    if (!Object.hasOwn(files, path)) return new Response("missing", { status: 404 });
    return api ? Response.json({ content: Buffer.from(files[path]).toString("base64") }) : new Response(files[path]);
  });
});

test("catalogue discovers all 21 reports and preserves every structured field and unit", async () => {
  const out = await dispatchTool("get_collateral_assessments", {});
  assert.equal(out.status, "available");
  assert.equal(out.total, 21); assert.equal(out.count, 21);
  assert.equal(out.assessments.filter((a) => a.publication === "published").length, 18);
  assert.equal(out.assessments.filter((a) => a.publication === "draft").length, 3);
  for (const assessment of out.assessments) {
    assert.deepEqual(assessment.metadata, parseAssessment(files[assessment.path]).metadata);
    assert.ok(assessment.summary.length > 20);
    assert.equal(assessment.content, undefined);
  }
  const wbtc = out.assessments.find((a) => a.asset === "WBTC");
  assert.equal(wbtc.metadata.risk_parameters.retained_reserve, 0.2);
  assert.equal(wbtc.metadata.risk_parameters.global_minting_limit, "no limit");
  assert.equal(wbtc.metadata.risk_parameters.maturity, "3 years");
});

test("detail, all-content, publication filters and all supporting documents retain full source", async () => {
  const detail = await dispatchTool("get_collateral_assessments", { asset: "wbtc" });
  assert.equal(detail.count, 1);
  assert.equal(detail.assessments[0].content, files["assessments/published/WBTC.md"]);
  const drafts = await dispatchTool("get_collateral_assessments", { publication: "draft", includeContent: "true" });
  assert.equal(drafts.count, 3);
  assert.ok(drafts.assessments.every((a) => a.content === files[a.path] && a.publication === "draft"));
  assert.equal((await dispatchTool("get_collateral_assessments", { publication: "deprecated" })).count, 0);
  for (const doc of detail.documents) {
    const out = await dispatchTool("get_collateral_assessments", { document: doc.document });
    assert.equal(out.content, files[doc.path]);
    assert.equal(out.status, "available");
    if (doc.document === "schema") assert.ok(out.data.properties.risk_parameters);
  }
});

test("new entries are discovered without code changes and duplicate lifecycle versions remain distinct", async () => {
  for (const path of ["assessments/published/NEW.md", "assessments/deprecated/WBTC.md"]) {
    tree.tree.push({ path, mode: "100644", type: "blob", sha: "test" });
    files[path] = files["assessments/published/WBTC.md"];
  }
  assert.equal((await dispatchTool("get_collateral_assessments", {})).count, 23);
  const out = await dispatchTool("get_collateral_assessments", { asset: "WBTC" });
  assert.deepEqual(out.assessments.map((a) => a.publication), ["deprecated", "published"]);
});

test("malformed or absent JSON does not erase readable reports; unavailable files remain explicit", async () => {
  files["assessments/published/WBTC.md"] = "---\n{bad json}\n---\n# Assessment\n\n## Summary\nReadable.\n\n## Details\nPreserved.";
  files["assessments/draft/BGB.md"] = "# Legacy report\n\n## Summary\nNo metadata.";
  failed.add("assessments/published/CRV.md");
  const out = await dispatchTool("get_collateral_assessments", { includeContent: true });
  assert.equal(out.status, "partial");
  assert.equal(out.count, 21);
  const wbtc = out.assessments.find((a) => a.asset === "WBTC");
  assert.equal(wbtc.metadataStatus, "invalid"); assert.equal(wbtc.status, "partial");
  assert.equal(wbtc.summary, "Readable."); assert.match(wbtc.markdown, /Preserved/);
  assert.equal(out.assessments.find((a) => a.asset === "BGB").metadataStatus, "missing");
  assert.equal(out.assessments.find((a) => a.asset === "CRV").content, null);
  assert.equal(out.assessments.find((a) => a.asset === "WETH").status, "available");
});

test("tree failure or truncation falls back to all directories; discovery failure is never an empty success", async () => {
  treeDown = true;
  assert.equal((await dispatchTool("get_collateral_assessments", {})).count, 21);
  treeDown = false; tree.truncated = true;
  assert.equal((await dispatchTool("get_collateral_assessments", {})).count, 21);
  failed.add("assessments/draft");
  const out = await dispatchTool("get_collateral_assessments", {});
  assert.equal(out.status, "unavailable"); assert.equal(out.assessments, null); assert.equal(out.count, null);
});

test("invalid selectors and symlinks never become file requests; unknown assets preserve discovery", async () => {
  for (const args of [{ asset: "../secrets" }, { asset: "https://evil.example" }, { document: "__proto__" }, { publication: "../" }, { extra: true }]) await assert.rejects(() => dispatchTool("get_collateral_assessments", args));
  assert.deepEqual(calls, []);
  for (const entry of [
    { type: "blob", mode: "120000", path: "assessments/published/SYMLINK.md" },
    { type: "blob", mode: "100644", path: "assessments/published/../../secret.md" },
    { type: "blob", mode: "100644", path: "assessments/published/test.md?url=evil" },
  ]) assert.equal(assessmentEntry(entry), null);
  const out = await dispatchTool("get_collateral_assessments", { asset: "UNKNOWN" });
  assert.equal(out.count, 0); assert.equal(out.availableAssets.length, 21);
  assert.ok(calls.every((url) => url.includes("/git/trees/")));
});
