"use strict";
const { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, PutItemCommand, DeleteItemCommand, BatchWriteItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { jwtDecode } = require("jwt-decode");
const { syncTasks, validateSyncBody, ValidationError } = require("./task_sync");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env;

// A plain object return is sent by API Gateway as a 200, so errors need the explicit response shape.
function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

module.exports.handler = async (event) => {
  try {
    let readResult, writeResult;
    const params = event.queryStringParameters;
    const body = event.body && JSON.parse(event['body']);
    let userID = "";
    if (event.headers.authorization) {
      const token = event.headers.authorization;
      const decoded = jwtDecode(token);
      userID = `u#${decoded.sub}`;
    }
    let valid = false

    switch (event.routeKey) {
      //// GET ACTIVE TASKS ////
      case "GET /active-tasks":
        if (typeof params?.boardID !== "string") {
          return respond(400, { error: "boardID is required" });
        }
        // A board's owner never changes, so the task read can run alongside the check and be discarded on failure.
        // Only board IDs start it: "u#" and "b#" are GSI1 partitions holding every user's items.
        [valid, readResult] = await Promise.all([
          verifyBoard(userID, params.boardID),
          isBoardID(params.boardID) ? query(activeTasksQuery(params.boardID)) : undefined
        ]);
        if (!valid) {
          return respond(403, { error: "requested board does not belong to the currently logged in user" });
        }
        break;


      //// GET BOARDS ////
      case "GET /boards":
        readResult = await query(boardsPerUserQuery(userID));
        break;


      //// GET USER ////
      case "GET /user":
        readResult = await query(getUser(userID));
        break;


      //// ADD USER ////
      case "POST /new-user":
        writeResult = await add(addUser(body));
        const boardBody = { userID: body.userID, boardName: "Demo Board", boardID: "b#" + body.userID }
        await add(addBoard(body.userID, boardBody));
        const taskBody = { userID: body.userID, createdDate: "nil", expiryDate: "nil", taskID: "t#" + body.userID, description: "Start creating some new tasks!", completedDate: "nil", category: "Welcome", emoji: "✅", boardID: "b#" + body.userID }
        await add(addTask(body.userID, taskBody));
        break;


      //// UPDATE USER THEME ////
      case "POST /user-theme":
        writeResult = await update(updateUserTheme(userID, body.theme));
        break;


      //// SYNC TASK AND BOARD SETTINGS CHANGES ////
      case "POST /sync":
        try {
          writeResult = await syncTasks(client, tableName, userID, validateSyncBody(body));
        } catch (error) {
          if (error instanceof ValidationError) {
            return respond(400, { error: error.message });
          }
          throw error;
        }
        break;


      //// DELETE BOARD ////
      case "POST /delete-board":
        valid = await verifyBoard(userID, body.boardID);
        if (!valid) {
          return respond(403, { error: "Requested board does not belong to the currently logged-in user" });
        }

        try {
          await deleteBoardTasks(userID, body.boardID);
          const boardDeletionResult = await remove(deleteBoard(userID, body.boardID));
          return boardDeletionResult;
        } catch (error) {
          console.error("Failed to delete board or tasks:", error);
          return respond(500, { error: "Failed to delete board and/or tasks", details: error.message });
        }


      //// DELETE ACCOUNT ////
      // Data before login: a failure partway leaves the login in place, so the user can sign in and try again.
      case "POST /delete-account":
        await deleteUserItems(userID);
        await deleteCognitoUser(userID.slice(2));
        writeResult = { deleted: true };
        break;


      //// UPDATE BOARD SCORES ////
      // Manual score edits only. Ticking a task changes scores inside POST /sync.
      case "POST /board-scores":
        const scores = body?.scores;
        if (!scores || !["YScore", "MScore", "WScore"].every(field => Number.isFinite(Number(scores[field])) && Number(scores[field]) >= 0)) {
          return respond(400, { error: "scores must contain non-negative YScore, MScore and WScore" });
        }
        valid = await verifyBoard(userID, body.boardID);
        if (!valid) {
          return respond(403, { error: "Requested board does not belong to the currently logged-in user" });
        }
        writeResult = await update(updateBoardScores(userID, body.boardID, scores));
        break;


      default:
        throw new Error(`Unsupported route: "${event.routeKey}"`);
    }

    const data = readResult && readResult.Items.map((item) => {
      return unmarshall(item);
    });

    return {
      data: data ? data : writeResult
    }

  } catch (error) {
    console.error(error);
    return respond(500, { error: "Internal server error" });
  }
}


// The user item and tasks share the user's partition with their boards, so the prefix stops them passing as boards
function isBoardID(boardID) {
  return typeof boardID === "string" && boardID.startsWith("b#") && boardID.length > 2;
}

async function verifyBoard(userID, boardID) {
  if (!isBoardID(boardID)) return false;
  const result = await client.send(new GetItemCommand({
    TableName: tableName,
    Key: { PK: { S: userID }, SK: { S: boardID } },
    ProjectionExpression: "SK",
    // The frontend can open or delete a board moments after creating it
    ConsistentRead: true
  }));
  return !!result.Item;
}

async function query(input) {
  const command = new QueryCommand(input);
  const result = await client.send(command);
  return result
}

async function update(input) {
  const command = new UpdateItemCommand(input);
  const result = await client.send(command);
  return result
}

async function add(input) {
  const command = new PutItemCommand(input);
  const result = await client.send(command);
  return result
}

async function remove(input) {
  const command = new DeleteItemCommand(input);
  const result = await client.send(command);
  return result
}

function activeTasksQuery(boardID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "IndexName": "GSI1",
    "KeyConditionExpression": "#c1490 = :c1490 And #c1491 >= :c1491",
    "ExpressionAttributeValues": {
      ":c1490": { "S": boardID },
      ":c1491": { "S": String(Date.now()) }
    },
    "ExpressionAttributeNames": {
      "#c1490": "GSI1-PK",
      "#c1491": "GSI1-SK"
    }
  }
}

function boardsPerUserQuery(userID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    // Scores are read straight after a sync on page load, so an eventually consistent read can miss the tick
    "ConsistentRead": true,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "SK, Board, WScore, MScore, YScore, YTarget, MTarget, WTarget, Emoji, CategoryOrder",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": "b#" }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function getUser(userID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And #cd421 = :cd421",
    "ProjectionExpression": "Theme",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": userID }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function addTask(userID, body) {
  return {
    "Item": {
      "CreatedDate": { "S": body.createdDate },
      "GSI1-SK": { "S": body.expiryDate },
      "SK": { "S": body.taskID },
      "ExpiryDate": { "S": body.expiryDate },
      "ExpiryDateTTL": { "N": "0" },
      "GSI1-PK": { "S": body.boardID },
      "Description": { "S": body.description },
      "PK": { "S": userID },
      "CompletedDate": { "S": body.completedDate },
      "Category": { "S": body.category },
      "EntityType": { "S": "Task" },
      "Emoji": { "S": body.emoji },
    },
    "TableName": tableName
  }
}

function updateUserTheme(userID, theme) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": userID }
    },
    "UpdateExpression": "SET #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb52": { "S": theme }
    },
    "ExpressionAttributeNames": {
      "#9eb52": "Theme"
    }
  }
}

function addBoard(userID, body) {
  return {
    "Item": {
      "SK": { "S": body.boardID },
      "PK": { "S": userID },
      "Board": { "S": body.boardName },
      "EntityType": { "S": "Board" },
      "WScore": { "N": String(0) },
      "MScore": { "N": String(0) },
      "YScore": { "N": String(0) },
      "WTarget": { "N": String(7) },
      "MTarget": { "N": String(31) },
      "YTarget": { "N": String(365) },
      "GSI1-SK": { "S": body.boardID },
      "GSI1-PK": { "S": "b#" },
      "Emoji": { "S": "🚀" },
      "CategoryOrder": { "S": "[]" },
    },
    "TableName": tableName
  }
}

function deleteBoard(userID, boardID) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    }
  }
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


function updateBoardScores(userID, boardID, scores) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #9eb50 = :9eb50, #9eb51 = :9eb51, #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb50": { "N": String(scores.YScore) },
      ":9eb51": { "N": String(scores.MScore) },
      ":9eb52": { "N": String(scores.WScore) }
    },
    "ExpressionAttributeNames": {
      "#9eb50": "YScore",
      "#9eb51": "MScore",
      "#9eb52": "WScore"
    }
  }
}

function addUser(body) {
  return {
    "Item": {
      "SK": { "S": body.userID },
      "PK": { "S": body.userID },
      "EntityType": { "S": "User" },
      "GSI1-SK": { "S": body.userID },
      "GSI1-PK": { "S": "u#" },
      "Theme": { "S": "purple-haze" },
    },
    "TableName": tableName
  }
}
