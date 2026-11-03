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
// before tones apart from its emoji rule. Only concise keeps "never longer", and only playful may add flavour or an emoji.
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
  },
  playful: {
    lines: "Start each line with a verb and say exactly what to do, with a light, witty touch. A line may be a few words longer for flavour, but never split a line into several.",
    // Flavour, never facts: the reword saves at once, so an invented detail would read as a different task. A list of
    // fun verbs here was copied ("Conquer" on three of five tasks), and without it the wording came out garbled
    // ("Cherish mum with a bouquet buy"), so it asks for plain wording over awkward fun, with more examples to copy from
    style: "Add flavour through word choice, different for each task, using real, everyday words and correct grammar. If a fun wording doesn't read naturally, use a plain one. Never put a fun verb in front of the original words. Flavour sets the mood but never says what happens: \"gym\" may become \"Brave the gym\", never \"Go to the gym for leg day\". The line must still say plainly what to do.",
    emoji: "Keep any emoji the task has, and add at most one more per line, at its end",
    examples: ["Fire off an email to the landlord 📧", "Brave a call to the bank about the card ☎️", "Round up plates, cups and forks for the party 🎉", "Give the fence a fresh coat of paint 🎨\nHunt down some brushes first"],
    extraExamples: [
      [{ task_lines: ["hoover stairs"], category: "Cleaning", board: "Home" }, "Treat the stairs to a good hoover 🧹"],
      [{ task_lines: ["reply to emails"], category: "Inbox", board: "Work" }, "Clear the decks and answer those emails 📬"],
      [{ task_lines: ["return library books"], category: "Errands", board: "Town" }, "Send the library books back home 📚"]
    ]
  }
};

module.exports = { DEFAULT_REWORD_TONE, EXAMPLE_TASKS, REWORD_TONES };
