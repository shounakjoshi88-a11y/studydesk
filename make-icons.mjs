// Generates all app icons + splash screens from assets/logo-*.svg
// Run: bun make-icons.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const root = import.meta.dir;
const res = `${root}/android/app/src/main/res`;
const full = `${root}/assets/logo-full.svg`;
const fg = `${root}/assets/logo-fg.svg`;

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

// Launcher legacy + round PNGs
for (const [d, px] of Object.entries(densities)) {
  const buf = await sharp(full).resize(px, px).png().toBuffer();
  await Bun.write(`${res}/mipmap-${d}/ic_launcher.png`, buf);
  await Bun.write(`${res}/mipmap-${d}/ic_launcher_round.png`, buf);
}
// Adaptive foreground (432px) + background color
mkdirSync(`${root}/public`, { recursive: true });
await sharp(fg).resize(432, 432).png().toFile(`${res}/mipmap-xxxhdpi/ic_launcher_foreground.png`);
for (const d of Object.keys(densities)) {
  await Bun.write(
    `${res}/mipmap-${d}/ic_launcher_foreground.png`,
    await sharp(fg).resize(432, 432).png().toBuffer()
  );
}

// Splash: mark centered on dark bg (portrait 768x1280 base, scaled per density)
const splashBase = sharp({
  create: { width: 768, height: 1280, channels: 4, background: "#0f0f0e" },
}).composite([{ input: await sharp(full).resize(320, 320).png().toBuffer(), gravity: "center" }]);
const splashSizes = { mdpi: [384, 640], hdpi: [576, 960], xhdpi: [768, 1280], xxhdpi: [1152, 1920], xxxhdpi: [1536, 2560] };
for (const [d, [w, h]] of Object.entries(splashSizes)) {
  const png = await sharp(await splashBase.png().toBuffer()).resize(w, h).png().toBuffer();
  await Bun.write(`${res}/drawable-port-${d}/splash.png`, png);
  await Bun.write(`${res}/drawable-land-${d}/splash.png`, await sharp(png).resize(h, w).png().toBuffer());
}
await Bun.write(`${res}/drawable/splash.png`, await sharp(await splashBase.png().toBuffer()).resize(768, 1280).png().toBuffer());

// Web favicon + store assets
await sharp(full).resize(64, 64).png().toFile(`${root}/public/favicon.png`);
await Bun.write(`${root}/public/favicon.svg`, await Bun.file(full).text());
await sharp(full).resize(192, 192).png().toFile(`${root}/public/icon-192.png`);
await sharp(full).resize(512, 512).png().toFile(`${root}/public/icon-512.png`);
await sharp(full).resize(1024, 1024).png().toFile(`${root}/assets/icon-1024.png`);
await sharp(full).resize(256, 256).png().toFile(`${root}/assets/icon-256.png`);

console.log("icons done");
