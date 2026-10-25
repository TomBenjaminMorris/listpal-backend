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

test("an update to a deleted task reports gone and writes nothing", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("update", { Description: "Edited after delete" })]);

  assert.equal(result.results[0].status, "gone");
  assert.equal(inputs(mock, UpdateItemCommand).length, 0);
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

test("a delete is applied without touching scores", async () => {
  const { client, mock } = setup();
  const result = await sync(client, [op("delete")]);

  assert.equal(result.results[0].status, "applied");
  assert.equal(inputs(mock, DeleteItemCommand).length, 1);
  assert.equal(inputs(mock, TransactWriteItemsCommand).length, 0);
});

test("validateSyncBody rejects missing and oversized batches", () => {
  assert.throws(() => validateSyncBody({}), ValidationError);
  assert.throws(() => validateSyncBody({ ops: new Array(MAX_OPS + 1).fill(op("delete")) }), ValidationError);
  assert.equal(validateSyncBody({ ops: [] }).length, 0);
});
