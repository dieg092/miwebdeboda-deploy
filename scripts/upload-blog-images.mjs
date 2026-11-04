#!/usr/bin/env node
// Sube a S3 las imágenes del blog (originales del commit y variantes generadas en el
// job sin secretos). Es la versión de este repositorio de scripts/sync-blog-images.ts
// de la app: el job con las claves de AWS no ejecuta código de la app, solo lee
// ficheros. Misma lógica: sube lo que falta o cambió (ETag = MD5), nunca borra.
//
// Si la app cambia el bucket, los prefijos o la cabecera de caché
// (src/lib/blog-images/s3-layout.ts), hay que cambiarlos aquí también.
//
//   node scripts/upload-blog-images.mjs <carpeta public de la app>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUCKET = "wedding-invite-project";
export const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const LAYOUT = [
  { local: "images/blog", prefix: "blog-images/originals/" },
  { local: "img-variants/blog", prefix: "blog-images/variants/" },
];
const CONCURRENCY = 8;

export const contentTypeFor = (f) => (/\.png$/i.test(f) ? "image/png" : /\.jpe?g$/i.test(f) ? "image/jpeg" : "image/webp");

/** Ficheros locales con su clave de S3 (solo imágenes, sin salir de las carpetas del blog). */
export function localFiles(publicDir) {
  const out = [];
  for (const { local, prefix } of LAYOUT) {
    const root = path.join(publicDir, local);
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && /\.(webp|jpe?g|png)$/i.test(e.name)) {
          const rel = path.relative(root, full).split(path.sep).join("/");
          if (rel.startsWith("..")) continue;
          out.push({ file: full, key: prefix + rel, md5: createHash("md5").update(readFileSync(full)).digest("hex") });
        }
      }
    };
    walk(root);
  }
  return out;
}

export function planUploads(local, remote) {
  const toUpload = local.filter((f) => remote.get(f.key) !== f.md5);
  return { toUpload, unchanged: local.length - toUpload.length };
}

async function main(publicDir) {
  const { ListObjectsV2Command, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: (process.env.AWS_REGION ?? "").trim() || "eu-central-1" });
  const remote = new Map();
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "blog-images/", ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key && o.ETag) remote.set(o.Key, o.ETag.replace(/"/g, ""));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const local = localFiles(publicDir);
  const { toUpload, unchanged } = planUploads(local, remote);
  console.log(`Imágenes del blog: ${local.length} locales, ${unchanged} ya en S3, ${toUpload.length} por subir.`);
  for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
    await Promise.all(
      toUpload.slice(i, i + CONCURRENCY).map((f) =>
        s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: f.key, Body: readFileSync(f.file), ContentType: contentTypeFor(f.file), CacheControl: CACHE_CONTROL })),
      ),
    );
  }
  if (toUpload.length) console.log(`Imágenes del blog: ${toUpload.length} subidas.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(path.resolve(process.argv[2] ?? "app/public")).catch((e) => {
    console.log(`::error::No se pudieron subir las imágenes del blog: ${e?.message ?? e}`);
    process.exit(1);
  });
}
