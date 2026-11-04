import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { contentTypeFor, localFiles, planUploads } from "../scripts/upload-blog-images.mjs";

const root = mkdtempSync(path.join(tmpdir(), "upload-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("upload-blog-images", () => {
  it("mapea originales y variantes a sus prefijos y solo coge imágenes", () => {
    mkdirSync(path.join(root, "images/blog/post"), { recursive: true });
    mkdirSync(path.join(root, "img-variants/blog/post"), { recursive: true });
    writeFileSync(path.join(root, "images/blog/post/hero.webp"), "a");
    writeFileSync(path.join(root, "img-variants/blog/post/hero-640.webp"), "b");
    writeFileSync(path.join(root, "images/blog/post/notas.txt"), "x");
    writeFileSync(path.join(root, "secreto.webp"), "fuera");
    symlinkSync(path.join(root, "secreto.webp"), path.join(root, "images/blog/post/enlace.webp"));
    const keys = localFiles(root).map((f) => f.key).sort();
    assert.deepEqual(keys, ["blog-images/originals/post/hero.webp", "blog-images/variants/post/hero-640.webp"]);
  });

  it("sube lo que falta o cambió, nunca propone borrar", () => {
    const local = [{ key: "a", md5: "1" }, { key: "b", md5: "2" }, { key: "c", md5: "3" }];
    const { toUpload, unchanged } = planUploads(local, new Map([["a", "1"], ["b", "x"], ["z", "9"]]));
    assert.deepEqual(toUpload.map((f) => f.key), ["b", "c"]);
    assert.equal(unchanged, 1);
  });

  it("tipos de contenido iguales que la app", () => {
    assert.equal(contentTypeFor("a.PNG"), "image/png");
    assert.equal(contentTypeFor("a.jpeg"), "image/jpeg");
    assert.equal(contentTypeFor("a.webp"), "image/webp");
  });
});
