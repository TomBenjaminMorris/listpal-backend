"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand, BatchWriteItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { CognitoIdentityProviderClient, AdminDeleteUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { marshall } = require("@aws-sdk/util-dynamodb");

const mock = mockClient(DynamoDBClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
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
  cognitoMock.reset();
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
  assert.match(response.body, /3 items could not be deleted/);
  assert.deepEqual(batchSizes(), [3, 3, 3, 3, 3]);
  assert.equal(mock.commandCalls(DeleteItemCommand).length, 0);
});

test("POST /delete-account deletes every item in the user's partition, then the login", async () => {
  process.env.UserPoolId = "pool";
  mock.on(QueryCommand)
    .resolvesOnce({ Items: taskKeys(1, 30), LastEvaluatedKey: { SK: { S: "t#30" } } })
    .resolves({ Items: [marshall({ SK: "u#user" }), marshall({ SK: "b#mine" })] });
  mock.on(BatchWriteItemCommand).callsFake(() => {
    assert.equal(cognitoMock.commandCalls(AdminDeleteUserCommand).length, 0);
    return {};
  });

  const response = await request("POST /delete-account");

  assert.deepEqual(response, { data: { deleted: true } });
  const queries = mock.commandCalls(QueryCommand);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].args[0].input.ExpressionAttributeValues, { ":pk": { S: "u#user" } });
  assert.equal(queries[0].args[0].input.IndexName, undefined);
  assert.equal(queries[0].args[0].input.ConsistentRead, true);
  assert.deepEqual(queries[1].args[0].input.ExclusiveStartKey, { SK: { S: "t#30" } });
  assert.deepEqual(batchSizes(), [25, 5, 2]);
  const deleted = mock.commandCalls(BatchWriteItemCommand).flatMap(call => Object.values(call.args[0].input.RequestItems)[0]);
  assert.ok(deleted.every(r => r.DeleteRequest.Key.PK.S === "u#user"));
  assert.deepEqual(cognitoMock.commandCalls(AdminDeleteUserCommand)[0].args[0].input, { UserPoolId: "pool", Username: "user" });
});

test("POST /delete-account keeps the login when items stay unprocessed, so the user can retry", async t => {
  mock.on(QueryCommand).resolves({ Items: taskKeys(1, 2) });
  mock.on(BatchWriteItemCommand).callsFake(input => ({ UnprocessedItems: input.RequestItems }));
  t.mock.method(console, "error", () => {});

  const response = await request("POST /delete-account");

  assert.equal(response.statusCode, 500);
  assert.equal(cognitoMock.commandCalls(AdminDeleteUserCommand).length, 0);
});

test("POST /delete-account succeeds when an earlier attempt already deleted the login", async () => {
  mock.on(QueryCommand).resolves({ Items: [] });
  cognitoMock.on(AdminDeleteUserCommand).rejects(Object.assign(new Error("gone"), { name: "UserNotFoundException" }));

  const response = await request("POST /delete-account");

  assert.deepEqual(response, { data: { deleted: true } });
});

// Resolves an update's placeholders, so a test reads which attributes it sets to what
const setFields = input => Object.fromEntries(Object.entries(input.ExpressionAttributeNames)
  .map(([name, attribute]) => [attribute, input.ExpressionAttributeValues[`:${name.slice(1)}`]]));

const newUserItems = () => mock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems.map(item => item.Put);

test("POST /new-user stores no email or name", async () => {
  mock.on(TransactWriteItemsCommand).resolves({});

  await request("POST /new-user");

  const user = newUserItems()[0].Item;
  assert.equal(user.SK.S, "u#user");
  assert.equal(user.Email, undefined);
  assert.equal(user.Name, undefined);
});

test("POST /new-user writes the user, welcome board and its tasks for the token's user in one transaction", async () => {
  mock.on(TransactWriteItemsCommand).resolves({});

  const response = await request("POST /new-user", { body: { userID: "u#someone-else" } });

  assert.deepEqual(response, { data: { created: true } });
  assert.equal(mock.commandCalls(TransactWriteItemsCommand).length, 1);
  const items = newUserItems();
  const [user, board, ...tasks] = items;
  assert.equal(user.Item.EntityType.S, "User");
  assert.equal(board.Item.EntityType.S, "Board");
  assert.equal(board.Item.Board.S, "Welcome");
  assert.equal(board.Item.SK.S, "b#u#user");
  assert.ok(tasks.length > 1);
  assert.ok(tasks.every(put => put.Item.EntityType.S === "Task" && put.Item["GSI1-PK"].S === "b#u#user"));
  assert.ok(items.every(put => put.Item.PK.S === "u#user"));
});

test("POST /new-user writes task items with every field a task created through /sync has", async () => {
  mock.on(TransactWriteItemsCommand).resolves({});

  await request("POST /new-user");

  const [, , ...tasks] = newUserItems();
  const expected = ["PK", "SK", "EntityType", "GSI1-PK", "GSI1-SK", "CreatedDate", "Description", "Category", "Emoji", "Important", "Link", "CompletedDate", "ExpiryDate", "ExpiryDateTTL"].sort();
  tasks.forEach(put => assert.deepEqual(Object.keys(put.Item).sort(), expected));
});

test("POST /new-user stores the board's scores, emoji and category order as the frontend reads them", async () => {
  mock.on(TransactWriteItemsCommand).resolves({});

  await request("POST /new-user");

  const [, board, ...tasks] = newUserItems();
  const ticked = tasks.filter(put => put.Item.CompletedDate.S !== "nil").length;
  assert.equal(board.Item.WScore.N, String(ticked));
  assert.equal(board.Item.MScore.N, String(ticked));
  assert.equal(board.Item.YScore.N, String(ticked));
  assert.equal(board.Item.WTarget.N, "4");
  assert.equal(board.Item.MTarget.N, "31");
  assert.equal(board.Item.YTarget.N, "365");
  assert.equal(board.Item.Emoji.S, "👋");
  assert.deepEqual(JSON.parse(board.Item.CategoryOrder.S), [...new Set(tasks.map(put => put.Item.Category.S))]);
});

test("POST /new-user guards only the user item, so a deleted welcome board stays deleted", async () => {
  mock.on(TransactWriteItemsCommand).resolves({});

  await request("POST /new-user");

  const [user, ...rest] = newUserItems();
  assert.equal(user.ConditionExpression, "attribute_not_exists(SK)");
  assert.ok(rest.every(put => put.ConditionExpression === undefined));
});

test("POST /new-user for a user already set up succeeds without changing anything", async () => {
  mock.on(TransactWriteItemsCommand).rejects(Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }]
  }));

  const response = await request("POST /new-user");

  assert.deepEqual(response, { data: { created: false } });
});

test("POST /new-user is a 500 when the transaction fails for any other reason", async () => {
  mock.on(TransactWriteItemsCommand).rejects(Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }]
  }));

  const response = await request("POST /new-user");

  assert.equal(response.statusCode, 500);
});

test("GET /user reads consistently, as the frontend reads it straight after POST /new-user", async () => {
  mock.on(QueryCommand).resolves({ Items: [marshall({ Theme: "purple-haze" })] });

  await request("GET /user");

  assert.equal(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead, true);
});

test("GET /user returns the reword tone and AI setting with the theme", async () => {
  await request("GET /user");

  assert.equal(mock.commandCalls(QueryCommand)[0].args[0].input.ProjectionExpression, "Theme, RewordTone, AIEnabled");
});

test("POST /user-reword-tone saves the tone on the caller's user item", async () => {
  mock.on(UpdateItemCommand).resolves({});

  const response = await request("POST /user-reword-tone", { body: { tone: "formal" } });

  assert.equal(response.statusCode, undefined);
  const [{ args: [{ input }] }] = mock.commandCalls(UpdateItemCommand);
  assert.deepEqual(input.Key, { PK: { S: "u#user" }, SK: { S: "u#user" } });
  assert.deepEqual(setFields(input), { RewordTone: { S: "formal" } });
});

for (const [name, body] of [["no body", undefined], ["an unknown tone", { tone: "sarcastic" }], ["the dropped playful tone", { tone: "playful" }], ["an inherited property name", { tone: "constructor" }], ["a tone that isn't a string", { tone: 3 }]]) {
  test(`POST /user-reword-tone with ${name} is a 400 with nothing written`, async () => {
    const response = await request("POST /user-reword-tone", { body });
    assert.equal(response.statusCode, 400);
    assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
  });
}

for (const enabled of [false, true]) {
  test(`POST /user-ai-enabled saves ${enabled} on the caller's user item`, async () => {
    mock.on(UpdateItemCommand).resolves({});

    const response = await request("POST /user-ai-enabled", { body: { enabled } });

    assert.equal(response.statusCode, undefined);
    const [{ args: [{ input }] }] = mock.commandCalls(UpdateItemCommand);
    assert.deepEqual(input.Key, { PK: { S: "u#user" }, SK: { S: "u#user" } });
    assert.deepEqual(setFields(input), { AIEnabled: { BOOL: enabled } });
  });
}

for (const [name, body] of [["no body", undefined], ["no value", {}], ["a string", { enabled: "false" }], ["a number", { enabled: 0 }], ["null", { enabled: null }]]) {
  test(`POST /user-ai-enabled with ${name} is a 400 with nothing written`, async () => {
    const response = await request("POST /user-ai-enabled", { body });
    assert.equal(response.statusCode, 400);
    assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
  });
}

test("POST /board-scores for another user's board is a 403 with nothing written", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#theirs", scores: { YScore: 1, MScore: 1, WScore: 1 } } });
  assert.equal(response.statusCode, 403);
  assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
});

test("POST /board-scores for the user's own board writes the scores", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#mine", scores: { YScore: 3, MScore: "2", WScore: 1 } } });
  assert.equal(response.statusCode, undefined);
  const [{ args: [{ input }] }] = mock.commandCalls(UpdateItemCommand);
  assert.deepEqual(input.Key, { PK: { S: "u#user" }, SK: { S: "b#mine" } });
  assert.deepEqual(setFields(input), { YScore: { N: "3" }, MScore: { N: "2" }, WScore: { N: "1" } });
});

test("POST /user-theme saves the theme on the caller's user item", async () => {
  await request("POST /user-theme", { body: { theme: "nord" } });
  const [{ args: [{ input }] }] = mock.commandCalls(UpdateItemCommand);
  assert.deepEqual(input.Key, { PK: { S: "u#user" }, SK: { S: "u#user" } });
  assert.deepEqual(setFields(input), { Theme: { S: "nord" } });
});

test("GET /boards returns the caller's boards, unmarshalled", async () => {
  const response = await request("GET /boards");
  assert.deepEqual(response, { data: [{ SK: "b#mine" }] });
  const { input } = mock.commandCalls(QueryCommand)[0].args[0];
  assert.deepEqual(input.ExpressionAttributeValues, { ":pk": { S: "u#user" }, ":board": { S: "b#" } });
  assert.equal(input.ConsistentRead, true);
});

test("POST /board-scores with a negative score is a 400", async () => {
  const response = await request("POST /board-scores", { body: { boardID: "b#mine", scores: { YScore: 1, MScore: 1, WScore: -1 } } });
  assert.equal(response.statusCode, 400);
});

for (const route of ["POST /new-board", "POST /rename-board", "POST /board-emoji", "POST /board-category-order", "POST /board-targets"]) {
  test(`${route} is gone, as board changes go through POST /sync`, async t => {
    t.mock.method(console, "error", () => {});
    const response = await request(route, { body: { boardID: "b#mine" } });
    assert.equal(response.statusCode, 500);
    assert.equal(mock.commandCalls(UpdateItemCommand).length, 0);
  });
}

test("an unexpected failure is a 500 rather than an empty 200", async () => {
  mock.on(QueryCommand).rejects(new Error("DynamoDB is down"));
  const response = await request("GET /boards");
  assert.equal(response.statusCode, 500);
});
