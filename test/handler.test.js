"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
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

test("an unexpected failure is a 500 rather than an empty 200", async () => {
  mock.on(QueryCommand).rejects(new Error("DynamoDB is down"));
  const response = await request("GET /boards");
  assert.equal(response.statusCode, 500);
});
