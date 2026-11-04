"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");

const mock = mockClient(DynamoDBClient);
const { handler } = require("../src/score_reset");

const rule = name => ({ resources: [`arn:aws:events:eu-west-2:123:rule/listpal_${name}_score_reset_dev`] });

test.beforeEach(() => {
  mock.reset();
  mock.on(QueryCommand).resolves({ Items: [marshall({ PK: "u#a", SK: "b#1" }), marshall({ PK: "u#b", SK: "b#2" })] });
  mock.on(UpdateItemCommand).resolves({});
});

for (const [name, field] of [["weekly", "WScore"], ["monthly", "MScore"], ["yearly", "YScore"]]) {
  test(`the ${name} rule zeroes ${field} on every board`, async () => {
    await handler(rule(name));

    const { input: query } = mock.commandCalls(QueryCommand)[0].args[0];
    assert.equal(query.IndexName, "GSI1");
    assert.deepEqual(query.ExpressionAttributeValues, { ":board": { S: "b#" } });
    const updates = mock.commandCalls(UpdateItemCommand).map(call => call.args[0].input);
    assert.deepEqual(updates.map(input => input.Key), [
      { PK: { S: "u#a" }, SK: { S: "b#1" } },
      { PK: { S: "u#b" }, SK: { S: "b#2" } }
    ]);
    assert.ok(updates.every(input => input.ExpressionAttributeNames["#score"] === field
      && input.ExpressionAttributeValues[":zero"].N === "0"));
  });
}

test("an unknown rule writes nothing", async t => {
  t.mock.method(console, "error", () => {});
  await handler(rule("hourly"));
  assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
});

test("a failed write is logged rather than thrown", async t => {
  const error = t.mock.method(console, "error", () => {});
  mock.on(UpdateItemCommand).rejects(new Error("throttled"));
  const result = await handler(rule("weekly"));
  assert.match(result, /throttled/);
  assert.equal(error.mock.callCount(), 1);
});
