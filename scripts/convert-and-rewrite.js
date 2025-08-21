// C:\website\scripts\convert-and-rewrite.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC_IMAGES_DIR = path.join(ROOT, 'public', 'images');     // مكان الصور الأصلية
const OUT_IMAGES_DIR = path.join(SRC_IMAGES_DIR, 'webp');       // مكان صور webp
const VIEWS_DIR = path.join(ROOT, 'views');                      // مكان ملفات EJS

const DRY_RUN = process.argv.includes('--dry-run'); // جرّب بدون كتابة أي تغيير

// ----- أدوات مساعدة -----
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function walkImages(dir, out = []) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);

    // ما ندخل على مجلد webp لأنو هو الناتج
    if (stat.isDirectory()) {
      if (path.basename(full).toLowerCase() === 'webp') continue;
      walkImages(full, out);
    } else {
      if (/\.(png|jpe?g)$/i.test(item)) out.push(full);
    }
  }
  return out;
}

async function convertOne(inputPath) {
  // احفظ البنية نفسها داخل webp
  const rel = path.relative(SRC_IMAGES_DIR, inputPath); // ex: banners/home/hero.jpg
  const relDir = path.dirname(rel);                     // ex: banners/home
  const base = path.basename(rel, path.extname(rel));   // ex: hero
  const outDir = path.join(OUT_IMAGES_DIR, relDir);
  const outPath = path.join(outDir, `${base}.webp`);

  ensureDirSync(outDir);

  if (DRY_RUN) {
    console.log(`(dry-run) Convert ${inputPath} -> ${outPath}`);
    return;
  }

  await sharp(inputPath)
    .webp({ quality: 82 }) // جودة مناسبة لحجم أصغر
    .toFile(outPath);

  console.log(`✅ Converted: ${path.relative(ROOT, inputPath)} -> ${path.relative(ROOT, outPath)}`);
}

async function convertAll() {
  ensureDirSync(OUT_IMAGES_DIR);
  const images = walkImages(SRC_IMAGES_DIR);
  if (images.length === 0) {
    console.log('لا توجد صور PNG/JPG/JPEG داخل public/images.');
    return;
  }
  for (const img of images) {
    await convertOne(img);
  }
}

// ----- تعديل المسارات داخل ملفات EJS -----
function updateImagePathsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // ندعم مسارات مع مجلدات فرعية:
  // /images/.../name.png -> /images/webp/.../name.webp
  const re = /\/images\/((?:[\w\-]+\/)*)?([\w\-]+)\.(png|jpe?g)/gi;
  const updated = content.replace(re, (_m, subdirs = '', name) => {
    return `/images/webp/${subdirs || ''}${name}.webp`;
  });

  if (updated !== content) {
    if (!DRY_RUN) fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`🔧 ${DRY_RUN ? 'Would update' : 'Updated'}: ${filePath}`);
  }
}

function processViews(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      processViews(full);
    } else if (item.toLowerCase().endsWith('.ejs')) {
      updateImagePathsInFile(full);
    }
  }
}

// ----- التشغيل -----
(async () => {
  try {
    console.log('— Step 1/2: Convert images to WebP —');
    await convertAll();

    console.log('— Step 2/2: Rewrite image paths inside EJS —');
    processViews(VIEWS_DIR);

    console.log(DRY_RUN ? '✅ Dry run finished.' : '✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
})();
