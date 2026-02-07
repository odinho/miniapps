/**
 * Load parsed posts from cache
 */

import fs from 'fs/promises';
import path from 'path';

const PARSED_DIR = path.resolve('cache/parsed');

export default async function() {
  try {
    const files = await fs.readdir(PARSED_DIR);
    const posts = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(PARSED_DIR, f), 'utf-8');
          const post = JSON.parse(content);
          // Mark if this is a destination (has dates) or an article (no dates)
          post.isDestination = post.days.some(d => d.date);
          return post;
        })
    );

    // Sort by first date in each post (latest first)
    // Articles without dates go to the end
    posts.sort((a, b) => {
      const dateA = a.days.find(d => d.date)?.date || '0000';
      const dateB = b.days.find(d => d.date)?.date || '0000';
      return dateB.localeCompare(dateA);
    });

    return posts;
  } catch (error) {
    console.warn('Kunne ikkje lesa innlegg frå cache:', error.message);
    return [];
  }
}
