const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const docsDir = path.join(root, "docs");

const copyRecursive = (src, dest) => {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

const cleanDirectory = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
};

if (!fs.existsSync(publicDir)) {
  console.error("Chybi slozka public/.");
  process.exit(1);
}

fs.mkdirSync(docsDir, { recursive: true });
cleanDirectory(docsDir);
copyRecursive(publicDir, docsDir);
console.log("Hotovo: docs/ je synchronizovane z public/.");
