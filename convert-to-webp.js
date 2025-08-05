const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputFolder = './public/images';  // مكان الصور الأصلية
const outputFolder = './public/images/webp'; // مكان الصور المحوّلة

// تأكد أن مجلد WebP موجود
if (!fs.existsSync(outputFolder)) {
  fs.mkdirSync(outputFolder);
}

// اقرأ كل الملفات بالمجلد
fs.readdirSync(inputFolder).forEach(file => {
  const inputPath = path.join(inputFolder, file);
  const ext = path.extname(file).toLowerCase();

  // تأكد أنه صورة بصيغة PNG أو JPG أو JPEG
  if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const fileNameWithoutExt = path.parse(file).name;
    const outputPath = path.join(outputFolder, `${fileNameWithoutExt}.webp`);

    sharp(inputPath)
      .webp({ quality: 80 }) // جودة 80% (بتقدر تغيرها)
      .toFile(outputPath)
      .then(() => console.log(`✅ Converted: ${file} → ${fileNameWithoutExt}.webp`))
      .catch(err => console.error(`❌ Error with ${file}:`, err));
  }
});
