"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand, BatchWriteItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");

const mock = mockClient(DynamoDBClient);
const { handler } = require("../src/handler");

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ sub: "user" })}.sig`;
const request = (routeKey, { body, params } = {}) => handler({
  routeKey,
  headers: { authorization: token },
  queryStringParameters: params,
  body: body && JSON.stringify(body)
});

test.beforeEach(() => {
  mock.reset();
  mock.on(QueryCommand).resolves({ Items: [marshall({ SK: "b#mine" })] });
  mock.on(GetItemCommand).resolves({});
  mock.on(GetItemCommand, { Key: { PK: { S: "u#user" }, SK: { S: "b#mine" } } }).resolves({ Item: marshall({ SK: "b#mine" }) });
  mock.on(DeleteItemCommand).resolves({});
});

test("POST /sync with a malformed body is a 400", async () => {
  const response = await request("POST /sync", { body: { ops: "not an array" } });
  assert.equal(response.statusCode, 400);
});

test("POST /sync returns per-op results in the data envelope", async () => {
  const response = await request("POST /sync", { body: { ops: [] } });
  assert.deepEqual(response, { data: { results: [], boards: [] } });
});

test("GET /active-tasks for another user's board is a 403", async () => {
  mock.on(QueryCommand, { IndexName: "GSI1" }).resolves({ Items: [marshall({ SK: "t#theirs", Description: "Private" })] });
  const response = await request("GET /active-tasks", { params: { boardID: "b#theirs" } });
  assert.equal(response.statusCode, 403);
  assert.doesNotMatch(response.body, /Private/);
});

test("GET /active-tasks for the user's own board returns its tasks", async () => {
  mock.on(QueryCommand, { IndexName: "GSI1" }).resolves({ Items: [marshall({ SK: "t#1", Description: "Mine" })] });
  const response = await request("GET /active-tasks", { params: { boardID: "b#mine" } });
  assert.deepEqual(response.data, [{ SK: "t#1", Description: "Mine" }]);
  assert.equal(mock.commandCalls(GetItemCommand).length, 1);
  assert.equal(mock.commandCalls(QueryCommand).length, 1);
});

test("GET /active-tasks without a boardID is a 400", async () => {
  const response = await request("GET /active-tasks");
  assert.equal(response.statusCode, 400);
});

test("a user item can't pass as a board", async () => {
  const response = await request("GET /active-tasks", { params: { boardID: "u#user" } });
  assert.equal(response.statusCode, 403);
  assert.equal(mock.commandCalls(QueryCommand).length, 0);
});

test("GET /active-tasks never queries the GSI1 partition holding every board", async () => {
  const response = await request("GET /active-tasks", { params: { boardID: "b#" } });
  assert.equal(response.statusCode, 403);
  assert.equal(mock.commandCalls(QueryCommand).length, 0);
});

test("POST /delete-board for another user's board is a 403 with nothing deleted", async () => {
  const response = await request("POST /delete-board", { body: { boardID: "b#theirs" } });
  assert.equal(response.statusCode, 403);
  assert.equal(mock.commandCalls(QueryCommand).length, 0);
  assert.equal(mock.commandCalls(BatchWriteItemCommand).length, 0);
  assert.equal(mock.commandCalls(DeleteItemCommand).length, 0);
});

const taskKeys = (from, count) => Array.from({ length: count }, (_, i) => ({ SK: { S: `t#${from + i}` } }));
const batchSizes = () => mock.commandCalls(BatchWriteItemCommand).map(call => Object.values(call.args[0].input.RequestItems)[0].length);

test("deleting a board deletes all its tasks in batches of 25, then the board", async t => {
  const lastKey = { PK: { S: "u#user" }, SK: { S: "t#30" }, "GSI1-PK": { S: "b#mine" }, "GSI1-SK": { S: "1" } };
  mock.on(QueryCommand, { IndexName: "GSI1" })
    .resolvesOnce({ Items: taskKeys(1, 30), LastEvaluatedKey: lastKey })
    .resolvesOnce({ Items: taskKeys(31, 5) });
  mock.on(BatchWriteItemCommand).resolves({});
  const log = t.mock.method(console, "log");

  const response = await request("POST /delete-board", { body: { boardID: "b#mine" } });

  assert.deepEqual(response, {});
  const queries = mock.commandCalls(QueryCommand).map(call => call.args[0].input);
  assert.equal(queries.length, 2);
  // No sort key condition, so expired tasks are included
  assert.equal(queries[0].KeyConditionExpression, "#pk = :pk");
  assert.deepEqual(queries[1].ExclusiveStartKey, lastKey);
  assert.deepEqual(batchSizes(), [25, 5, 5]);
  const deleted = mock.commandCalls(BatchWriteItemCommand).flatMap(call => Object.values(call.args[0].input.RequestItems)[0]);
  assert.deepEqual(deleted.map(r => r.DeleteRequest.Key.SK.S), taskKeys(1, 35).map(k => k.SK.S));
  assert.ok(deleted.every(r => r.DeleteRequest.Key.PK.S === "u#user"));
  const calls = mock.calls().map(call => call.args[0]);
  assert.ok(calls.at(-1) instanceof DeleteItemCommand);
  assert.deepEqual(calls.at(-1).input.Key, { PK: { S: "u#user" }, SK: { S: "b#mine" } });
  assert.equal(mock.commandCalls(DeleteItemCommand).length, 1);
  assert.equal(log.mock.callCount(), 0);
});

test("deleting a board resends unprocessed tasks", async () => {
  mock.on(QueryCommand, { IndexName: "GSI1" }).resolves({ Items: taskKeys(1, 3) });
  mock.on(BatchWriteItemCommand)
    .callsFakeOnce(input => {
      const [[table, requests]] = Object.entries(input.RequestItems);
      return { UnprocessedItems: { [table]: requests.slice(1) } };
    })
    .resolves({});

  const response = await request("POST /delete-board", { body: { boardID: "b#mine" } });

  assert.deepEqual(response, {});
  assert.deepEqual(batchSizes(), [3, 2]);
  const resent = Object.values(mock.commandCalls(BatchWriteItemCommand)[1].args[0].input.RequestItems)[0];
  assert.deepEqual(resent.map(r => r.DeleteRequest.Key.SK.S), ["t#2", "t#3"]);
  assert.equal(mock.commandCalls(DeleteItemCommand).length, 1);
});

test("deleting a board fails and keeps the board when tasks stay unprocessed", async t => {
  mock.on(QueryCommand, { IndexName: "GSI1" }).resolves({ Items: taskKeys(1, 3) });
  mock.on(BatchWriteItemCommand).callsFake(input => ({ UnprocessedItems: input.RequestItems }));
  t.mock.method(console, "error", () => {});

  const response = await request("POST /delete-board", { body: { boardID: "b#mine" } });

  assert.equal(response.statusCode, 500);
  assert.match(response.body, /3 tasks could not be deleted/);
  assert.deepEqual(batchSizes(), [3, 3, 3, 3, 3]);
  assert.equal(mock.commandCalls(DeleteItemCommand).length, 0);
});

test("POST /board-scores for another user's board is a 403 with nothing written", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#theirs", scores: { YScore: 1, MScore: 1, WScore: 1 } } });
  assert.equal(response.statusCode, 403);
  assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
});

test("POST /board-scores for the user's own board writes the scores", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#mine", scores: { YScore: 1, MScore: 1, WScore: 1 } } });
  assert.equal(response.statusCode, undefined);
  assert.equal(mock.commandCalls(UpdateItemCommand).length, 1);
});

test("POST /board-scores with a negative score is a 400", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#mine", scores: { YScore: 1, MScore: 1, WScore: -1 } } });
  assert.equal(response.statusCode, 400);
});

const TARGETS = { YTarget: 365, MTarget: 31, WTarget: 7 };
const settingRoutes = [
  ["POST /rename-board", { name: "Home" }],
  ["POST /board-emoji", { emoji: "🏡" }],
  ["POST /board-category-order", { categoryOrder: "[]" }],
  ["POST /board-targets", { targets: TARGETS }]
];
const conditionalCheckFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

for (const [route, fields] of settingRoutes) {
  test(`${route} writes only to an existing board`, async () => {
    mock.on(UpdateItemCommand).resolves({});
    const response = await request(route, { body: { boardID: "b#mine", ...fields } });

    assert.deepEqual(response, { data: {} });
    const [update] = mock.commandCalls(UpdateItemCommand).map(call => call.args[0].input);
    assert.deepEqual(update.Key, { PK: { S: "u#user" }, SK: { S: "b#mine" } });
    assert.equal(update.ConditionExpression, "attribute_exists(SK)");
  });

  test(`${route} for a deleted board is a 404`, async () => {
    mock.on(UpdateItemCommand).rejects(conditionalCheckFailed());
    const response = await request(route, { body: { boardID: "b#deleted", ...fields } });

    assert.equal(response.statusCode, 404);
  });

  test(`${route} can't write to the user item`, async () => {
    const response = await request(route, { body: { boardID: "u#user", ...fields } });

    assert.equal(response.statusCode, 403);
    assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
  });
}

test("POST /board-targets with a missing or zero target is a 400", async () => {
  for (const targets of [undefined, { YTarget: 365, MTarget: 31 }, { ...TARGETS, WTarget: 0 }, { ...TARGETS, MTarget: "lots" }]) {
    const response = await request("POST /board-targets", { body: { boardID: "b#mine", targets } });
    assert.equal(response.statusCode, 400, JSON.stringify(targets));
  }
  assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
});

test("a board setting write that fails for another reason is a 500", async t => {
  mock.on(UpdateItemCommand).rejects(new Error("DynamoDB is down"));
  t.mock.method(console, "error", () => {});
  const response = await request("POST /board-emoji", { body: { boardID: "b#mine", emoji: "🏡" } });
  assert.equal(response.statusCode, 500);
});

test("an unexpected failure is a 500 rather than an empty 200", async () => {
  mock.on(QueryCommand).rejects(new Error("DynamoDB is down"));
  const response = await request("GET /boards");
  assert.equal(response.statusCode, 500);
});
