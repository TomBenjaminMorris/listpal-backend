"use strict";
const { randomUUID } = require("node:crypto");

const NIL = "nil";

// The cards appear in this order. A card takes its emoji from its tasks, so each category has just one.
const CATEGORIES = [
  {
    name: "Getting started",
    emoji: "💡",
    tasks: [
      { description: "This is an example board: edit anything, or delete it when you're ready to make your own", important: true },
      { description: "Tick a task to add to your weekly, monthly and yearly scores" },
      { description: "Ticked tasks clear themselves the following Monday" },
      { description: "Open a task's menu to mark it as important or add a link" }
    ]
  },
  {
    name: "Home",
    emoji: "🏠",
    tasks: [
      { description: "Put the bins out", done: true },
      { description: "Book the boiler service", important: true },
      { description: "Fix the dripping kitchen tap" },
      { description: "Find a recipe to try this weekend", link: "https://www.bbcgoodfood.com/recipes" }
    ]
  },
  {
    name: "Work",
    emoji: "💼",
    tasks: [
      { description: "Book annual leave for the summer", done: true },
      { description: "Finish the slides for Thursday's meeting", important: true },
      { description: "Reply to the project update email" },
      { description: "Arrange a catch-up with the team" }
    ]
  },
  {
    name: "Health",
    emoji: "🏃",
    tasks: [
      { description: "Go for a 30-minute walk", done: true },
      { description: "Book a dentist check-up" },
      { description: "Get to bed by 10:30 three nights this week" },
      { description: "Read the NHS guide to staying active", link: "https://www.nhs.uk/live-well/exercise/" }
    ]
  },
  {
    name: "Someday",
    emoji: "🌱",
    tasks: [
      { description: "Plan a weekend away" },
      { description: "Learn ten phrases of Spanish" },
      { description: "Sort through the old photos" }
    ]
  }
];

// The rule the frontend applies to a tick (getNextMondayAt5AM), in UTC because the Lambda doesn't know the user's timezone
function nextMondayAt5AM(nowMs) {
  const now = new Date(nowMs);
  const [year, month, date] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  let days = (1 - now.getUTCDay() + 7) % 7;
  if (days === 0 && nowMs >= Date.UTC(year, month, date, 5)) days = 7;
  return Date.UTC(year, month, date + days, 5);
}

function welcomeBoard(userID, nowMs) {
  const boardID = "b#" + userID;
  const expiry = nextMondayAt5AM(nowMs);
  let order = 0;

  const tasks = CATEGORIES.flatMap(category => category.tasks.map(task => ({
    taskID: "t#" + randomUUID(),
    boardID,
    category: category.name,
    emoji: category.emoji,
    description: task.description,
    important: task.important ? "true" : "false",
    link: task.link ?? "",
    // A card lists its unticked tasks by CreatedDate, so each one needs its own
    createdDate: String(nowMs + order++),
    completedDate: task.done ? String(nowMs) : NIL,
    expiryDate: task.done ? String(expiry) : NIL,
    expiryDateTTL: task.done ? Math.trunc(expiry / 1000) : 0
  })));

  // Scores match the ticked tasks, as they do for real ticks, so unticking one takes its point back off
  const score = tasks.filter(task => task.completedDate !== NIL).length;

  return {
    board: {
      boardID,
      boardName: "Welcome",
      emoji: "👋",
      categoryOrder: JSON.stringify(CATEGORIES.map(category => category.name)),
      score,
      // One tick short, so the user's first tick shows the confetti
      weeklyTarget: score + 1
    },
    tasks
  };
}

module.exports = { welcomeBoard, nextMondayAt5AM };
