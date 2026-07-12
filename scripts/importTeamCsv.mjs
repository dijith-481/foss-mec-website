#!/usr/bin/env node

import { createClient } from '@sanity/client';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDryRun = process.argv.includes('--dry-run');

function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            value = value.replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
    }
  } catch {}
}

loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, '.env.local'));

const PROJECT_ID = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const DATASET = process.env.NEXT_PUBLIC_SANITY_DATASET;
const TOKEN = process.env.SANITY_API_TOKEN;

if (!PROJECT_ID || !DATASET || !TOKEN) {
  console.error('Missing required env vars: NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET, SANITY_API_TOKEN');
  process.exit(1);
}

const client = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  token: TOKEN,
  apiVersion: '2026-02-21',
  useCdn: false,
});

// ──────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────

const yearArg = process.argv.find((a) => a.startsWith('--year='));
const fileArg = process.argv.find((a) => a.startsWith('--file='));

if (!yearArg || !fileArg) {
  console.error('Usage: node scripts/importTeamCsv.mjs --year=2026 --file=./core26.csv [--dry-run]');
  process.exit(1);
}

const YEAR = parseInt(yearArg.split('=')[1], 10);
const CSV_PATH = path.resolve(fileArg.split('=')[1]);

if (isNaN(YEAR)) {
  console.error('Invalid --year value');
  process.exit(1);
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`File not found: ${CSV_PATH}`);
  process.exit(1);
}

// ──────────────────────────────────────────────
// CSV parser
// ──────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      current.push(field.trim());
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (field || current.length > 0) {
        current.push(field.trim());
      }
      if (current.length > 0) {
        rows.push(current);
      }
      field = '';
      current = [];
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += char;
    }
  }
  if (field || current.length > 0) {
    current.push(field.trim());
    rows.push(current);
  }
  return rows;
}

function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z]/g, '');
}

const csvText = fs.readFileSync(CSV_PATH, 'utf-8');
const parsed = parseCSV(csvText);

if (parsed.length < 2) {
  console.error('CSV must have a header row and at least one data row');
  process.exit(1);
}

const header = parsed[0].map(normalizeHeader);

const colIdx = {
  name: header.findIndex((h) => h.includes('name')),
  position: header.findIndex((h) => h.includes('position') || h.includes('role')),
  linkedin: header.findIndex((h) => h.includes('linkedin')),
  github: header.findIndex((h) => h.includes('github')),
  photo: header.findIndex((h) => h.includes('photo') || h.includes('image') || h.includes('picture') || h.includes('img')),
};

console.log('Column mapping:');
for (const [key, idx] of Object.entries(colIdx)) {
  console.log(`  ${key}: ${idx >= 0 ? `column ${idx}` : 'NOT FOUND'}`);
}

if (colIdx.name < 0 || colIdx.position < 0) {
  console.error('CSV must have at least "Name" and "Position" columns');
  process.exit(1);
}

const rows = parsed.slice(1);
console.log(`\nRows found: ${rows.length}`);
console.log(`Year: ${YEAR}`);
console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}\n`);

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function getCell(row, idx) {
  return idx >= 0 && idx < row.length ? row[idx] : '';
}

function extractGDriveId(url) {
  const match = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return match ? match[1] : null;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    let finalUrl = url;

    const gdriveId = extractGDriveId(url);
    if (gdriveId) {
      finalUrl = `https://drive.google.com/uc?export=download&id=${gdriveId}`;
    }

    const mod = finalUrl.startsWith('https') ? https : http;

    mod.get(finalUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const ext = contentType.split('/').pop() || 'jpg';
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ buffer: Buffer.concat(chunks), contentType, ext });
      });
      res.on('error', reject);
    }).on('timeout', function () {
      this.destroy();
      reject(new Error('Download timeout'));
    }).on('error', reject);
  });
}

function buildMemberObj(member, imageAssetId) {
  const obj = {
    _key: `m${Math.random().toString(36).slice(2, 8)}`,
    name: member.name,
    position: member.position,
  };
  if (imageAssetId) {
    obj.image = {
      _type: 'image',
      asset: { _type: 'reference', _ref: imageAssetId },
    };
  }
  if (member.linkedin) obj.linkedin = member.linkedin;
  if (member.github) obj.github = member.github;
  return obj;
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  // 1. Check connectivity
  try {
    await client.fetch('count(*[_type == "teamYear"])');
  } catch (err) {
    console.error('Failed to connect to Sanity. Check credentials and CORS.');
    process.exit(1);
  }

  // 2. Delete existing doc for this year
  if (!isDryRun) {
    const existing = await client.fetch(`*[_type == "teamYear" && year == $year]._id`, { year: YEAR });
    if (existing.length > 0) {
      const tx = client.transaction();
      for (const id of existing) tx.delete(id);
      await tx.commit();
      console.log(`Deleted existing teamYear for ${YEAR}`);
    }
  } else {
    const count = await client.fetch(`count(*[_type == "teamYear" && year == $year])`, { year: YEAR });
    console.log(`Existing doc for ${YEAR}: ${count > 0 ? 'YES (will be replaced)' : 'NONE'}`);
  }

  // 3. Parse rows into members
  const members = rows.map((row, i) => ({
    index: i,
    name: getCell(row, colIdx.name),
    position: getCell(row, colIdx.position),
    linkedin: getCell(row, colIdx.linkedin),
    github: getCell(row, colIdx.github),
    photo: getCell(row, colIdx.photo),
  }));

  const emptyNames = members.filter((m) => !m.name);
  if (emptyNames.length > 0) {
    console.error(`Rows ${emptyNames.map((m) => m.index + 2).join(', ')} have empty names`);
    process.exit(1);
  }

  // 4. Upload photos
  const imageAssetIds = [];
  console.log('');
  for (const member of members) {
    if (!member.photo) {
      imageAssetIds.push(null);
      console.log(`  ${member.name} — no photo`);
      continue;
    }

    if (isDryRun) {
      console.log(`  ${member.name} — would download: ${member.photo.slice(0, 80)}`);
      imageAssetIds.push(null);
      continue;
    }

    try {
      console.log(`  ${member.name} — downloading...`);
      const { buffer, contentType } = await downloadImage(member.photo);
      const asset = await client.assets.upload('image', buffer, {
        contentType,
        filename: `core${YEAR}_${member.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${contentType.split('/').pop()}`,
      });
      imageAssetIds.push(asset._id);
      console.log(`    → uploaded: ${asset._id}`);
    } catch (err) {
      console.error(`    ✗ FAILED: ${err.message}`);
      imageAssetIds.push(null);
    }
  }

  // 5. Create document
  const doc = {
    _type: 'teamYear',
    year: YEAR,
    title: `Core ${YEAR}`,
    members: members.map((m, i) => buildMemberObj(m, imageAssetIds[i])),
  };

  const withPhotos = members.filter((_, i) => imageAssetIds[i]).length;
  const noPhotos = members.filter((_, i) => !imageAssetIds[i]).length;

  if (isDryRun) {
    console.log(`\nDocument ready: ${doc.members.length} members (${withPhotos} with photos, ${noPhotos} without)`);
  } else {
    const created = await client.create(doc);
    console.log(`\nCreated document: ${created._id}`);
  }

  console.log(`\nDone. ${members.length} members imported for Core ${YEAR}.`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
