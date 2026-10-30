"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const {
  DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, TransactWriteItemsCommand
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { syncTasks, validateSyncBody, ValidationError, MAX_OPS } = require("../src/task_sync");

const USER = "u#user";
const BOARD = "b#board";
const TABLE = "ListPal-Test";
const WEDNESDAY = Date.parse("2026-10-28T12:00:00Z");
const THIS_WEEK = String(Date.parse("2026-10-27T09:00:00Z"));

function setup({ board = { WScore: 3, MScore: 5, YScore: 9 }, task } = {}) {
  const client = new DynamoDBClient({ region: "eu-west-2" });
  const mock = mockClient(client);
  mock.on(QueryCommand).resolves({ Items: [marshall({ SK: BOARD, ...board })] });
  mock.on(GetItemCommand).resolves(task ? { Item: marshall({ PK: USER, SK: "t#1", "GSI1-PK": BOARD, ...task }) } : {});
  mock.on(PutItemCommand).resolves({});
  mock.on(UpdateItemCommand).resolves({});
  mock.on(DeleteItemCommand).resolves({});
  mock.on(TransactWriteItemsCommand).resolves({});
  return { client, mock };
}

const sync = (client, ops, now = WEDNESDAY) => syncTasks(client, TABLE, USER, ops, now);
const op = (kind, fields = {}, overrides = {}) => ({ opId: "t#1:1", SK: "t#1", boardID: BOARD, kind, fields, ...overrides });
const inputs = (mock, command) => mock.commandCalls(command).map(call => call.args[0].input);
const scoreUpdate = transactInput => transactInput.TransactItems[1].Update;
const delay = ms => new Promise(resolve => setTimeout(() => resolve({}), ms));

const conditionalCheckFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

function conditionFailure() {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }]
  });
}

test("a create keeps every field, including completion", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("create", {
    Description: "Buy milk", Important: "true", Link: "https://example.com",
    CompletedDate: THIS_WEEK, ExpiryDate: "1793000000000", "GSI1-SK": "1793000000000", ExpiryDateTTL: 1793000000
  })]);

  assert.equal(result.results[0].status, "applied");
  const [transaction] = inputs(mock, TransactWriteItemsCommand);
  const item = unmarshall(transaction.TransactItems[0].Put.Item);
  assert.equal(item.Important, "true");
  assert.equal(item.Link, "https://example.com");
  assert.equal(item.CompletedDate, THIS_WEEK);
  assert.equal(item.PK, USER);
  assert.equal(item["GSI1-PK"], BOARD);
  assert.equal(scoreUpdate(transaction).UpdateExpression, "ADD #s0 :delta, #s1 :delta, #s2 :delta");
  assert.equal(unmarshall(scoreUpdate(transaction).ExpressionAttributeValues)[":delta"], 1);
});

test("a create that is not completed is a plain put and leaves scores alone", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("create", { Description: "New" })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
  assert.equal(unmarshall(inputs(mock, PutItemCommand)[0].Item).CompletedDate, "nil");
  assert.deepEqual(result.boards, []);
});

test("a retried create whose first attempt landed is applied as an update without double counting", async () => {
  const { client, mock } = setup({ task: { CompletedDate: THIS_WEEK, Description: "Old" } });
  mock.on(TransactWriteItemsCommand).rejects(conditionFailure());

  const result = await sync(client, [op("create", { Description: "New", CompletedDate: THIS_WEEK, CreatedDate: "1" })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 1);
  const [update] = inputs(mock, UpdateItemCommand);
  assert.ok(!Object.values(update.ExpressionAttributeNames).includes("CreatedDate"));
  assert.ok(update.UpdateExpression.startsWith("SET"));
});

test("ticking a task adds to the scores in the same transaction and returns the new scores", async () => {
  const { client, mock } = setup({ task: { CompletedDate: "nil" } });
  mock.on(QueryCommand)
    .resolvesOnce({ Items: [marshall({ SK: BOARD, WScore: 3, MScore: 5, YScore: 9 })] })
    .resolves({ Items: [marshall({ SK: BOARD, WScore: 4, MScore: 6, YScore: 10 })] });

  const result = await sync(client, [op("update", { CompletedDate: THIS_WEEK, "GSI1-SK": "1793000000000" })]);

  assert.equal(result.results[0].status, "applied");
  const [transaction] = inputs(mock, TransactWriteItemsCommand);
  assert.equal(unmarshall(transaction.TransactItems[0].Update.ExpressionAttributeValues)[":expectedCompleted"], "nil");
  assert.deepEqual(result.boards, [{ SK: BOARD, WScore: 4, MScore: 6, YScore: 10 }]);
});

test("a retried tick does not count twice", async () => {
  const { client, mock } = setup({ task: { CompletedDate: THIS_WEEK } });
  const result = await sync(client, [op("update", { CompletedDate: THIS_WEEK })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
  assert.equal(inputs(mock, UpdateItemCommand).length, 1);
  // The client may have read scores before the first attempt landed, so it still gets the current ones
  assert.deepEqual(result.boards, [{ SK: BOARD, WScore: 3, MScore: 5, YScore: 9 }]);
});

test("an update that does not touch completion reports no scores", async () => {
  const { client } = setup({ task: { CompletedDate: "nil" } });
  const result = await sync(client, [op("update", { Description: "Typing" })]);

  assert.deepEqual(result.boards, []);
});

test("an update that does not touch completion is one conditional write", async () => {
  const { client, mock } = setup({ task: { CompletedDate: "nil" } });
  const result = await sync(client, [op("update", { Description: "Typing" })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, GetItemCommand).length, 0);
  const updates = inputs(mock, UpdateItemCommand);
  assert.equal(updates.length, 1);
  assert.ok(!Object.values(updates[0].ExpressionAttributeNames).includes("CompletedDate"));
});

test("an update to a deleted task reports gone and cannot recreate it", async () => {
  const { client, mock } = setup();
  mock.on(UpdateItemCommand).rejects(conditionalCheckFailed());
  const result = await sync(client, [op("update", { Description: "Edited after delete" })]);

  assert.equal(result.results[0].status, "gone");
  assert.equal(inputs(mock, GetItemCommand).length, 0);
  const updates = inputs(mock, UpdateItemCommand);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ConditionExpression, "attribute_exists(SK)");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
});

test("unticking a task from before the month reset only takes the point back from the periods it counted in", async () => {
  const completedSunday = String(Date.parse("2026-11-01T12:00:00Z"));
  const { client, mock } = setup({ task: { CompletedDate: completedSunday } });
  const tuesday = Date.parse("2026-11-03T10:00:00Z");

  await sync(client, [op("update", { CompletedDate: "nil" })], tuesday);

  const update = scoreUpdate(inputs(mock, TransactWriteItemsCommand)[0]);
  assert.deepEqual(Object.values(update.ExpressionAttributeNames), ["MScore", "YScore"]);
  assert.equal(unmarshall(update.ExpressionAttributeValues)[":delta"], -1);
  assert.match(update.ConditionExpression, /#s0 > :zero And #s1 > :zero/);
});

test("unticking never takes a score below zero", async () => {
  const { client, mock } = setup({ board: { WScore: 0, MScore: 0, YScore: 0 }, task: { CompletedDate: THIS_WEEK } });
  const result = await sync(client, [op("update", { CompletedDate: "nil" })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
  assert.equal(inputs(mock, UpdateItemCommand).length, 1);
});

test("a task that keeps changing under the update is reported as a conflict", async () => {
  const { client, mock } = setup({ task: { CompletedDate: "nil" } });
  mock.on(TransactWriteItemsCommand).rejects(conditionFailure());

  const result = await sync(client, [op("update", { CompletedDate: THIS_WEEK })]);

  assert.equal(result.results[0].status, "conflict");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 2);
});

test("ops for a board the user does not own are rejected without writing", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("create", { Description: "Sneaky" }, { boardID: "b#someone-else" })]);

  assert.equal(result.results[0].status, "rejected");
  assert.equal(inputs(mock, PutItemCommand).length, 0);
});

test("fields outside the allow-list are rejected", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("create", { PK: "u#someone-else" })]);

  assert.equal(result.results[0].status, "rejected");
  assert.equal(inputs(mock, PutItemCommand).length, 0);
});

test("a transient DynamoDB error asks the client to retry and does not stop the batch", async () => {
  const { client, mock } = setup();
  mock.on(PutItemCommand)
    .rejectsOnce(Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" }))
    .resolves({});

  const result = await sync(client, [op("create"), op("create", {}, { opId: "t#2:1", SK: "t#2" })]);

  assert.deepEqual(result.results.map(r => r.status), ["retry", "applied"]);
});

test("results keep request order when an earlier op finishes later", async () => {
  const { client, mock } = setup();
  mock.on(UpdateItemCommand, { Key: marshall({ PK: USER, SK: "t#1" }) }).callsFake(() => delay(20));
  const ops = ["t#1", "t#2", "t#3"].map(SK => op("update", { Category: "Renamed" }, { opId: `${SK}:1`, SK }));

  const result = await sync(client, ops);

  assert.deepEqual(result.results.map(r => r.SK), ["t#1", "t#2", "t#3"]);
  assert.deepEqual(result.results.map(r => r.status), ["applied", "applied", "applied"]);
});

test("ops that change scores still run one at a time alongside other ops", async () => {
  const { client, mock } = setup({ task: { CompletedDate: "nil" } });
  const events = [];
  mock.on(TransactWriteItemsCommand).callsFake(async () => {
    events.push("start");
    await delay(10);
    events.push("end");
    return {};
  });
  const ops = [
    op("update", { CompletedDate: THIS_WEEK }),
    op("update", { Category: "Renamed" }, { opId: "t#2:1", SK: "t#2" }),
    op("update", { CompletedDate: THIS_WEEK }, { opId: "t#3:1", SK: "t#3" })
  ];

  const result = await sync(client, ops);

  assert.deepEqual(result.results.map(r => r.status), ["applied", "applied", "applied"]);
  assert.deepEqual(events, ["start", "end", "start", "end"]);
  assert.deepEqual(result.boards.map(board => board.SK), [BOARD]);
});

test("repeated ops on one task apply in request order", async () => {
  const { client, mock } = setup();
  const events = [];
  mock.on(UpdateItemCommand).callsFake(async input => {
    const Description = unmarshall(input.ExpressionAttributeValues)[":f0"];
    events.push(`start ${Description}`);
    // The first write is slower, so running them together would finish out of order
    await delay(Description === "a" ? 20 : 0);
    events.push(`end ${Description}`);
    return {};
  });
  const ops = [op("update", { Description: "a" }), op("update", { Description: "b" }, { opId: "t#1:2" })];

  const result = await sync(client, ops);

  assert.deepEqual(result.results.map(r => r.opId), ["t#1:1", "t#1:2"]);
  assert.deepEqual(events, ["start a", "end a", "start b", "end b"]);
});

test("a delete is applied without touching scores", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("delete")]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, DeleteItemCommand).length, 1);
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
});

const boardOp = (fields, overrides = {}) => ({ opId: `${BOARD}:1`, SK: BOARD, boardID: BOARD, kind: "update", fields, ...overrides });

test("a board update writes every allowed field in one conditional write", async () => {
  const { client, mock } = setup();
  const fields = { Board: "Home", Emoji: "🏡", CategoryOrder: JSON.stringify(["Garden", "Kitchen"]), WTarget: 5, MTarget: 20, YTarget: 200 };

  const result = await sync(client, [boardOp(fields)]);

  assert.deepEqual(result.results, [{ opId: `${BOARD}:1`, SK: BOARD, status: "applied" }]);
  const [update] = inputs(mock, UpdateItemCommand);
  assert.deepEqual(unmarshall(update.Key), { PK: USER, SK: BOARD });
  assert.equal(update.ConditionExpression, "attribute_exists(SK)");
  const written = Object.fromEntries(Object.entries(update.ExpressionAttributeNames)
    .map(([alias, name]) => [name, unmarshall(update.ExpressionAttributeValues)[alias.replace("#", ":")]]));
  assert.deepEqual(written, fields);
  assert.equal(update.ExpressionAttributeValues[":f3"].N, "5");
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
});

test("board ops with bad fields, kinds or IDs are rejected without writing", async () => {
  const { client, mock } = setup();
  const bad = [
    boardOp({ Board: "" }),
    boardOp({ Board: 3 }),
    boardOp({ Emoji: null }),
    boardOp({ CategoryOrder: "not json" }),
    boardOp({ CategoryOrder: "[1, 2]" }),
    boardOp({ CategoryOrder: "{}" }),
    boardOp({ CategoryOrder: ["Garden"] }),
    boardOp({ WTarget: 0 }),
    boardOp({ MTarget: 1.5 }),
    boardOp({ YTarget: "365" }),
    boardOp({ WScore: 99 }),
    boardOp({ PK: "u#someone-else" }),
    boardOp({ constructor: "x" }),
    boardOp([]),
    boardOp({ Board: "Home" }, { kind: "delete" }),
    boardOp({ Board: "Home" }, { boardID: "b#other" }),
    boardOp({ Board: "Home" }, { SK: "b#", boardID: "b#" })
  ];

  const result = await sync(client, bad);

  result.results.forEach(r => assert.equal(r.status, "rejected", JSON.stringify(r)));
  assert.equal(inputs(mock, UpdateItemCommand).length, 0);
});

test("a board update for a deleted board reports gone and creates nothing", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [boardOp({ Emoji: "🗑️" }, { SK: "b#deleted", boardID: "b#deleted" })]);

  assert.equal(result.results[0].status, "gone");
  assert.equal(inputs(mock, UpdateItemCommand).length, 0);
});

test("a board deleted after the boards were read reports gone", async () => {
  const { client, mock } = setup();
  mock.on(UpdateItemCommand).rejects(conditionalCheckFailed());
  const result = await sync(client, [boardOp({ Emoji: "🗑️" })]);

  assert.equal(result.results[0].status, "gone");
  assert.equal(inputs(mock, UpdateItemCommand)[0].ConditionExpression, "attribute_exists(SK)");
});

test("a board update with no fields is applied without writing", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [boardOp({})]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, UpdateItemCommand).length, 0);
});

test("board ops finish before task ops start, so a tick and a category order change on one board both apply", async () => {
  const { client, mock } = setup({ task: { CompletedDate: "nil" } });
  const events = [];
  mock.on(UpdateItemCommand).callsFake(async input => {
    const SK = unmarshall(input.Key).SK;
    events.push(`start ${SK}`);
    await delay(SK === BOARD ? 20 : 0);
    events.push(`end ${SK}`);
    return {};
  });
  mock.on(TransactWriteItemsCommand).callsFake(async () => {
    events.push("start tick");
    events.push("end tick");
    return {};
  });
  const ops = [
    op("update", { CompletedDate: THIS_WEEK }),
    op("update", { Description: "Typing" }, { opId: "t#2:1", SK: "t#2" }),
    boardOp({ CategoryOrder: JSON.stringify(["Garden"]) })
  ];

  const result = await sync(client, ops);

  assert.deepEqual(result.results.map(r => [r.SK, r.status]), [["t#1", "applied"], ["t#2", "applied"], [BOARD, "applied"]]);
  assert.deepEqual(events.slice(0, 2), [`start ${BOARD}`, `end ${BOARD}`]);
  assert.ok(events.includes("start tick"));
});

test("repeated board ops apply in request order", async () => {
  const { client, mock } = setup();
  const events = [];
  mock.on(UpdateItemCommand).callsFake(async input => {
    const Board = unmarshall(input.ExpressionAttributeValues)[":f0"];
    events.push(`start ${Board}`);
    await delay(Board === "a" ? 20 : 0);
    events.push(`end ${Board}`);
    return {};
  });

  await sync(client, [boardOp({ Board: "a" }), boardOp({ Board: "b" }, { opId: `${BOARD}:2` })]);

  assert.deepEqual(events, ["start a", "end a", "start b", "end b"]);
});

const NEW_BOARD = "b#new";
const boardCreate = (fields = { Board: "Garden" }, overrides = {}) =>
  ({ opId: `${NEW_BOARD}:1`, SK: NEW_BOARD, boardID: NEW_BOARD, kind: "create", fields, ...overrides });

test("a board create writes a whole board with defaults, only if it doesn't exist", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [boardCreate({ Board: "Garden", Emoji: "🌱" })]);

  assert.equal(result.results[0].status, "applied");
  const [put] = inputs(mock, PutItemCommand);
  assert.equal(put.ConditionExpression, "attribute_not_exists(SK)");
  assert.deepEqual(unmarshall(put.Item), {
    PK: USER, SK: NEW_BOARD, EntityType: "Board", "GSI1-PK": "b#", "GSI1-SK": NEW_BOARD,
    Board: "Garden", Emoji: "🌱", CategoryOrder: "[]",
    WScore: 0, MScore: 0, YScore: 0, WTarget: 7, MTarget: 31, YTarget: 365
  });
});

test("a board create and tasks for it in one batch all apply, the board first", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [
    op("create", { Description: "First task", CompletedDate: THIS_WEEK }, { boardID: NEW_BOARD }),
    boardCreate()
  ]);

  assert.deepEqual(result.results.map(r => [r.SK, r.status]), [["t#1", "applied"], [NEW_BOARD, "applied"]]);
  assert.equal(unmarshall(inputs(mock, PutItemCommand)[0].Item).SK, NEW_BOARD);
  const [transaction] = inputs(mock, TransactWriteItemsCommand);
  assert.equal(unmarshall(transaction.TransactItems[0].Put.Item)["GSI1-PK"], NEW_BOARD);
  assert.deepEqual(unmarshall(scoreUpdate(transaction).Key), { PK: USER, SK: NEW_BOARD });
});

test("a resent board create applies its fields without resetting the scores", async () => {
  const { client, mock } = setup();
  mock.on(QueryCommand).resolves({ Items: [marshall({ SK: NEW_BOARD, WScore: 4, MScore: 4, YScore: 4 })] });
  const result = await sync(client, [boardCreate({ Board: "Garden renamed" })]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, PutItemCommand).length, 0);
  const [update] = inputs(mock, UpdateItemCommand);
  assert.equal(update.ConditionExpression, "attribute_exists(SK)");
  assert.deepEqual(Object.values(update.ExpressionAttributeNames), ["Board"]);
});

test("a board created by another request since the read is updated instead", async () => {
  const { client, mock } = setup();
  mock.on(QueryCommand)
    .resolvesOnce({ Items: [] })
    .resolves({ Items: [marshall({ SK: NEW_BOARD, WScore: 2, MScore: 2, YScore: 2 })] });
  mock.on(PutItemCommand).rejects(conditionalCheckFailed());
  const result = await sync(client, [boardCreate()]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, UpdateItemCommand).length, 1);
});

test("a board create needs a name and only allowed fields", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [
    boardCreate({ Emoji: "🌱" }),
    boardCreate({ Board: "" }),
    boardCreate({ Board: "Garden", WScore: 99 }),
    boardCreate({ Board: "Garden" }, { boardID: BOARD })
  ]);

  result.results.forEach(r => assert.equal(r.status, "rejected", JSON.stringify(r)));
  assert.equal(inputs(mock, PutItemCommand).length, 0);
});

test("tasks for a board that is neither stored nor created in the batch are still rejected", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("create", {}, { boardID: "b#elsewhere" })]);

  assert.deepEqual(result.results.map(r => [r.status, r.reason]), [["rejected", "unknown board"]]);
  assert.equal(inputs(mock, PutItemCommand).length, 0);
});

test("validateSyncBody rejects missing and oversized batches", () => {
  assert.throws(() => validateSyncBody({}), ValidationError);
  assert.throws(() => validateSyncBody({ ops: new Array(MAX_OPS + 1).fill(op("delete")) }), ValidationError);
  assert.equal(validateSyncBody({ ops: [] }).length, 0);
});
