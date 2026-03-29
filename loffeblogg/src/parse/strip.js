/**
 * Strip Google Docs HTML cruft to reduce memory usage.
 *
 * Google Docs exports embed images as base64 data URIs, making a
 * typical document 93 MB+ when the actual markup is only ~100 KB.
 * Cheerio's DOM representation inflates input ~33×, so loading the
 * raw export OOMs on constrained machines.
 *
 * This module uses only string/regex operations (no DOM parsing)
 * to strip the bloat before any Cheerio work happens.
 */

/**
 * Extract CSS class names that imply bold text from a <style> block.
 * Google Docs encodes bold via generated class names, e.g.
 *   .c5{font-weight:700}
 */
function extractBoldClasses(html) {
  const boldClasses = new Set();
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return boldClasses;

  const css = styleMatch[1];
  // Match class definitions containing font-weight:700 or font-weight:bold
  const classRegex = /\.([\w-]+)\s*\{[^}]*font-weight:\s*(?:700|bold)[^}]*\}/gi;
  let m;
  while ((m = classRegex.exec(css)) !== null) {
    boldClasses.add(m[1]);
  }
  return boldClasses;
}

/**
 * Convert spans whose class implies bold into <b> tags.
 * Must run before class attributes are stripped.
 */
function convertBoldClassesToTags(html, boldClasses) {
  if (boldClasses.size === 0) return html;

  // Build alternation: (c5|c12|...)
  const alt = [...boldClasses].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  // Match <span class="...boldClass...">content</span>
  // The class attribute may list several classes; we match if any is bold.
  const re = new RegExp(
    `<span([^>]*)\\bclass="([^"]*\\b(?:${alt})\\b[^"]*)"([^>]*)>([\\s\\S]*?)</span>`,
    'gi'
  );

  return html.replace(re, (match, pre, cls, post, content) => {
    // Remove the bold class(es) from the class list
    const remaining = cls.split(/\s+/).filter(c => !boldClasses.has(c)).join(' ');
    const attrs = remaining
      ? `${pre} class="${remaining}"${post}`
      : `${pre}${post}`;
    // Wrap content in <b>, keep remaining attrs on span if any
    if (attrs.trim()) {
      return `<span${attrs}><b>${content}</b></span>`;
    }
    return `<b>${content}</b>`;
  });
}

/**
 * Strip a Google Docs HTML export down to lightweight markup.
 *
 * Call this AFTER processImages/replaceImageUrls so base64 data URIs
 * have already been swapped for local paths.  If any data URIs remain
 * (e.g. on a reentrant run before images were processed), they are
 * replaced with a placeholder to keep the output small.
 */
export function stripDocHtml(html) {
  let result = html;

  // --- Preserve bold semantics before stripping classes ---
  const boldClasses = extractBoldClasses(result);
  result = convertBoldClassesToTags(result, boldClasses);

  // --- Remove base64 data URIs that may still be present ---
  result = result.replace(/src="data:image\/[^;]+;base64,[A-Za-z0-9+/=]+"/gi, 'src="data:stripped"');

  // --- Remove <style> blocks (bulk of the CSS) ---
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // --- Remove <script> blocks ---
  result = result.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // --- Remove class attributes ---
  result = result.replace(/\s+class="[^"]*"/gi, '');

  // --- Remove style attributes ---
  result = result.replace(/\s+style="[^"]*"/gi, '');

  // --- Remove Google comment anchors ---
  // Superscript comment references: <sup><a href="#cmnt...">...</a></sup>
  result = result.replace(/<sup>\s*<a[^>]*href="#cmnt[^"]*"[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi, '');
  // Comment anchor targets: <a id="cmnt_ref...">, <a id="cmnt..."> and their parent <p>/<div>
  result = result.replace(/<p[^>]*>\s*<a[^>]*id="cmnt[^"]*"[^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');

  // --- Unwrap bare <span> elements (no attributes left) ---
  // Iterate because spans may be nested: <span><span>text</span></span>
  let prev;
  do {
    prev = result;
    result = result.replace(/<span>([\s\S]*?)<\/span>/g, '$1');
  } while (result !== prev);

  return result;
}
