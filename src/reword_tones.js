"use strict";

// Missing or unknown tones fall back to this, so a client from before tones existed gets it too
const DEFAULT_REWORD_TONE = "casual";

// The rule from before tones, "no emoji unless the task has them", let formal and concise drop a task's own emoji in
// live runs on 3 Nov 2026
const KEEP_EMOJI = "Keep any emoji the task has and add none";

// The examples are deliberately unlike real test tasks, so a test run shows the rules working rather than an echo.
// Every tone rewords the same four, so the examples show the difference between tones rather than between tasks.
const EXAMPLE_TASKS = [
  { task_lines: ["email"], category: "Landlord", board: "Flat" },
  { task_lines: ["make a phone call to the bank about the card"], category: "Money", board: "Admin" },
  { task_lines: ["plates cups forks"], category: "Party", board: "Home" },
  { task_lines: ["paint fence", "get brushes first"], category: "Garden", board: "Home" }
];

// Each tone fills the same slots in the shared prompt in src/reword.js. Concise, with no style, is the prompt from
// before tones apart from its emoji rule. Only concise keeps "never longer".
// A playful tone was tried and dropped on 3 Nov 2026, as gpt-5-nano at minimal reasoning invented words and added
// details however the prompt was put. See "Tones" in ARCHITECTURE.md before bringing it back.
const REWORD_TONES = {
  casual: {
    lines: "Start each line with a verb and say exactly what to do, in everyday words. A line may be a word or two longer if that reads more naturally, but never split a line into several.",
    // Casual is the default, so it stays plain rather than chatty
    style: "Sound like a note to a friend: everyday words and contractions, such as \"ring\", \"grab\" or \"pick up\" rather than \"telephone\", \"obtain\" or \"purchase\". Stay plain, with no jokes, flourishes or added colour.",
    emoji: KEEP_EMOJI,
    examples: ["Drop the landlord an email", "Give the bank a ring about the card", "Pick up plates, cups and forks", "Get the fence painted\nGrab some brushes first"]
  },
  concise: {
    lines: "Start each line with a verb and say exactly what to do, in as few words as possible. Never make a line longer just to change its wording, and never split a line into several.",
    emoji: KEEP_EMOJI,
    examples: ["Email the landlord", "Call the bank about the card", "Get plates, cups and forks", "Paint the fence\nBuy brushes first"]
  },
  formal: {
    lines: "Start each line with a verb and say exactly what to do, in complete, precise wording. A line may be a few words longer, but never split a line into several.",
    style: "Sound like an item in a work plan: precise, professional words, with no slang or contractions. Never add courtesy phrases such as \"please\" or \"kindly\": it is still a to-do item, not a letter.",
    emoji: KEEP_EMOJI,
    examples: ["Contact the landlord by email", "Telephone the bank regarding the card", "Obtain plates, cups and forks for the party", "Paint the garden fence\nPurchase brushes beforehand"]
  }
};

module.exports = { DEFAULT_REWORD_TONE, EXAMPLE_TASKS, REWORD_TONES };
