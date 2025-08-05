const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '../views');

function updateImagePathsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  const updated = content.replace(/\/images\/([\w-]+)\.(png|jpg)/g, '/images/webp/$1.webp');

  if (updated !== content) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`✅ Updated: ${filePath}`);
  }
}

function processDirectory(dir) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.endsWith('.ejs')) {
      updateImagePathsInFile(fullPath);
    }
  }
}

processDirectory(VIEWS_DIR);
