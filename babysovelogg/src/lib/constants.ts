/** Mood options for sleep tagging */
export const MOODS = [
  { value: "happy", label: "😊", title: "Glad" },
  { value: "normal", label: "😐", title: "Normal" },
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
  happy: "😊",
  normal: "😐",
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
  "5-15": "5–15 min",
  "15-30": "15–30 min",
  "30+": "30+ min",
};

export const FALL_ASLEEP_BUCKETS = [
  { value: "<5", label: "< 5 min" },
  { value: "5-15", label: "5–15 min" },
  { value: "15-30", label: "15–30 min" },
  { value: "30+", label: "30+ min" },
] as const;
