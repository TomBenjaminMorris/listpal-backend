"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mockClient } = require("aws-sdk-client-mock");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { DynamoDBClient, UpdateItemCommand, ConditionalCheckFailedException } = require("@aws-sdk/client-dynamodb");
const { DEFAULT_REWORD_TONE, EXAMPLE_TASKS, REWORD_TONES } = require("../src/reword_tones");

const ssmMock = mockClient(SSMClient);
const dynamoMock = mockClient(DynamoDBClient);
const today = () => new Date().toISOString().slice(0, 10);
const counterKey = (PK, day = today()) => ({ PK: { S: PK }, SK: { S: `ai#${day}` } });
const conditionFailed = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
const counterCalls = () => dynamoMock.commandCalls(UpdateItemCommand).map(call => call.args[0].input);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ sub: "user" })}.sig`;
const realFetch = global.fetch;

let handler, fetchCalls, fetchReply, moderationCalls, moderationReply;
const request = body => handler({
  routeKey: "POST /reword-task",
  headers: { authorization: token },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const reply = (text, extra = {}) => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text }] }
  ],
  ...extra
});
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });
const verdict = (flagged, categories = {}, scores = {}) => jsonResponse(200, { results: [{ flagged, categories, category_scores: scores }] });

test.beforeEach(() => {
  process.env.OpenAIKeyParameter = "/listpal/dev/openai-api-key";
  process.env.Env = "Dev";
  ssmMock.reset();
  dynamoMock.reset();
  dynamoMock.on(UpdateItemCommand).resolves({});
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "sk-test" } });
  fetchCalls = [];
  moderationCalls = [];
  fetchReply = () => jsonResponse(200, reply("Book a dentist appointment"));
  moderationReply = () => verdict(false, { violence: false });
  // fetchCalls holds only the reword requests, so counts and indexes stay about the model
  global.fetch = async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body) };
    if (url.endsWith("/moderations")) {
      moderationCalls.push(call);
      return moderationReply();
    }
    fetchCalls.push(call);
    return fetchReply(fetchCalls.length);
  };
  // A fresh module each time, so the cached key from one test can't leak into the next
  delete require.cache[require.resolve("../src/reword")];
  ({ handler } = require("../src/reword"));
});

test.after(() => {
  global.fetch = realFetch;
});

test("returns the reworded text in the data envelope", async () => {
  const response = await request({ text: "dentist thing", category: "Health", board: "Life" });
  assert.deepEqual(response, { data: { text: "Book a dentist appointment" } });
});

test("sends the task as JSON data with the model, token cap and store off", async () => {
  await request({ text: "  dentist thing  ", category: "Health", board: "Life" });
  const [call] = fetchCalls;
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.options.headers.Authorization, "Bearer sk-test");
  assert.equal(call.body.model, "gpt-5-nano");
  assert.equal(call.body.store, false);
  assert.equal(call.body.max_output_tokens, 300);
  assert.deepEqual(call.body.reasoning, { effort: "minimal" });
  assert.deepEqual(JSON.parse(call.body.input), { task_lines: ["dentist thing"], category: "Health", board: "Life" });
  assert.match(call.body.safety_identifier, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(call.body.safety_identifier, /user/);
});

test("sends the chosen tone's instructions", async () => {
  for (const tone of Object.keys(REWORD_TONES)) {
    await request({ text: "dentist thing", tone });
  }
  const sent = fetchCalls.map(call => call.body.instructions);
  assert.equal(new Set(sent).size, 3);
  assert.match(sent[1], /in as few words as possible/);
  assert.match(sent[1], /\nCall the bank about the card\n/);
  assert.match(sent[2], /work plan/);
  assert.match(sent[2], /\nTelephone the bank regarding the card\n/);
});

test("every tone tells the model to keep the task's own emoji", async () => {
  for (const tone of Object.keys(REWORD_TONES)) {
    await request({ text: "dentist thing", tone });
  }
  const sent = fetchCalls.map(call => call.body.instructions);
  assert.ok(sent.every(instructions => /Keep any emoji the task has/.test(instructions)));
  assert.ok(sent.every(instructions => !/No emoji unless/.test(instructions)));
});

for (const [name, tone] of [["no tone", undefined], ["an unknown tone", "sarcastic"], ["an inherited property name", "constructor"], ["a tone that isn't a string", 3], ["the dropped playful tone", "playful"]]) {
  test(`${name} gets the default tone, not a 400`, async () => {
    await request({ text: "dentist thing", tone: DEFAULT_REWORD_TONE });
    const response = await request({ text: "dentist thing", tone });
    assert.equal(response.data.text, "Book a dentist appointment");
    assert.equal(fetchCalls[1].body.instructions, fetchCalls[0].body.instructions);
  });
}

test("the default tone is casual", () => {
  assert.equal(DEFAULT_REWORD_TONE, "casual");
});

test("every tone has a reply for each example task, one line per task line", () => {
  for (const { examples } of Object.values(REWORD_TONES)) {
    assert.deepEqual(examples.map(example => example.split("\n").length), EXAMPLE_TASKS.map(task => task.task_lines.length));
  }
});

test("the retry keeps the tone", async () => {
  fetchReply = call => jsonResponse(200, reply(call === 1 ? "Renew passport" : "Get the passport renewed"));
  await request({ text: "renew passport", tone: "formal" });
  assert.equal(fetchCalls[1].body.instructions, fetchCalls[0].body.instructions);
  assert.match(fetchCalls[1].body.instructions, /work plan/);
});

test("reads the key once and decrypts it", async () => {
  await request({ text: "a" });
  await request({ text: "b" });
  const calls = ssmMock.commandCalls(GetParameterCommand);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args[0].input, { Name: "/listpal/dev/openai-api-key", WithDecryption: true });
});

test("reads the key again after OpenAI rejects it", async () => {
  fetchReply = () => jsonResponse(401, { error: { type: "invalid_request_error" } });
  await request({ text: "a" });
  await request({ text: "b" });
  assert.equal(ssmMock.commandCalls(GetParameterCommand).length, 2);
});

test("sends each line separately, leaving blank lines out", async () => {
  fetchReply = () => jsonResponse(200, reply("Pack\nBook a taxi"));
  await request({ text: "pack\n\nbook taxi" });
  assert.deepEqual(JSON.parse(fetchCalls[0].body.input).task_lines, ["pack", "book taxi"]);
});

test("puts blank lines back where they were", async () => {
  fetchReply = () => jsonResponse(200, reply("Pack\n\n\nBook a taxi"));
  const response = await request({ text: "pack\n\nbook taxi\n\n\nsleep" });
  // Two lines back for three sent: the model's own layout is kept
  assert.equal(response.data.text, "Pack\nBook a taxi");

  fetchReply = () => jsonResponse(200, reply("Pack\nBook a taxi\nGo to bed"));
  const restored = await request({ text: "pack\n\nbook taxi\n\n\nsleep" });
  assert.equal(restored.data.text, "Pack\n\nBook a taxi\n\n\nGo to bed");
});

test("asks once more when the reply only changes capitals or punctuation", async () => {
  fetchReply = call => jsonResponse(200, reply(call === 1 ? "Renew passport." : "Get the passport renewed"));
  const response = await request({ text: "renew passport" });
  assert.equal(response.data.text, "Get the passport renewed");
  assert.equal(fetchCalls.length, 2);
  const [task, previous, nudge] = fetchCalls[1].body.input;
  assert.equal(task.content, fetchCalls[0].body.input);
  assert.deepEqual(previous, { role: "assistant", content: "Renew passport." });
  assert.match(nudge.content, /different words/);
  // Both attempts count as one reword
  assert.equal(counterCalls().length, 2);
});

test("keeps the first reply when the retry fails", async () => {
  fetchReply = call => call === 1
    ? jsonResponse(200, reply("Renew passport"))
    : jsonResponse(500, { error: { type: "server_error" } });
  const response = await request({ text: "renew passport" });
  assert.equal(response.data.text, "Renew passport");
});

test("doesn't ask again when the wording changed", async () => {
  await request({ text: "dentist thing" });
  assert.equal(fetchCalls.length, 1);
});

test("moderation and both attempts share one deadline", async () => {
  fetchReply = call => jsonResponse(200, reply(call === 1 ? "Renew passport" : "Get the passport renewed"));
  await request({ text: "renew passport" });
  assert.equal(fetchCalls[0].options.signal, fetchCalls[1].options.signal);
  assert.equal(moderationCalls[0].options.signal, fetchCalls[0].options.signal);
});

test("keeps the first reply when the retry is much longer than the task", async () => {
  fetchReply = call => jsonResponse(200, reply(call === 1 ? "Renew passport" : "a".repeat(100)));
  const response = await request({ text: "renew passport" });
  assert.equal(response.data.text, "Renew passport");
});

test("a reply much longer than the task is a 502", async () => {
  // Twice the task's 4 characters plus 40 is the most allowed
  fetchReply = () => jsonResponse(200, reply("a".repeat(49)));
  const tooLong = await request({ text: "cats" });
  assert.equal(tooLong.statusCode, 502);

  fetchReply = () => jsonResponse(200, reply("a".repeat(48)));
  const longest = await request({ text: "cats" });
  assert.equal(longest.data.text.length, 48);
});

test("checks the task, category and board with moderation before the model sees them", async () => {
  await request({ text: " dentist thing ", category: "Health", board: "Life" });
  assert.equal(moderationCalls.length, 1);
  const [call] = moderationCalls;
  assert.equal(call.url, "https://api.openai.com/v1/moderations");
  assert.equal(call.options.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(call.body, { model: "omni-moderation-latest", input: "dentist thing\nHealth\nLife" });
});

test("flagged text is a 400 flagged, never reaches the model and still counts", async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args.join(" ")));
  moderationReply = () => verdict(true, { violence: true, harassment: false }, { violence: 0.94, harassment: 0.01 });
  const response = await request({ text: "something nasty" });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "flagged" });
  assert.equal(fetchCalls.length, 0);
  assert.equal(counterCalls().length, 2);
  assert.deepEqual(warned, ["Reword refused by moderation: violence"]);
});

test("a flag below the threshold still reaches the model", async () => {
  // "finish the murder mystery book" scored 0.43 and was flagged by OpenAI
  moderationReply = () => verdict(true, { violence: true }, { violence: 0.43 });
  const response = await request({ text: "finish the murder mystery book" });
  assert.equal(fetchCalls.length, 1);
  assert.ok(response.data.text);
});

test("a flag at the threshold is refused", async () => {
  moderationReply = () => verdict(true, { violence: true }, { violence: 0.7 });
  const response = await request({ text: "dentist thing" });
  assert.deepEqual(JSON.parse(response.body), { error: "flagged" });
});

test("sexual content involving minors is refused at any score", async () => {
  moderationReply = () => verdict(true, { "sexual/minors": true }, { "sexual/minors": 0.2 });
  const response = await request({ text: "dentist thing" });
  assert.deepEqual(JSON.parse(response.body), { error: "flagged" });
  assert.equal(fetchCalls.length, 0);
});

for (const [name, makeVerdict] of [
  ["a moderation error", () => jsonResponse(500, { error: { type: "server_error" } })],
  ["a moderation reply with no result", () => jsonResponse(200, { results: [] })],
  ["a moderation timeout", () => { throw new DOMException("The operation was aborted", "TimeoutError"); }]
]) {
  test(`${name} is a 502 and never reaches the model`, async () => {
    moderationReply = makeVerdict;
    const response = await request({ text: "dentist thing" });
    assert.equal(response.statusCode, 502);
    assert.equal(fetchCalls.length, 0);
  });
}

test("strips quotation marks wrapped around the reply", async () => {
  fetchReply = () => jsonResponse(200, reply("  “Book a dentist appointment”\n"));
  const response = await request({ text: "dentist thing" });
  assert.equal(response.data.text, "Book a dentist appointment");
});

test("keeps quotation marks inside the reply", async () => {
  fetchReply = () => jsonResponse(200, reply("Read \"Dune\" before book club"));
  const response = await request({ text: "dune" });
  assert.equal(response.data.text, "Read \"Dune\" before book club");
});

for (const [name, body] of [
  ["no body", undefined],
  ["a body that isn't JSON", "{"],
  ["no text", { category: "Health" }],
  ["blank text", { text: "   " }],
  ["text over 500 characters", { text: "a".repeat(501) }],
  ["a category that isn't a string", { text: "a", category: 3 }],
  ["a board name over 100 characters", { text: "a", board: "b".repeat(101) }]
]) {
  test(`${name} is a 400 and calls nothing`, async () => {
    const response = await request(body);
    assert.equal(response.statusCode, 400);
    assert.equal(fetchCalls.length, 0);
    assert.equal(ssmMock.commandCalls(GetParameterCommand).length, 0);
    assert.equal(counterCalls().length, 0);
  });
}

for (const [name, makeReply] of [
  ["an OpenAI 500", () => jsonResponse(500, { error: { type: "server_error" } })],
  ["an OpenAI 429", () => jsonResponse(429, { error: { type: "rate_limit_exceeded" } })],
  ["a timeout", () => { throw new DOMException("The operation was aborted", "TimeoutError"); }],
  ["a reply cut short by the token cap", () => jsonResponse(200, reply("Book a", { status: "incomplete" }))],
  ["an empty reply", () => jsonResponse(200, reply("  "))],
  ["a reply over 500 characters", () => jsonResponse(200, reply("a".repeat(501)))],
  ["a reply with no message", () => jsonResponse(200, { status: "completed", output: [] })]
]) {
  test(`${name} is a 502 reword_unavailable`, async () => {
    fetchReply = makeReply;
    const response = await request({ text: "dentist thing" });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), { error: "reword_unavailable" });
  });
}

test("counts the reword against the user and then everyone, before calling OpenAI", async () => {
  await request({ text: "dentist thing" });
  const [user, global] = counterCalls();
  assert.equal(counterCalls().length, 2);
  assert.equal(user.TableName, "ListPal-Dev");
  assert.deepEqual(user.Key, counterKey("u#user"));
  assert.equal(user.ExpressionAttributeValues[":limit"].N, "30");
  assert.deepEqual(global.Key, counterKey("ai#global"));
  assert.equal(global.ExpressionAttributeValues[":limit"].N, "500");
  for (const update of [user, global]) {
    assert.equal(update.UpdateExpression, "ADD #count :one SET #ttl = :ttl");
    assert.equal(update.ConditionExpression, "attribute_not_exists(#count) OR #count < :limit");
    assert.equal(update.ExpressionAttributeNames["#ttl"], "ExpiryDateTTL");
    assert.equal(update.ExpressionAttributeValues[":ttl"].N, String(Date.parse(today()) / 1000 + 2 * 24 * 60 * 60));
  }
  assert.equal(fetchCalls.length, 1);
});

test("a user at their daily limit gets a 429 daily_limit and costs nothing", async () => {
  dynamoMock.on(UpdateItemCommand, { Key: counterKey("u#user") }).rejects(conditionFailed());
  const response = await request({ text: "dentist thing" });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(JSON.parse(response.body), { error: "daily_limit" });
  assert.equal(counterCalls().length, 1);
  assert.equal(fetchCalls.length, 0);
  assert.equal(ssmMock.commandCalls(GetParameterCommand).length, 0);
});

test("everyone at the global limit gets a 429 busy_today and the user's count is refunded", async () => {
  dynamoMock.on(UpdateItemCommand, { Key: counterKey("ai#global") }).rejects(conditionFailed());
  const response = await request({ text: "dentist thing" });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(JSON.parse(response.body), { error: "busy_today" });
  const refund = counterCalls()[2];
  assert.deepEqual(refund.Key, counterKey("u#user"));
  assert.equal(refund.UpdateExpression, "ADD #count :minusOne");
  assert.equal(fetchCalls.length, 0);
});

test("a failed refund still answers busy_today", async () => {
  dynamoMock.on(UpdateItemCommand, { Key: counterKey("ai#global") }).rejects(conditionFailed());
  dynamoMock.on(UpdateItemCommand, { UpdateExpression: "ADD #count :minusOne" }).rejects(new Error("ProvisionedThroughputExceededException"));
  const response = await request({ text: "dentist thing" });
  assert.deepEqual(JSON.parse(response.body), { error: "busy_today" });
});

test("a DynamoDB failure on the quota is a 500 and calls nothing else", async () => {
  dynamoMock.on(UpdateItemCommand).rejects(new Error("InternalServerError"));
  const response = await request({ text: "dentist thing" });
  assert.equal(response.statusCode, 500);
  assert.equal(fetchCalls.length, 0);
});

test("a failed OpenAI call still counts", async () => {
  fetchReply = () => jsonResponse(500, { error: { type: "server_error" } });
  await request({ text: "dentist thing" });
  assert.equal(counterCalls().length, 2);
  assert.ok(counterCalls().every(update => update.UpdateExpression.startsWith("ADD #count :one")));
});

test("the day is the UTC date, whatever the local time zone", async (t) => {
  const RealDate = Date;
  const realTZ = process.env.TZ;
  // 23:30 UTC on 2 Nov is already 3 Nov in Auckland
  const fixed = RealDate.parse("2026-11-02T23:30:00Z");
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  process.env.TZ = "Pacific/Auckland";
  t.after(() => {
    global.Date = RealDate;
    if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ;
  });

  await request({ text: "dentist thing" });
  const [user] = counterCalls();
  assert.deepEqual(user.Key, counterKey("u#user", "2026-11-02"));
  assert.equal(user.ExpressionAttributeValues[":ttl"].N, String(RealDate.parse("2026-11-04T00:00:00Z") / 1000));
});

test("a failed key read is a 500", async () => {
  ssmMock.on(GetParameterCommand).rejects(new Error("AccessDeniedException"));
  const response = await request({ text: "dentist thing" });
  assert.equal(response.statusCode, 500);
  assert.equal(fetchCalls.length, 0);
});

test("never logs task, category or board text", async (t) => {
  const logged = [];
  for (const method of ["log", "info", "warn", "error"]) {
    t.mock.method(console, method, (...args) => logged.push(args.join(" ")));
  }
  fetchReply = () => jsonResponse(500, { error: { type: "server_error" } });
  await request({ text: "secret task", category: "secret category", board: "secret board" });
  fetchReply = () => jsonResponse(200, reply("secret reply"));
  await request({ text: "secret task", category: "secret category", board: "secret board" });
  fetchReply = () => jsonResponse(200, reply("secret " + "reply ".repeat(30)));
  await request({ text: "secret task", category: "secret category", board: "secret board" });
  moderationReply = () => verdict(true, { violence: true }, { violence: 0.94 });
  await request({ text: "secret task", category: "secret category", board: "secret board" });
  assert.ok(logged.length >= 3);
  assert.doesNotMatch(logged.join("\n"), /secret/);
});
