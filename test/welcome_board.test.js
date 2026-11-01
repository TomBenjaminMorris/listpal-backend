"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { welcomeBoard, nextMondayAt5AM } = require("../src/welcome_board");
const { periodsContaining } = require("../src/score_periods");

// A Wednesday
const NOW = Date.UTC(2026, 10, 4, 12);
const { board, tasks } = welcomeBoard("u#new", NOW);
const ticked = tasks.filter(task => task.completedDate !== "nil");
const unticked = tasks.filter(task => task.completedDate === "nil");

test("the board's ticked tasks count towards every score period, so its scores match them", () => {
  assert.ok(ticked.length > 0);
  assert.equal(board.score, ticked.length);
  ticked.forEach(task => {
    assert.deepEqual(periodsContaining(Number(task.completedDate), NOW), ["WScore", "MScore", "YScore"]);
  });
});

test("the weekly target is one tick away, so the user's first tick reaches it", () => {
  assert.equal(board.score, 3);
  assert.equal(board.weeklyTarget, 4);
});

test("a ticked task expires as a real tick does", () => {
  const expiry = Date.UTC(2026, 10, 9, 5);
  ticked.forEach(task => {
    assert.equal(task.expiryDate, String(expiry));
    assert.equal(task.expiryDateTTL, expiry / 1000);
  });
});

test("an unticked task never expires", () => {
  assert.ok(unticked.length > 0);
  unticked.forEach(task => {
    assert.equal(task.expiryDate, "nil");
    assert.equal(task.expiryDateTTL, 0);
  });
});

test("every category has a task left to tick, and one emoji for its card", () => {
  JSON.parse(board.categoryOrder).forEach(category => {
    const inCategory = tasks.filter(task => task.category === category);
    assert.ok(inCategory.some(task => task.completedDate === "nil"), category);
    assert.equal(new Set(inCategory.map(task => task.emoji)).size, 1, category);
  });
});

test("the category order lists every category exactly once", () => {
  const order = JSON.parse(board.categoryOrder);
  assert.equal(new Set(order).size, order.length);
  assert.deepEqual([...new Set(tasks.map(task => task.category))].sort(), [...order].sort());
});

test("tasks have their own IDs and keep their listed order", () => {
  assert.equal(new Set(tasks.map(task => task.taskID)).size, tasks.length);
  assert.ok(tasks.every(task => /^t#[0-9a-f-]{36}$/.test(task.taskID)));
  assert.equal(new Set(tasks.map(task => task.createdDate)).size, tasks.length);
  tasks.slice(1).forEach((task, i) => assert.ok(Number(task.createdDate) > Number(tasks[i].createdDate)));
});

test("links are https, as the task menu requires", () => {
  const links = tasks.map(task => task.link).filter(Boolean);
  assert.ok(links.length > 0);
  links.forEach(link => assert.ok(link.startsWith("https://"), link));
});

test("setup stays within DynamoDB's limit of 100 items in a transaction", () => {
  assert.ok(tasks.length + 2 <= 100);
});

test("two sign-ups get different task IDs", () => {
  const other = welcomeBoard("u#other", NOW);
  assert.equal(other.board.boardID, "b#u#other");
  assert.notEqual(other.tasks[0].taskID, tasks[0].taskID);
});

test("nextMondayAt5AM picks the coming Monday, or next week's once this Monday's 5 AM has passed", () => {
  const monday = Date.UTC(2026, 10, 9, 5);
  assert.equal(nextMondayAt5AM(Date.UTC(2026, 10, 3, 9)), monday, "Tuesday");
  assert.equal(nextMondayAt5AM(Date.UTC(2026, 10, 8, 23)), monday, "Sunday");
  assert.equal(nextMondayAt5AM(Date.UTC(2026, 10, 9, 4, 59)), monday, "Monday before 5 AM");
  assert.equal(nextMondayAt5AM(monday), Date.UTC(2026, 10, 16, 5), "Monday at 5 AM");
  assert.equal(nextMondayAt5AM(Date.UTC(2026, 11, 30, 12)), Date.UTC(2027, 0, 4, 5), "across a new year");
});
