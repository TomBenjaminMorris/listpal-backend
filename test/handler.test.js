"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
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
  const response = await request("GET /active-tasks", { params: { boardID: "b#theirs" } });
  assert.equal(response.statusCode, 403);
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
