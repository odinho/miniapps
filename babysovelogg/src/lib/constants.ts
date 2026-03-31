/** Mood options for sleep tagging */
export const MOODS = [
  { value: "normal", label: "😊", title: "Normal" },
  { value: "upset", label: "😢", title: "Uroleg" },
  { value: "fighting", label: "😤", title: "Kjempa mot" },
] as const;

/** Sleep method options */
export const METHODS = [
  { value: "bed", label: "🛏️", title: "I senga" },
  { value: "nursing", label: "🤱", title: "Amming" },
  { value: "held", label: "🤗", title: "Boren" },
  { value: "stroller", label: "🚼", title: "Vogn" },
  { value: "car", label: "🚗", title: "Bil" },
  { value: "bottle", label: "🍼", title: "Flaske" },
] as const;

export const MOOD_EMOJI: Record<string, string> = {
  normal: "😊",
  upset: "😢",
  fighting: "😤",
};

export const METHOD_EMOJI: Record<string, string> = {
  bed: "🛏️",
  nursing: "🤱",
  held: "🤗",
  stroller: "🚼",
  car: "🚗",
  bottle: "🍼",
};

export const FALL_ASLEEP_LABELS: Record<string, string> = {
  "<5": "< 5 min",
  "5-20": "5–20 min",
  "20+": "20+ min",
};

export const FALL_ASLEEP_BUCKETS = [
  { value: "<5", label: "< 5 min" },
  { value: "5-20", label: "5–20 min" },
  { value: "20+", label: "20+ min" },
] as const;

/** Wake mood options — assessed ~5 min after waking, not the initial cry. */
export const WAKE_MOODS = [
  { value: "happy", label: "😊", title: "Blid" },
  { value: "tired", label: "😴", title: "Trøytt" },
  { value: "cranky", label: "😫", title: "Gretten" },
] as const;

export const WAKE_MOOD_EMOJI: Record<string, string> = {
  happy: "😊",
  tired: "😴",
  cranky: "😫",
};
