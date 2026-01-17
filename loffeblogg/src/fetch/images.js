/**
 * Image extraction, downloading, and thumbnail generation
 */

import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { load } from 'cheerio';
import crypto from 'crypto';

const IMAGES_DIR = path.resolve('cache/images');
const THUMBS_DIR = path.resolve('cache/images/thumbs');

/**
 * Generate a stable ID for an image URL
 */
function generateImageId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

/**
 * Extract all image URLs from HTML
 */
export function extractImageUrls(html) {
  const $ = load(html);
  const images = [];

  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      const id = generateImageId(src);
      images.push({
        url: src,
        id,
        originalIndex: i
      });
    }
  });

  return images;
}

/**
 * Check if an image is already cached
 */
export async function isImageCached(imageId) {
  const extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  for (const ext of extensions) {
    try {
      await fs.access(path.join(IMAGES_DIR, `${imageId}.${ext}`));
      return true;
    } catch {
      // Continue checking
    }
  }
  return false;
}

/**
 * Get the cached image path
 */
export async function getCachedImagePath(imageId) {
  const extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  for (const ext of extensions) {
    const filePath = path.join(IMAGES_DIR, `${imageId}.${ext}`);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Continue checking
    }
  }
  return null;
}

/**
 * Determine file extension from content-type or URL
 */
function getExtension(contentType, url) {
  const typeMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
  };

  if (contentType && typeMap[contentType]) {
    return typeMap[contentType];
  }

  // Try to get from URL
  const urlExt = url.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(urlExt)) {
    return urlExt;
  }

  return 'jpg'; // Default
}

/**
 * Download a single image
 */
export async function downloadImage(url, imageId) {
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  // Check if already cached
  const cachedPath = await getCachedImagePath(imageId);
  if (cachedPath) {
    return cachedPath;
  }

  console.log(`Lastar ned bilete: ${imageId}`);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`Kunne ikkje lasta ned bilete ${imageId}: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type');
    const ext = getExtension(contentType, url);
    const filePath = path.join(IMAGES_DIR, `${imageId}.${ext}`);

    const buffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(buffer));

    return filePath;
  } catch (error) {
    console.error(`Feil ved nedlasting av bilete ${imageId}:`, error.message);
    return null;
  }
}

/**
 * Generate thumbnail for an image using Sharp
 */
export async function generateThumbnail(imagePath, imageId) {
  await fs.mkdir(THUMBS_DIR, { recursive: true });

  const ext = path.extname(imagePath);
  const thumbPath = path.join(THUMBS_DIR, `${imageId}${ext}`);

  // Check if thumbnail already exists
  try {
    await fs.access(thumbPath);
    return thumbPath;
  } catch {
    // Continue to generate
  }

  try {
    // Dynamic import of sharp to handle potential installation issues
    const sharp = (await import('sharp')).default;

    await sharp(imagePath)
      .resize(800, null, {
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbPath.replace(ext, '.jpg'));

    console.log(`Laga miniatyrbilde: ${imageId}`);
    return thumbPath.replace(ext, '.jpg');
  } catch (error) {
    console.error(`Feil ved miniatyrbilde ${imageId}:`, error.message);
    // Return original as fallback
    return imagePath;
  }
}

/**
 * Process all images in HTML: download, create thumbnails, return mapping
 */
export async function processImages(html, docId) {
  const images = extractImageUrls(html);
  const imageMap = new Map();

  console.log(`Fann ${images.length} bilete i dokument ${docId}`);

  for (const img of images) {
    const localPath = await downloadImage(img.url, img.id);
    if (localPath) {
      const thumbPath = await generateThumbnail(localPath, img.id);
      imageMap.set(img.url, {
        id: img.id,
        original: localPath,
        thumbnail: thumbPath,
        // Paths relative to site root
        webOriginal: `/images/${path.basename(localPath)}`,
        webThumbnail: `/images/thumbs/${path.basename(thumbPath)}`
      });
    }
  }

  return imageMap;
}

/**
 * Replace image URLs in HTML with local paths
 */
export function replaceImageUrls(html, imageMap) {
  let result = html;
  for (const [originalUrl, paths] of imageMap) {
    // Use thumbnail for inline display
    result = result.replaceAll(originalUrl, paths.webThumbnail);
  }
  return result;
}
