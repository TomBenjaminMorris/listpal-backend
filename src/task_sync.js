"use strict";
const { QueryCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { periodsContaining } = require("./score_periods");

const MAX_OPS = 50;
// Bounded so a full batch doesn't burst 50 parallel requests at the on-demand table and the Lambda's sockets.
const CONCURRENCY = 10;
const NIL = "nil";
const KINDS = ["create", "update", "delete"];
const STRING_FIELDS = ["Description", "Category", "Emoji", "Important", "Link", "CompletedDate", "ExpiryDate", "GSI1-SK", "CreatedDate"];
const NUMBER_FIELDS = ["ExpiryDateTTL"];
// GSI key attributes cannot hold an empty string, so DynamoDB would reject the write on every retry.
const NON_EMPTY_FIELDS = ["GSI1-SK"];
const isTarget = value => Number.isInteger(value) && value >= 1;
const BOARD_FIELDS = {
  Board: value => typeof value === "string" && value !== "",
  Emoji: value => typeof value === "string",
  // Stored as a JSON string, as GET /boards returns it and the client parses it
  CategoryOrder: isCategoryOrder,
  WTarget: isTarget,
  MTarget: isTarget,
  YTarget: isTarget
};

class ValidationError extends Error { }

function validateSyncBody(body) {
  if (!body || !Array.isArray(body.ops)) throw new ValidationError("ops must be an array");
  if (body.ops.length > MAX_OPS) throw new ValidationError(`at most ${MAX_OPS} ops per request`);
  return body.ops;
}

// A reason here means the op can never succeed, so the client should drop it rather than retry.
function opProblem(op, boards) {
  if (!op || typeof op.opId !== "string") return "missing opId";
  if (isBoardOp(op)) return boardOpProblem(op);
  if (typeof op.SK !== "string" || !op.SK.startsWith("t#")) return "invalid SK";
  if (!KINDS.includes(op.kind)) return "invalid kind";
  if (!boards.has(op.boardID)) return "unknown board";
  const fields = op.fields ?? {};
  if (typeof fields !== "object" || Array.isArray(fields)) return "invalid fields";
  for (const [name, value] of Object.entries(fields)) {
    if (STRING_FIELDS.includes(name) && typeof value === "string") {
      if (NON_EMPTY_FIELDS.includes(name) && value === "") return `empty field ${name}`;
      continue;
    }
    if (NUMBER_FIELDS.includes(name) && Number.isFinite(value)) continue;
    return `invalid field ${name}`;
  }
  return null;
}

// No ownership check is needed: the key is built from the caller's userID, and a missing board is reported as gone.
function boardOpProblem(op) {
  if (op.SK.length <= "b#".length) return "invalid SK";
  if (op.kind !== "create" && op.kind !== "update") return "invalid kind";
  if (op.boardID !== op.SK) return "invalid boardID";
  const fields = op.fields ?? {};
  if (typeof fields !== "object" || Array.isArray(fields)) return "invalid fields";
  for (const [name, value] of Object.entries(fields)) {
    // hasOwn, so a field named after an Object.prototype member such as "constructor" can't pass
    if (!Object.hasOwn(BOARD_FIELDS, name) || !BOARD_FIELDS[name](value)) return `invalid field ${name}`;
  }
  if (op.kind === "create" && !("Board" in fields)) return "missing field Board";
  return null;
}

function isBoardOp(op) {
  return typeof op.SK === "string" && op.SK.startsWith("b#");
}

function isCategoryOrder(value) {
  if (typeof value !== "string") return false;
  try {
    const order = JSON.parse(value);
    return Array.isArray(order) && order.every(category => typeof category === "string");
  } catch {
    return false;
  }
}

async function syncTasks(client, tableName, userID, ops, now = Date.now()) {
  const ctx = { client, tableName, userID, now, boards: await loadBoards(client, tableName, userID), scoredBoards: new Set() };
  const results = new Array(ops.length);
  const run = async ([op, i]) => {
    let status;
    try {
      status = await applyOp(ctx, op);
    } catch (error) {
      console.error("Sync op failed:", op.opId, error);
      status = error.name === "ValidationException" ? "rejected" : "retry";
    }
    results[i] = { opId: op.opId, SK: op.SK, status };
  };

  const perTask = new Map();
  ops.forEach(op => {
    if (typeof op?.SK === "string") perTask.set(op.SK, (perTask.get(op.SK) ?? 0) + 1);
  });

  const boardOps = [];
  const taskOps = [];
  ops.forEach((op, i) => (op && isBoardOp(op) ? boardOps : taskOps).push([op, i]));
  const accepted = entries => entries.filter(([op, i]) => {
    const reason = opProblem(op, ctx.boards);
    if (reason) results[i] = { opId: op?.opId, SK: op?.SK, status: "rejected", reason };
    return !reason;
  });

  // A plain write to a board item cancels any tick transaction updating it at the same moment, so board ops
  // finish before task ops start. They are rare and may repeat a board, so they run one at a time in order.
  for (const entry of accepted(boardOps)) await run(entry);

  // A create that hit a transient error will be resent, so its board's tasks must wait for it rather than be
  // rejected as "unknown board", which the client would drop
  const unmadeBoards = new Set(boardOps
    .filter(([op, i]) => op.kind === "create" && results[i].status === "retry")
    .map(([op]) => op.SK));
  const waiting = taskOps.filter(([op, i]) => {
    if (!unmadeBoards.has(op?.boardID)) return true;
    results[i] = { opId: op.opId, SK: op.SK, status: "retry" };
    return false;
  });

  // Checked after the board ops, so tasks for a board created in this batch pass the ownership check.
  // Ops that can move scores share the board item, where parallel transactions would cancel each other, and
  // repeated tasks must apply in order, so those stay sequential. The rest touch only their own task and never ctx.
  const concurrent = [];
  const sequential = [];
  accepted(waiting).forEach(([op, i]) => {
    const touchesScores = "CompletedDate" in (op.fields ?? {});
    (touchesScores || perTask.get(op.SK) > 1 ? sequential : concurrent).push([op, i]);
  });

  await runLimited(concurrent, CONCURRENCY, run);
  for (const entry of sequential) await run(entry);

  if (ctx.scoredBoards.size) {
    ctx.boards = await loadBoards(client, tableName, userID);
  }
  const boards = [...ctx.scoredBoards]
    .filter(SK => ctx.boards.has(SK))
    .map(SK => {
      const { WScore, MScore, YScore } = ctx.boards.get(SK);
      return { SK, WScore, MScore, YScore };
    });

  return { results, boards };
}

function applyOp(ctx, op) {
  if (isBoardOp(op)) return op.kind === "create" ? createBoard(ctx, op) : updateBoard(ctx, op);
  switch (op.kind) {
    case "create":
      return createTask(ctx, op);
    case "update":
      return updateTask(ctx, op);
    case "delete":
      return deleteTask(ctx, op);
  }
}

async function createTask(ctx, op) {
  const item = {
    PK: ctx.userID,
    SK: op.SK,
    EntityType: "Task",
    "GSI1-PK": op.boardID,
    CreatedDate: String(ctx.now),
    Description: "",
    Category: "",
    Emoji: "",
    Important: "false",
    Link: "",
    CompletedDate: NIL,
    ExpiryDate: NIL,
    "GSI1-SK": NIL,
    ExpiryDateTTL: 0,
    ...op.fields
  };
  const put = {
    TableName: ctx.tableName,
    Item: marshall(item),
    ConditionExpression: "attribute_not_exists(SK)"
  };
  const periods = isDone(item.CompletedDate) ? periodsContaining(Number(item.CompletedDate), ctx.now) : [];

  try {
    if (periods.length) {
      await transact(ctx, [{ Put: put }, scoreChange(ctx, op.boardID, periods, 1)]);
    } else {
      await ctx.client.send(new PutItemCommand(put));
    }
    noteScoreChange(ctx, op.boardID, periods, 1);
    return "applied";
  } catch (error) {
    // The task already exists, so an earlier attempt landed but its ack was lost: apply the fields as an update.
    if (isConditionFailure(error)) return updateTask(ctx, op);
    throw error;
  }
}

async function updateTask(ctx, op) {
  const fields = { ...op.fields };
  delete fields.CreatedDate;
  if (!Object.keys(fields).length) {
    return (await getTask(ctx, op.SK)) ? "applied" : "gone";
  }

  // Only a completion change moves scores and so needs the current task; anything else is a single write
  // whose condition stops a deleted task coming back as a partial item
  if (!("CompletedDate" in fields)) {
    try {
      await ctx.client.send(new UpdateItemCommand(itemUpdate(ctx, op.SK, fields, undefined, { checkCompletion: false })));
      return "applied";
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return "gone";
      throw error;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    // Without this read an UpdateItem on a deleted task would recreate it as a partial item.
    const current = await getTask(ctx, op.SK);
    if (!current) return "gone";

    const boardID = current["GSI1-PK"];
    const board = ctx.boards.get(boardID);
    const wasDone = isDone(current.CompletedDate);
    const willBeDone = "CompletedDate" in fields ? isDone(fields.CompletedDate) : wasDone;
    let periods = [];
    let delta = 0;
    if (board && !wasDone && willBeDone) {
      periods = periodsContaining(Number(fields.CompletedDate), ctx.now);
      delta = 1;
    } else if (board && wasDone && !willBeDone) {
      // Only take the point back from periods it was counted in and that have not been reset since.
      periods = periodsContaining(Number(current.CompletedDate), ctx.now).filter(field => board[field] > 0);
      delta = -1;
    }

    const update = itemUpdate(ctx, op.SK, fields, current.CompletedDate);
    try {
      if (periods.length) {
        await transact(ctx, [{ Update: update }, scoreChange(ctx, boardID, periods, delta)]);
      } else {
        await ctx.client.send(new UpdateItemCommand(update));
      }
      noteScoreChange(ctx, boardID, periods, delta);
      // A resent tick that an earlier request already applied changes nothing, but the client may be
      // holding scores read before that request finished, so report the current ones anyway.
      if (board && "CompletedDate" in fields) ctx.scoredBoards.add(boardID);
      return "applied";
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      // Another tab or the score reset changed the task or board since the read, so read both again.
      ctx.boards = await loadBoards(ctx.client, ctx.tableName, ctx.userID);
    }
  }
  return "conflict";
}

async function createBoard(ctx, op) {
  // Already there, so an earlier attempt landed but its ack was lost: apply the fields without resetting the scores
  if (ctx.boards.has(op.SK)) return updateBoard(ctx, op);
  const scores = { WScore: 0, MScore: 0, YScore: 0 };
  const item = {
    PK: ctx.userID,
    SK: op.SK,
    EntityType: "Board",
    "GSI1-PK": "b#",
    "GSI1-SK": op.SK,
    ...scores,
    WTarget: 7,
    MTarget: 31,
    YTarget: 365,
    Emoji: "🚀",
    CategoryOrder: "[]",
    ...op.fields
  };
  try {
    await ctx.client.send(new PutItemCommand({
      TableName: ctx.tableName,
      Item: marshall(item),
      ConditionExpression: "attribute_not_exists(SK)"
    }));
    ctx.boards.set(op.SK, { SK: op.SK, ...scores });
    return "applied";
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    // Another request created it since the boards were read, so read its real scores before ticks use them
    ctx.boards = await loadBoards(ctx.client, ctx.tableName, ctx.userID);
    return updateBoard(ctx, op);
  }
}

async function updateBoard(ctx, op) {
  if (!ctx.boards.has(op.SK)) return "gone";
  const fields = op.fields ?? {};
  if (!Object.keys(fields).length) return "applied";
  try {
    // The condition stops an edit that lands after a delete from coming back as a ghost board
    await ctx.client.send(new UpdateItemCommand(itemUpdate(ctx, op.SK, fields, undefined, { checkCompletion: false })));
    return "applied";
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return "gone";
    throw error;
  }
}

async function deleteTask(ctx, op) {
  await ctx.client.send(new DeleteItemCommand({
    TableName: ctx.tableName,
    Key: marshall({ PK: ctx.userID, SK: op.SK })
  }));
  return "applied";
}

// expectedCompletedDate: undefined means the item has no CompletedDate; pass checkCompletion: false to skip the check
function itemUpdate(ctx, SK, fields, expectedCompletedDate, { checkCompletion = true } = {}) {
  const names = {};
  const values = {};
  const sets = Object.keys(fields).map((name, i) => {
    names[`#f${i}`] = name;
    values[`:f${i}`] = fields[name];
    return `#f${i} = :f${i}`;
  });

  let condition = "attribute_exists(SK)";
  if (checkCompletion) {
    names["#completed"] = "CompletedDate";
    if (expectedCompletedDate === undefined) {
      condition += " And attribute_not_exists(#completed)";
    } else {
      condition += " And #completed = :expectedCompleted";
      values[":expectedCompleted"] = expectedCompletedDate;
    }
  }

  return {
    TableName: ctx.tableName,
    Key: marshall({ PK: ctx.userID, SK }),
    UpdateExpression: "SET " + sets.join(", "),
    ConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values)
  };
}

function scoreChange(ctx, boardID, fields, delta) {
  const names = {};
  const adds = [];
  const conditions = ["attribute_exists(SK)"];
  const values = { ":delta": delta };
  fields.forEach((field, i) => {
    names[`#s${i}`] = field;
    adds.push(`#s${i} :delta`);
    if (delta < 0) conditions.push(`#s${i} > :zero`);
  });
  if (delta < 0) values[":zero"] = 0;

  return {
    Update: {
      TableName: ctx.tableName,
      Key: marshall({ PK: ctx.userID, SK: boardID }),
      UpdateExpression: "ADD " + adds.join(", "),
      ConditionExpression: conditions.join(" And "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values)
    }
  };
}

function noteScoreChange(ctx, boardID, fields, delta) {
  if (!fields.length) return;
  const board = ctx.boards.get(boardID);
  fields.forEach(field => { board[field] = (board[field] ?? 0) + delta; });
  ctx.scoredBoards.add(boardID);
}

async function loadBoards(client, tableName, userID) {
  const boards = new Map();
  let ExclusiveStartKey;
  do {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk And begins_with(SK, :board)",
      ProjectionExpression: "SK, WScore, MScore, YScore",
      ExpressionAttributeValues: marshall({ ":pk": userID, ":board": "b#" }),
      ExclusiveStartKey
    }));
    (result.Items ?? []).forEach(item => {
      const board = unmarshall(item);
      boards.set(board.SK, board);
    });
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return boards;
}

async function getTask(ctx, SK) {
  const result = await ctx.client.send(new GetItemCommand({
    TableName: ctx.tableName,
    Key: marshall({ PK: ctx.userID, SK }),
    ConsistentRead: true
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

function transact(ctx, items) {
  return ctx.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
}

function isDone(completedDate) {
  return typeof completedDate === "string" && completedDate !== NIL && completedDate !== "";
}

function isConditionFailure(error) {
  if (error.name === "ConditionalCheckFailedException") return true;
  return error.name === "TransactionCanceledException" &&
    (error.CancellationReasons ?? []).some(reason => reason.Code === "ConditionalCheckFailed");
}

async function runLimited(items, limit, work) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

module.exports = { syncTasks, validateSyncBody, ValidationError, MAX_OPS };
