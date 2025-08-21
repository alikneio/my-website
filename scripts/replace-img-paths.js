const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '../views');
const DRY_RUN = process.argv.includes('--dry-run'); // جرّب بدون كتابة

function updateImagePathsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // يدعم png/jpg/jpeg وبلا حساسّية لحروف كبيرة
  const re = /\/images\/([\w-]+)\.(png|jpg|jpeg)/gi;
  const updated = content.replace(re, '/images/webp/$1.webp');

  if (updated !== content) {
    if (!DRY_RUN) {
      fs.writeFileSync(filePath, updated, 'utf8');
    }
    console.log(`✅ ${DRY_RUN ? 'Would update' : 'Updated'}: ${filePath}`);
  }
}

function processDirectory(dir) {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.toLowerCase().endsWith('.ejs')) {
      updateImagePathsInFile(fullPath);
    }
  }
}

processDirectory(VIEWS_DIR);
