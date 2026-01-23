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

  // Smart date range filter - if same month/year, only show full date at end
  eleventyConfig.addFilter("datoSpenn", (startDateStr, endDateStr) => {
    if (!startDateStr || !endDateStr) return '';
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    const months = [
      'januar', 'februar', 'mars', 'april', 'mai', 'juni',
      'juli', 'august', 'september', 'oktober', 'november', 'desember'
    ];

    // If same month and year, show: "21. – 26. januar 2026"
    if (startDate.getMonth() === endDate.getMonth() &&
        startDate.getFullYear() === endDate.getFullYear()) {
      return `${startDate.getDate()}. – ${endDate.getDate()}. ${months[endDate.getMonth()]} ${endDate.getFullYear()}`;
    }

    // If same year but different month, show: "21. januar – 5. februar 2026"
    if (startDate.getFullYear() === endDate.getFullYear()) {
      return `${startDate.getDate()}. ${months[startDate.getMonth()]} – ${endDate.getDate()}. ${months[endDate.getMonth()]} ${endDate.getFullYear()}`;
    }

    // Different years, show both full dates: "21. januar 2025 – 5. februar 2026"
    return `${startDate.getDate()}. ${months[startDate.getMonth()]} ${startDate.getFullYear()} – ${endDate.getDate()}. ${months[endDate.getMonth()]} ${endDate.getFullYear()}`;
  });

  // Calculate days between first and last date, capped at today
  eleventyConfig.addFilter("countDays", (days) => {
    if (!days || !Array.isArray(days)) return 0;
    const daysWithDates = days.filter(d => d.date);
    if (daysWithDates.length === 0) return 0;

    const firstDate = new Date(daysWithDates[0].date);

    // For the last date, use endDate if it's a range, otherwise use date
    const lastDay = daysWithDates[daysWithDates.length - 1];
    const lastDate = new Date(lastDay.endDate || lastDay.date);
    const today = new Date();

    firstDate.setHours(0, 0, 0, 0);
    lastDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    const endDate = lastDate < today ? lastDate : today;
    const diffTime = endDate - firstDate;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include both start and end day

    return diffDays > 0 ? diffDays : 0;
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
