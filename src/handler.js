"use strict";
const { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand, BatchWriteItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { jwtDecode } = require("jwt-decode");
const { syncTasks, validateSyncBody, ValidationError, isConditionFailure } = require("./task_sync");
const { welcomeBoard } = require("./welcome_board");
const { REWORD_TONES } = require("./reword_tones");
const { respond } = require("./respond");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env;

const notYourBoard = () => respond(403, { error: "Requested board does not belong to the currently logged-in user" });

module.exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters;
    const body = event.body && JSON.parse(event.body);
    const token = event.headers.authorization;
    const userID = token ? `u#${jwtDecode(token).sub}` : "";

    switch (event.routeKey) {
      case "GET /active-tasks": {
        if (typeof params?.boardID !== "string") {
          return respond(400, { error: "boardID is required" });
        }
        // A board's owner never changes, so the task read can run alongside the check and be discarded on failure.
        // Only board IDs start it: "u#" and "b#" are GSI1 partitions holding every user's items.
        const [valid, tasks] = await Promise.all([
          verifyBoard(userID, params.boardID),
          isBoardID(params.boardID) ? queryItems(activeTasksQuery(params.boardID)) : undefined
        ]);
        if (!valid) return notYourBoard();
        return { data: tasks };
      }

      case "GET /boards":
        return { data: await queryItems(boardsQuery(userID)) };

      case "GET /user":
        return { data: await queryItems(userQuery(userID)) };

      case "POST /new-user":
        return { data: await createNewUser(userID) };

      case "POST /user-theme":
        return { data: await setUserField(userID, "Theme", body.theme) };

      // No default is written for new users: a missing tone means the default in src/reword_tones.js
      case "POST /user-reword-tone":
        if (!Object.hasOwn(REWORD_TONES, body?.tone)) {
          return respond(400, { error: `tone must be one of ${Object.keys(REWORD_TONES).join(", ")}` });
        }
        return { data: await setUserField(userID, "RewordTone", body.tone) };

      // The opt-out for every AI feature. No default is written: a missing value means on, see src/ai_features.js
      case "POST /user-ai-enabled":
        if (typeof body?.enabled !== "boolean") {
          return respond(400, { error: "enabled must be true or false" });
        }
        return { data: await setUserField(userID, "AIEnabled", body.enabled) };

      // Task and board settings changes
      case "POST /sync":
        try {
          return { data: await syncTasks(client, tableName, userID, validateSyncBody(body)) };
        } catch (error) {
          if (error instanceof ValidationError) {
            return respond(400, { error: error.message });
          }
          throw error;
        }

      case "POST /delete-board":
        if (!(await verifyBoard(userID, body.boardID))) return notYourBoard();
        try {
          await deleteBoardTasks(userID, body.boardID);
          return await client.send(new DeleteItemCommand({ TableName: tableName, Key: itemKey(userID, body.boardID) }));
        } catch (error) {
          console.error("Failed to delete board or tasks:", error);
          return respond(500, { error: "Failed to delete board and/or tasks", details: error.message });
        }

      // Data before login: a failure partway leaves the login in place, so the user can sign in and try again.
      case "POST /delete-account":
        await deleteUserItems(userID);
        await deleteCognitoUser(userID.slice(2));
        return { data: { deleted: true } };

      // Manual score edits only. Ticking a task changes scores inside POST /sync.
      case "POST /board-scores": {
        const scores = body?.scores;
        if (!scores || !["YScore", "MScore", "WScore"].every(field => Number.isFinite(Number(scores[field])) && Number(scores[field]) >= 0)) {
          return respond(400, { error: "scores must contain non-negative YScore, MScore and WScore" });
        }
        if (!(await verifyBoard(userID, body.boardID))) return notYourBoard();
        return { data: await setBoardScores(userID, body.boardID, scores) };
      }

      default:
        throw new Error(`Unsupported route: "${event.routeKey}"`);
    }
  } catch (error) {
    console.error(error);
    return respond(500, { error: "Internal server error" });
  }
};


// The user item and tasks share the user's partition with their boards, so the prefix stops them passing as boards
function isBoardID(boardID) {
  return typeof boardID === "string" && boardID.startsWith("b#") && boardID.length > 2;
}

const itemKey = (PK, SK) => marshall({ PK, SK });

async function verifyBoard(userID, boardID) {
  if (!isBoardID(boardID)) return false;
  const result = await client.send(new GetItemCommand({
    TableName: tableName,
    Key: itemKey(userID, boardID),
    ProjectionExpression: "SK",
    // The frontend can open or delete a board moments after creating it
    ConsistentRead: true
  }));
  return !!result.Item;
}

async function createNewUser(userID) {
  const { board, tasks } = welcomeBoard(userID, Date.now());
  try {
    await client.send(new TransactWriteItemsCommand({
      TransactItems: [
        // Only the user item is guarded: it exists once setup has run, so a user who deleted the welcome board doesn't get it back
        { Put: { ...putItem(userItem(userID)), ConditionExpression: "attribute_not_exists(SK)" } },
        { Put: putItem(boardItem(userID, board)) },
        ...tasks.map(task => ({ Put: putItem(taskItem(userID, task)) }))
      ]
    }));
    return { created: true };
  } catch (error) {
    if (isConditionFailure(error)) return { created: false };
    throw error;
  }
}

function query(input) {
  return client.send(new QueryCommand(input));
}

async function queryItems(input) {
  const result = await query(input);
  return result.Items.map(item => unmarshall(item));
}

function activeTasksQuery(boardID) {
  return {
    TableName: tableName,
    IndexName: "GSI1",
    KeyConditionExpression: "#pk = :pk And #sk >= :now",
    ExpressionAttributeNames: { "#pk": "GSI1-PK", "#sk": "GSI1-SK" },
    ExpressionAttributeValues: marshall({ ":pk": boardID, ":now": String(Date.now()) })
  };
}

function boardsQuery(userID) {
  return {
    TableName: tableName,
    // Scores are read straight after a sync on page load, so an eventually consistent read can miss the tick
    ConsistentRead: true,
    KeyConditionExpression: "PK = :pk And begins_with(SK, :board)",
    ProjectionExpression: "SK, Board, WScore, MScore, YScore, YTarget, MTarget, WTarget, Emoji, CategoryOrder",
    ExpressionAttributeValues: marshall({ ":pk": userID, ":board": "b#" })
  };
}

function userQuery(userID) {
  return {
    TableName: tableName,
    // The frontend reads this straight after POST /new-user, and a missing user sends it back to set up again
    ConsistentRead: true,
    KeyConditionExpression: "PK = :pk And SK = :pk",
    ProjectionExpression: "Theme, RewordTone, AIEnabled",
    ExpressionAttributeValues: marshall({ ":pk": userID })
  };
}

function putItem(item) {
  return { TableName: tableName, Item: marshall(item) };
}

function userItem(userID) {
  return {
    PK: userID,
    SK: userID,
    EntityType: "User",
    "GSI1-PK": "u#",
    "GSI1-SK": userID,
    Theme: "purple-haze"
  };
}

function boardItem(userID, board) {
  return {
    PK: userID,
    SK: board.boardID,
    EntityType: "Board",
    "GSI1-PK": "b#",
    "GSI1-SK": board.boardID,
    Board: board.boardName,
    WScore: board.score,
    MScore: board.score,
    YScore: board.score,
    WTarget: board.weeklyTarget,
    MTarget: 31,
    YTarget: 365,
    Emoji: board.emoji,
    CategoryOrder: board.categoryOrder
  };
}

function taskItem(userID, task) {
  return {
    PK: userID,
    SK: task.taskID,
    EntityType: "Task",
    "GSI1-PK": task.boardID,
    "GSI1-SK": task.expiryDate,
    CreatedDate: task.createdDate,
    Description: task.description,
    Category: task.category,
    Emoji: task.emoji,
    Important: task.important,
    Link: task.link,
    CompletedDate: task.completedDate,
    ExpiryDate: task.expiryDate,
    ExpiryDateTTL: task.expiryDateTTL
  };
}

function updateFields(PK, SK, fields) {
  const names = Object.keys(fields);
  return client.send(new UpdateItemCommand({
    TableName: tableName,
    Key: itemKey(PK, SK),
    UpdateExpression: "SET " + names.map((_, i) => `#f${i} = :f${i}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#f${i}`, name])),
    ExpressionAttributeValues: marshall(Object.fromEntries(names.map((name, i) => [`:f${i}`, fields[name]])))
  }));
}

function setUserField(userID, name, value) {
  return updateFields(userID, userID, { [name]: value });
}

function setBoardScores(userID, boardID, { YScore, MScore, WScore }) {
  return updateFields(userID, boardID, { YScore: Number(YScore), MScore: Number(MScore), WScore: Number(WScore) });
}

// Every task on the board, expired ones included, a page at a time; batches of 25 are BatchWriteItem's limit.
// Keys use the caller's userID, so nothing outside their partition can be deleted.
function deleteBoardTasks(userID, boardID) {
  return deleteQueried(userID, {
    TableName: tableName,
    IndexName: "GSI1",
    KeyConditionExpression: "#pk = :pk",
    ProjectionExpression: "SK",
    ExpressionAttributeNames: { "#pk": "GSI1-PK" },
    ExpressionAttributeValues: { ":pk": { S: boardID } }
  });
}

// The user item, boards and tasks all share the user's partition
function deleteUserItems(userID) {
  return deleteQueried(userID, {
    TableName: tableName,
    KeyConditionExpression: "#pk = :pk",
    ProjectionExpression: "SK",
    ExpressionAttributeNames: { "#pk": "PK" },
    ExpressionAttributeValues: { ":pk": { S: userID } },
    // A task synced just before the delete must not be left behind
    ConsistentRead: true
  });
}

async function deleteQueried(userID, input) {
  let ExclusiveStartKey;
  do {
    const page = await query({ ...input, ExclusiveStartKey });
    const keys = (page.Items ?? []).map(item => ({ PK: { S: userID }, SK: item.SK }));
    for (let i = 0; i < keys.length; i += 25) {
      await batchDelete(keys.slice(i, i + 25));
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

async function deleteCognitoUser(sub) {
  // Only this rarely used route needs the Cognito client, so other routes' cold starts don't pay to load it
  const { CognitoIdentityProviderClient, AdminDeleteUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
  try {
    await new CognitoIdentityProviderClient().send(new AdminDeleteUserCommand({ UserPoolId: process.env.UserPoolId, Username: sub }));
  } catch (error) {
    // An earlier attempt may have deleted the login and lost its response
    if (error.name !== "UserNotFoundException") throw error;
  }
}

// DynamoDB may hand back part of a batch when throttled; resend just those with a short backoff
async function batchDelete(keys) {
  let requests = keys.map(Key => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; requests.length && attempt < 5; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    const result = await client.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }));
    requests = result.UnprocessedItems?.[tableName] ?? [];
  }
  if (requests.length) throw new Error(`${requests.length} items could not be deleted`);
}
