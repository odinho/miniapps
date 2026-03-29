/**
 * Global data: current build time (ISO string)
 * Used to show "last updated" on the front page
 */
export default function() {
  return new Date().toISOString();
}
