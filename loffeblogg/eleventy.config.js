/**
 * Eleventy configuration for Løffeblogg
 */

export default function(eleventyConfig) {
  // Copy static assets
  eleventyConfig.addPassthroughCopy("site/css");
  eleventyConfig.addPassthroughCopy({ "cache/images": "images" });

  // Nynorsk date filter
  eleventyConfig.addFilter("dato", (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const months = [
      'januar', 'februar', 'mars', 'april', 'mai', 'juni',
      'juli', 'august', 'september', 'oktober', 'november', 'desember'
    ];
    return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}`;
  });

  // Short date filter (day and month only)
  eleventyConfig.addFilter("kortdato", (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const months = [
      'jan', 'feb', 'mar', 'apr', 'mai', 'jun',
      'jul', 'aug', 'sep', 'okt', 'nov', 'des'
    ];
    return `${date.getDate()}. ${months[date.getMonth()]}`;
  });

  // Slugify filter
  eleventyConfig.addFilter("slugify", (text) => {
    return text
      .toLowerCase()
      .replace(/[æå]/g, 'a')
      .replace(/ø/g, 'o')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  });

  // Use Nunjucks' built-in safe filter - no need to define our own

  return {
    dir: {
      input: "site",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
