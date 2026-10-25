"use strict";
const { QueryCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { periodsContaining } = require("./score_periods");

const MAX_OPS = 50;
const NIL = "nil";
const KINDS = ["create", "update", "delete"];
const STRING_FIELDS = ["Description", "Category", "Emoji", "Important", "Link", "CompletedDate", "ExpiryDate", "GSI1-SK", "CreatedDate"];
const NUMBER_FIELDS = ["ExpiryDateTTL"];
// GSI key attributes cannot hold an empty string, so DynamoDB would reject the write on every retry.
const NON_EMPTY_FIELDS = ["GSI1-SK"];

class ValidationError extends Error { }

function validateSyncBody(body) {
  if (!body || !Array.isArray(body.ops)) throw new ValidationError("ops must be an array");
  if (body.ops.length > MAX_OPS) throw new ValidationError(`at most ${MAX_OPS} ops per request`);
  return body.ops;
}

// A reason here means the op can never succeed, so the client should drop it rather than retry.
function opProblem(op, boards) {
  if (!op || typeof op.opId !== "string") return "missing opId";
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

async function syncTasks(client, tableName, userID, ops, now = Date.now()) {
  const ctx = { client, tableName, userID, now, boards: await loadBoards(client, tableName, userID), scoredBoards: new Set() };
  const results = [];

  // Sequential on purpose: two transactions on the same board item in parallel would cancel each other.
  for (const op of ops) {
    const reason = opProblem(op, ctx.boards);
    if (reason) {
      results.push({ opId: op?.opId, SK: op?.SK, status: "rejected", reason });
      continue;
    }
    let status;
    try {
      status = await applyOp(ctx, op);
    } catch (error) {
      console.error("Sync op failed:", op.opId, error);
      status = error.name === "ValidationException" ? "rejected" : "retry";
    }
    results.push({ opId: op.opId, SK: op.SK, status });
  }

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
      await ctx.client.send(new UpdateItemCommand(taskUpdate(ctx, op.SK, fields, undefined, { checkCompletion: false })));
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

    const update = taskUpdate(ctx, op.SK, fields, current.CompletedDate);
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

async function deleteTask(ctx, op) {
  await ctx.client.send(new DeleteItemCommand({
    TableName: ctx.tableName,
    Key: marshall({ PK: ctx.userID, SK: op.SK })
  }));
  return "applied";
}

// expectedCompletedDate: undefined means the item has no CompletedDate; pass checkCompletion: false to skip the check
function taskUpdate(ctx, SK, fields, expectedCompletedDate, { checkCompletion = true } = {}) {
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

module.exports = { syncTasks, validateSyncBody, ValidationError, MAX_OPS };
