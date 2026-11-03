import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../sources/", import.meta.url));
const json = name => JSON.parse(readFileSync(join(root, name), "utf8"));
for (const [file, expected] of Object.entries(json("SHA256.json"))) {
  assert.equal(createHash("sha256").update(readFileSync(join(root, file))).digest("hex"), expected, `pinned source bytes: ${file}`);
}
const manifest = json("manifest.json");
assert.equal(manifest.repository.externalRepositoryId, "11061773");
assert.equal(manifest.repository.license, "MIT");
assert(readFileSync(join(root, "ESLINT-LICENSE"), "utf8").includes("Permission is hereby granted"));
for (const source of manifest.sources) {
  const number = source.reference.split("/")[1];
  const pr = json(`eslint-pr-${number}.json`);
  assert.equal(pr.merged, true);
  assert.equal(pr.base.repo.id.toString(), manifest.repository.externalRepositoryId);
  assert.equal(pr.base.repo.full_name, manifest.repository.fullName);
  assert.equal(pr.merge_commit_sha, source.revision);
  assert.equal(pr.merged_at, source.mergedAt);
  assert.equal(pr.html_url, source.url);
  assert(readFileSync(join(root, source.rawFile), "utf8").includes(source.excerpt));
}
for (const release of manifest.releases) {
  const major = release.version.split(".")[0];
  const tag = json(`eslint-v${major}-annotated-tag.json`);
  const metadata = json(`eslint-npm-${release.version}.json`);
  assert.equal(tag.object.type, "commit");
  assert.equal(tag.object.sha, release.commit);
  assert.equal(metadata.gitHead, release.commit);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.version, release.version);
  assert.equal(tag.tagger.date.slice(0,10), release.date);
  assert(metadata.dist.integrity.startsWith("sha512-"));
}
const merge = json("eslint-merge-commit.json");
assert.equal(merge.sha, manifest.sources[1].revision);
assert(merge.commit.message.includes("#20037"));
console.log(JSON.stringify({ status: "pass", repository: manifest.repository.fullName, sources: manifest.sources.length, releases: manifest.releases.length, checkedAt: new Date().toISOString() }, null, 2));
